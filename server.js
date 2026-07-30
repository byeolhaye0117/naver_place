#!/usr/bin/env node
/* ============================================================================
 * 헬스장 플레이스 진단 — 로컬 서버
 *
 *   node server.js            서버 실행 (http://localhost:5173)
 *   node server.js --probe "강남역 헬스장" <플레이스URL>
 *                             네이버 응답이 살아있는지 점검하고 진단 출력
 *
 * 의존성 없음 (Node 18+ 내장 fetch 사용). npm install 불필요.
 *
 * ── 설계 원칙 ────────────────────────────────────────────────────────────
 * 네이버는 공개 API를 제공하지 않고 내부 응답 구조를 예고 없이 바꿉니다.
 * 그래서 경로를 고정해 파싱하지 않고,
 *   (1) 여러 엔드포인트를 순서대로 시도하고 (STRATEGIES)
 *   (2) 응답 트리 전체를 훑어 '필드 이름'으로 값을 주워담습니다 (harvest)
 * 구조가 바뀌어도 필드명이 남아 있으면 계속 동작하고,
 * 완전히 깨지면 --probe 가 어디서 깨졌는지 그대로 보여줍니다.
 * ========================================================================== */

'use strict';

const http = require('http');
const fs   = require('fs');
const path = require('path');
const os   = require('os');
const crypto = require('crypto');

const PORT     = Number(process.env.PORT || 5173);
const HOST     = process.env.HOST || '0.0.0.0';   // 같은 와이파이의 휴대폰에서도 붙을 수 있게
const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY  = path.join(DATA_DIR, 'rank-history.json');
const KEYFILE  = path.join(DATA_DIR, 'access-key.txt');
const STATE    = path.join(DATA_DIR, 'state.json');   // 기기 사이 공유 저장
const SAVES    = path.join(DATA_DIR, 'saves.json');   // 저장 내역

/* ============================================================================
 * 접근 키
 *
 * 0.0.0.0 으로 열면 같은 와이파이의 다른 기기도 접근할 수 있다.
 * 집이나 매장 와이파이라면 대개 문제없지만, 손님용 와이파이를 함께 쓴다면
 * /api/ai 를 통해 API 키가 쓰일 수 있다. 그래서 외부 기기 요청에만 키를 요구한다.
 * 키는 파일에 저장하므로 서버를 다시 켜도 휴대폰 북마크가 그대로 동작한다.
 * ========================================================================== */
function accessKey() {
  /* 인터넷에 올려 두고 쓸 때는 파일이 배포마다 사라진다.
     그래서 환경변수로 준 키를 최우선으로 쓴다 — 주소를 북마크해 두면 계속 통한다. */
  const env = String(process.env.ACCESS_KEY || '').trim();
  if (env) return env;
  try { return fs.readFileSync(KEYFILE, 'utf8').trim(); }
  catch {
    const k = crypto.randomBytes(9).toString('base64url');
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KEYFILE, k);
    return k;
  }
}
const KEY = accessKey();

function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}

/* 이 PC의 공유기 내부 주소 — 휴대폰이 붙을 곳 */
function lanIp() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const n of list || []) {
      if (n.family === 'IPv4' && !n.internal) return n.address;
    }
  }
  return null;
}

/* ============================================================================
 * 공통 HTTP
 * ========================================================================== */

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 '
         + '(KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

async function get(url, extraHeaders = {}) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': UA,
      'accept': 'application/json,text/html;q=0.9,*/*;q=0.8',
      'accept-language': 'ko-KR,ko;q=0.9',
      'referer': 'https://m.place.naver.com/',
      ...extraHeaders,
    },
  });
  const text = await res.text();
  return { ok: res.ok, status: res.status, url: res.url, text };
}

/* 여는 괄호의 짝을 직접 세어 객체를 통째로 잘라낸다.
   정규식으로 `(\{[\s\S]*?\})\s*<\/script>` 처럼 자르면
   상태 객체 뒤에 다른 자바스크립트가 한 줄이라도 붙는 순간 전부 실패한다.
   문자열 안의 괄호와 백슬래시 이스케이프는 세지 않는다. */
function extractBalanced(text, start) {
  const open = text[start];
  if (open !== '{' && open !== '[') return null;
  const close = open === '{' ? '}' : ']';
  let depth = 0, inStr = false, quote = '', esc = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (esc) { esc = false; continue; }
    if (inStr) {
      if (c === '\\') esc = true;
      else if (c === quote) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; quote = c; continue; }
    else if (c === open) depth++;
    else if (c === close && --depth === 0) return text.slice(start, i + 1);
  }
  return null;   // 끝까지 안 닫힘 (응답이 잘렸다는 뜻)
}

/* HTML 안에 박혀 있는 상태 객체를 꺼낸다.
   구체적인 이름을 먼저 보고, 다 실패하면 이름을 모르는 것까지 훑는다.
   네이버가 변수명이나 프레임워크를 바꿔도 살아남게 하려는 것이다. */
