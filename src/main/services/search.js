'use strict';

const { normKr, normEn, isSubsequence } = require('./normalize');

/**
 * 카탈로그 레코드에 대한 한글/영문 검색 + 랭킹 (순수 함수).
 *
 * 레코드는 krNorm(한글 정규화) / enNorm(영문 정규화) 를 미리 보유한다.
 * 한글 질의는 krNorm 으로, 영문 질의는 enNorm 으로 매칭한다.
 */

function scoreRecord(rec, qKr, qEn) {
  let best = 0;
  const kr = rec.krNorm;
  const en = rec.enNorm;

  // 한글(또는 한글 폴백) 기준
  if (qKr) {
    if (kr === qKr) best = Math.max(best, 1000);
    else if (kr.startsWith(qKr)) best = Math.max(best, 800);
    else if (kr.includes(qKr)) best = Math.max(best, 600);
    else if (qKr.length >= 2 && isSubsequence(qKr, kr)) best = Math.max(best, 300);
  }
  // 영문 기준 (질의에 영문이 2자 이상일 때만)
  if (qEn && qEn.length >= 2) {
    if (en === qEn) best = Math.max(best, 980);
    else if (en.startsWith(qEn)) best = Math.max(best, 780);
    else if (en.includes(qEn)) best = Math.max(best, 580);
    else if (isSubsequence(qEn, en)) best = Math.max(best, 280);
  }
  return best;
}

/**
 * @param {Array} records  카탈로그 레코드
 * @param {string} query   사용자 입력(한글/영문)
 * @param {number} limit   최대 결과 수
 */
function search(records, query, limit = 40) {
  const qKr = normKr(query);
  const qEn = normEn(query);
  if (!qKr && !qEn) return [];

  const scored = [];
  for (const rec of records) {
    const s = scoreRecord(rec, qKr, qEn);
    if (s > 0) scored.push({ rec, s });
  }

  scored.sort((a, b) => {
    if (b.s !== a.s) return b.s - a.s;
    // 동점 → 가치 높은 순, 그다음 거래량
    const av = a.rec.valueDivine ?? -1;
    const bv = b.rec.valueDivine ?? -1;
    if (bv !== av) return bv - av;
    return (b.rec.volume ?? 0) - (a.rec.volume ?? 0);
  });

  return scored.slice(0, limit).map((x) => x.rec);
}

module.exports = { search, scoreRecord };
