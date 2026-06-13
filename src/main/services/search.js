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
    // 역접두: 질의가 레코드명으로 시작 = 사용자가 "유니크명 + 기반"을 통째로 친 경우
    // (예: "꼬인혀갈라진창" → 레코드 "꼬인혀"). 인게임 표기 그대로 검색해도 매칭되게.
    else if (kr.length >= 2 && qKr.startsWith(kr)) best = Math.max(best, 760);
    else if (kr.includes(qKr)) best = Math.max(best, 600);
    // 레코드명이 질의 안에 통째로 포함(앞뒤 군더더기 흡수, 3자+ 라야 오매칭 방지)
    else if (kr.length >= 3 && qKr.includes(kr)) best = Math.max(best, 560);
    else if (qKr.length >= 2 && isSubsequence(qKr, kr)) best = Math.max(best, 300);
  }
  // 영문 기준 (질의에 영문이 2자 이상일 때만)
  if (qEn && qEn.length >= 2) {
    if (en === qEn) best = Math.max(best, 980);
    else if (en.startsWith(qEn)) best = Math.max(best, 780);
    else if (en.length >= 3 && qEn.startsWith(en)) best = Math.max(best, 740);
    else if (en.includes(qEn)) best = Math.max(best, 580);
    else if (en.length >= 4 && qEn.includes(en)) best = Math.max(best, 540);
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
    // 동점(같은 이름의 변형들) → 거래량 많은 순 = 실제 시장가를 대표로.
    // 예: "번개 도선"이 흔한 기반(거래량 3074, 1ex)과 희귀 Runemastered 기반(거래량 16, 32ex)으로
    // 갈릴 때, 가격 높은 쪽을 올리면 32ex 가 대표처럼 보여 오해를 부른다 → 유동성 우선.
    const avol = a.rec.volume ?? 0;
    const bvol = b.rec.volume ?? 0;
    if (bvol !== avol) return bvol - avol;
    const av = a.rec.valueDivine ?? -1;
    const bv = b.rec.valueDivine ?? -1;
    return bv - av;
  });

  return scored.slice(0, limit).map((x) => x.rec);
}

module.exports = { search, scoreRecord };
