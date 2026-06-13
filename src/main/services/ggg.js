'use strict';

const { ENDPOINTS, HTTP } = require('../config');
const { getJson, postJson, sleep } = require('./http');
const { matchMod } = require('./stats');

/**
 * GGG 공식 PoE2 거래(trade2) 실시간 시세 클라이언트.
 *
 * poe.ninja 집계가 인게임과 수십 배씩 어긋나는 문제로, 가격은 GGG 거래소의
 * "실제 온라인 매물"에서 직접 산출한다. ninja 는 아이템 목록·한글명 용도로만 남는다.
 *
 * 흐름:
 *   1) search  : POST /api/trade2/search/{league}  → 가격 오름차순 결과 id 목록
 *   2) fetch   : GET  /api/trade2/fetch/{ids}?query={id} → 매물 상세(가격 통화·수량)
 *   3) 정규화  : 매물 통화(divine/chaos/regal…)를 exalted 기준으로 환산 → 최저가 중앙값
 *
 * 통화 환율은 bulk exchange(POST /api/trade2/exchange/{league})로 GGG-네이티브하게 구한다.
 *
 * IP 레이트리밋(실측): search 5:10:60 / 15:60:300 / 30:300:1800 (10초 5회…).
 * → 버킷별 최소 간격을 두고 직렬화한다(아래 _throttle).
 */

const TRADE_BASE = 'https://www.pathofexile.com/api/trade2';

// 가격 산출에 쓰는 매물 표본 수(가격 오름차순 상위 N).
const SAMPLE_SIZE = 10;
// 시세 캐시 TTL: 12분(과도한 호출 방지, 인게임 변동 반영 균형).
const PRICE_TTL = 12 * 60 * 1000;
const RATE_TTL = 30 * 60 * 1000; // 환율은 비교적 안정적 → 길게 캐시(pre-warm 이 오래 유효)

// 버킷별 최소 호출 간격(ms). 실측 리밋보다 보수적으로(차단 회피 우선).
const SPACING = Object.freeze({ search: 2300, fetch: 1200, exchange: 1500 });
// GGG 요청 타임아웃: 조회가 오래 매달리지 않게 8초·재시도 0회(빠른 실패).
// (재시도/429 대기를 없애 "한참 조회중" 매달림 방지 — 실패하면 즉시 "시세 없음")
const GGG_REQ = Object.freeze({ timeoutMs: 8000, retries: 0 });

// ---------------------------------------------------------------------------
// 레이트리밋 스로틀: 버킷별로 직렬화 + 최소 간격 보장.
// 같은 버킷 호출은 한 번에 하나씩, 직전 호출과 SPACING[bucket] 이상 간격을 둔다.
// ---------------------------------------------------------------------------
const _chains = Object.create(null); // bucket → Promise(직전 호출 완료)
const _lastAt = Object.create(null); // bucket → 마지막 호출 시각

function _throttle(bucket, task) {
  const gap = SPACING[bucket] || 1000;
  const prev = _chains[bucket] || Promise.resolve();
  const run = prev.then(async () => {
    const since = Date.now() - (_lastAt[bucket] || 0);
    if (since < gap) await sleep(gap - since);
    try {
      return await task();
    } finally {
      _lastAt[bucket] = Date.now();
    }
  });
  // 체인은 실패해도 다음 작업이 이어지도록 swallow.
  _chains[bucket] = run.then(
    () => {},
    () => {}
  );
  return run;
}

// ---------------------------------------------------------------------------
// 통화 환율표(통화 id → exalted 단가). 매물에 등장한 통화만 지연 조회 후 캐시.
// ---------------------------------------------------------------------------
const _rateCache = new Map(); // `${league}|${currency}` → { rate, at }

/** 중앙값(median). 빈 배열이면 null. */
function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * 통화 1단위가 몇 exalted 인지. exalted=1. 조회 실패 시 null.
 * bulk exchange want=exalted have=[currency] → 최저가 몇 건의 비율 중앙값.
 */
