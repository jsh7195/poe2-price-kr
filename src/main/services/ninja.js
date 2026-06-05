'use strict';

const { ENDPOINTS } = require('../config');
const { getJson } = require('./http');

/**
 * poe.ninja PoE2 economy API 클라이언트 + 가치(value) 계산.
 *
 * 두 종류의 응답 형태(실측 확정):
 *  - exchange : { core:{items,rates,primary,secondary}, lines:[{id,primaryValue,sparkline,...}], items:[{id,name,image,category}] }
 *  - stash    : { core:{...}, lines:[{name,baseType,icon,primaryValue,listingCount,sparkLine,...}] }
 *
 * primaryValue 는 core.primary(=divine) 통화 기준 가치이며,
 * core.rates 는 "primary 1개당 해당 통화 개수"(예: exalted: 87.69 → 1 divine = 87.69 exalted).
 */

/** gen/image 상대경로를 절대 URL로 보정. */
function imageUrl(raw) {
  if (!raw) return '';
  if (/^https?:\/\//i.test(raw)) return raw;
  return ENDPOINTS.poecdn + (raw.startsWith('/') ? raw : '/' + raw);
}

/** core 로부터 primaryValue → {divine, exalted, chaos} 변환 함수를 만든다. */
function makeValueCalc(core) {
  const rates = (core && core.rates) || {};
  const exRate = typeof rates.exalted === 'number' ? rates.exalted : null;
  const chaosRate = typeof rates.chaos === 'number' ? rates.chaos : null;
  return (primaryValue) => {
    if (typeof primaryValue !== 'number' || !isFinite(primaryValue)) return null;
    return {
      divine: primaryValue, // primary = divine
      exalted: exRate != null ? primaryValue * exRate : null,
      chaos: chaosRate != null ? primaryValue * chaosRate : null,
    };
  };
}

/** UI 표기용 기준 통화 정보(divine/exalted/chaos 아이콘·환율). */
function refCurrencies(core) {
  const byId = {};
  for (const it of (core && core.items) || []) byId[it.id] = it;
  const pick = (id) =>
    byId[id] ? { id, name: byId[id].name, icon: imageUrl(byId[id].image) } : { id, name: id, icon: '' };
  return {
    primary: core ? core.primary : 'divine',
    divine: pick('divine'),
    exalted: pick('exalted'),
    chaos: pick('chaos'),
    rates: (core && core.rates) || {},
  };
}

function parseExchange(json) {
  const core = json.core || {};
  const calc = makeValueCalc(core);
  const byId = {};
  for (const it of json.items || []) byId[it.id] = it;
  const out = [];
  for (const line of json.lines || []) {
    const meta = byId[line.id];
    if (!meta || !meta.name) continue;
    const value = calc(line.primaryValue);
    if (!value || value.divine === 0) continue; // 가치 0(=시세 없음) 제외
    out.push({
      en: meta.name,
      icon: imageUrl(meta.image),
      value,
      change7d: line.sparkline ? line.sparkline.totalChange : null,
      volume: typeof line.volumePrimaryValue === 'number' ? line.volumePrimaryValue : null,
    });
  }
  return { records: out, ref: refCurrencies(core) };
}

function parseStash(json) {
  const core = json.core || {};
  const calc = makeValueCalc(core);
  const out = [];
  for (const line of json.lines || []) {
    if (!line.name) continue;
    const value = calc(line.primaryValue);
    if (!value || value.divine === 0) continue; // 가치 0(=시세 없음) 제외
    out.push({
      en: line.name,
      baseType: line.baseType || '',
      icon: imageUrl(line.icon),
      value,
      change7d: line.sparkLine ? line.sparkLine.totalChange : null,
      volume: typeof line.listingCount === 'number' ? line.listingCount : null,
      corrupted: !!line.corrupted,
      levelRequired: line.levelRequired || null,
    });
  }
  return { records: out, ref: refCurrencies(core) };
}

function categoryUrl(leagueName, category) {
  const L = encodeURIComponent(leagueName).replace(/%20/g, '+');
  const T = encodeURIComponent(category.type);
  if (category.endpoint === 'stash') {
    return `${ENDPOINTS.ninjaBase}/economy/stash/current/item/overview?league=${L}&type=${T}`;
  }
  return `${ENDPOINTS.ninjaBase}/economy/exchange/current/overview?league=${L}&type=${T}`;
}

/**
 * 한 카테고리의 가격 레코드를 가져온다.
 * @returns {Promise<{records: Array, ref: object}>}
 */
async function fetchCategory(leagueName, category) {
  const json = await getJson(categoryUrl(leagueName, category));
  return category.endpoint === 'stash' ? parseStash(json) : parseExchange(json);
}

module.exports = {
  imageUrl,
  makeValueCalc,
  refCurrencies,
  parseExchange,
  parseStash,
  categoryUrl,
  fetchCategory,
};
