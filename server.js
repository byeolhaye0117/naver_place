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

const PORT     = Number(process.env.PORT || 5173);
const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const HISTORY  = path.join(DATA_DIR, 'rank-history.json');

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

function tryJson(text) {
  try { return JSON.parse(text); } catch { /* not json */ }
  // HTML 안에 박혀 있는 상태 객체를 꺼내본다 (네이버는 __APOLLO_STATE__ 를 자주 쓴다)
  const patterns = [
    /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/,
    /window\.__PLACE_STATE__\s*=\s*(\{[\s\S]*?\})\s*;?\s*<\/script>/,
    /__NEXT_DATA__[^>]*>\s*(\{[\s\S]*?\})\s*<\/script>/,
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (m) { try { return JSON.parse(m[1]); } catch { /* keep trying */ } }
  }
  return null;
}

/* 트리 전체를 훑어 원하는 필드명의 값을 주워담는다.
   경로가 바뀌어도 필드명만 남아 있으면 계속 동작한다. */
function harvest(node, fields, out = {}, depth = 0) {
  if (!node || typeof node !== 'object' || depth > 12) return out;
  for (const [k, v] of Object.entries(node)) {
    if (fields.includes(k) && out[k] === undefined) {
      if (v !== null && typeof v !== 'object') out[k] = v;
      else if (Array.isArray(v)) out[k] = v.length;
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

const PLACE_FIELDS = [
  'name', 'category', 'description', 'phone', 'virtualPhone',
  'visitorReviewCount', 'visitorReviewScore', 'blogCafeReviewCount',
  'totalReviewCount', 'imageCount', 'photoCount', 'bookmarkCount',
  'roadAddress', 'address', 'x', 'y', 'homepage', 'bookingUrl', 'talktalkUrl',
  'businessHours', 'conveniences', 'keywords', 'microReviews',
];

const PLACE_STRATEGIES = [
  id => `https://m.place.naver.com/place/${id}/home`,
  id => `https://pcmap.place.naver.com/place/${id}/home`,
  id => `https://m.place.naver.com/hairshop/${id}/home`,
  id => `https://map.naver.com/p/api/place/summary/${id}`,
];

async function collectPlace(idOrUrl) {
  const id = await resolvePlaceId(idOrUrl);
  const attempts = [];

  for (const build of PLACE_STRATEGIES) {
    const url = build(id);
    try {
      const r = await get(url);
      const json = tryJson(r.text);
      if (!json) {
        attempts.push({ url, status: r.status, result: 'JSON/상태객체를 찾지 못함', bytes: r.text.length });
        continue;
      }
      const data = harvest(json, PLACE_FIELDS);
      const found = Object.keys(data).length;
      if (found < 2) {
        attempts.push({ url, status: r.status, result: `필드 ${found}개만 발견`, bytes: r.text.length });
        continue;
      }
      return { ok: true, placeId: id, source: url, fields: found, data, attempts };
    } catch (e) {
      attempts.push({ url, result: `요청 실패: ${e.message}` });
    }
  }
  return { ok: false, placeId: id, attempts,
    error: '네이버 응답에서 플레이스 정보를 읽지 못했습니다. 구조가 변경되었을 수 있습니다.' };
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
        attempts,
      };
    }
  }

  return { ok: false, keyword, placeId: String(placeId), attempts,
    error: '검색 결과를 읽지 못했습니다. 네이버 응답 구조가 변경되었을 수 있습니다.' };
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
    if (u.pathname === '/api/health') {
      return sendJson(res, 200, { ok: true, version: 1, ai: Boolean(process.env.ANTHROPIC_API_KEY) });
    }

    if (u.pathname === '/api/place') {
      const target = q.get('url');
      if (!target) return sendJson(res, 400, { ok: false, error: 'url 파라미터가 필요합니다.' });
      return sendJson(res, 200, await collectPlace(target));
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

    if (u.pathname === '/api/history') {
      const kw = q.get('keyword');
      const all = readHistory().records;
      return sendJson(res, 200, { ok: true, records: kw ? all.filter(r => r.keyword === kw) : all });
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
  line('\n네이버 응답 점검\n' + '='.repeat(56));

  if (placeUrl) {
    line('\n[1] 플레이스 정보 수집');
    const r = await collectPlace(placeUrl);
    line(`  플레이스 ID : ${r.placeId}`);
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
  }

  if (keyword && placeUrl) {
    line(`\n[2] 순위 조회 — "${keyword}"`);
    const id = await resolvePlaceId(placeUrl);
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
 * 진입점
 * ========================================================================== */

if (process.argv.includes('--probe')) {
  const rest = process.argv.slice(process.argv.indexOf('--probe') + 1);
  probe(rest[0], rest[1]).catch(e => { console.error('오류:', e.message); process.exit(1); });
} else {
  server.listen(PORT, () => {
    console.log(`\n  헬스장 플레이스 진단 서버`);
    console.log(`  → http://localhost:${PORT}\n`);
    console.log(`  AI 프록시: ${process.env.ANTHROPIC_API_KEY ? '사용 가능' : '꺼짐 (ANTHROPIC_API_KEY 미설정)'}`);
    console.log(`  순위 기록: ${HISTORY}\n`);
    console.log(`  응답 점검:  node server.js --probe "강남역 헬스장" <플레이스URL>\n`);
  });
}
