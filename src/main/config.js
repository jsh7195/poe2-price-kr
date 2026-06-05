'use strict';

/**
 * 앱 전역 설정 + poe.ninja 카테고리 매핑.
 *
 * 카테고리 매핑(slug/type/endpoint)은 poe.ninja PoE2 economy API를
 * 실측(네트워크 분석 + curl probe)하여 확정한 값이다. 임의로 추측한 값이 아니다.
 *   - exchange  : /poe2/api/economy/exchange/current/overview?league=..&type=..
 *   - stash     : /poe2/api/economy/stash/current/item/overview?league=..&type=..
 */

const ENDPOINTS = Object.freeze({
  ninjaBase: 'https://poe.ninja/poe2/api',
  ninjaIndexState: 'https://poe.ninja/poe2/api/data/index-state',
  // GGG 공식 거래 데이터 (한글↔영문 사전 출처)
  gggEn: 'https://www.pathofexile.com/api/trade2/data',
  gggKr: 'https://poe.game.daum.net/api/trade2/data',
  // 아이콘(gen/image 상대경로) 보정용 CDN
  poecdn: 'https://web.poecdn.com',
});

// GGG 트래픽 예절: 앱을 식별할 수 있는 User-Agent. 브라우저 프리픽스를 유지해 차단을 피한다.
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) PoE2PriceKR/1.0 (desktop price tool)';

const HTTP = Object.freeze({
  timeoutMs: 25000,
  retries: 2,
  concurrency: 5,
});

// 캐시 TTL (밀리초)
const TTL = Object.freeze({
  prices: 20 * 60 * 1000, //  poe.ninja 시세: 20분
  dictionary: 7 * 24 * 60 * 60 * 1000, // GGG 한글 사전: 7일
  leagues: 6 * 60 * 60 * 1000, // 리그 목록: 6시간
});

/**
 * poe.ninja economy 카테고리 정의.
 * key       : 내부 식별자
 * labelKr   : UI 표기(한글)
 * endpoint  : 'exchange' | 'stash'
 * type      : poe.ninja API의 type 파라미터 (실측 확정)
 */
const CATEGORIES = Object.freeze([
  // --- 통화/소모품류 (exchange) ---
  { key: 'currency', labelKr: '화폐', endpoint: 'exchange', type: 'Currency' },
  { key: 'fragments', labelKr: '조각', endpoint: 'exchange', type: 'Fragments' },
  { key: 'abyssalBones', labelKr: '심연의 뼈', endpoint: 'exchange', type: 'Abyss' },
  { key: 'uncutGems', labelKr: '미가공 젬', endpoint: 'exchange', type: 'UncutGems' },
  { key: 'lineageGems', labelKr: '혈통 보조 젬', endpoint: 'exchange', type: 'LineageSupportGems' },
  { key: 'essences', labelKr: '에센스', endpoint: 'exchange', type: 'Essences' },
  { key: 'soulCores', labelKr: '영혼 핵', endpoint: 'exchange', type: 'SoulCores' },
  { key: 'idols', labelKr: '우상', endpoint: 'exchange', type: 'Idols' },
  { key: 'runes', labelKr: '룬', endpoint: 'exchange', type: 'Runes' },
  { key: 'omens', labelKr: '징조', endpoint: 'exchange', type: 'Ritual' },
  { key: 'expedition', labelKr: '탐험', endpoint: 'exchange', type: 'Expedition' },
  { key: 'liquidEmotions', labelKr: '액체 감정', endpoint: 'exchange', type: 'Delirium' },
  { key: 'catalysts', labelKr: '기폭제', endpoint: 'exchange', type: 'Breach' },
  { key: 'verisium', labelKr: '베리시움', endpoint: 'exchange', type: 'Verisium' },
  // --- 유니크 장비 (stash) ---
  { key: 'uniqueWeapons', labelKr: '유니크 무기', endpoint: 'stash', type: 'UniqueWeapons' },
  { key: 'uniqueArmours', labelKr: '유니크 방어구', endpoint: 'stash', type: 'UniqueArmours' },
  { key: 'uniqueAccessories', labelKr: '유니크 장신구', endpoint: 'stash', type: 'UniqueAccessories' },
  { key: 'uniqueFlasks', labelKr: '유니크 플라스크', endpoint: 'stash', type: 'UniqueFlasks' },
  { key: 'uniqueCharms', labelKr: '유니크 부적', endpoint: 'stash', type: 'UniqueCharms' },
  { key: 'uniqueJewels', labelKr: '유니크 주얼', endpoint: 'stash', type: 'UniqueJewels' },
  { key: 'uniqueMaps', labelKr: '유니크 지도', endpoint: 'stash', type: 'UniqueMaps' },
]);

module.exports = { ENDPOINTS, USER_AGENT, HTTP, TTL, CATEGORIES };