async function getRate(league, currency) {
  if (!currency || currency === 'exalted' || currency === 'exalt') return 1;
  const key = `${league}|${currency}`;
  const hit = _rateCache.get(key);
  if (hit && Date.now() - hit.at < RATE_TTL) return hit.rate;

  const url = `${TRADE_BASE}/exchange/${encodeURIComponent(league)}`;
  const body = {
    query: { status: { option: 'online' }, want: ['exalted'], have: [currency] },
    sort: { have: 'asc' },
    engine: 'new',
  };
  try {
    const json = await _throttle('exchange', () => postJson(url, body, GGG_REQ));
    const result = (json && json.result) || {};
    const ratios = [];
    for (const k of Object.keys(result)) {
      const offers = (result[k] && result[k].listing && result[k].listing.offers) || [];
      for (const o of offers) {
        // have(=currency) amount 당 want(=exalted) amount → exalted/통화.
        const have = o.exchange && o.exchange.amount;
        const want = o.item && o.item.amount;
        if (have > 0 && want > 0) ratios.push(want / have);
      }
      if (ratios.length >= SAMPLE_SIZE) break;
    }
    const rate = median(ratios.slice(0, SAMPLE_SIZE));
    if (rate && isFinite(rate)) {
      _rateCache.set(key, { rate, at: Date.now() });
      return rate;
    }
  } catch (e) {
    // 환율 조회 실패 → 해당 통화 매물은 정규화 불가(상위에서 제외).
  }
  return null;
}

/** 캐시된 환율만 반환(네트워크 안 함). 미캐시면 undefined → 핫패스에서 새 호출 방지. */
function cachedRate(league, currency) {
  if (!currency || currency === 'exalted' || currency === 'exalt') return 1;
  const hit = _rateCache.get(`${league}|${currency}`);
  if (hit && Date.now() - hit.at < RATE_TTL) return hit.rate;
  return undefined;
}

// 미캐시 통화는 백그라운드로 한 번만 적재(다음 조회 때 캐시 히트 → 빠름). 중복 방지.
const _pendingRate = new Set();
function ensureRate(league, currency) {
  if (!currency || currency === 'exalted' || currency === 'exalt') return;
  const key = `${league}|${currency}`;
  if (cachedRate(league, currency) !== undefined || _pendingRate.has(key)) return;
  _pendingRate.add(key);
  Promise.resolve(getRate(league, currency)).catch(() => {}).then(() => _pendingRate.delete(key));
}

// 매물 가격에 흔히 쓰이는 통화 — 시작 시 미리 받아 조회 핫패스에서 환율 호출 0회로.
const PREWARM_CURRENCIES = Object.freeze([
  'divine', 'chaos', 'regal', 'vaal', 'annul', 'alch', 'aug', 'transmute', 'chance', 'exalted',
]);

/** 시작 시(또는 리그 전환 후) 흔한 통화 환율을 미리 캐시한다. 백그라운드 호출용. */
async function prewarmRates(league) {
  if (!league) return;
  for (const c of PREWARM_CURRENCIES) {
    try {
      await getRate(league, c);
    } catch (e) {
      /* 개별 실패 무시 */
    }
  }
}

/**
 * fetch 매물들 → "최저가 매물" 원본 통화 그대로(환율 변환 없음 → 빠름).
 * GGG 가 가격 오름차순으로 주므로 첫 매물이 최저가. divine/exalted 면 해당 필드,
 * 그 외 통화면 altAmount/altCurrency. low=가장 싼 몇 건(맥락용).
 */
function cheapestFromRows(rows, total) {
  const priced = [];
  for (const row of rows) {
    const p = row && row.listing && row.listing.price;
    if (p && typeof p.amount === 'number' && p.amount > 0 && p.currency) {
      priced.push({ amount: p.amount, currency: p.currency });
    }
  }
  if (!priced.length) return null;
  const c = priced[0];
  const out = {
    divine: null, exalted: null, altAmount: null, altCurrency: null,
    listingCount: typeof total === 'number' ? total : priced.length,
    sampled: priced.length,
    low: priced.slice(0, 6),
  };
  if (c.currency === 'divine') out.divine = c.amount;
  else if (c.currency === 'exalted' || c.currency === 'exalt') out.exalted = c.amount;
  else {
    out.altAmount = c.amount;
    out.altCurrency = c.currency;
  }
  return out;
}

// ---------------------------------------------------------------------------
// 검색 쿼리 빌더
// ---------------------------------------------------------------------------

/** 카탈로그 레코드 → GGG trade2 검색 본문.
 *  유니크는 **이름만**(고유 아이템은 옵션이 고정이라 기반/상세 필터 불필요). 그 외는 type.
 *  status:'any' = 온라인+오프라인(거래가 아니라 가치 평가). */
function buildQuery(rec) {
  const status = { option: 'any' };
  const isUnique = typeof rec.categoryKey === 'string' && rec.categoryKey.startsWith('unique');
  if (isUnique && rec.en) {
    return { query: { status, name: rec.en }, sort: { price: 'asc' } };
  }
  return { query: { status, type: rec.en }, sort: { price: 'asc' } };
}

