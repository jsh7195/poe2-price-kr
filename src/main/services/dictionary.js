'use strict';

const { ENDPOINTS } = require('../config');
const { getJson } = require('./http');
const { normEn } = require('./normalize');

/**
 * GGG 공식 거래 데이터로부터 영문→한글 사전을 만든다.
 *
 * 출처(동일한 데이터의 두 언어 realm):
 *   영문: pathofexile.com/api/trade2/data/{static,items}
 *   한글: poe.kakaogames.com/api/trade2/data/{static,items}  (구 poe.game.daum.net → 301 이전)
 *
 * 조인 전략(실측 검증, 통화류 100% · 유니크 100%):
 *   - static : 각 항목에 안정적 `id` 존재 → id 로 직접 조인.
 *   - items  : id 없음, 개수도 약간 불일치. 단, "유니크(name 보유)만" 필터링하면
 *              카테고리별 EN/KR 개수가 정확히 일치 → 유니크끼리 인덱스 조인.
 */

/**
 * items 카테고리의 비유니크 `type`(기반 타입)을 앵커 기반 구간 인덱스 조인으로 붙인다.
 *
 * EN/KR items 목록은 같은 순서지만 개수가 약간 어긋나는 카테고리가 있다(실측: currency 616 vs 615).
 * 이미 한글을 아는 항목(static 조인 결과)을 앵커로 삼아, 앵커 사이 구간의 EN/KR 개수가 같을 때만
 * 그 구간을 인덱스로 조인한다. 개수가 다른 구간은 건너뛴다(틀린 번역보다 영문 폴백이 낫다).
 * 앵커가 하나도 없고 전체 개수가 같으면 전체를 인덱스 조인한다.
 *
 * @param {Array<{type?:string,name?:string}>} enEntries
 * @param {Array<{type?:string,name?:string}>} krEntries
 * @param {object} enToKr  normEn(영문) → 한글. 앵커 판정에 읽고, 결과를 여기에 추가한다(기존 값은 유지).
 */
function joinTypesByAnchors(enEntries, krEntries, enToKr) {
  const en = Array.isArray(enEntries) ? enEntries : [];
  const kr = Array.isArray(krEntries) ? krEntries : [];
  if (!en.length || !kr.length) return;

  const joinSegment = (enFrom, enTo, krFrom, krTo) => {
    if (enTo - enFrom !== krTo - krFrom) return; // 구간 길이 불일치 → 안전하게 건너뜀
    for (let k = 0; k < enTo - enFrom; k++) {
      const e = en[enFrom + k];
      const t = kr[krFrom + k];
      if (!e || !t || !e.type || !t.type) continue;
      const key = normEn(e.type);
      if (key && !enToKr[key]) enToKr[key] = t.type;
    }
  };

  // 앵커: EN 항목의 type 한글이 이미 알려져 있고, KR 목록에서 그 한글 type 이 근처에 존재하는 위치.
  const LOOKAHEAD = 8;
  let enSeg = 0;
  let krSeg = 0;
  let krCursor = 0;
  let anchors = 0;
  for (let i = 0; i < en.length; i++) {
    const e = en[i];
    if (!e || !e.type) continue;
    const known = enToKr[normEn(e.type)];
    if (!known) continue;
    let j = -1;
    const from = Math.max(krCursor, i - LOOKAHEAD);
    const to = Math.min(kr.length, i + LOOKAHEAD + 1);
    for (let c = from; c < to; c++) {
      if (kr[c] && kr[c].type === known) {
        j = c;
        break;
      }
    }
    if (j < 0) continue;
    joinSegment(enSeg, i, krSeg, j);
    enSeg = i + 1;
    krSeg = j + 1;
    krCursor = j + 1;
    anchors++;
  }
  if (anchors === 0) {
    if (en.length === kr.length) joinSegment(0, en.length, 0, kr.length);
    return;
  }
  joinSegment(enSeg, en.length, krSeg, kr.length); // 마지막 앵커 이후 꼬리 구간
}

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
    // 비유니크(기반 타입: 우상·서판·룬 조각 등)는 static 조인으로 이미 아는 항목을 앵커로 삼아 구간별 인덱스 조인.
    joinTypesByAnchors(cat.entries || [], krEntries, enToKr);
  }

  // --- 통화 아이콘: static 엔트리(id+image) → 절대 URL. 매물 price.currency 가 이 id 와 일치. ---
  const POECDN = 'https://web.poecdn.com';
  const toUrl = (img) =>
    /^https?:\/\//i.test(img) ? img : POECDN + (img.startsWith('/') ? img : '/' + img);
  const currencyIcons = Object.create(null);
  for (const cat of (staticEn && staticEn.result) || []) {
    for (const e of cat.entries || []) {
      if (e.id && e.image && !currencyIcons[e.id]) currencyIcons[e.id] = toUrl(e.image);
    }
  }

  return { enToKr, currencyIcons, size: Object.keys(enToKr).length };
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

module.exports = { buildFromRaw, buildDictionary, joinTypesByAnchors };
