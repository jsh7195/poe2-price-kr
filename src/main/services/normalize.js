'use strict';

/**
 * 문자열 정규화 유틸. 사전 빌드 / 카탈로그 매칭 / 검색에서 동일하게 사용해
 * 키 불일치를 방지한다(DRY).
 */

/**
 * 영문 이름 키 정규화. poe.ninja 영문명 ↔ GGG 영문명 매칭에 사용.
 * 소문자화 후 영숫자만 남긴다. (공백/아포스트로피/하이픈 차이를 흡수)
 *   "Soul Core of Azcapa" -> "soulcoreofazcapa"
 */
function normEn(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^a-z0-9]+/g, '');
}

/**
 * 한글 검색어 정규화. 사용자가 입력한 한글/영문 혼합 질의에 사용.
 * 공백·구두점 제거, 한글/영숫자 유지.
 *   "영혼 핵" -> "영혼핵"
 */
function normKr(s) {
  return (s || '')
    .toString()
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^0-9a-z가-힣]+/g, ''); // 공백·구두점 제거, 한글/영숫자만 유지
}

/**
 * q 의 모든 문자가 target 안에 순서대로 등장하는지(부분 수열). 오타·축약 허용 매칭용.
 */
function isSubsequence(q, target) {
  if (!q) return false;
  let i = 0;
  for (let j = 0; j < target.length && i < q.length; j++) {
    if (target[j] === q[i]) i++;
  }
  return i === q.length;
}

// 한글 음절 분해(초성/중성/종성) 상수.
const HANGUL_BASE = 0xac00;
const HANGUL_LAST = 0xd7a3;
const V_COUNT = 21;
const T_COUNT = 28;
const L_LIST = ['ㄱ','ㄲ','ㄴ','ㄷ','ㄸ','ㄹ','ㅁ','ㅂ','ㅃ','ㅅ','ㅆ','ㅇ','ㅈ','ㅉ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];
const V_LIST = ['ㅏ','ㅐ','ㅑ','ㅒ','ㅓ','ㅔ','ㅕ','ㅖ','ㅗ','ㅘ','ㅙ','ㅚ','ㅛ','ㅜ','ㅝ','ㅞ','ㅟ','ㅠ','ㅡ','ㅢ','ㅣ'];
const T_LIST = ['','ㄱ','ㄲ','ㄳ','ㄴ','ㄵ','ㄶ','ㄷ','ㄹ','ㄺ','ㄻ','ㄼ','ㄽ','ㄾ','ㄿ','ㅀ','ㅁ','ㅂ','ㅄ','ㅅ','ㅆ','ㅇ','ㅈ','ㅊ','ㅋ','ㅌ','ㅍ','ㅎ'];

const _jamoCache = new Map();

/**
 * 한글 음절을 자모(초성+중성+종성) 열로 분해. 비한글 문자는 그대로 둔다.
 * OCR 오인식(룬↔른, 으↔오 등)은 보통 자모 1~2개 차이라, 자모 단위 비교가
 * 음절 단위보다 훨씬 관대하게 매칭된다.  "룬" -> "ㄹㅜㄴ", "른" -> "ㄹㅡㄴ" (1 차이)
 */
function decomposeHangul(s) {
  const str = s || '';
  const cached = _jamoCache.get(str);
  if (cached !== undefined) return cached;
  let out = '';
  for (const ch of str) {
    const code = ch.codePointAt(0);
    if (code >= HANGUL_BASE && code <= HANGUL_LAST) {
      const idx = code - HANGUL_BASE;
      const l = Math.floor(idx / (V_COUNT * T_COUNT));
      const v = Math.floor((idx % (V_COUNT * T_COUNT)) / T_COUNT);
      const t = idx % T_COUNT;
      out += L_LIST[l] + V_LIST[v] + T_LIST[t];
    } else {
      out += ch;
    }
  }
  _jamoCache.set(str, out);
  return out;
}

/** 두 문자열의 Levenshtein(삽입/삭제/치환) 편집거리. */
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  if (!m) return n;
  if (!n) return m;
  let prev = new Array(n + 1);
  for (let j = 0; j <= n; j++) prev[j] = j;
  for (let i = 1; i <= m; i++) {
    const cur = [i];
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    prev = cur;
  }
  return prev[n];
}

/**
 * 한글 자모 분해 후 정규화 편집거리 유사도(0~1). 1 = 완전 일치.
 * OCR 오인식을 흡수하기 위한 퍼지 매칭에 사용.
 */
function jamoSimilarity(a, b) {
  const da = decomposeHangul(a);
  const db = decomposeHangul(b);
  const maxLen = Math.max(da.length, db.length);
  if (!maxLen) return 0;
  return 1 - levenshtein(da, db) / maxLen;
}

module.exports = { normEn, normKr, isSubsequence, decomposeHangul, levenshtein, jamoSimilarity };
