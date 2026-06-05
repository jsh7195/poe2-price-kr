'use strict';

const { ENDPOINTS } = require('../config');
const { getJson } = require('./http');
const { normEn } = require('./normalize');

/**
 * GGG 공식 거래 데이터로부터 영문→한글 사전을 만든다.
 *
 * 출처(동일한 데이터의 두 언어 realm):
 *   영문: pathofexile.com/api/trade2/data/{static,items}
 *   한글: poe.game.daum.net/api/trade2/data/{static,items}
 *
 * 조인 전략(실측 검증, 통화류 100% · 유니크 100%):
 *   - static : 각 항목에 안정적 `id` 존재 → id 로 직접 조인.
 *   - items  : id 없음, 개수도 약간 불일치. 단, "유니크(name 보유)만" 필터링하면
 *              카테고리별 EN/KR 개수가 정확히 일치 → 유니크끼리 인덱스 조인.
 */

/**
 * 순수 함수: 4개 원본 JSON → { enToKr } (normEn(영문) → 한글).
 * 테스트에서 고정 픽스처로 검증 가능하도록 분리.
 */
function buildFromRaw(staticEn, staticKr, itemsEn, itemsKr) {
  const enToKr = Object.create(null);

  // API 응답 구조 드리프트 방어: result 가 배열이 아니면 경고 후 빈 배열로.
  const results = (obj, label) => {
    const r = obj && obj.result;
    if (!Array.isArray(r)) {
      console.warn(`[dictionary] 예상치 못한 응답 구조: ${label}.result 가 배열이 아님`);
      return [];
    }
    return r;
  };
  staticEn = { result: results(staticEn, 'static(EN)') };
  staticKr = { result: results(staticKr, 'static(KR)') };
  itemsEn = { result: results(itemsEn, 'items(EN)') };
  itemsKr = { result: results(itemsKr, 'items(KR)') };

  // --- static: id 조인 ---
  const sKrById = new Map();
  for (const cat of (staticKr && staticKr.result) || []) {
    const m = new Map();
    for (const e of cat.entries || []) if (e.id) m.set(e.id, e.text);
    sKrById.set(cat.id, m);
  }
  for (const cat of (staticEn && staticEn.result) || []) {
    const krMap = sKrById.get(cat.id);
    if (!krMap) continue;
    for (const e of cat.entries || []) {
      if (!e.id || !e.text) continue;
      const kr = krMap.get(e.id);
      if (kr) enToKr[normEn(e.text)] = kr;
    }
  }

  // --- items: 유니크(name 보유)만 인덱스 조인 ---
  const iKrById = new Map();
  for (const cat of (itemsKr && itemsKr.result) || []) iKrById.set(cat.id, cat.entries || []);
  for (const cat of (itemsEn && itemsEn.result) || []) {
    const krEntries = iKrById.get(cat.id) || [];
    const enUniques = (cat.entries || []).filter((e) => e.name);
    const krUniques = krEntries.filter((e) => e.name);
    if (enUniques.length !== krUniques.length) {
      console.warn(
        `[dictionary] 유니크 인덱스 개수 불일치 (cat=${cat.id}): EN=${enUniques.length} KR=${krUniques.length} — 일부 유니크 한글명이 틀어질 수 있음`
      );
    }
    enUniques.forEach((e, i) => {
      const kr = krUniques[i];
      if (kr && kr.name) enToKr[normEn(e.name)] = kr.name;
    });
  }

  return { enToKr, size: Object.keys(enToKr).length };
}

/**
 * 네트워크에서 원본을 받아 사전을 빌드한다.
 * @returns {Promise<{enToKr: object, size: number}>}
 */
async function buildDictionary() {
  const [staticEn, staticKr, itemsEn, itemsKr] = await Promise.all([
    getJson(`${ENDPOINTS.gggEn}/static`),
    getJson(`${ENDPOINTS.gggKr}/static`),
    getJson(`${ENDPOINTS.gggEn}/items`),
    getJson(`${ENDPOINTS.gggKr}/items`),
  ]);
  return buildFromRaw(staticEn, staticKr, itemsEn, itemsKr);
}

module.exports = { buildFromRaw, buildDictionary };