const STATE_MARKERS = [
  /window\.__APOLLO_STATE__\s*=\s*/g,
  /window\.__PLACE_STATE__\s*=\s*/g,
  /window\.__INITIAL_STATE__\s*=\s*/g,
  /window\.__PRELOADED_STATE__\s*=\s*/g,
  /<script[^>]*\bid=["']__NEXT_DATA__["'][^>]*>\s*/g,
  /<script[^>]*\btype=["']application\/json["'][^>]*>\s*/g,
  /window\.__[A-Z0-9_]+__\s*=\s*/g,          // 이름을 모르는 경우
  /:\s*window\.__[A-Z0-9_]+__\s*\|\|\s*/g,   // 번들러가 감싸 놓은 경우
];

function tryJson(text) {
  try { return JSON.parse(text); } catch { /* HTML 이거나 JSONP */ }

  // JSONP: fn({...}) 형태
  const jp = text.match(/^[^(]{0,80}\(\s*(?=[{[])/);
  if (jp) {
    const raw = extractBalanced(text, jp[0].length);
    if (raw) { try { return JSON.parse(raw); } catch { /* 계속 */ } }
  }

  for (const re of STATE_MARKERS) {
    re.lastIndex = 0;
    const blocks = [];
    let m;
    while ((m = re.exec(text)) && blocks.length < 8) {
      const raw = extractBalanced(text, m.index + m[0].length);
      if (!raw) continue;
      try {
        const o = JSON.parse(raw);
        if (o && typeof o === 'object' && Object.keys(o).length) blocks.push(o);
      } catch { /* 자바스크립트 리터럴이라 JSON 이 아님 */ }
    }
    if (blocks.length === 1) return blocks[0];
    // 여러 개 잡히면 하나로 묶는다 — harvest 는 트리 전체를 훑으므로 문제없다
    if (blocks.length > 1) return Object.fromEntries(blocks.map((o, i) => [`_block${i}`, o]));
  }
  return null;
}

/* 트리 전체를 훑어 원하는 필드명의 값을 주워담는다.
   경로가 바뀌어도 필드명만 남아 있으면 계속 동작한다. */
/* 같은 필드명이 트리 안에 여러 번 나온다. 예를 들어 menus 가 어떤 노드에서는
   빈 배열이고 다른 노드에서는 실제 목록이다. 먼저 만난 값을 그대로 쓰면
   "메뉴 0개"로 읽고 끝나므로, 빈 값은 채워진 값으로 덮어쓴다.
   반대로 이미 채워진 값은 덮지 않는다 (목록에 섞인 남의 가게 이름이 이기지 않게). */
const isEmptyVal = v => v === undefined || v === null || v === '' || v === 0 || v === false;

function harvest(node, fields, out = {}, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  for (const [k, v] of Object.entries(node)) {
    if (fields.includes(k)) {
      const cur = out[k];
      const next = (v !== null && typeof v !== 'object') ? v
                 : Array.isArray(v) ? v.length : undefined;
      if (next !== undefined && (cur === undefined || (isEmptyVal(cur) && !isEmptyVal(next)))) out[k] = next;
    }
    if (v && typeof v === 'object') harvest(v, fields, out, depth + 1);
  }
  return out;
}

/* 트리에서 '업체처럼 생긴 객체'를 등장 순서대로 모은다 (순위 판정용) */
function harvestPlaces(node, acc = [], seen = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return acc;
  if (Array.isArray(node)) {
    for (const v of node) harvestPlaces(v, acc, seen, depth + 1);
    return acc;
  }
  const id = node.id ?? node.placeId ?? node.sid;
  const name = node.name ?? node.title ?? node.displayName;
  if (id != null && name && /^\d{5,}$/.test(String(id)) && !seen.has(String(id))) {
    seen.add(String(id));
    acc.push({ id: String(id), name: String(name).replace(/<[^>]*>/g, '') });
  }
  for (const v of Object.values(node)) harvestPlaces(v, acc, seen, depth + 1);
  return acc;
}

/* ============================================================================
 * 플레이스 ID 추출
 * ========================================================================== */

async function resolvePlaceId(input) {
  const raw = String(input || '').trim();
  if (/^\d{5,}$/.test(raw)) return raw;

  let url = raw;
  // naver.me 단축링크는 리다이렉트를 따라가야 실제 주소가 나온다
  if (/naver\.me/.test(url)) {
    const r = await get(url);
    url = r.url || url;
  }
  const m = url.match(/(?:place|entry\/place|restaurant|hairshop)\/(\d{5,})/)
         || url.match(/[?&]id=(\d{5,})/)
         || url.match(/(\d{9,})/);
  if (!m) throw new Error(`플레이스 ID를 찾지 못했습니다: ${raw}`);
  return m[1];
}

/* ============================================================================
 * 플레이스 정보 수집
 * ========================================================================== */

/* 네이버는 응답 구조를 예고 없이 바꾸고 페이지 유형마다 필드명이 다르다.
   그래서 같은 뜻의 후보 이름을 여러 개 걸어두고, 잡히는 것을 쓴다. */
const PLACE_FIELDS = [
  'name', 'category', 'categoryCode', 'description', 'phone', 'virtualPhone',
  'visitorReviewCount', 'visitorReviewScore', 'blogCafeReviewCount',
  'totalReviewCount', 'imageCount', 'photoCount', 'bookmarkCount',
  'roadAddress', 'address', 'x', 'y', 'homepage', 'bookingUrl', 'talktalkUrl',
  'businessHours', 'conveniences', 'keywords', 'microReviews',
  // ↓ 자동 판정을 위해 추가한 후보들
  'newBusinessHours', 'businessHoursInfo', 'operationTime', 'businessStatus',
  'menus', 'menuInfo', 'menuImages', 'hasMenu', 'priceInfo', 'prices',
  'amenities', 'facilities', 'options', 'conveniencesInfo',
  'isBusinessRegistered', 'businessRegistration', 'certified', 'isCertified', 'ownerVerified',
  'newsCount', 'feedCount', 'announcementCount', 'newsList', 'feedList',
  'reviewReplyCount', 'replyCount', 'answeredReviewCount', 'ownerReplyCount',
  'lastPhotoUpdatedAt', 'photoUpdatedAt', 'lastFeedAt', 'lastNewsAt',
  'homepages', 'socials', 'snsUrl', 'instagramUrl',
  // ↓ 리뷰·저장 수는 페이지마다 이름이 다르게 나온다. 후보를 넓게 걸어둔다.
  'visitorReviewsTotal', 'visitorReviewTotal', 'visitorReviewsCount',
  'blogCafeReviewTotal', 'blogReviewCount', 'cafeReviewCount', 'ugcReviewCount',
  'reviewCount', 'reviewTotal', 'fsasReviewCount',
  'favoriteCount', 'saveCount', 'bookmarkTotal', 'keepCount',
  'photoTotal', 'imageTotal', 'totalImageCount',
  // ↓ 사장님 플레이스 실측에서 확인된 실제 이름들
  'totalImages', 'imageReviewCount', 'cafeBlogReviewsTotal',
  'visitorReviewsScore', 'avgRating', 'ratingReviewsTotal', 'authorCount',
];

/* 필요한 값이 한 페이지에 다 있지 않다. 리뷰 수는 리뷰 탭에만 있는 경우가 많다.
   그래서 첫 성공에서 멈추지 않고, 아래 항목이 다 채워질 때까지 이어서 시도한다. */
const PLACE_STRATEGIES = [
  id => `https://m.place.naver.com/place/${id}/home`,
  id => `https://pcmap.place.naver.com/place/${id}/home`,
  id => `https://m.place.naver.com/place/${id}/review/visitor`,
  id => `https://m.place.naver.com/place/${id}/review/ugc`,
  id => `https://m.place.naver.com/place/${id}/photo`,
  id => `https://m.place.naver.com/place/${id}/news`,
  id => `https://m.place.naver.com/place/${id}/feed`,
  id => `https://m.place.naver.com/place/${id}/information`,
  id => `https://m.place.naver.com/hairshop/${id}/home`,
  id => `https://map.naver.com/p/api/place/summary/${id}`,
];

/* 이게 다 모이면 더 요청하지 않는다 (불필요한 왕복을 줄이려는 것) */
const KEY_FIELDS = ['description', 'imageCount', 'visitorReviewCount',
                    'blogCafeReviewCount', 'visitorReviewsScore'];

/* 개수 항목은 남의 것이 섞이면 곧바로 거짓 판정이 된다.
   실제로 리뷰 탭을 읽었더니 방문자 리뷰 4,667개라는 값이 잡혔는데 이 가게 것이 아니었다.
   그래서 개수만큼은 "이 플레이스에 속한 노드"에서 나온 것만 인정한다. */
const COUNT_FIELDS = [
  'visitorReviewCount', 'visitorReviewsTotal', 'visitorReviewTotal', 'visitorReviewsCount',
  'totalReviewCount', 'reviewCount', 'reviewTotal', 'fsasReviewCount',
  'blogCafeReviewCount', 'blogCafeReviewTotal', 'blogReviewCount', 'cafeReviewCount', 'ugcReviewCount',
  'bookmarkCount', 'favoriteCount', 'saveCount', 'bookmarkTotal', 'keepCount',
  'imageCount', 'photoCount', 'photoTotal', 'imageTotal', 'totalImageCount',
  'menus', 'menuImages', 'prices', 'conveniences', 'facilities', 'amenities', 'options',
  'newsCount', 'feedCount', 'announcementCount', 'visitorReviewScore',
  // 실측에서 확인된 이름들도 같은 보호를 받아야 한다
  'visitorReviewsScore', 'avgRating', 'rating', 'ratingReviewsTotal',
  'totalImages', 'imageReviewCount', 'cafeBlogReviewsTotal', 'authorCount',
];

/* 이름 목록으로 찾는 방식은 네이버가 이름을 바꾸면 그대로 놓친다.
   실제로 블로그 리뷰·저장수·소식이 전부 "가져오지 못했습니다"로 남았다.
   그래서 이름을 모를 때는 뜻으로 찾는다 — 무엇에 관한 키인지 + 개수인지. */
/* 개념 단위로 묶는다. alts 중 하나라도 이미 잡혔으면 패턴 추측은 하지 않는다.
   실측에서 imageReviewCount(리뷰에 달린 사진 3,775장)를 방문자 리뷰로 집는 사고가 났다.
   "review 가 들어가고 count 로 끝난다"만으로는 부족하고, 아닌 것도 걸러야 한다. */
const CONCEPTS = {
  visitorReviewCount: {
    alts: ['visitorReviewCount', 'visitorReviewsTotal', 'visitorReviewTotal', 'visitorReviewsCount',
           'totalReviewCount', 'reviewCount', 'reviewTotal', 'fsasReviewCount'],
    what: /visitor/i, count: /count|total|num|cnt/i,
    not: /media|image|photo|text|score|rating|author|user|single|max/i,
  },
  blogCafeReviewCount: {
    alts: ['blogCafeReviewCount', 'cafeBlogReviewsTotal', 'blogCafeReviewTotal',
           'blogReviewCount', 'cafeReviewCount', 'ugcReviewCount'],
    what: /blog|cafe|ugc/i, count: /count|total|num|cnt/i, not: /score|rating|media/i,
  },
  imageCount: {
    alts: ['imageCount', 'totalImages', 'photoTotal', 'imageTotal', 'totalImageCount', 'photoCount'],
    what: /image|photo|picture/i, count: /count|total|num|cnt/i,
    not: /review|media|width|height|size/i,
  },
  newsCount: {
    alts: ['newsCount', 'feedCount', 'announcementCount'],
    what: /news|feed|announce|notice|event|post/i, count: /count|total|num|cnt/i,
    not: /id$|score/i,
  },
  visitorReviewsScore: {
    alts: ['visitorReviewsScore', 'visitorReviewScore', 'avgRating', 'rating'],
    what: /rating|score/i, count: /rating|score|avg/i, not: /count|total|num/i,
  },
};

/* 링크는 "필드가 있다"로 판단하면 안 된다.
   실제로 homepages 라는 객체가 있는데 안에 주소가 하나도 없는 경우가 있다.
   껍데기만 보고 "연결됨"이라 하면 사장님이 확인할 방법이 없다. */
const LINK_FIELDS = ['homepage', 'homepages', 'snsUrl', 'instagramUrl', 'socials'];

/* 업체 기본 정보 노드에서만 가져와야 하는 글. 다른 노드에도 같은 이름이 있다. */
const TEXT_FROM_BASE = ['description', 'microReviews'];

/* 소개글은 이름이 하나가 아니다. 그리고 리뷰 본문·예약 안내문처럼
   "긴 한국어 문장"이 여럿 섞여 있어서 먼저 만난 것을 쓰면 엉뚱한 게 들어온다.
   후보를 다 모은 뒤 사장님이 쓴 글로 보이는 쪽을 고른다. */
const INTRO_KEYS = [
  'description', 'introduction', 'intro', 'detailDescription', 'placeDescription',
  'businessDescription', 'bizDescription', 'longDescription', 'shortDescription',
  'profile', 'detail', 'content', 'body', 'text',
];

/* 사장님이 쓴 소개글인가, 손님이 쓴 리뷰인가 */
function introScore(t) {
  const s = String(t || '');
  if (s.length < 15) return -99;
  let v = Math.min(s.length, 1500) / 500;                       // 길수록 소개글일 확률이 높다
  if (/안녕하세요|저희|입니다|운영합니다|드립니다|하고 있습니다|오시면/.test(s)) v += 3;
  if (/방문했어요|다녀왔|받았어요|같아요|추천해요|좋았어요|친절하[셨시]/.test(s)) v -= 5;  // 리뷰 말투
  if (/^실시간 예약|예약관리를 온라인/.test(s)) v -= 4;          // 네이버 예약 기본 문구
  return v;
}

function collectIntros(nodes, out = [], depth = 0) {
  for (const nd of nodes) walkIntros(nd, out);
  return out;
}
function walkIntros(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8 || out.length > 40) return;
  if (isReviewNode(node)) return;                                // 리뷰 노드는 통째로 건너뛴다
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'string' && INTRO_KEYS.includes(k) && v.trim().length >= 15)
      out.push({ key: k, text: v.trim(), score: introScore(v) });
    else if (v && typeof v === 'object') walkIntros(v, out, depth + 1);
  }
}

function findUrls(node, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6 || out.length > 5) return out;
  for (const v of Object.values(node)) {
    if (typeof v === 'string' && /^https?:\/\/\S+$/.test(v.trim())) out.push(v.trim());
    else if (v && typeof v === 'object') findUrls(v, out, depth + 1);
  }
  return out;
}

/* 링크 필드 아래에 실제로 존재하는 주소만 모은다 */
function collectLinks(nodes, out = {}, depth = 0) {
  for (const node of nodes) walkLinks(node, out);
  return out;
}
function walkLinks(node, out, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 8) return;
  for (const [k, v] of Object.entries(node)) {
    if (LINK_FIELDS.includes(k)) {
      const urls = typeof v === 'string' ? (/^https?:\/\//.test(v.trim()) ? [v.trim()] : []) : findUrls(v);
      if (urls.length) (out[k] ||= []).push(...urls);
    }
    if (v && typeof v === 'object') walkLinks(v, out, depth + 1);
  }
}

/* 좌표나 아이디 같은 것 말고, 세는 값으로 보이는 숫자만 모은다 */
function collectNumbers(node, out = {}, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6 || Object.keys(out).length > 80) return out;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'number' && isFinite(v) && !/^(x|y|lat|lng|longitude|latitude|id)$/i.test(k)
        && out[k] === undefined) out[k] = v;
    if (v && typeof v === 'object') collectNumbers(v, out, depth + 1);
  }
  return out;
}