/** 폴백: 자유 텍스트(term) 검색. 이름 문자열이 GGG와 약간 다를 때. */
function buildTermQuery(rec) {
  return { query: { status: { option: 'any' }, term: rec.en }, sort: { price: 'asc' } };
}

// ---------------------------------------------------------------------------
// 가격 조회
// ---------------------------------------------------------------------------
const _priceCache = new Map(); // signature → { price, at }

function signature(rec) {
  return [rec.categoryKey, rec.enNorm || rec.en, rec.baseType || '', rec.corrupted ? 1 : 0].join('|');
}

async function search(league, body) {
  const url = `${TRADE_BASE}/search/${encodeURIComponent(league)}`;
  return _throttle('search', () => postJson(url, body, GGG_REQ));
}

async function fetchListings(league, queryId, ids) {
  const url = `${TRADE_BASE}/fetch/${ids.join(',')}?query=${queryId}`;
  return _throttle('fetch', () => getJson(url, GGG_REQ));
}

/**
 * 한 아이템의 실시간 시세를 구한다.
 * @returns {Promise<null | {exalted:number, divine:number|null, min:number,
 *   listingCount:number, sampled:number, currencies:string[]}>}
 *   null = 매물 없음/조회 실패.
 */
async function priceItem(league, rec, opts = {}) {
  if (!league || !rec || !rec.en) return null;
  const sig = signature(rec);
  const cached = _priceCache.get(sig);
  if (cached && Date.now() - cached.at < PRICE_TTL) return cached.price;

  // 1) 검색(기본 → 실패 시 term 폴백)
  let sres = null;
  try {
    sres = await search(league, buildQuery(rec));
  } catch (e) {
    if (e && e.status === 429) return { rateLimited: true }; // 조회 한도 — 캐시 안 함
    if (e && e.status === 400) sres = null; // 알 수 없는 name/type → 폴백
    else throw e;
  }
  if (!sres || !Array.isArray(sres.result) || sres.result.length === 0) {
    try {
      sres = await search(league, buildTermQuery(rec));
    } catch (e) {
      if (e && e.status === 429) return { rateLimited: true };
      sres = null;
    }
  }
  if (!sres || !Array.isArray(sres.result) || sres.result.length === 0) {
    _priceCache.set(sig, { price: null, at: Date.now() });
    return null;
  }

  // 2) 상위 N 매물 상세
  const ids = sres.result.slice(0, SAMPLE_SIZE);
  let fres = null;
  try {
    fres = await fetchListings(league, sres.id, ids);
  } catch (e) {
    if (e && e.status === 429) return { rateLimited: true };
    return null; // 일시 오류는 캐시하지 않음
  }
  const rows = (fres && fres.result) || [];

  // 3) 최저가 매물을 원본 통화 그대로(환율 변환 없음). 매물 없으면 null.
  const price = cheapestFromRows(rows, sres.total);
  if (!price) {
    _priceCache.set(sig, { price: null, at: Date.now() });
    return null;
  }
  _priceCache.set(sig, { price, at: Date.now() });
  return price;
}

// ---------------------------------------------------------------------------
// 옵션(모드) 기반 검색 — 레어 아이템의 "동급 이상" 실시세
// ---------------------------------------------------------------------------

// 모드 중요도 키워드(높을수록 보편적으로 값나가는 옵션 → 추려서 남길 우선순위).
const MOD_KEYWORDS = [
  { re: /생명력|life/i, w: 100 },
  { re: /정신력|spirit/i, w: 95 },
  { re: /저항|resist/i, w: 88 },
  { re: /이동\s*속도|movement speed/i, w: 85 },
  { re: /모든 속성|모든 능력치|힘|민첩|지능|attribute/i, w: 72 },
  { re: /공격 속도|시전 속도|attack speed|cast speed/i, w: 66 },
  { re: /피해|damage/i, w: 60 },
  { re: /치명타|critical/i, w: 54 },
  { re: /방어도|회피|에너지 보호막|armour|evasion|energy shield/i, w: 40 },
];

function modWeight(clean) {
  for (const k of MOD_KEYWORDS) if (k.re.test(clean)) return k.w;
  return 20;
}

