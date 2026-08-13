/* ============================================================================
 * 리뷰 답글 — 지시문 만들기와 점검
 *
 * 지금까지 이 일은 index.html 안, 즉 브라우저에만 있었다. 그래서 대시보드처럼
 * 다른 곳에서 같은 기능을 쓰려면 코드를 한 벌 더 써야 했고, 여기를 고쳐도
 * 그쪽은 옛날 그대로였다.
 *
 * 이 파일은 서버에서 돌린다. /api/reply 가 이걸 쓰고, 대시보드는 그 창구를
 * 부른다. 여기만 고치면 부르는 쪽이 몇 군데든 같이 좋아진다.
 *
 * 브라우저 값(getInfo, window.__place)에 손대지 않는다 — 필요한 재료는
 * 부르는 쪽이 넘긴다. 그래야 서버에서도 돌고, 시험하기도 쉽다.
 * ==========================================================================*/

/* ── 네이버 입력칸이 받아주는 글자 ────────────────────────────
   답글 칸은 소개글 칸과 달리 이모지를 받는다. m.place 에 실제로 달려 있는
   답글에 😊 가 들어 있는 것을 확인했다. 줄 나눔도 살린다. */
const NAVER_ALLOWED =
  /[가-힣ㄱ-ㅎㅏ-ㅣa-zA-Z一-鿿ぁ-ゟ゠-ヿ0-9 \n\r\t\-_()&!\[\],.%+~@*^'/?²℃※<>:]/u;

const EMOJI_OK = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/u;

/* 우리가 만드는 글에서는 아예 안전한 글자로 바꿔서 내보낸다.
   마크다운은 지시문에서 쓰지 말라고 못박아도 AI 가 습관처럼 쓴다.
   네이버 입력칸은 마크다운을 못 읽어서 별표가 글자 그대로 박힌다. */
const SAFE_SWAP = [
  [/[·・]/g, ', '], [/[–—]/g, '-'], [/…/g, '...'],
  [/[“”]/g, "'"], [/[‘’]/g, "'"], [/[→←↑↓]/g, '-'],
  [/[「」『』]/g, ''], [/["]/g, "'"],
  [/\*\*([^*\n]+)\*\*/g, '$1'], [/__([^_\n]+)__/g, '$1'],
  [/(^|\n)#{1,6}\s+/g, '$1'], [/(^|\n)>\s+/g, '$1'],
  [/\*/g, ''],
];

function replySafe(t) {
  let out = (t || '').normalize('NFC');
  SAFE_SWAP.forEach(([re, to]) => { out = out.replace(re, to); });
  return [...out].filter(ch => NAVER_ALLOWED.test(ch) || EMOJI_OK.test(ch)).join('')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]*\n[ \t]*/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* 네이버가 못 받는 글자가 남아 있는가. 이모지는 빼고 본다 */
function replyCharOK(t) {
  return [...String(t)]
    .filter(ch => !EMOJI_OK.test(ch))
    .every(ch => NAVER_ALLOWED.test(ch));
}

const norm = s => (s || '').replace(/\s+/g, '').toLowerCase();

/* ── 손님이 쓴 말을 되받았는가 ────────────────────────────────
   어떤 리뷰에 붙여도 되는 답글은 읽는 사람이 바로 알아본다.
   리뷰에서 뽑은 낱말이 답글에 하나도 없으면 그 답글은 읽지 않고 쓴 것이다. */
const RV_STOP = /^(있|없|하는|해서|그리|그런|정말|너무|진짜|아주|조금|매우|여기|저기|이곳|그곳|좋습|좋아|감사|고맙|합니|했습|해요|이라|위해|같습|것 ?같)/;

function reviewStems(review) {
  const out = new Set();
  String(review || '').replace(/[^가-힣a-zA-Z0-9]/g, ' ').split(/\s+/).forEach(w => {
    const n = [...w].length;
    if (n < 2) return;
    /* 세 글자가 넘으면 조사가 붙은 것으로 보고 앞 두 글자만 쓴다.
       두 글자짜리는 그 자체가 낱말이라 그대로 본다. */
    out.add(n >= 3 ? [...w].slice(0, 2).join('') : w);
  });
  return [...out].filter(w => !RV_STOP.test(w));
}

function hasReviewWord(text, review) {
  return reviewStems(review).some(w => String(text).includes(w));
}

/* ── 지시문 ───────────────────────────────────────────────────
 *
 * 답글은 광고가 아니라 응대다. 그래서 지켜야 할 선을 지시문에 못 박는다.
 * 아래 규칙은 실제로 사고가 났던 것들이다 —
 *  - 없는 시설을 지어내서 방문 첫날 들통난 일
 *  - 별 하나짜리 리뷰에 "기분이 좋습니다"로 시작한 일
 *  - "앞으로도 가격을 올리지 않겠습니다"가 몇 년 뒤 증거가 된 일
 *  - 사과할 자리에 검색어를 심어 티가 난 일
 */
const LENGTH_RULE = {
  짧게: '2~3문장', short: '2~3문장',
  중간: '4~5문장', medium: '4~5문장',
  길게: '6~8문장', long: '6~8문장',
};

const TONE_RULE = {
  정중: '정중하고 단정한 존댓말. 과하게 들뜨지 않는다.',
  친근: '따뜻하고 사람 냄새 나는 존댓말. 딱딱한 표현을 피한다.',
  담백: '군더더기 없이 짧고 깔끔한 존댓말. 미사여구를 쓰지 않는다.',
  사과:
    '먼저 불편을 드린 점을 분명히 사과한다. 변명하거나 반박하지 않는다. ' +
    '무엇을 어떻게 고치겠다는 말을 한 문장 넣는다.',
};

/** 별 셋 이하면 사과 중심이 기본이다 */
function suggestTone(star) {
  return star > 0 && star <= 3 ? '사과' : '정중';
}

/**
 * 리뷰 하나에 맞춘 답글 지시문
 *
 * facts 는 "실제로 확인된 것"만 넣는다. 비면 비었다고 말한다 —
 * 지어내는 것보다 낫다.
 */
function buildReplyPrompt(input) {
  const o = input || {};
  const name = String(o.name || '').trim();
  const area = String(o.area || '').trim();
  const review = String(o.review || '').trim();
  const star = Number(o.star) || 0;
  const tone = TONE_RULE[o.tone] ? o.tone : suggestTone(star);
  const lenRule = LENGTH_RULE[o.length] || LENGTH_RULE.중간;
  const keywords = (Array.isArray(o.keywords) ? o.keywords : []).map(String).filter(Boolean);
  const facts = (Array.isArray(o.facts) ? o.facts : []).map(String).filter(Boolean);
  const near = (Array.isArray(o.landmarks) ? o.landmarks : []).map(String).filter(Boolean);
  const closing = String(o.closing || '').trim();
  const bad = star > 0 && star <= 2;
  const who = name || '우리 가게';

  const L = [];
  L.push(`너는 ${area ? area + '에 있는 ' : ''}${o.type || '헬스장'} 「${who}」의`
    + ' 사장님을 대신해 손님 리뷰에 답글을 쓰는 사람이다.');
  L.push('네이버 플레이스 리뷰에 그대로 올릴 수 있는 답글을 쓴다.');
  L.push('');

  /* 잘 쓴 답글은 순서가 있다. 순서를 안 정해 주면 「감사합니다 + 좋은 말」로만
     채운, 어느 리뷰에 붙여도 되는 글이 나온다. 실제로 그렇게 나왔다. */
  if (bad) {
    L.push('[이 순서로 쓴다]');
    L.push('1. 사과 — 무엇이 불편하셨는지 손님이 쓴 말을 그대로 짚어서.');
    L.push('2. 지금 상태를 짧게. 변명하지 않는다.');
    L.push('3. 무엇을 어떻게 하겠다 — 구체적으로. "확인해 보겠습니다"로 끝내지 않는다.');
    L.push('4. 직접 연락할 길을 연다 (데스크·전화·남겨 주시면).');
  } else {
    L.push('[이 순서로 쓴다]');
    L.push(`1. 인사 — 「${who}」 이름을 넣어 인사한다.`);
    L.push('2. 되받기 — 리뷰에서 손님이 쓴 문장 하나를 그대로 짚어서 받는다.');
    L.push('   예) 리뷰에 "한동안 쉬다가 다시 시작"이라 적혀 있으면 → "한동안 쉬셨다가 다시 시작하셨군요".');
    L.push('   이 문장이 없으면 어떤 리뷰에 붙여도 되는 답글이 된다. 반드시 넣는다.');
    L.push('3. 대응 — 손님이 말한 그 대목에 딱 맞는 [확인된 사실] "하나만" 골라 든다.');
    L.push('   고른 사실이 왜 이 손님에게 좋은지까지 이어서 쓴다. 사실만 적으면 자랑이 된다.');
    L.push('   예) "조용히 혼자" 라고 하셨으면 →');
    L.push('       "웨이트존과 프리웨이트존을 공간부터 나눠 두어서, 혼자 오셔도 기다림 없이');
    L.push('        본인 속도대로 하실 수 있습니다" 처럼 사실 → 그래서 좋은 점 으로 잇는다.');
    L.push('   ※ 시설을 두 개 이상 늘어놓지 않는다. 목록처럼 나열하면 광고문이 된다.');
    L.push('     "A도 있고 B도 있고 C도 있습니다" 는 쓰지 않는다.');
    L.push('4. 다음 — 다음에 오시면 해보시라고 권할 것을 한 가지. [확인된 사실]에 있는 것만.');
    L.push('5. 마무리 — 이 손님에게 하는 한마디로 닫는다.');
    L.push('   리뷰에 적힌 그분의 목표나 상황을 받아서 응원한다. 이모지를 하나 붙여도 좋다.');
    L.push('   "앞으로도 최선을 다하겠습니다" 같은 어느 손님에게나 하는 말로만 닫지 않는다.');
  }
  L.push('');

  L.push('[반드시 지킬 것]');
  L.push('1. 리뷰에 적혀 있지 않은 사실을 절대 만들지 않는다. 특히 아래를 조심한다.');
  L.push('   - 다니신 기간·등록한 상품 (리뷰에 "6개월 회원권"이라고 없으면 쓰지 않는다)');
  L.push('   - 방문 빈도·오래된 관계 ("항상 이용해주셔서", "꾸준히 방문해주시는" 은 리뷰에 근거가 있을 때만)');
  L.push('   - 손님의 이름·나이·성별·직업');
  L.push('   리뷰를 다시 읽고, 거기 적힌 것만 가지고 쓴다.');
  L.push('2. 아래 [확인된 사실]에 없는 시설·행사·할인·직원 이름을 만들지 않는다.');
  L.push('   방문 첫날 들통나고 그게 다시 리뷰로 남는다.');
  L.push('3. 앞날을 약속하지 않는다. 특히 가격은 "앞으로도 올리지 않겠다" 같은 말을 절대 쓰지 않는다.');
  L.push('   답글은 몇 년씩 남고 그대로 증거가 된다.');
  L.push('4. 진행 중인 이벤트·할인·특가를 인용하지 않는다. 답글은 오래 남는데 혜택은 곧 끝난다.');
  L.push('5. 존댓말로 쓴다. 이모지는 없거나 많아도 한 개. 느낌표도 한 개까지.');
  L.push('6. "최고", "1등", "무조건" 같은 단정하는 말을 쓰지 않는다.');
  L.push('7. 다른 손님의 개인정보를 언급하지 않는다.');
  L.push('8. 마크다운(**, #, 목록표시)을 쓰지 않는다. 네이버는 그것을 글자 그대로 보여준다.');
  L.push('');
  L.push('[누구를 위한 글인가] 답글은 리뷰를 쓴 손님보다, 그 답글을 읽을 다음 손님을 위한 것이다.');
  L.push('');

  L.push(facts.length
    ? `[확인된 사실] 실제로 확인된 것이다. 여기 있는 것만 쓴다.\n- ${facts.join('\n- ')}`
    : '[확인된 사실] 아직 하나도 없다. 그러니 시설·프로그램·혜택을 한 마디도 말하지 말고, '
      + '손님이 쓴 말에만 답한다. 없는 것을 지어내느니 짧게 쓰는 편이 낫다.');
  if (near.length) L.push(`[근처] ${near.join(', ')}`);
  L.push('');
  L.push(`[길이] ${lenRule}로 쓴다.`);
  L.push(`[말투] ${TONE_RULE[tone]}`);

  /* 불만 리뷰에는 검색어도 끝인사도 넣지 않는다 — 사과 자리에 광고가 있으면 티가 난다 */
  if (keywords.length && !bad) {
    L.push(`[키워드] 다음 말을 답글 안에 자연스럽게 넣는다: ${keywords.join(', ')}. `
      + '인사말에 업체 이름과 함께 넣으면 자연스럽다. 한 키워드를 두 번 이상 반복하지 않는다.');
  } else {
    L.push('[키워드] 따로 넣을 말은 없다.');
  }
  if (closing && !bad) {
    L.push(`[끝인사] 맨 마지막 문장으로 다음을 그대로 붙인다: ${closing}`);
    L.push('   다만 그 바로 앞에는 이 손님에게 하는 한마디가 있어야 한다. 끝인사로만 닫지 않는다.');
  }
  L.push('');
  L.push('[답하는 방식]');
  L.push('설명 없이 JSON 하나만 답한다. 형태는 이렇다.');
  L.push('{"주제": ["리뷰에서 읽어낸 주제 2~4개"], "답글": "답글 본문"}');
  L.push('주제는 "친절", "시설 청결", "조용한 분위기", "주차 불편" 처럼 짧은 말로 적는다.');
  /* 네이버 답글 칸은 줄 나눔을 그대로 받는다. 한 덩어리로 붙여 놓으면
     읽는 사람이 어디까지가 무슨 얘기인지 몰라 그냥 넘긴다. */
  L.push(o.length === '짧게' || o.length === 'short'
    ? '답글은 한 문단으로 쓴다.'
    : '답글은 문단 세 개로 나눈다. 문단 사이는 빈 줄 하나(\\n\\n)로 띄운다. '
      + '위 [이 순서로 쓴다]의 1~2가 첫 문단, 3이 둘째 문단, 4~5가 셋째 문단이다.');
  L.push('');
  L.push(star ? `손님이 준 별점: 별 ${star}개` : '손님이 준 별점: 알 수 없음');
  L.push('');
  L.push('손님이 남긴 리뷰 — 여기 적힌 것만 사실이다:');
  L.push(review);

  return L.join('\n');
}

/**
 * AI 가 준 답에서 JSON 만 골라낸다
 *
 * "JSON 으로만 답하라"고 시켜도 앞뒤에 설명이 붙어 올 때가 있다.
 * 그때마다 실패로 처리하면 쓰는 사람은 이유를 모른 채 다시 누르게 된다.
 */
function parseReply(text) {
  const t = String(text || '').trim();
  const tries = [t];
  const s = t.indexOf('{'), e = t.lastIndexOf('}');
  if (s >= 0 && e > s) tries.push(t.slice(s, e + 1));
  for (const cand of tries) {
    try {
      const j = JSON.parse(cand);
      if (j && typeof j === 'object') return j;
    } catch { /* 다음 후보 */ }
  }
  return null;
}

/* ── 답글 점검 ────────────────────────────────────────────────
 *
 * 만든 답글을 우리 잣대로 실제로 재 준다. 만들어만 주고 "잘 됐나 보세요"
 * 하는 것과, 무엇이 빠졌는지 짚어 주는 것은 다르다.
 *
 * o 는 { name, keywords } 만 있으면 된다.
 */
function auditReply(text, review, o, star = 5) {
  const t = String(text);
  const info = o || {};
  const K = (Array.isArray(info.keywords) ? info.keywords : []).filter(Boolean);
  const echoed = hasReviewWord(t, review);
  const n = [...t].length;

  /* 지킬 수 있을지 모르는 앞날 약속. 지시문으로 막아 놨지만 AI 가
     습관처럼 쓰기 때문에 여기서 한 번 더 본다. */
  const vow = t.match(/(올리지 않(겠|고)|계속 (유지|확보|지키)|앞으로도 (유지|이대로)|비용이? (나중에 )?붙는 일은 없|그날 안에|영원히|절대 안 올)/g) || [];

  /* 불만 리뷰는 잣대가 다르다. 칭찬 답글 잣대를 그대로 대면
     사과할 자리에 "키워드를 넣으세요"라고 시키게 된다.
     그건 다음 손님이 제일 싫어하는 답글이다. */
  if (star <= 2) {
    const promo = t.match(/(무료|이벤트|할인|특가|등록하시면|추천드립|저희 시설|둘러보|체험)/g) || [];
    /* 업체명 자체에 검색어가 들어 있는 경우가 많다. 이름은 첫머리에
       당연히 나오는 것이라 심은 것이 아니다. 빼고 본다. */
    const bare = info.name ? t.split(info.name).join(' ') : t;
    const kwHit = K.filter(k => norm(bare).includes(norm(k)));
    const act = /(확인하|보겠습니다|잡겠습니다|손보겠|전달하겠|붙여 두겠|처리하겠|바로잡)/.test(t);
    const sorry = /죄송|사과/.test(t.slice(0, 60));
    const excuse = /(바쁜 시간|그날따라|어쩔 수 없|원래|다른 분들은|오해)/.test(t);
    return [
      { t: '사과가 먼저 나온다', ok: sorry, note: sorry ? '' : '첫머리에 사과가 없습니다' },
      { t: '무엇이 불편했는지 짚었다', ok: echoed,
        note: echoed ? '' : '리뷰 내용이 안 들어갔습니다 - 어떤 리뷰에도 붙는 답글입니다' },
      { t: '무엇을 하겠다고 적었다', ok: act,
        note: act ? '' : '"확인해 보겠습니다" 같은 말로 끝내지 말고 무엇을 할지 적으세요' },
      { t: '직접 연락할 길을 열었다', ok: /연락|데스크|전화|남겨 주시면/.test(t) },
      { t: '변명이 없다', ok: !excuse,
        note: excuse ? '사정 설명은 읽는 사람에게 핑계로 보입니다' : '' },
      { t: '홍보가 없다', ok: promo.length === 0,
        note: promo.length ? `"${promo[0]}" - 사과 자리에 광고를 넣으면 그것부터 눈에 띕니다` : '' },
      { t: '검색어를 심지 않았다', ok: kwHit.length === 0,
        note: kwHit.length ? `"${kwHit[0]}" - 불만 답글에 검색어를 넣으면 티가 납니다` : '' },
      { t: '지킬 수 있을지 모르는 약속이 없다', ok: vow.length === 0,
        note: vow.length ? `"${vow[0]}" - 답글은 몇 년 남습니다` : '' },
      { t: '네이버 금지문자 0개', ok: replyCharOK(t) },
    ];
  }

  const thanks = /감사|고마|고맙|죄송/.test(t);
  const we = (t.match(/저희|우리/g) || []).length;
  /* 높임의 -시/-실 을 같이 본다. "하시"만 보면 "수월하실 거예요"를 놓친다 */
  const you = (t.match(/하셨|하시|하실|오시|오실|되시|되실|보시|보실|쓰시|쓰실|받으시|받으실|계시|가시|가실|다니시|다니실|주셔서|주신|주세요|드리|회원님|고객님|손님|축하|고생/g) || []).length;
  const mineOK = we <= 3 && you >= we;
  const bye = /다음에|또 뵙|뵙|뵐|오래|편하게 오|들러|들르|들려|오시면|찾아|보러|방문|언제든|기다리|문의|물어봐|물어보|좋은 ?하루|건강|응원|행복|화이팅|파이팅/.test(t);

  return [
    { t: '감사가 들어갔다', ok: thanks,
      note: thanks ? '' : '고맙다는 말이 없습니다 - 첫 문장에 넣으세요' },
    { t: '우리 자랑이 아니라 그분 이야기다', ok: mineOK,
      note: mineOK ? '' : (we > 3
        ? `"저희·우리"가 ${we}번 - 세 번까지가 좋습니다. 한 번은 주어를 손님 쪽으로 돌리세요`
        : '우리 얘기가 손님 얘기보다 많습니다') },
    { t: '마무리 인사가 있다', ok: bye,
      note: bye ? '' : '끝맺음이 없습니다 - 다시 오시라는 말이나 덕담으로 닫으세요' },
    { t: '손님이 쓴 말을 되받았다', ok: echoed,
      note: echoed ? '' : '리뷰 내용이 안 들어갔습니다' },
    { t: '길이가 적당하다 (80~500자)', ok: n >= 80 && n <= 500, note: `${n}자` },
    { t: '지킬 수 있을지 모르는 약속이 없다', ok: vow.length === 0,
      note: vow.length ? `"${vow[0]}" - 답글은 몇 년 남습니다` : '' },
    { t: '네이버 금지문자 0개', ok: replyCharOK(t) },
  ];
}

module.exports = {
  buildReplyPrompt, parseReply, auditReply,
  replySafe, replyCharOK, hasReviewWord, suggestTone,
  LENGTH_RULE, TONE_RULE,
};