function scanNumeric(node, c, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 6) return null;
  for (const [k, v] of Object.entries(node)) {
    if (typeof v === 'number' && isFinite(v) && v >= 0
        && c.what.test(k) && c.count.test(k) && !(c.not && c.not.test(k)))
      return { key: k, value: v };
    if (v && typeof v === 'object') {
      const hit = scanNumeric(v, c, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/* 이 플레이스를 가리키는 노드를 찾는다.
   아폴로 캐시는 "PlaceDetailBase:11716617" 처럼 키에 번호가 박히고,
   그렇지 않은 경우에도 노드 안에 id 가 들어 있다. */
function scopedNodes(node, placeId, out = [], depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  for (const [k, v] of Object.entries(node)) {
    if (!v || typeof v !== 'object') continue;
    const byKey  = k.includes(placeId);
    const bySelf = !Array.isArray(v) && String(v.id ?? v.placeId ?? '') === placeId;
    if (byKey || bySelf) { out.push(v); v.__key = k; }
    scopedNodes(v, placeId, out, depth + 1);
  }
  return out;
}

/* 리뷰 노드에도 description 이라는 이름의 본문이 들어 있다.
   그대로 훑으면 손님 리뷰가 소개글 자리를 차지한다. 실제로 그런 일이 있었다. */
function isReviewNode(nd) {
  if (!nd || typeof nd !== 'object') return false;
  if (/review|comment|reply|ugc/i.test(String(nd.__key || ''))) return true;
  const dated = DATE_KEYS.some(k => nd[k] != null);
  return dated && (nd.rating != null || nd.author != null || nd.authorName != null || nd.score != null);
}

/* harvest 는 스칼라와 배열만 담는다.
   businessHours 처럼 객체로 오는 필드는 "값이 있느냐"만 따로 확인한다. */
function harvestPresence(node, fields, found = new Set(), depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return found;
  for (const [k, v] of Object.entries(node)) {
    if (fields.includes(k) && v != null) {
      const empty = (Array.isArray(v) && v.length === 0)
                 || (typeof v === 'object' && !Array.isArray(v) && Object.keys(v).length === 0)
                 || v === '' || v === false;
      if (!empty) found.add(k);
    }
    if (v && typeof v === 'object') harvestPresence(v, fields, found, depth + 1);
  }
  return found;
}

/* 배열 필드의 '실제 값'을 꺼낸다. harvest 는 길이만 담기 때문에
   대표키워드·메뉴처럼 내용이 필요한 것은 따로 주워야 한다. */
function harvestList(node, field, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return null;
  for (const [k, v] of Object.entries(node)) {
    if (k === field && Array.isArray(v) && v.length) return v;
    if (v && typeof v === 'object') {
      const hit = harvestList(v, field, depth + 1);
      if (hit) return hit;
    }
  }
  return null;
}

/* ============================================================================
 * 입력란 자동 채우기
 *
 * 사장님이 직접 타이핑할 것을 최대한 줄인다.
 * 플레이스 주소만 넣으면 지역·업종·가격·대표키워드까지 채워지도록,
 * 수집한 값에서 끌어낼 수 있는 것은 전부 끌어낸다.
 * ========================================================================== */

/* 주소에서 검색에 쓸 지역명을 뽑는다. 동 > 구 > 시 순으로 구체적이다. */
function areaCandidates(addr) {
  const out = [];
  for (const tok of String(addr || '').split(/\s+/)) {
    const m = tok.match(/^(.{2,6})(동|구|시|군|읍|면)$/);
    if (!m) continue;
    // "서울특별시" → "서울특별" 같은 광역자치단체 조각은 검색어로 못 쓴다
    if (/(특별|광역|자치)$/.test(m[1])) continue;
    const rank = { '동': 0, '읍': 0, '면': 0, '구': 1, '시': 2, '군': 2 }[m[2]];
    // 동은 붙여 써야 검색어가 된다 (쌍용동 헬스장). 구·시는 떼는 쪽이 자연스럽다 (천안 헬스장).
    out.push({ name: rank === 0 ? tok : m[1], rank });
  }
  return [...new Set(out.sort((a, b) => a.rank - b.rank).map(x => x.name))];
}

function guessType(category) {
  const c = String(category || '');
  if (/필라테스/.test(c)) return '필라테스';
  if (/크로스핏/.test(c)) return '크로스핏';
  if (/(PT|피티|퍼스널)/i.test(c)) return 'PT 전문';
  return '헬스장';
}

/* 메뉴에서 1개월 이용권 가격을 찾는다 */
function guessPrice(menus) {
  if (!Array.isArray(menus)) return '';
  const priceOf = m => {
    const raw = m?.price ?? m?.amount ?? m?.cost;
    const n = Number(String(raw ?? '').replace(/[^\d]/g, ''));
    return isFinite(n) && n > 0 ? n : null;
  };
  const monthly = menus.find(m => /(1개월|한달|1달|월 ?회원|1개월권)/.test(String(m?.name ?? '')));
  const pick = priceOf(monthly) ?? menus.map(priceOf).find(v => v != null);
  return pick ? pick.toLocaleString('ko-KR') + '원' : '';
}

/* 대표키워드는 관리자 화면에만 있는 값이라 응답에 안 나온다.
   그런데 사장님들이 소개글 끝에 키워드 줄을 그대로 붙여 두는 경우가 많다.
   "쌍용동헬스장, 쌍용동pt, 쌍용동24시헬스장, 천안쌍용동헬스장, 봉명동 헬스장"
   문장이 아니라 나열이고, 지역·업종 말이 반복되는 줄을 찾는다.
   그런 줄이 없으면 아무것도 만들지 않는다 — 시설 나열을 키워드로 오해하면 안 된다. */
function keywordsFromIntro(text, hints) {
  const t = String(text || '');
  if (!t) return [];
  const lines = t.split(/\r?\n|·|\||\/{2,}/).map(x => x.trim()).filter(Boolean);
  let best = null, bestScore = 0;

  for (const ln of lines) {
    if (ln.length > 200) continue;
    if (/[.!?]\s*$|습니다|해요|입니다|하세요|드립니다|있어요|주세요/.test(ln)) continue;  // 문장은 제외
    const parts = ln.replace(/^#/, '').split(/[,#]/).map(x => x.trim()).filter(Boolean);
    if (parts.length < 3) continue;
    if (parts.some(p => p.length < 2 || p.length > 22)) continue;

    // 지역·업종 말이 얼마나 겹치는지로 "키워드 줄"인지 가른다
    const hit = parts.filter(p => hints.some(h => h && p.includes(h))).length;
    if (hit < Math.ceil(parts.length / 2)) continue;
    if (hit >= bestScore) { bestScore = hit; best = parts; }   // 같으면 뒤쪽 줄을 택한다
  }
  return best || [];
}

/* 화면의 시설 항목 ← 네이버 편의시설 표기.
   같은 뜻인데 말이 다르다 (주차 가능 / 무료주차, 락커 / 사물함). */
const FACILITY_MAP = [
  ['주차 가능',    ['주차']],
  ['샤워실',      ['샤워']],
  ['락커',        ['락커', '라커', '사물함']],
  ['운동복 대여',  ['운동복', '운동화', '대여']],
  ['사우나',      ['사우나', '찜질']],
  ['24시간 운영',  ['24시', '24시간', '연중무휴']],
  ['여성 전용존',  ['여성', '여성전용']],
  ['GX 프로그램',  ['GX', '그룹운동', '단체']],
  ['PT 상담 무료', ['무료상담', '상담무료', '무료 상담']],
  ['인바디 측정',  ['인바디', '체성분']],
  ['무인 출입',    ['무인', '키오스크']],
  ['단백질바',    ['단백질', '헬스보충', '카페']],
];

function deriveInputs(data, jsons) {
  const all = Array.isArray(jsons) ? jsons : [jsons];
  const pick = (...names) => {
    for (const j of all) for (const nm of names) { const v = harvestList(j, nm); if (v) return v; }
    return [];
  };
  const kwList = pick('keywords')
    .map(k => String(k?.name ?? k).trim()).filter(Boolean);
  const menus  = pick('menus', 'menuInfo');
  /* 도로명 주소에는 동이 없는 경우가 많다 ("천안시 서북구 미란7길 26").
     지번 주소를 같이 봐야 쌍용동이 나온다. 손님은 구가 아니라 동으로 검색한다. */
  const fromAddr = areaCandidates([data.roadAddress, data.address].filter(Boolean).join(' '));

  // 이미 등록해 둔 대표키워드가 가장 강한 신호다.
  // 주소는 "어디에 있는가"일 뿐이고, 대표키워드는 "어디로 검색되고 싶은가"다.
  // 예: 주소는 역삼동이지만 대표키워드가 "강남역헬스장"이면 목표는 강남역이다.
  const station = kwList.map(k => (k.match(/^(.{2,8}?역)/) || [])[1]).find(Boolean);
  const areas = [...new Set([station, ...fromAddr].filter(Boolean))];

  /* 등록 대표키워드를 못 받았으면 소개글 끝의 키워드 줄에서 찾아본다 */
  const fromIntro = kwList.length ? []
    : keywordsFromIntro(data.description, [...areas, '헬스', 'PT', 'pt', '피트니스', '짐']);
  const repList = kwList.length ? kwList : fromIntro;

  /* 편의시설은 개수만 세고 이름은 버리고 있었다. 이름이 있으면 화면의 시설 체크를
     사람이 누를 필요가 없다. 네이버 표기와 우리 항목 이름이 조금씩 다르므로 뜻으로 잇는다. */
  const convRaw = pick('conveniences', 'amenities', 'facilities', 'options', 'conveniencesInfo')
    .map(v => String(v?.name ?? v ?? '').trim()).filter(Boolean);
  const facilities = FACILITY_MAP
    .filter(([ours, res]) => convRaw.some(c => res.some(w => c.includes(w))))
    .map(([ours]) => ours);

  return {
    areas,
    facilities,
    conveniences: convRaw.slice(0, 30),
    area:  areas[0] || '',
    repkwFrom: kwList.length ? '등록값' : (fromIntro.length ? '소개글' : ''),
    areaFrom: station ? '대표키워드' : (fromAddr.length ? '주소' : ''),
    type:  guessType(data.category),
    price: guessPrice(menus),
    repkw: repList.join(', '),
    // 목표 키워드 제안: 등록한 대표키워드가 있으면 그것을 그대로 쓴다
    kwSuggest: repList.slice(0, 3),
  };
}

/* ============================================================================
 * 자가 체크 항목 자동 판정
 *
 * 수집한 값으로 확실히 판정되는 것만 true/false 를 낸다.
 * 근거가 없으면 null 을 반환해 "직접 확인"으로 남긴다.
 * 애매한 것을 추측으로 채우면 점수가 거짓이 되므로, 모르면 모른다고 한다.
 * ========================================================================== */
/* ============================================================================
 * 목록에서 직접 세기
 *
 * 리뷰 답글 비율, 마지막 리뷰 날짜, 마지막 사진 날짜는 "개수" 필드로 오지 않는다.
 * 목록 안에 날짜와 답글이 들어 있으므로 직접 센다.
 * 목록을 못 찾으면 아무것도 만들지 않는다 — 없는 것을 추측하지 않기 위해서다.
 * ========================================================================== */

const DATE_KEYS  = ['created', 'createdAt', 'createdDateTime', 'created_at', 'visited', 'visitDate',
                    'visitedAt', 'date', 'writtenAt', 'regDate', 'registeredAt', 'updateTime', 'uploadDate'];
const REPLY_KEYS = ['reply', 'ownerReply', 'authorReply', 'replyBody', 'ownerComment', 'comment', 'replies'];

function parseWhen(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v > 1e12 ? v : v * 1000;   // 초/밀리초 둘 다 온다
  const s = String(v).trim().replace(/\./g, '-').replace(/-+$/, '');
  const t = Date.parse(/^\d{4}-\d{1,2}-\d{1,2}$/.test(s) ? s + 'T00:00:00' : s);
  return isFinite(t) ? t : null;
}

const whenOf = o => { for (const k of DATE_KEYS) { const t = parseWhen(o?.[k]); if (t) return t; } return null; };
const hasReply = o => REPLY_KEYS.some(k => {
  const v = o?.[k];
  return Array.isArray(v) ? v.length > 0 : (v != null && v !== '' && v !== false);
});

/* 날짜가 들어 있는 객체 목록을 찾는다. 이름을 모르므로 "모양"으로 찾는다. */
function findDatedList(node, minLen = 3, depth = 0, best = null) {
  if (!node || typeof node !== 'object' || depth > 12) return best;
  for (const v of Object.values(node)) {
    if (Array.isArray(v) && v.length >= minLen) {
      const dated = v.filter(x => x && typeof x === 'object' && whenOf(x));
      if (dated.length >= minLen && (!best || dated.length > best.length)) best = dated;
    }
    if (v && typeof v === 'object') best = findDatedList(v, minLen, depth + 1, best);
  }
  return best;
}

/* 날짜가 없어도 "몇 장이나 실려 있는지"는 셀 수 있다.
   네이버가 준 imageCount 가 무엇을 센 값인지 확실하지 않아, 비교 대상으로 쓴다. */
function biggestListLen(jsons) {
  let best = 0;
  const walk = (n, d = 0) => {
    if (!n || typeof n !== 'object' || d > 8) return;
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) {
        const objs = v.filter(x => x && typeof x === 'object').length;
        if (objs > best) best = objs;
      }
      if (v && typeof v === 'object') walk(v, d + 1);
    }
  };
  jsons.forEach(j => walk(j));
  return best;
}

function listStats(jsons) {
  const items = jsons.map(j => findDatedList(j)).filter(Boolean)
                     .sort((a, b) => b.length - a.length)[0];
  if (!items) return null;
  const times = items.map(whenOf).filter(Boolean).sort((a, b) => b - a);
  if (!times.length) return null;
  const replied = items.filter(hasReply).length;
  return {
    n: items.length,
    latest: times[0],
    daysSince: Math.floor((Date.now() - times[0]) / 86400000),
    replyRate: items.length ? replied / items.length : 0,
    replied,
  };
}

function judgeItems(data, present, userType, extra = {}) {
  const loose = extra.loose || new Set();
  const foundBy = extra.foundBy || {};
  const note = k => loose.has(k) ? ' (가게 정보 밖에서 읽은 값 — 확인해 주세요)'
                  : foundBy[k]   ? ` (${foundBy[k]} 에서 읽음)` : '';
  let usedKey = null;   // 방금 n() 이 어떤 필드에서 값을 가져왔는지
  const n = (...k) => {
    for (const x of k) { const v = Number(data[x]); if (isFinite(v)) { usedKey = x; return v; } }
    usedKey = null; return null;
  };
  const src = () => note(usedKey);
  const has = (...k) => k.some(x => present.has(x) || !isEmptyVal(data[x]));
  /* 무엇을 보고 충족이라 했는지 이름을 돌려준다.
     '연결됨'만 적어 두면 사장님이 맞는지 틀린지 확인할 방법이 없다. */
  const which = (...k) => k.filter(x => present.has(x) || !isEmptyVal(data[x]));

  const J = {};
  const put = (id, ok, evidence) => { J[id] = { ok, evidence }; };
  // 근거 없음 → 직접 확인으로 남긴다
  const unknown = (id, why) => { J[id] = { ok: null, evidence: why }; };
  // 사람이 봐야 아는 것과, 네이버가 아예 공개하지 않는 것은 다르다.
  // 후자를 '직접 확인'에 섞어두면 영영 끝나지 않는 숙제처럼 보인다.
  const na = (id, why) => { J[id] = { ok: null, evidence: why, na: true }; };

  // ── 수치가 그대로 있는 항목 ──────────────────────────────
  /* 실측에서 imageCount 는 1, totalImages 는 14, 사진 탭 목록은 19장이었다.
     1 은 대표사진 같은 다른 것을 센 값으로 보여 가장 큰 값을 쓰고, 후보를 전부 보여준다. */
  const photoKeys = CONCEPTS.imageCount.alts;
  const photoCands = photoKeys.filter(k => isFinite(Number(data[k]))).map(k => `${k} ${data[k]}`);
  const photo = photoKeys.map(k => Number(data[k])).filter(v => isFinite(v)).sort((a, b) => b - a)[0] ?? null;
  photo == null ? unknown('p2', '사진 수를 가져오지 못했습니다')
                : put('p2', photo >= 30,
                    `사진 ${photo}장 — 네이버가 준 값: ${photoCands.join(', ')}`
                    + (extra.photoListN ? `, 사진 탭 목록 ${extra.photoListN}장` : ''));

  const rev = n(...CONCEPTS.visitorReviewCount.alts);
  rev == null ? unknown('p6', '리뷰 수를 가져오지 못했습니다')
              : put('p6', rev >= 50, `방문자 리뷰 ${rev.toLocaleString('ko-KR')}개${src()}`);

  const blog = n(...CONCEPTS.blogCafeReviewCount.alts);
  blog == null ? unknown('p7', '블로그 리뷰 수를 가져오지 못했습니다')
               : put('p7', blog >= 10, `블로그 리뷰 ${blog}개${src()}`);

  /* 저장수는 네이버가 더 이상 공개하지 않는다 (실측 36개 숫자에 없었다).
     확인할 수 없는 항목을 남겨두는 대신, 공개되는 평점으로 자리를 바꿨다. */
  const score = n(...CONCEPTS.visitorReviewsScore.alts);
  score == null ? unknown('p10', '평점을 가져오지 못했습니다')
                : put('p10', score >= 4.5, `평점 ${score}점${src()}`);

  // ── 있으면 충족인 항목 ──────────────────────────────────
  {
    const w = which('bookingUrl', 'talktalkUrl');
    put('p11', w.length > 0, w.length ? `예약·톡톡 연결됨 (${w.join(', ')})` : '예약·톡톡 연결 없음');
  }

  {
    /* 실제 주소가 있어야 연결된 것이다. 필드만 있는 것은 연결이 아니다. */
    const found = Object.entries(extra.links || {});
    const urls = [...new Set(found.flatMap(([, v]) => v))];
    const shell = which('homepage', 'homepages', 'snsUrl', 'instagramUrl', 'socials');
    if (urls.length)
      put('d3', true, `외부 채널 연결됨 — ${urls.slice(0, 2).map(u => u.slice(0, 50)).join(', ')}`);
    else if (shell.length)
      put('d3', false, `${shell.join(', ')} 필드는 있으나 실제 주소가 없습니다 — 연결 안 된 것으로 봅니다`);
    else
      put('d3', false, '홈페이지·SNS 연결 없음');
  }

  has('businessHours', 'newBusinessHours', 'businessHoursInfo', 'operationTime')
    ? put('r8', true, `영업시간 등록됨 (${which('businessHours', 'newBusinessHours', 'businessHoursInfo', 'operationTime').join(', ')})`
                    + ' — 공휴일 반영 여부는 직접 확인')
    : unknown('r8', '영업시간 정보를 가져오지 못했습니다');

  /* 개수를 읽었다면 개수를 믿는다. 0개인데 "등록됨"으로 찍으면 점수가 거짓이 된다. */
  const menuN = n('menus', 'menuImages', 'prices');
  if (menuN === 0 && !has('menuInfo', 'priceInfo', 'hasMenu'))
    put('r6', false, '메뉴·가격 등록 0개');
  else if (menuN != null && menuN > 0)
    put('r6', true, `메뉴·가격 ${menuN}개 등록`);
  else if (has('menus', 'menuInfo', 'hasMenu', 'priceInfo', 'prices', 'menuImages'))
    put('r6', true, '메뉴·가격 정보 등록됨');
  else
    unknown('r6', '가격 정보를 확인하지 못했습니다 (등록 안 했거나 수집 실패)');

  const conv = n('conveniences', 'amenities', 'facilities', 'options');
  conv == null ? unknown('r7', '편의시설 정보를 가져오지 못했습니다')
               : put('r7', conv >= 4, `편의시설 ${conv}개 등록`);

  /* 스마트플레이스는 사업자 인증을 거쳐야 등록·관리할 수 있다.
     그러니 사장님이 직접 등록해 둔 흔적(예약·톡톡·대표키워드·소개글)이 있으면
     인증은 이미 끝난 것으로 본다. 전용 필드만 찾다가 "모른다"고 남기는 건
     사실과 다른 데다, 사장님에게 확인할 일거리만 늘린다. */
  const ownerSigns = [
    has('bookingUrl') && '네이버 예약',
    has('talktalkUrl') && '톡톡',
    has('keywords') && '대표키워드',
    !isEmptyVal(data.description) && '소개글',
    has('menus', 'menuInfo', 'prices') && '메뉴·가격',
  ].filter(Boolean);

  if (has('isBusinessRegistered', 'businessRegistration', 'certified', 'isCertified', 'ownerVerified'))
    put('d2', true, '사업자 인증 확인됨');
  else if (ownerSigns.length)
    put('d2', true, `사장님이 직접 등록·운영 중 (${ownerSigns.join('·')} 등록됨)` +
                    ` — 스마트플레이스 등록 자체가 사업자 인증을 거칩니다`);
  else
    unknown('d2', '사장님이 등록한 흔적을 찾지 못했습니다 (미등록 플레이스일 수 있습니다)');

  /* 주소에 건물·층이 들어 있는지. 지도 핀 정확도는 사람만 알 수 있지만
     주소가 어디까지 적혀 있는지는 글자만 보면 안다. */
  const addr = String(data.roadAddress || data.address || '');
  if (!addr) unknown('d4', '주소를 가져오지 못했습니다');
  else {
    const detail = /\d+\s*층|\bB\d|\d+\s*호|빌딩|타워|프라자|플라자|센터|스퀘어|아파트|상가/.test(addr);
    put('d4', detail, detail ? `주소에 건물·층 정보 있음 — ${addr}`
                             : `건물명·층이 없습니다 — ${addr}`);
  }

  // ── 카테고리: 주력 업종과 맞는지 ────────────────────────
  const cat = String(data.category || '');
  if (!cat) unknown('r2', '카테고리를 가져오지 못했습니다');
  else {
    const want = { '헬스장': ['헬스', '피트니스'], 'PT 전문': ['PT', '피티', '퍼스널'],
                   '헬스+PT': ['헬스', '피트니스', 'PT'], '필라테스': ['필라테스'],
                   '크로스핏': ['크로스핏'] }[userType] || ['헬스', '피트니스'];
    const hit = want.some(w => cat.toLowerCase().includes(w.toLowerCase()));
    put('r2', hit, `카테고리 "${cat}"` + (hit ? ' — 주력 업종과 일치' : ` — 주력(${userType})과 다름`));
  }

  // ── 소식 ────────────────────────────────────────────────
  const news = n(...CONCEPTS.newsCount.alts, 'newsList', 'feedList');
  news == null ? na('p5', '네이버가 소식 개수를 공개하지 않습니다 — 스마트플레이스에서 직접 보셔야 합니다')
               : put('p5', news > 0, `소식 ${news}건${src()}`);

  /* ── 리뷰 목록을 직접 세서 판정 ─────────────────────────
     목록을 못 가져오면 예전처럼 직접 확인으로 남긴다.
     표본은 응답에 실려 온 최근 N개뿐이므로 근거에 그 사실을 적는다. */
  const rs = extra.reviews;
  if (rs && rs.n >= 3) {
    put('p9', rs.daysSince <= 30,
        `마지막 리뷰 ${rs.daysSince}일 전 (최근 ${rs.n}개 기준)`);
    /* 0% 는 "답글을 안 단다"일 수도 있고 "응답에 답글 정보가 없다"일 수도 있다.
       둘을 구분할 방법이 없으므로 단정하지 않고 그 사실을 적는다. */
    put('p8', rs.replyRate >= 0.9,
        `최근 리뷰 ${rs.n}개 중 ${rs.replied}개에 답글 (${Math.round(rs.replyRate * 100)}%)`
        + (rs.replied === 0 ? ' — 실제로는 답글을 다시는데 0%로 나온다면 알려주세요 (수집 실패일 수 있습니다)' : ''));
  } else {
    unknown('p9', '리뷰 목록을 가져오지 못했습니다');
    unknown('p8', '리뷰 목록을 가져오지 못해 답글 비율을 세지 못했습니다');
  }

  const ps = extra.photos;
  if (ps && ps.n >= 3) {
    put('p4', ps.daysSince <= 183, `마지막 사진 ${ps.daysSince}일 전 (최근 ${ps.n}장 기준)`);
  } else {
    na('p4', '네이버가 사진 업로드 날짜를 공개하지 않습니다');
  }

  // ── 사람 눈이 있어야만 아는 것 ──────────────────────────
  unknown('p1', '대표사진이 시설 전경인지는 사진을 봐야 압니다');
  unknown('p3', '어느 구역 사진이 있는지는 사진을 봐야 압니다');
  unknown('d1', '지도를 열어 핀이 우리 건물 위에 있는지만 보시면 됩니다 (10초)');

  return J;
}

/* deep=true 는 내 가게용. 리뷰·사진 탭까지 반드시 들러 답글 비율과 갱신 시점을 센다.
   경쟁사 분석에서는 그 항목을 쓰지 않으므로 얕게 훑어 왕복을 줄인다. */
async function collectPlace(idOrUrl, userType, opts = {}) {
  const deep = opts.deep !== false;
  const id = await resolvePlaceId(idOrUrl);
  const attempts = [];
  const data = {};
  const present = new Set();
  const looseCount = new Set();   // 가게 노드 밖에서 주운 개수 항목
  const foundBy = {};             // 이름이 아니라 뜻으로 찾은 항목 (target → 실제 키 이름)
  const numbers = {};             // 가게 노드 안의 숫자 전부 — 못 찾은 값을 추적할 단서
  const links = {};               // 링크 필드 아래에 실제로 있는 주소
  const introCands = [];          // 소개글 후보 (리뷰·예약 안내문과 섞여 온다)
  const jsons = [];
  const sources = [];

  for (const build of PLACE_STRATEGIES) {
    const url = build(id);
    try {
      const r = await get(url);
      const json = tryJson(r.text);
      if (!json) {
        attempts.push({ url, status: r.status, result: 'JSON/상태객체를 찾지 못함', bytes: r.text.length });
        continue;
      }
      const before = Object.keys(data).length;

      /* 이 가게 노드에서 먼저 줍는다. 개수 항목은 여기서 나온 것만 인정한다.
         가게 노드를 못 찾았을 때만 트리 전체를 훑는다 (없는 것보단 낫다). */
      const scoped = scopedNodes(json, id);
      if (scoped.length) {
        /* 소개글은 업체 기본 정보 노드(업체명·카테고리가 같이 있는 곳)에만 있다.
           리뷰 노드에도 description 이라는 이름의 본문이 들어 있어서, 그냥 훑으면
           손님 리뷰가 소개글 자리에 들어온다. 실제로 그런 일이 있었다.
           기본 정보 노드를 찾았다면 소개글은 거기서만 가져온다. */
        /* 소개글 후보를 모아 두고, 어느 것을 쓸지는 전부 모은 뒤에 정한다 */
        collectIntros(scoped, introCands);

        const noIntro = PLACE_FIELDS.filter(f => !TEXT_FROM_BASE.includes(f));
        for (const s of scoped) {
          harvest(s, noIntro, data);
          harvestPresence(s, noIntro, present);
        }
        const fields = noIntro;
        /* 가게 노드에 없는 값은 바깥에서 보충한다. 버리면 진짜 값까지 잃는다.
           다만 개수 항목을 바깥에서 주웠다는 사실은 기억해 두고 근거에 밝힌다. */
        const loose = harvest(json, fields, {});
        for (const [k, v] of Object.entries(loose)) {
          if (isEmptyVal(v) || !isEmptyVal(data[k])) continue;
          data[k] = v;
          if (COUNT_FIELDS.includes(k)) looseCount.add(k);
        }

        /* 가게 노드 안의 숫자를 전부 모아 둔다.
           뜻으로도 못 찾은 값이 있을 때, 어떤 이름으로 오는지 볼 유일한 단서다. */
        for (const node of scoped) collectNumbers(node, numbers);
        collectLinks(scoped, links);

        /* 이름으로 못 찾은 개수는 뜻으로 찾아본다. 가게 노드 안에서만 본다. */
        for (const [target, c] of Object.entries(CONCEPTS)) {
          if (c.alts.some(a => !isEmptyVal(data[a]))) continue;   // 정확한 이름으로 이미 잡혔다
          for (const node of scoped) {
            const hit = scanNumeric(node, c);
            if (hit) { data[target] = hit.value; foundBy[target] = hit.key; break; }
          }
        }
      } else {
        harvest(json, PLACE_FIELDS, data);
        harvestPresence(json, PLACE_FIELDS, present);
      }

      const gained = Object.keys(data).length - before;
      if (gained <= 0 && before === 0) {
        attempts.push({ url, status: r.status, result: '필드를 찾지 못함', bytes: r.text.length });
        continue;
      }
      jsons.push(json);
      sources.push({ url, gained });

      // 필요한 값이 다 모였으면 남은 주소는 두드리지 않는다.
      // 다만 깊게 볼 때는 리뷰·사진 탭을 한 번은 들러야 답글·갱신 판정이 산다.
      const seen = re => sources.some(x => re.test(x.url));
      const enough = KEY_FIELDS.every(f => (CONCEPTS[f]?.alts || [f]).some(a => !isEmptyVal(data[a])))
        && (!deep || (seen(/review/) && seen(/photo/) && seen(/news|feed/)));
      if (enough) break;
    } catch (e) {
      attempts.push({ url, result: `요청 실패: ${e.message}` });
    }
  }

  /* 후보 중 사장님이 쓴 글로 보이는 것을 고른다. 같은 글이 여러 번 나오므로 중복은 뺀다. */
  const seenIntro = new Set();
  const intros = introCands
    .filter(c => !seenIntro.has(c.text) && seenIntro.add(c.text))
    .sort((a, b) => b.score - a.score);
  if (intros.length && intros[0].score > 0) data.description = intros[0].text;

  const found = Object.keys(data).length;
  if (found < 2) {
    return { ok: false, placeId: id, attempts,
      error: '네이버 응답에서 플레이스 정보를 읽지 못했습니다. 구조가 변경되었을 수 있습니다.' };
  }

  return {
    ok: true, placeId: id,
    source: sources[0].url,
    sources,                       // 어느 주소가 무엇을 보탰는지
    fields: found, data, attempts,
    // 개념 단위로 본다. visitorReviewsTotal 이 있으면 visitorReviewCount 가 없어도 있는 것이다.
    missing: KEY_FIELDS.filter(f =>
      (CONCEPTS[f]?.alts || [f]).every(a => isEmptyVal(data[a]))),
    numbers,
    links,
    foundBy,
    // 사진 수는 이름마다 값이 달라서 어느 것이 '관리자 화면 사진 수'인지 확실하지 않다.
    // 판단 재료를 그대로 넘긴다.
    photoListN: biggestListLen(jsons.filter((_, i) => /photo|image/.test(sources[i]?.url || ''))),
    // 어떤 후보들이 있었는지 보여준다. 고른 것이 틀렸으면 사장님이 바꿀 수 있어야 한다.
    introCandidates: intros.slice(0, 4).map(c => ({ key: c.key, score: Math.round(c.score * 10) / 10,
                                                    len: c.text.length, text: c.text })),
    judge: judgeItems(data, present, userType, {
      loose: looseCount, foundBy, links,
      reviews: listStats(jsons.filter((_, i) => /review/.test(sources[i]?.url || ''))) || listStats(jsons),
      photos: listStats(jsons.filter((_, i) => /photo|image/.test(sources[i]?.url || ''))),
      photoListN: biggestListLen(jsons.filter((_, i) => /photo|image/.test(sources[i]?.url || ''))),
    }),
    derived: deriveInputs(data, jsons),
  };
}

/* ============================================================================
 * 순위 조회
 * ========================================================================== */

const RANK_STRATEGIES = [
  (q, p) => `https://m.map.naver.com/search2/searchMore.naver?query=${encodeURIComponent(q)}&type=SITE&page=${p}&displayCount=50`,
  (q, p) => `https://map.naver.com/p/api/search/allSearch?query=${encodeURIComponent(q)}&type=all&page=${p}`,
  (q, p) => `https://pcmap.place.naver.com/place/list?query=${encodeURIComponent(q)}&page=${p}`,
];

async function findRank(keyword, placeId, maxPages = 3) {
  const attempts = [];

  for (const build of RANK_STRATEGIES) {
    const collected = [];
    let usable = false;

    for (let page = 1; page <= maxPages; page++) {
      const url = build(keyword, page);
      try {
        const r = await get(url);
        const json = tryJson(r.text);
        if (!json) { attempts.push({ url, status: r.status, result: 'JSON 파싱 실패' }); break; }
        const places = harvestPlaces(json);
        if (!places.length) { attempts.push({ url, status: r.status, result: '업체 목록 없음' }); break; }
        usable = true;
        collected.push(...places);
        if (places.length < 10) break;   // 마지막 페이지로 판단
      } catch (e) {
        attempts.push({ url, result: `요청 실패: ${e.message}` });
        break;
      }
    }

    if (usable && collected.length) {
      // 중복 제거하며 순서 유지
      const seen = new Set(), list = [];
      for (const p of collected) if (!seen.has(p.id)) { seen.add(p.id); list.push(p); }

      const idx = list.findIndex(p => p.id === String(placeId));
      return {
        ok: true, keyword, placeId: String(placeId),
        rank: idx >= 0 ? idx + 1 : null,
        scanned: list.length,
        found: idx >= 0,
        top5: list.slice(0, 5).map((p, i) => ({ rank: i + 1, ...p })),
        ranked: list.map((p, i) => ({ rank: i + 1, ...p })),   // 경쟁 분석용 전체 목록
        attempts,
      };
    }
  }

  return { ok: false, keyword, placeId: String(placeId), attempts,
    error: '검색 결과를 읽지 못했습니다. 네이버 응답 구조가 변경되었을 수 있습니다.' };
}

/* ============================================================================
 * 경쟁 분석 — 상위 N곳은 왜 뜨는가
 *
 * 핵심 원칙: 알아낸 격차를 "따라잡을 수 있는 것 / 시간이 걸리는 것 /
 * 못 바꾸는 것" 으로 반드시 나눈다. 섞어서 보여주면 실행할 수 없는 목록이 된다.
 * ========================================================================== */

/* 헬스장 도메인 어휘.
   상위권 소개글에 나오는데 우리에겐 없는 표현을 찾아낸다.
   형태소 분석기 없이도 정확도가 높고, 바로 실행 가능한 결과가 나온다. */
const GYM_LEXICON = {
  '시설':   ['무료주차','주차','샤워실','샤워','락커','사물함','운동복','수건','사우나','탈의실',
             '파우더룸','정수기','인바디','체성분','안마의자','휴게실','냉난방','환기'],
  '프로그램':['PT','퍼스널트레이닝','개인레슨','그룹운동','GX','필라테스','요가','스피닝','크로스핏',
             '다이어트','바디프로필','체형교정','재활','근력','유산소','식단'],
  '운영조건':['24시간','연중무휴','무인','새벽','야간','주말운영','일일권','1일권','단기','환불',
             '양도','연장','당일등록','무약정'],
  '대상':   ['초보','입문','여성전용','여성','직장인','학생','시니어','1인'],
  '기구':   ['프리웨이트','머신','덤벨','바벨','스미스머신','케이블','런닝머신','트레드밀','사이클','로잉'],
  '신뢰':   ['무료상담','무료체험','체험','상담','경력','자격증','생활스포츠지도사','전문','자세지도'],
};

/* 두 좌표 사이 거리(m) */
function distanceM(x1, y1, x2, y2) {
  const toNum = v => Number(v);
  [x1, y1, x2, y2] = [x1, y1, x2, y2].map(toNum);
  if ([x1, y1, x2, y2].some(v => !isFinite(v) || v === 0)) return null;
  const R = 6371000, rad = d => d * Math.PI / 180;
  const dLat = rad(y2 - y1), dLon = rad(x2 - x1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(y1)) * Math.cos(rad(y2)) * Math.sin(dLon / 2) ** 2;
  return Math.round(2 * R * Math.asin(Math.sqrt(a)));
}

const numOr = (...vals) => { for (const v of vals) { const n = Number(v); if (isFinite(n)) return n; } return null; };

/* 받침 판정 → 조사 선택. 사용자에게 보이는 문장이라 조사가 틀리면 눈에 띈다. */
const EN_BATCHIM = new Set(['l', 'm', 'n', 'r', 'f', 'h', 's', 'x']);
function josa(word, pair) {
  const ch = String(word || '').trim().slice(-1);
  const set = { '은': ['은', '는'], '이': ['이', '가'], '을': ['을', '를'] };
  const [withB, noB] = set[pair] || [pair, pair];
  if (!ch) return noB;
  const code = ch.charCodeAt(0);
  let batchim;
  if (code >= 0xAC00 && code <= 0xD7A3) batchim = (code - 0xAC00) % 28 !== 0;
  else if (/[a-zA-Z]/.test(ch)) batchim = EN_BATCHIM.has(ch.toLowerCase());
  else batchim = false;
  return batchim ? withB : noB;
}

/* 한 업체의 지표를 표준 형태로 정리 */
function toMetrics(data = {}) {
  return {
    introLen : String(data.description || '').trim().length,
    review   : numOr(data.visitorReviewCount, data.totalReviewCount),
    blog     : numOr(data.blogCafeReviewCount),
    photo    : numOr(data.imageCount, data.photoCount),
    save     : numOr(data.bookmarkCount),
    score    : numOr(data.visitorReviewScore),
    booking  : Boolean(data.bookingUrl || data.talktalkUrl),
    homepage : Boolean(data.homepage),
    x        : data.x, y: data.y,
    intro    : String(data.description || ''),
    name     : String(data.name || ''),
    category : String(data.category || ''),
  };
}

/* 상위권이 공통으로 쓰는데 우리에겐 없는 표현 */
function lexiconGap(mineIntro, rivalIntros) {
  const mine = mineIntro.replace(/\s+/g, '').toLowerCase();
  const rivals = rivalIntros.map(t => t.replace(/\s+/g, '').toLowerCase());
  const out = [];

  for (const [cat, terms] of Object.entries(GYM_LEXICON)) {
    for (const term of terms) {
      const t = term.toLowerCase();
      const usedBy = rivals.filter(r => r.includes(t)).length;
      if (usedBy < 2) continue;                 // 상위권 2곳 이상이 쓸 때만 신호로 본다
      const inMine = mine.includes(t);
      out.push({ term, category: cat, usedBy, total: rivals.length, inMine });
    }
  }
  // 부분 문자열 흡수 — "무료주차"가 있으면 "주차"는 버린다.
  // 긴 표현을 넣으면 짧은 쪽은 자동으로 충족되므로, 둘 다 보여주면 할 일이 부풀려 보인다.
  const absorbed = out.filter(a =>
    !out.some(b => b !== a && b.inMine === a.inMine && b.term.length > a.term.length
                && b.term.toLowerCase().includes(a.term.toLowerCase())));

  // 우리에게 없는 것 먼저, 많이 쓰이는 것 먼저
  return absorbed.sort((a, b) => (a.inMine - b.inMine) || (b.usedBy - a.usedBy));
}

/* 지표 비교표 */
function buildComparison(mine, rivals) {
  const SPEC = [
    { key:'introLen', label:'소개글 길이',   unit:'자',  higher:true,  axis:'R' },
    { key:'review',   label:'방문자 리뷰',   unit:'개',  higher:true,  axis:'P' },
    { key:'blog',     label:'블로그 리뷰',   unit:'개',  higher:true,  axis:'P' },
    { key:'photo',    label:'사진',         unit:'장',  higher:true,  axis:'P' },
    { key:'save',     label:'저장',         unit:'회',  higher:true,  axis:'P' },
    { key:'score',    label:'평점',         unit:'점',  higher:true,  axis:'P' },
  ];

  return SPEC.map(s => {
    const vals = rivals.map(r => r.m[s.key]).filter(v => v != null);
    if (!vals.length || mine[s.key] == null) {
      return { ...s, mine: mine[s.key], rivals: rivals.map(r => r.m[s.key]), unknown: true };
    }
    const min = Math.min(...vals);           // 3위 안에 들기 위한 최소선
    const max = Math.max(...vals);
    const gap = Math.round((min - mine[s.key]) * 10) / 10;
    return {
      ...s,
      mine: mine[s.key],
      rivals: rivals.map(r => r.m[s.key]),
      min, max,
      gap: gap > 0 ? gap : 0,
      behind: gap > 0,
    };
  });
}

/* 어느 축에서 지고 있는가 */
function axisVerdict(comparison, distance, kwHit) {
  const behindIn = ax => comparison.filter(c => c.axis === ax && c.behind).length;
  const v = {};

  v.R = {
    name: '적합도',
    lose: behindIn('R') > 0 || !kwHit,
    note: !kwHit
      ? '목표 키워드가 내 소개글에 제대로 안 들어가 있습니다. 상위권과의 격차 이전에 매칭 자체가 안 되는 상태입니다.'
      : behindIn('R') > 0
        ? '키워드는 들어가 있지만 소개글 분량이 상위권보다 적습니다. 검색어와 매칭될 표면적이 좁습니다.'
        : '적합도에서는 상위권과 대등하거나 앞섭니다.',
  };

  const pBehind = comparison.filter(c => c.axis === 'P' && c.behind);
  v.P = {
    name: '인기도',
    lose: pBehind.length > 0,
    note: pBehind.length
      ? `${pBehind.map(c => c.label).join(', ')}에서 상위권에 밀립니다. 이 지표들은 손님이 만드는 결과라 하루아침에 못 뒤집습니다.`
      : '인기도 지표는 상위권과 대등하거나 앞섭니다.',
  };

  v.D = {
    name: '거리',
    lose: distance.mine != null && distance.rivalAvg != null && distance.mine > distance.rivalAvg * 1.5,
    note: distance.mine == null
      ? '좌표를 가져오지 못해 거리 비교를 하지 못했습니다.'
      : distance.mine > (distance.rivalAvg || 0) * 1.5
        ? `상위권은 검색 중심에서 평균 ${distance.rivalAvg}m인데 우리는 ${distance.mine}m입니다. 거리는 바꿀 수 없는 조건이라, 이 키워드는 구조적으로 불리합니다.`
        : `검색 중심에서 ${distance.mine}m로 상위권(평균 ${distance.rivalAvg}m)과 비슷합니다. 거리는 불리하지 않습니다.`,
  };

  return v;
}

/* 실행안 — 반드시 실행 가능성으로 나눈다 */
function buildActions(comparison, gaps, verdict, distance, keyword) {
  const now = [], slow = [], cant = [];

  const introCmp = comparison.find(c => c.key === 'introLen');
  if (introCmp?.behind) {
    now.push(`소개글을 ${introCmp.min}자 이상으로 늘리세요. 상위 3곳 중 가장 짧은 곳이 ${introCmp.min}자입니다 (현재 ${introCmp.mine}자).`);
  }

  const missing = gaps.filter(g => !g.inMine);
  if (missing.length) {
    const top = missing.slice(0, 8);
    now.push(`상위권이 공통으로 쓰는데 우리 소개글엔 없는 표현 ${missing.length}개를 넣으세요. 우선순위: ${top.map(g => `${g.term}(${g.usedBy}/${g.total}곳)`).join(', ')}`);
  }
  if (!verdict.R.lose && !missing.length) {
    now.push('적합도 쪽은 이미 상위권 수준입니다. 여기서 더 밀어붙이기보다 인기도 쪽에 시간을 쓰세요.');
  }

  for (const c of comparison.filter(x => x.axis === 'P' && x.behind)) {
    if (c.key === 'photo') {
      now.push(`사진을 ${c.gap}장 더 올리세요. 상위권 최소가 ${c.min}장입니다. 사진은 오늘 바로 채울 수 있는 인기도 항목입니다.`);
    } else if (c.key === 'review' || c.key === 'blog') {
      slow.push(`${c.label} ${c.gap}개 부족합니다 (상위권 최소 ${c.min}개). 자연 유입으로만 채워야 하므로 몇 달 단위로 봐야 합니다. 구매는 제재 대상입니다.`);
    } else if (c.key === 'save') {
      slow.push(`저장 ${c.gap}회 부족합니다. 소식·이벤트를 꾸준히 올려 자연 저장을 늘리는 것 말고 안전한 방법이 없습니다.`);
    } else if (c.key === 'score') {
      slow.push(`평점이 상위권보다 ${c.gap}점 낮습니다. 불만 리뷰에 성실히 답하고 실제 불편 요인을 없애는 것 외엔 방법이 없습니다.`);
    }
  }

  if (verdict.D.lose) {
    cant.push(`거리는 바꿀 수 없습니다. 상위권은 검색 중심에서 평균 ${distance.rivalAvg}m인데 우리는 ${distance.mine}m입니다. `
      + `"${keyword}"${josa(keyword, '은')} 이 위치에서 구조적으로 불리한 키워드라, 다른 항목을 다 채워도 상위권 진입이 어려울 수 있습니다. `
      + `우리 가게가 중심이 되는 키워드(더 가까운 동네·역 이름)를 1순위로 바꾸는 편이 현실적입니다.`);
  }

  return { now, slow, cant };
}

async function analyzeCompetitors(keyword, myUrl, topN = 3) {
  const myId = await resolvePlaceId(myUrl);

  const rankRes = await findRank(keyword, myId);
  if (!rankRes.ok) return { ok: false, stage: 'rank', error: rankRes.error, attempts: rankRes.attempts };

  const top = (rankRes.ranked || []).slice(0, topN).filter(p => p.id !== myId);
  if (!top.length) return { ok: false, stage: 'rank', error: '상위 업체 목록을 얻지 못했습니다.' };

  // 내 정보 + 경쟁사 정보 (네이버에 부담을 주지 않도록 순차 요청)
  const myPlace = await collectPlace(myId);
  if (!myPlace.ok) return { ok: false, stage: 'place', error: '내 플레이스 정보를 가져오지 못했습니다.', attempts: myPlace.attempts };

  const rivals = [];
  for (const p of top) {
    await new Promise(r => setTimeout(r, 300));
    const c = await collectPlace(p.id, undefined, { deep: false });
    rivals.push({ rank: p.rank, id: p.id, name: p.name, ok: c.ok, m: c.ok ? toMetrics(c.data) : {} });
  }

  const usable = rivals.filter(r => r.ok);
  if (!usable.length) return { ok: false, stage: 'rivals', error: '상위 업체 정보를 하나도 가져오지 못했습니다.' };

  const mine = toMetrics(myPlace.data);

  // 검색 중심을 상위권 좌표의 중심으로 추정한다.
  // 네이버의 실제 검색 좌표는 알 수 없지만, 상위권이 몰려 있는 지점이 곧 그 키워드의 중심이다.
  const pts = usable.filter(r => r.m.x && r.m.y);
  let distance = { mine: null, rivalAvg: null, rivals: [] };
  if (pts.length) {
    const cx = pts.reduce((a, r) => a + Number(r.m.x), 0) / pts.length;
    const cy = pts.reduce((a, r) => a + Number(r.m.y), 0) / pts.length;
    distance.rivals = pts.map(r => ({ rank: r.rank, d: distanceM(cx, cy, r.m.x, r.m.y) }));
    const ds = distance.rivals.map(r => r.d).filter(d => d != null);
    distance.rivalAvg = ds.length ? Math.round(ds.reduce((a, b) => a + b, 0) / ds.length) : null;
    distance.mine = distanceM(cx, cy, mine.x, mine.y);
  }

  const comparison = buildComparison(mine, usable);
  const gaps = lexiconGap(mine.intro, usable.map(r => r.m.intro));

  const kwNorm = keyword.replace(/\s+/g, '').toLowerCase();
  const kwHit = mine.intro.replace(/\s+/g, '').toLowerCase().includes(kwNorm);

  const verdict = axisVerdict(comparison, distance, kwHit);
  const actions = buildActions(comparison, gaps, verdict, distance, keyword);

  return {
    ok: true, keyword, myRank: rankRes.rank, myId,
    mine: { name: mine.name, category: mine.category, ...comparison.reduce((o, c) => (o[c.key] = c.mine, o), {}) },
    rivals: usable.map(r => ({
      rank: r.rank, name: r.name, category: r.m.category,
      introLen: r.m.introLen, review: r.m.review, blog: r.m.blog,
      photo: r.m.photo, save: r.m.save, score: r.m.score,
      booking: r.m.booking, homepage: r.m.homepage,
    })),
    comparison, gaps, distance, verdict, actions,
    failedRivals: rivals.filter(r => !r.ok).map(r => ({ rank: r.rank, name: r.name })),
  };
}

/* ============================================================================
 * 순위 기록 저장
 * ========================================================================== */

function readHistory() {
  try { return JSON.parse(fs.readFileSync(HISTORY, 'utf8')); }
  catch { return { records: [] }; }
}

function appendHistory(rec) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const h = readHistory();
  h.records.push({ ts: new Date().toISOString(), ...rec });
  // 최근 2000건만 유지
  if (h.records.length > 2000) h.records = h.records.slice(-2000);
  fs.writeFileSync(HISTORY, JSON.stringify(h, null, 2));
  return h.records.length;
}

/* ============================================================================
 * Claude API 프록시 — 키를 브라우저에 노출하지 않는다
 * ========================================================================== */

async function aiProxy(body) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('ANTHROPIC_API_KEY 환경변수가 설정되어 있지 않습니다.');
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, text: await res.text() };
}