// 클립보드 "아이템 종류"(한글) → GGG trade2 카테고리 id. 검색을 같은 부위로 좁힌다
// (옵션만으로 검색하면 방어구·방패 등 다른 부위가 섞여 시세가 부정확해짐).
const KR_CLASS_TO_CATEGORY = Object.freeze({
  // 액세서리
  허리띠: 'accessory.belt', 목걸이: 'accessory.amulet', 부적: 'accessory.amulet', 반지: 'accessory.ring',
  // 방어구
  투구: 'armour.helmet', 모자: 'armour.helmet',
  갑옷: 'armour.chest', '몸통 갑옷': 'armour.chest', 흉갑: 'armour.chest',
  장갑: 'armour.gloves', 건틀릿: 'armour.gloves',
  장화: 'armour.boots', 신발: 'armour.boots', 부츠: 'armour.boots',
  방패: 'armour.shield', 버클러: 'armour.buckler', 집중구: 'armour.focus', 화살통: 'armour.quiver',
  // 무기
  단검: 'weapon.dagger', 클로: 'weapon.claw', 한손검: 'weapon.onesword', '한손 도끼': 'weapon.oneaxe',
  '한손 철퇴': 'weapon.onemace', 창: 'weapon.spear', 도리깨: 'weapon.flail', 양손검: 'weapon.twosword',
  '양손 도끼': 'weapon.twoaxe', '양손 철퇴': 'weapon.twomace', 육척봉: 'weapon.warstaff', 활: 'weapon.bow',
  석궁: 'weapon.crossbow', 마법봉: 'weapon.wand', 셉터: 'weapon.sceptre', 지팡이: 'weapon.staff',
  // 기타
  주얼: 'jewel',
});

/** 클립보드 아이템 종류(한글) → GGG 카테고리 id(없으면 null → 타입필터 생략). */
function gggCategoryId(krClass) {
  if (!krClass || typeof krClass !== 'string') return null;
  return KR_CLASS_TO_CATEGORY[krClass.trim()] || null;
}

/** stats/카테고리/희귀도/아이템레벨 → trade2 query 객체.
 *  status:'any' = 온라인+오프라인(가치 평가 → 접속 무관). opts:{category, rarity, ilvl}.
 *  옵션(stats) 없이 카테고리만으로도 검색 가능(베이스 아이템). */
function buildStatQuery(statFilters, opts = {}) {
  const query = { status: { option: 'any' } };
  if (Array.isArray(statFilters) && statFilters.length) {
    query.stats = [{ type: 'and', filters: statFilters }];
  }
  const typeFilters = {};
  if (opts.category) typeFilters.category = { option: opts.category };
  if (opts.rarity) typeFilters.rarity = { option: opts.rarity };
  const filters = {};
  if (Object.keys(typeFilters).length) filters.type_filters = { filters: typeFilters };
  if (opts.ilvl) filters.misc_filters = { filters: { ilvl: { min: Number(opts.ilvl) } } };
  if (Object.keys(filters).length) query.filters = filters;
  return query;
}

// 검색 min = 아이템의 실제 굴림값(기준값). 멀티값(# ~ # 피해추가)은 평균.
// (아이템 "가치 평가"용 — 내 아이템과 동급 이상[≥기준값] 매물의 시세를 본다. 자체적으로 값을
//  낮추거나 옵션을 빼면 더 싼 하위 매물이 섞여 평가가 왜곡되므로 절대 완화하지 않는다)
function searchMin(value) {
  return Math.round(value);
}

function statFilterValue(values) {
  if (!values || !values.length) return undefined;
  const base = values.length >= 2 ? (values[0] + values[1]) / 2 : values[0];
  return { min: searchMin(base) };
}

function tradeUrl(league, id) {
  return `https://www.pathofexile.com/trade2/search/poe2/${encodeURIComponent(league)}/${id}`;
}

/** 검색 결과(sres)의 최저가 매물을 원본 통화 그대로 반환(환율 변환 없음 → 빠름). */
async function _priceFromSearch(league, sres) {
  const ids = sres.result.slice(0, SAMPLE_SIZE);
  let fres = null;
  try {
    fres = await fetchListings(league, sres.id, ids);
  } catch (e) {
    return null;
  }
  return cheapestFromRows((fres && fres.result) || [], sres.total);
}

/**
 * 임의의 stat 필터 목록으로 "동급 이상" 매물 실시세. (인터랙티브 옵션선택 UI 용)
 * @param {string} league
 * @param {Array<{id:string, value?:{min?:number,max?:number}}>} statFilters
 * @returns {Promise<null | {exalted, divine, min, listingCount, sampled, searchUrl, empty?:boolean}>}
 */
