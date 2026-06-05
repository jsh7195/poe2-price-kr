'use strict';

const { CATEGORIES, HTTP } = require('../config');
const { fetchCategory } = require('./ninja');
const { mapLimit } = require('./http');
const { normKr, normEn } = require('./normalize');

/**
 * 검색 카탈로그 빌더.
 * poe.ninja 의 모든 카테고리 가격을 받아오고, 각 아이템 영문명에
 * GGG 사전(enToKr)으로 한글명을 붙여 검색 가능한 레코드 배열을 만든다.
 */

function toRecord(raw, category, enToKr) {
  const kr = enToKr[normEn(raw.en)] || raw.en; // 사전에 없으면 영문 폴백
  return {
    kr,
    en: raw.en,
    baseType: raw.baseType || '',
    krNorm: normKr(kr),
    enNorm: normEn(raw.en),
    icon: raw.icon || '',
    valueDivine: raw.value ? raw.value.divine : null,
    valueExalted: raw.value ? raw.value.exalted : null,
    valueChaos: raw.value ? raw.value.chaos : null,
    categoryKey: category.key,
    labelKr: category.labelKr,
    endpoint: category.endpoint,
    change7d: raw.change7d ?? null,
    volume: raw.volume ?? null,
    corrupted: !!raw.corrupted,
    levelRequired: raw.levelRequired || null,
  };
}

/**
 * @param {string} leagueName  예: "Runes of Aldur"
 * @param {{enToKr: object}} dict
 * @returns {Promise<{records:Array, ref:object|null, leagueName:string, updatedAt:number, errors:Array}>}
 */
async function buildCatalog(leagueName, dict) {
  const enToKr = (dict && dict.enToKr) || {};
  const records = [];
  const errors = [];
  let ref = null;

  const results = await mapLimit(CATEGORIES, HTTP.concurrency, async (category) => {
    try {
      const { records: raws, ref: catRef } = await fetchCategory(leagueName, category);
      return { category, raws, catRef };
    } catch (e) {
      errors.push({ category: category.key, message: String(e && e.message ? e.message : e) });
      return null;
    }
  });

  for (const r of results) {
    if (!r) continue;
    // 기준 통화(divine/exalted 아이콘·환율)는 currency 카테고리 것을 우선 사용
    if (r.catRef && (!ref || r.category.key === 'currency')) ref = r.catRef;
    for (const raw of r.raws) records.push(toRecord(raw, r.category, enToKr));
  }

  return { records: dedupe(records), ref, leagueName, updatedAt: Date.now(), errors };
}

/**
 * 같은 아이템의 변형(예: poe.ninja 가 유니크를 링크/티어별로 여러 줄 반환)을 합친다.
 * 키: 카테고리 + 영문명 + 기반타입. 거래량(volume) 최다 → 가치 높은 쪽을 대표로 남긴다.
 */
function dedupe(records) {
  const byKey = new Map();
  for (const r of records) {
    // 타락/비타락은 같은 이름·기반이라도 별개 시세 → 키에 corrupted 포함
    const key = `${r.categoryKey}|${r.enNorm}|${normEn(r.baseType)}|${r.corrupted ? '1' : '0'}`;
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, r);
      continue;
    }
    const rv = r.volume ?? 0;
    const pv = prev.volume ?? 0;
    const better = rv > pv || (rv === pv && (r.valueDivine ?? 0) > (prev.valueDivine ?? 0));
    if (better) byKey.set(key, r);
  }
  return [...byKey.values()];
}

module.exports = { buildCatalog, toRecord, dedupe };
