'use strict';

const { ENDPOINTS } = require('../config');
const { getJson } = require('./http');

/**
 * poe.ninja index-state 에서 economy 리그 목록을 가져온다.
 * 반환: { leagues: [{ name, url, displayName, hardcore, indexed }], current }
 *   - current: 현재 시즌(가장 위, indexed=true 인 소프트코어) 리그
 */
async function fetchLeagues() {
  const json = await getJson(ENDPOINTS.ninjaIndexState);
  const list = Array.isArray(json.economyLeagues) ? json.economyLeagues : [];
  const leagues = list.map((l) => ({
    name: l.name,
    url: l.url,
    displayName: l.displayName || l.name,
    hardcore: !!l.hardcore,
    indexed: !!l.indexed,
  }));
  // 현재 시즌 우선순위: indexed && !hardcore  →  indexed  →  목록 첫 항목
  const current =
    leagues.find((l) => l.indexed && !l.hardcore) ||
    leagues.find((l) => l.indexed) ||
    leagues[0] ||
    null;
  return { leagues, current };
}

module.exports = { fetchLeagues };