async function priceByStatFilters(league, statFilters, opts = {}) {
  const hasStats = Array.isArray(statFilters) && statFilters.length > 0;
  // 옵션(stats) 또는 카테고리 둘 중 하나는 있어야 검색(베이스 아이템은 카테고리+ilvl 만).
  if (!league || (!hasStats && !opts.category)) return null;
  // 선택한 옵션 "그대로" 단일 검색. 자동 완화 없음 — 매물 없으면 없는 대로 정직하게 보여준다
  // (중요 옵션을 빼고 싼 값을 보여주면 아이템 가치 평가가 왜곡되므로).
  const body = { query: buildStatQuery(hasStats ? statFilters : [], opts), sort: { price: 'asc' } };
  let sres = null;
  try {
    sres = await search(league, body);
  } catch (e) {
    if (e && e.status === 429) return { rateLimited: true };
    return null;
  }
  if (!sres || !Array.isArray(sres.result) || !sres.result.length) {
    return {
      exalted: null, divine: null, min: null,
      listingCount: (sres && sres.total) || 0, sampled: 0,
      searchUrl: sres && sres.id ? tradeUrl(league, sres.id) : null, empty: true,
    };
  }
  const p = await _priceFromSearch(league, sres);
  if (!p) return null;
  return { ...p, searchUrl: tradeUrl(league, sres.id) };
}

/**
 * 아이템의 모드를 stat id 로 매칭하고 가중치/기본선택을 부여한 목록.
 * 인터랙티브 옵션선택 UI(Shift+F9)가 이 목록으로 체크박스를 그린다.
 * @returns {Array<{text, affix, statType, id:string|null, values:number[],
 *   weight:number, matched:boolean, checked:boolean}>}
 */
function matchItemMods(item, statIndex) {
  const out = (item.mods || []).map((m) => {
    const r = matchMod(statIndex, m.clean, m.statType);
    const values = r ? r.values : m.values || [];
    const base = values.length >= 2 ? (values[0] + values[1]) / 2 : values[0];
    return {
      text: m.clean,
      affix: m.affix,
      statType: m.statType,
      id: r ? r.id : null,
      values,
      defaultMin: base != null ? searchMin(base) : '', // 굴림값×0.8 (인게임 "아이템으로 검색"과 동일)
      weight: modWeight(m.clean),
      matched: !!r,
      // 기본 선택: 매칭된 "실제 옵션"(explicit/rune/crafted/fractured) 전부 체크.
      // implicit(베이스 공통)·매칭불가만 해제. → 룬 모드도 기본 포함.
      checked: !!r && m.statType !== 'implicit' && m.statType !== 'pseudo' && m.statType !== 'enchant',
    };
  });
  // 검색 가능한(매칭) 모드를 위로, 불가(회색)는 아래로 정렬 → 상단 정돈.
  out.sort((a, b) => Number(b.matched) - Number(a.matched) || b.weight - a.weight);
  return out;
}

/**
 * 옵션(모드)으로 "이 아이템과 동급 이상" 매물의 실시세를 구한다(F9 자동).
 * 매칭된 explicit 모드 "전부"를 기준값(굴림값)으로 AND 검색 — 옵션을 빼지 않는다.
 * 매물 없으면 empty 로 정직하게 반환(가치 왜곡 방지).
 * @returns {Promise<null | {exalted, divine, min, listingCount, sampled,
 *   usedMods:string[], totalExplicit:number, searchUrl:string, empty?:boolean}>}
 */
async function priceByMods(league, item, statIndex, opts = {}) {
  if (!league || !item || !statIndex) return null;
  // explicit 모드만(implicit 은 베이스 공통). 매칭된 것 전부 사용.
  const matched = [];
  for (const m of item.mods || []) {
    if (m.statType !== 'explicit') continue;
    const r = matchMod(statIndex, m.clean, m.statType);
    if (r && r.id) matched.push({ id: r.id, values: r.values, clean: m.clean });
  }
  if (!matched.length) return null;
  const filters = matched.map((f) => ({ id: f.id, value: statFilterValue(f.values) }));
  const res = await priceByStatFilters(league, filters, opts);
  if (!res) return null;
  return { ...res, usedMods: matched.map((m) => m.clean), totalExplicit: matched.length };
}

/** 캐시 비우기(리그 전환·강제 갱신 시). */
function clearCache() {
  _priceCache.clear();
  _rateCache.clear();
}

module.exports = {
  priceItem,
  priceByMods,
  priceByStatFilters,
  matchItemMods,
  gggCategoryId,
  prewarmRates,
  buildStatQuery,
  statFilterValue,
  modWeight,
  getRate,
  buildQuery,
  buildTermQuery,
  median,
  signature,
  clearCache,
};
