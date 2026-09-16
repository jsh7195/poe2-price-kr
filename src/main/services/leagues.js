'use strict';

const { ENDPOINTS } = require('../config');
const { getJson } = require('./http');

// 시즌과 무관하게 항상 존재하는 상설 리그. 사용자가 여기를 골랐다면 새 시즌 자동 전환 대상이 아니다.
const PERMANENT_LEAGUES = new Set(['Standard', 'Hardcore']);

/**
 * 현재 시즌 리그를 고른다.
 * poe.ninja 는 최신 리그를 목록 맨 위에 두지만, 시즌 시작 직후에는 `indexed=false` 인 채로
 * 이미 시세 API 가 응답한다(0.5.5 "Forbidden Rites" 실측). 따라서 indexed 보다
 * "가장 위의 소프트코어 챌린지 리그"를 우선한다.
 * @param {Array<{name:string, hardcore:boolean, indexed:boolean}>} leagues
 */
function pickCurrent(leagues) {
  const list = Array.isArray(leagues) ? leagues : [];
  return (
    list.find((l) => !l.hardcore && !PERMANENT_LEAGUES.has(l.name)) ||
    list.find((l) => l.indexed && !l.hardcore) ||
    list.find((l) => l.indexed) ||
    list[0] ||
    null
  );
}

/**
 * 시작/갱신 시 실제로 사용할 리그를 정한다(순수 함수).
 *  - 저장된 선택(wanted)이 목록에 없으면 현재 시즌.
 *  - 새 시즌이 감지되면(prevCurrent ≠ current): 직전 시즌(또는 그 HC)에 머물던 사용자는 새 시즌으로
 *    자동 이동, 상설 리그(Standard/Hardcore)를 고른 사용자는 그대로 둔다.
 *  - prevCurrent 를 모르는 경우(구버전에서 업그레이드)도 새 시즌 감지로 취급한다.
 * @param {{wanted?:string|null, prevCurrent?:string|null, leagues:Array, current:object|null}} p
 * @returns {string|null}
 */
function resolveLeague({ wanted, prevCurrent, leagues, current }) {
  const list = Array.isArray(leagues) ? leagues : [];
  const names = new Set(list.map((l) => l.name));
  const cur = current ? current.name : null;
  if (!cur) return wanted && names.has(wanted) ? wanted : list[0] ? list[0].name : null;
  if (!wanted || !names.has(wanted) || wanted === cur) return cur;
  const seasonChanged = prevCurrent ? prevCurrent !== cur : true;
  if (!seasonChanged) return wanted;
  if (PERMANENT_LEAGUES.has(wanted)) return wanted;
  const hcOfCur = 'HC ' + cur;
  if (wanted.startsWith('HC ') && names.has(hcOfCur)) return hcOfCur;
  return cur;
}

/**
 * 카카오게임즈(한국) 거래소의 리그 한글 표기(id → text). 실패해도 앱 동작에는 영향 없음(표시용).
 * @returns {Promise<Object<string,string>>}
 */
async function fetchKrLeagueNames() {
  try {
    const json = await getJson(`${ENDPOINTS.gggKr}/leagues`, { retries: 0 });
    const out = Object.create(null);
    for (const l of json && Array.isArray(json.result) ? json.result : []) {
      if (l && l.id && l.text && l.text !== l.id) out[l.id] = l.text;
    }
    return out;
  } catch (e) {
    console.warn('[leagues] 한글 리그명 조회 실패(표시만 영문으로 폴백):', e && e.message ? e.message : e);
    return Object.create(null);
  }
}

/**
 * poe.ninja index-state 에서 economy 리그 목록을 가져온다.
 * 반환: { leagues: [{ name, url, displayName, displayKr, hardcore, indexed }], current }
 *   - current: 현재 시즌 리그 (pickCurrent 참조)
 */
async function fetchLeagues() {
  const [json, krNames] = await Promise.all([getJson(ENDPOINTS.ninjaIndexState), fetchKrLeagueNames()]);
  const list = Array.isArray(json.economyLeagues) ? json.economyLeagues : [];
  const leagues = list.map((l) => ({
    name: l.name,
    url: l.url,
    displayName: l.displayName || l.name,
    displayKr: krNames[l.name] || '',
    hardcore: !!l.hardcore,
    indexed: !!l.indexed,
  }));
  return { leagues, current: pickCurrent(leagues) };
}

module.exports = { fetchLeagues, pickCurrent, resolveLeague, PERMANENT_LEAGUES };