/* ============================================================================
 * 서버
 * ========================================================================== */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
               '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8',
                        'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function readSaves() {
  try { const v = JSON.parse(fs.readFileSync(SAVES, 'utf8')); return Array.isArray(v) ? v : []; }
  catch { return []; }
}
function writeSaves(list) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(SAVES, JSON.stringify(list));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let d = '';
    req.on('data', c => { d += c; if (d.length > 5e6) reject(new Error('요청이 너무 큽니다')); });
    req.on('end', () => resolve(d));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);
  const q = u.searchParams;

  try {
    /* ---- API ---- */
    // 외부 기기(휴대폰 등)는 접근 키가 있어야 API를 쓸 수 있다. 이 PC에서는 그냥 통과.
    if (u.pathname.startsWith('/api/') && !isLocal(req)) {
      const given = q.get('k') || req.headers['x-access-key'];
      if (given !== KEY) {
        return sendJson(res, 401, { ok: false, error: '접근 키가 없거나 틀렸습니다. PC 화면에 표시된 주소로 다시 접속하세요.' });
      }
    }

    if (u.pathname === '/api/health') {
      const ip = lanIp();
      return sendJson(res, 200, {
        ok: true, version: 2,
        ai: Boolean(process.env.ANTHROPIC_API_KEY),
        lanUrl: ip ? `http://${ip}:${PORT}/#k=${KEY}` : null,
      });
    }

    if (u.pathname === '/api/place') {
      const target = q.get('url');
      if (!target) return sendJson(res, 400, { ok: false, error: 'url 파라미터가 필요합니다.' });
      return sendJson(res, 200, await collectPlace(target, q.get('type')));
    }

    if (u.pathname === '/api/rank') {
      const kw = q.get('keyword'), target = q.get('url');
      if (!kw || !target) return sendJson(res, 400, { ok: false, error: 'keyword, url 파라미터가 필요합니다.' });
      const placeId = await resolvePlaceId(target);
      const r = await findRank(kw, placeId, Number(q.get('pages') || 3));
      if (r.ok && q.get('save') !== '0') {
        appendHistory({ keyword: kw, placeId, rank: r.rank, scanned: r.scanned });
      }
      return sendJson(res, 200, r);
    }

    if (u.pathname === '/api/competitors') {
      const kw = q.get('keyword'), target = q.get('url');
      if (!kw || !target) return sendJson(res, 400, { ok: false, error: 'keyword, url 파라미터가 필요합니다.' });
      return sendJson(res, 200, await analyzeCompetitors(kw, target, Number(q.get('top') || 3)));
    }

    if (u.pathname === '/api/history') {
      const kw = q.get('keyword');
      const all = readHistory().records;
      return sendJson(res, 200, { ok: true, records: kw ? all.filter(r => r.keyword === kw) : all });
    }

    /* ---- 기기 사이 공유 저장 ----
       체크·대표키워드·개선 기록을 서버에 둔다. 그래야 폰에서 체크한 것이
       PC 에서도 그대로 보인다.

       무료 요금제는 배포할 때마다 디스크가 지워진다. 그래서 서버를 유일한
       원본으로 삼지 않는다. 각 기기도 자기 사본을 갖고 있다가, 서버 것이
       사라졌으면 다시 올려 준다. 어느 쪽이 최신인지는 저장 시각으로 가른다. */
    if (u.pathname === '/api/state') {
      if (req.method === 'GET') {
        try { return sendJson(res, 200, { ok: true, state: JSON.parse(fs.readFileSync(STATE, 'utf8')) }); }
        catch { return sendJson(res, 200, { ok: true, state: null }); }
      }
      if (req.method === 'PUT') {
        const body = JSON.parse(await readBody(req));
        if (!body || typeof body !== 'object') return sendJson(res, 400, { ok: false, error: '형식 오류' });
        fs.mkdirSync(DATA_DIR, { recursive: true });
        fs.writeFileSync(STATE, JSON.stringify(body));
        return sendJson(res, 200, { ok: true, at: body.at || null });
      }
      if (req.method === 'DELETE') {
        try { fs.unlinkSync(STATE); } catch {}
        return sendJson(res, 200, { ok: true });
      }
    }

    /* ---- 저장 내역 ----
       지금 상태 하나만 이어 쓰는 것과, 시점을 남겨 두고 되돌아가는 것은 다른 일이다.
       소개글을 고치기 전 상태, 사진을 올리기 전 상태를 남겨 두면 무엇이 달라졌는지 본다. */
    if (u.pathname === '/api/saves') {
      const list = readSaves();
      if (req.method === 'GET') {
        const id = q.get('id');
        if (id) {
          const hit = list.find(x => x.id === id);
          return hit ? sendJson(res, 200, { ok: true, save: hit })
                     : sendJson(res, 404, { ok: false, error: '없는 기록입니다' });
        }
        // 목록에는 본문을 빼고 보낸다 — 개수가 쌓여도 가볍게
        return sendJson(res, 200, { ok: true,
          saves: list.map(({ snap, ...meta }) => meta).reverse() });
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req));
        if (!body || !body.snap) return sendJson(res, 400, { ok: false, error: '내용이 없습니다' });
        const entry = {
          id: 's' + Date.now().toString(36),
          place: String(body.place || '').slice(0, 40),   // 같은 가게를 알아보는 열쇠
          name: String(body.name || '').slice(0, 60) || '이름 없음',
          at: body.at || new Date().toISOString(),
          score: Number.isFinite(Number(body.score)) ? Number(body.score) : null,
          keyword: String(body.keyword || '').slice(0, 60),
          snap: body.snap,
        };
        /* 같은 가게는 가장 최근 것 하나만 남긴다. 시점별 비교는 순위 기록과
           개선 기록이 따로 담당하므로, 여기에 같은 가게가 쌓이면 찾기만 어려워진다. */
        const key = entry.place || entry.name;
        const kept = list.filter(x => (x.place || x.name) !== key);
        writeSaves([...kept, entry].slice(-50));
        return sendJson(res, 200, { ok: true, id: entry.id });
      }
      if (req.method === 'DELETE') {
        const id = q.get('id');
        writeSaves(list.filter(x => x.id !== id));
        return sendJson(res, 200, { ok: true });
      }
    }

    if (u.pathname === '/api/ai' && req.method === 'POST') {
      const out = await aiProxy(JSON.parse(await readBody(req)));
      res.writeHead(out.status, { 'content-type': 'application/json; charset=utf-8' });
      return res.end(out.text);
    }

    /* ---- 정적 파일 ---- */
    let rel = u.pathname === '/' ? '/index.html' : u.pathname;
    const file = path.join(ROOT, path.normalize(rel).replace(/^(\.\.[/\\])+/, ''));
    if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('forbidden'); }
    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) { res.writeHead(404); return res.end('not found'); }

    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);

  } catch (e) {
    sendJson(res, 500, { ok: false, error: e.message });
  }
});

