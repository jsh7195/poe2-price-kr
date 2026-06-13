'use strict';

const { ENDPOINTS } = require('../config');
const { getJson } = require('./http');

/**
 * GGG 거래소 스탯 사전(한글) 기반 "모드 텍스트 → stat id" 매처.
 *
 * 출처: poe.game.daum.net/api/trade2/data/stats  (8천여 항목)
 *   result: [ { label, entries:[ { id, text } ] } ]
 *   id 예: "explicit.stat_3372524247", text 예: "화염 저항 #%"  (#=수치 자리)
 *
 * 핵심 아이디어: 사전 text 는 이미 "#" 자리표시자 형태다. 인게임 모드 라인의 숫자를
 * "#" 로 치환하면 사전 text 와 동일한 키가 된다 → 정확 일치 조회(8천 항목 정규식 순회 불필요).
 *   "번개 저항 +34%"  --(숫자→#)-->  "번개 저항 #%"  == 사전 text
 *
 * 접사 모호성(같은 텍스트가 explicit/implicit/crafted… 여러 id): 모드의 접사 종류
 * (파서가 `{ }` 주석으로 판별한 statType)로 올바른 id 를 고른다.
 */

// 숫자(부호·소수 포함) 토큰 → '#'. 사전 text 와 라인을 같은 정규형으로.
// "(특정)"=로컬 방어 모드 표기 → 제거해서 글로벌/로컬을 같은 키로 묶는다(둘 중 로컬을 골라야 함).
function normKey(text) {
  return String(text || '')
    .replace(/\[[^\]|]*\|([^\]]*)\]/g, '$1') // [A|B] → B (방어적; data/stats엔 보통 없음)
    .replace(/\[([^\]]*)\]/g, '$1')
    .replace(/\((?:특정|local)\)/gi, '') // 로컬 표기 제거 → 클립보드(표기 없음)와 매칭
    .replace(/[+\-]?\d+(?:\.\d+)?/g, '#')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * data/stats JSON → { byKey: Map<normKey, Array<{id, statType, text}>>, size }.
 * statType = id 의 prefix(explicit/implicit/rune/crafted/enchant/pseudo/…).
 */
function buildStatIndex(statsJson) {
  const byKey = new Map();
  let size = 0;
  for (const grp of (statsJson && statsJson.result) || []) {
    for (const e of grp.entries || []) {
      if (!e || !e.id || !e.text) continue;
      const statType = String(e.id).split('.')[0];
      const key = normKey(e.text);
      if (!key) continue;
      let arr = byKey.get(key);
      if (!arr) byKey.set(key, (arr = []));
      // local: "(특정)" 로컬 방어 모드. 장비 가격평가에선 로컬 id 가 실제 검색됨(글로벌은 0건).
      arr.push({ id: e.id, statType, text: e.text, local: /\((?:특정|local)\)/i.test(e.text) });
      size++;
    }
  }
  return { byKey, size };
}

// 접사 선호 순위(원하는 statType 없을 때 폴백 순서).
const TYPE_PRIORITY = ['explicit', 'implicit', 'rune', 'crafted', 'enchant', 'fractured', 'sanctum', 'skill', 'pseudo'];

/**
 * 정규화된 모드 라인 → stat id 후보 선택.
 * @param {{byKey:Map}} index
 * @param {string} cleanLine  범위 제거된 모드 텍스트 (예: "번개 저항 +34%")
 * @param {string} [preferType]  파서가 판별한 접사 statType(explicit/implicit/…)
 * @returns {null | {id, statType, text, values:number[]}}
 */
function matchMod(index, cleanLine, preferType) {
  const key = normKey(cleanLine);
  const cands = index.byKey.get(key);
  if (!cands || !cands.length) return null;
  // 로컬("특정") 변형이 있으면 우선(장비 방어 모드는 로컬 id 라야 검색됨). 없으면 전체.
  const localCands = cands.filter((c) => c.local);
  const pool = localCands.length ? localCands : cands;
  const pick =
    (preferType && pool.find((c) => c.statType === preferType)) ||
    TYPE_PRIORITY.map((t) => pool.find((c) => c.statType === t)).find(Boolean) ||
    pool[0];
  const values = (cleanLine.match(/[+\-]?\d+(?:\.\d+)?/g) || []).map(Number);
  return { id: pick.id, statType: pick.statType, text: pick.text, values };
}

/** 한글 스탯 사전 원본 JSON(디스크 캐시용 — Map 은 직렬화 안 되므로 raw 를 캐시). */
async function fetchRawStats() {
  return getJson(`${ENDPOINTS.gggKr}/stats`);
}

/** 네트워크에서 한글 스탯 사전을 받아 인덱스를 만든다. */
async function fetchStatIndex() {
  return buildStatIndex(await fetchRawStats());
}

module.exports = { normKey, buildStatIndex, matchMod, fetchRawStats, fetchStatIndex };
