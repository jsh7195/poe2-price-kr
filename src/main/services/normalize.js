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

module.exports = { normEn, normKr, isSubsequence };