/* ============================================================================
 * --probe : 네이버 응답이 아직 살아있는지 점검
 * ========================================================================== */

async function probe(keyword, placeUrl) {
  const line = s => console.log(s);

  /* URL이 없으면 점검할 게 없다. 조용히 빈 결과를 내지 말고 이유를 말한다. */
  if (!placeUrl) {
    console.error('\n❌ 플레이스 URL을 받지 못했습니다. 점검할 대상이 없어 아무것도 실행하지 않았습니다.\n');
    console.error('  사용법  node server.js --probe "키워드" "플레이스URL"');
    console.error('  예시    node server.js --probe "쌍용동 헬스장" "https://naver.me/xq3KrZES"\n');
    console.error('  ⚠ 키워드와 URL 사이에 공백을 반드시 넣으세요.');
    console.error('     "키워드""URL" 처럼 붙여 쓰면 PowerShell이 둘을 한 덩어리로 합칩니다.');
    if (keyword) console.error(`\n  이번에 받은 값: ${JSON.stringify(keyword)}`);
    console.error('');
    process.exitCode = 1;
    return;
  }

  line('\n네이버 응답 점검\n' + '='.repeat(56));
  line(`  대상 URL : ${placeUrl}`);
  line(`  키워드   : ${keyword || '(없음 — 순위 조회는 건너뜁니다)'}`);

  /* ID 확인을 따로 떼어 놓는다. 여기서 막히면 뒤 단계는 의미가 없고,
     단축링크가 안 열린 것과 네이버가 응답을 바꾼 것은 완전히 다른 문제다. */
  line('\n[0] 플레이스 ID 확인');
  let id;
  try {
    id = await resolvePlaceId(placeUrl);
    line(`  ✅ ${id}`);
  } catch (e) {
    line(`  ❌ ${e.message}`);
    if (/naver\.me/.test(placeUrl)) {
      try {
        const r = await get(placeUrl);
        line(`     단축링크 응답: HTTP ${r.status} → ${r.url}`);
      } catch (e2) {
        line(`     단축링크 요청 자체가 실패: ${e2.message}`);
      }
      line('     👉 단축링크(naver.me)가 실제 주소로 넘어가지 않았습니다.');
      line('        네이버 지도에서 내 가게를 열고, 브라우저 주소창의 긴 주소를');
      line('        (map.naver.com/p/entry/place/숫자) 그대로 넣어 다시 실행해 보세요.');
    }
    line('\n' + '='.repeat(56) + '\n');
    process.exitCode = 1;
    return;
  }

  {
    line('\n[1] 플레이스 정보 수집');
    const r = await collectPlace(id);
    if (r.ok) {
      line(`  ✅ 성공 — ${r.source}`);
      line(`  수집 필드 ${r.fields}개:`);
      for (const [k, v] of Object.entries(r.data)) {
        line(`     ${k.padEnd(22)} ${String(v).slice(0, 60)}`);
      }
    } else {
      line(`  ❌ 실패 — ${r.error}`);
    }
    if (r.attempts.length) {
      line('  시도 내역:');
      r.attempts.forEach(a => line(`     ${a.result} ← ${a.url || ''} ${a.status ? '(HTTP ' + a.status + ')' : ''}`));
    }
    /* 못 가져온 값이 있으면, 네이버가 준 숫자를 전부 보여준다.
       그 안에 다른 이름으로 들어 있을 수 있고, 그게 이름을 맞출 유일한 단서다. */
    if (r.ok && r.missing?.length) {
      line(`  ⚠ 못 가져온 값: ${r.missing.join(', ')}`);
      const nums = Object.entries(r.numbers || {});
      if (nums.length) {
        line(`  네이버가 준 숫자 ${nums.length}개 (이 중에 있을 수 있습니다):`);
        nums.sort(([a], [b]) => a.localeCompare(b))
            .forEach(([k, v]) => line(`     ${k.padEnd(28)} ${v}`));
      }
    }
  }

  if (keyword) {
    line(`\n[2] 순위 조회 — "${keyword}"`);
    const r = await findRank(keyword, id);
    if (r.ok) {
      line(`  ✅ 성공 — ${r.scanned}개 업체 스캔`);
      line(r.found ? `  내 순위: ${r.rank}위` : '  내 가게가 스캔 범위 안에 없습니다 (더 뒤에 있거나 노출 제외)');
      line('  상위 5곳:');
      r.top5.forEach(p => line(`     ${String(p.rank).padStart(2)}. ${p.name}`));
    } else {
      line(`  ❌ 실패 — ${r.error}`);
    }
    if (r.attempts.length) {
      line('  시도 내역:');
      r.attempts.forEach(a => line(`     ${a.result} ← ${a.url || ''} ${a.status ? '(HTTP ' + a.status + ')' : ''}`));
    }
  }

  line('\n' + '='.repeat(56));
  line('실패했다면 위 "시도 내역"을 그대로 알려주시면 파서를 맞춰 드립니다.\n');
}

/* ============================================================================
 * --dump : 응답 안에 실제로 무엇이 들어있는지 지문을 뜬다
 *
 * --probe 는 "못 읽었다"까지만 알려준다. 왜 못 읽었는지는 응답 본문을 봐야 하는데,
 * 본문은 수십만 자라서 그대로 옮길 수가 없다. 그래서 판단에 필요한 것만 추린다.
 * 전문은 data/dump/ 에 저장하니 필요하면 파일로 보내면 된다.
 * ========================================================================== */

const DUMP_DIR = path.join(DATA_DIR, 'dump');

function fingerprint(label, url, r) {
  const t = r.text || '';
  const line = s => console.log(s);
  line(`\n${label}  ${url}`);
  line(`   HTTP ${r.status} · ${t.length.toLocaleString('en-US')}자`);

  if (!t.length) { line('   ⚠ 본문이 비어 있습니다'); return; }

  // 로봇 차단 페이지인지
  const blocked = /captcha|자동입력|로봇이 아닙니다|비정상적인 접근|접근이 차단/i.test(t);
  if (blocked) line('   🚫 차단/캡차 문구가 보입니다');

  // 어떤 상태 변수를 쓰고 있나
  const vars = [...new Set([...t.matchAll(/window\.__([A-Z0-9_]+)__\s*=/g)].map(m => m[1]))];
  line(`   window.__변수__ : ${vars.length ? vars.join(', ') : '없음'}`);

  const ids = [...new Set([...t.matchAll(/<script[^>]*\bid=["']([^"']+)["']/g)].map(m => m[1]))];
  line(`   <script id>     : ${ids.length ? ids.slice(0, 8).join(', ') : '없음'}`);

  const jsonTags = (t.match(/<script[^>]*type=["']application\/json["']/g) || []).length;
  line(`   JSON script 태그: ${jsonTags}개`);

  // 우리 파서가 지금 성공하는지
  const json = tryJson(t);
  if (json) {
    const got = harvest(json, PLACE_FIELDS);
    line(`   ✅ 파서 추출 성공 — 필드 ${Object.keys(got).length}개: ${Object.keys(got).join(', ') || '(없음)'}`);
  } else {
    line('   ❌ 파서 추출 실패');
  }

  // 파서와 무관하게, 필드 이름이 본문에 원문으로 있는지
  // 있다면 컨테이너만 못 찾는 것이고, 없다면 데이터가 애초에 이 응답에 없다는 뜻이다
  const hits = [];
  for (const f of ['name', 'description', 'visitorReviewCount', 'blogCafeReviewCount',
                   'imageCount', 'bookmarkCount', 'roadAddress', 'category', 'keywords']) {
    const n = (t.match(new RegExp(`["']${f}["']`, 'g')) || []).length;
    if (n) hits.push(`${f}(${n})`);
  }
  line(`   필드명 원문 등장 : ${hits.length ? hits.join(' ') : '없음 — 이 응답에는 데이터가 없습니다'}`);

  const sample = t.slice(0, 160).replace(/\s+/g, ' ');
  line(`   앞부분          : ${sample}`);

  try {
    fs.mkdirSync(DUMP_DIR, { recursive: true });
    const safe = label.replace(/[^\w가-힣]/g, '') + '-' + new URL(url).hostname + '.txt';
    fs.writeFileSync(path.join(DUMP_DIR, safe), t);
    line(`   전문 저장       : data/dump/${safe}`);
  } catch (e) {
    line(`   전문 저장 실패   : ${e.message}`);
  }
}

async function dump(keyword, placeUrl) {
  if (!placeUrl) {
    console.error('\n사용법  node server.js --dump "키워드" "플레이스URL"\n');
    process.exitCode = 1;
    return;
  }
  console.log('\n네이버 응답 지문\n' + '='.repeat(56));

  let id;
  try { id = await resolvePlaceId(placeUrl); }
  catch (e) { console.error(`\n❌ 플레이스 ID 확인 실패 — ${e.message}\n`); process.exitCode = 1; return; }
  console.log(`  플레이스 ID : ${id}`);

  console.log('\n── 플레이스 정보 ' + '─'.repeat(40));
  for (let i = 0; i < PLACE_STRATEGIES.length; i++) {
    const url = PLACE_STRATEGIES[i](id);
    try { fingerprint(`정보${i + 1}`, url, await get(url)); }
    catch (e) { console.log(`\n정보${i + 1}  ${url}\n   ❌ 요청 실패 — ${e.message}`); }
  }

  if (keyword) {
    console.log('\n── 검색 결과 ' + '─'.repeat(43));
    for (let i = 0; i < RANK_STRATEGIES.length; i++) {
      const url = RANK_STRATEGIES[i](keyword, 1);
      try { fingerprint(`검색${i + 1}`, url, await get(url)); }
      catch (e) { console.log(`\n검색${i + 1}  ${url}\n   ❌ 요청 실패 — ${e.message}`); }
    }
  }

  console.log('\n' + '='.repeat(56));
  console.log('위 지문을 그대로 알려주시면 파서를 응답 구조에 맞춰 고칠 수 있습니다.');
  console.log('전문은 data/dump/ 에 저장되어 있습니다 (git 에 올라가지 않습니다).\n');
}

/* ============================================================================
 * 진입점
 * ========================================================================== */

/* --track "키워드" <URL> : 순위만 한 번 기록하고 끝낸다.
   윈도우 작업 스케줄러나 macOS cron 에 걸어두면 매일 알아서 쌓인다. */
async function track(keyword, url) {
  const id = await resolvePlaceId(url);
  const r = await findRank(keyword, id);
  const stamp = new Date().toISOString().slice(0, 16).replace('T', ' ');
  if (!r.ok) { console.error(`[${stamp}] 실패 — ${r.error}`); process.exit(1); }
  appendHistory({ keyword, placeId: id, rank: r.rank, scanned: r.scanned });
  console.log(`[${stamp}] "${keyword}" → ${r.found ? r.rank + '위' : `${r.scanned}위 밖`}`);
}

/* PowerShell에서 "키워드""URL" 처럼 공백 없이 붙여 넣으면 셸이 둘을 한 인자로 합친다.
   흔한 실수라서, 붙은 자리를 찾아 갈라 주고 그렇게 했다고 알려 준다. */
function splitArgs(rest) {
  const parts = rest.map(a => String(a)).filter(a => a.trim() !== '');
  if (parts.length >= 2) return { keyword: parts[0].trim(), url: parts[1].trim() };

  const one = parts[0] || '';
  const at = one.search(/https?:\/\/|naver\.me|map\.naver\.com/);
  if (at > 0) {
    const split = { keyword: one.slice(0, at).trim(), url: one.slice(at).trim() };
    console.error(`\n⚠ 키워드와 URL이 공백 없이 붙어 있었습니다. 이렇게 나눠서 진행합니다:`);
    console.error(`   키워드 ${JSON.stringify(split.keyword)}`);
    console.error(`   URL    ${JSON.stringify(split.url)}`);
    return split;
  }
  return { keyword: one.trim(), url: '' };
}

const argv = process.argv;
if (argv.includes('--probe')) {
  const a = splitArgs(argv.slice(argv.indexOf('--probe') + 1));
  probe(a.keyword, a.url).catch(e => { console.error('오류:', e.message); process.exit(1); });

} else if (argv.includes('--dump')) {
  const a = splitArgs(argv.slice(argv.indexOf('--dump') + 1));
  dump(a.keyword, a.url).catch(e => { console.error('오류:', e.message); process.exit(1); });

} else if (argv.includes('--track')) {
  const a = splitArgs(argv.slice(argv.indexOf('--track') + 1));
  if (!a.keyword || !a.url) { console.error('사용법: node server.js --track "키워드" "플레이스URL"'); process.exit(1); }
  track(a.keyword, a.url).catch(e => { console.error('오류:', e.message); process.exit(1); });

} else {
  server.listen(PORT, HOST, () => {
    const ip = lanIp();
    console.log(`\n  헬스장 플레이스 진단 서버\n`);
    console.log(`  이 PC에서       http://localhost:${PORT}`);
    if (ip) {
      console.log(`  휴대폰에서      http://${ip}:${PORT}/#k=${KEY}`);
      console.log(`                  (같은 와이파이에 연결한 뒤 위 주소로 접속 → 북마크해두면 끝)`);
    } else {
      console.log(`  휴대폰 접속용 주소를 찾지 못했습니다 (네트워크 연결을 확인하세요)`);
    }
    console.log(`\n  AI 프록시       ${process.env.ANTHROPIC_API_KEY ? '사용 가능' : '꺼짐 (ANTHROPIC_API_KEY 미설정)'}`);
    console.log(`  순위 기록       ${HISTORY}`);
    console.log(`\n  응답 점검       node server.js --probe "강남역 헬스장" <플레이스URL>`);
    console.log(`  순위만 기록     node server.js --track "강남역 헬스장" <플레이스URL>`);
    console.log(`\n  종료하려면 Ctrl+C\n`);
  });
}
