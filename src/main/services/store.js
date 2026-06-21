'use strict';

const { EventEmitter } = require('events');
const { TTL } = require('../config');
const { DiskCache } = require('./cache');
const { fetchLeagues } = require('./leagues');
const { buildDictionary } = require('./dictionary');
const { buildCatalog } = require('./catalog');
const { search, scoreRecord } = require('./search');
const { normKr, normEn, jamoSimilarity, decomposeHangul, levenshtein } = require('./normalize');
const { extractItemName, parseRecipeLines } = require('./itemtext');
const { parseItem } = require('./itemparse');
const { isElevated } = require('./elevation');
const ggg = require('./ggg');
const { fetchRawStats, buildStatIndex } = require('./stats');
const errorReport = require('./errorReport');

// F10 스캔에서 GGG 실시간 조회할 최대 아이템 수(레이트리밋·지연 한계). 초과분은 partial 표시.
const MAX_SCAN_PRICE = 8;
// F10 오버레이에 표시할 최대 아이템 수(화폐 거래소 "모두" 탭이 ~60종). 초과분은 잘라내고 partial 표시.
const MAX_SCAN_DISPLAY = 60;
// 레어/카탈로그 즐겨찾기의 "은신처로 이동" 기본 거래 도메인(한국 서버 — 사용자가 KR 에서 플레이).
const TRAVEL_HOST = 'poe.kakaogames.com';

/** 카탈로그 레코드 + GGG 라이브 가격 → 표시용 레코드(불변 복사).
 *  ninja 의 value/change7d 는 표시에서 배제하고 GGG 실측가로 덮어쓴다. */
function withLivePrice(rec, live) {
  return {
    ...rec,
    valueDivine: live ? live.divine : null,
    valueExalted: live ? live.exalted : null,
    valueChaos: null,
    change7d: null, // ninja 7일 변동은 더 이상 신뢰원으로 쓰지 않음
    listingCount: live ? live.listingCount : null,
    // 최저가 매물이 divine/exalted 가 아닌 통화면(예: chaos) 원본 그대로 표기.
    altPrice: live && live.altAmount ? { amount: live.altAmount, currency: live.altCurrency } : null,
  };
}

/** 즐겨찾기 저장용 가격 스냅샷(divine/exalted/alt 중 있는 것). 없으면 null. */
function priceSnapshot(p) {
  if (!p || (p.divine == null && p.exalted == null && p.altAmount == null)) return null;
  return {
    divine: p.divine ?? null,
    exalted: p.exalted ?? null,
    altAmount: p.altAmount ?? null,
    altCurrency: p.altCurrency ?? null,
    listingCount: p.listingCount ?? null,
  };
}

/**
 * 앱의 데이터 상태 보관소.
 * 캐시(사전/리그/카탈로그)를 관리하고, 검색·갱신·리그변경을 조율한다.
 * 진행 상태는 'status' 이벤트로 방출 → 메인이 렌더러로 전달.
 */
class Store extends EventEmitter {
  constructor(cacheDir) {
    super();
    this.cache = new DiskCache(cacheDir);
    this.leagues = [];
    this.selectedLeague = null; // league name (예: "Runes of Aldur")
    this.dict = null;
    this.catalog = null;
    this.building = false;
    this.phase = 'idle'; // idle | loading | ready | error
    this.lastMessage = '';
    this.hotkeyOk = true; // F9 전역 단축키 등록 성공 여부
    this.elevated = null; // 관리자 권한 여부(null=미확인/비win)
    this._settings = null; // 영속 설정 캐시(메모리)
  }

  /** 영속 설정 객체(league, startInTray 등)를 읽는다. */
  async getSettings() {
    if (!this._settings) this._settings = (await this.cache.get('settings', Infinity)) || {};
    return this._settings;
  }

  /** 설정 한 항목을 병합 저장. */
  async setSetting(key, value) {
    const s = await this.getSettings();
    s[key] = value;
    this._settings = s;
    await this.cache.set('settings', s);
    return s;
  }

  /** F9 단축키 등록 결과를 반영하고 상태를 방출. */
  setHotkeyOk(ok) {
    this.hotkeyOk = !!ok;
    this.emit('status', this.status());
  }

  /** 관리자 권한 여부를 확인해 상태에 반영. */
  async checkElevation() {
    this.elevated = await isElevated();
    this.emit('status', this.status());
  }

  status() {
    return {
      phase: this.phase,
      building: this.building,
      leagueName: this.selectedLeague,
      leagues: this.leagues,
      count: this.catalog ? this.catalog.records.length : 0,
      updatedAt: this.catalog ? this.catalog.updatedAt : null,
      errors: this.catalog ? this.catalog.errors : [],
      ref: this.catalog ? this.catalog.ref : null,
      message: this.lastMessage,
      hotkeyOk: this.hotkeyOk,
      elevated: this.elevated,
    };
  }

  _emit(phase, message) {
    if (phase) this.phase = phase;
    if (message != null) this.lastMessage = message;
    // 가격 조회 실패는 모두 이 choke point를 통과한다 → 자동 신고용 버퍼에 적재.
    if (phase === 'error') {
      errorReport.record({ message, league: this.selectedLeague });
    }
    this.emit('status', this.status());
  }

  async _getDict(force = false) {
    if (this.dict && !force) return this.dict;
    if (!force) {
      const cached = await this.cache.get('dictionary_v2', TTL.dictionary);
      if (cached && cached.enToKr) {
        this.dict = cached;
        return this.dict;
      }
    }
    this._emit('loading', '한글 사전 받는 중…');
    const dict = await buildDictionary();
    await this.cache.set('dictionary_v2', dict);
    this.dict = dict;
    return dict;
  }

  /** 옵션 검색용 한글 스탯 인덱스(모드텍스트→stat id). 메모리+디스크(raw) 캐시. */
  async _getStatIndex(force = false) {
    if (this._statIndex && !force) return this._statIndex;
    let raw = force ? null : await this.cache.get('stats', TTL.dictionary);
    if (!raw || !raw.result) {
      raw = await fetchRawStats();
      await this.cache.set('stats', raw);
    }
    this._statIndex = buildStatIndex(raw);
    return this._statIndex;
  }

  /** 통화 아이콘 맵(id→URL)을 ref 에 부착 → 렌더러가 가격 옆에 아이콘 표시. */
  _attachIcons() {
    if (this.catalog && this.catalog.ref && this.dict && this.dict.currencyIcons) {
      this.catalog.ref.currencyIcons = this.dict.currencyIcons;
    }
  }

  async _getLeagues(force = false) {
    // 디스크 캐시 TTL(6h)에 맡긴다 — 메모리 단락으로 프로세스 수명 내내 stale 되지 않도록.
    let data = force ? null : await this.cache.get('leagues', TTL.leagues);
    if (!data) {
      data = await fetchLeagues();
      await this.cache.set('leagues', data);
    }
    this.leagues = data.leagues;
    if (!this.selectedLeague) {
      const settings = await this.getSettings();
      const wanted = settings.league;
      const exists = wanted && data.leagues.some((l) => l.name === wanted);
      this.selectedLeague = exists ? wanted : data.current ? data.current.name : null;
    }
    return this.leagues;
  }

  _catalogKey() {
    return 'catalog_' + (this.selectedLeague || 'default');
  }

  async _ensureCatalog(force = false) {
    const key = this._catalogKey();
    if (!force) {
      const cached = await this.cache.get(key, TTL.prices);
      if (cached && cached.records) {
        this.catalog = cached;
        await this._getDict(); // 통화 아이콘 맵 확보
        this._attachIcons();
        return cached;
      }
    }
    this._emit('loading', `${this.selectedLeague} 시세 받는 중…`);
    const dict = await this._getDict();
    try {
      const catalog = await buildCatalog(this.selectedLeague, dict);
      await this.cache.set(key, catalog);
      this.catalog = catalog;
      this._attachIcons();
      return catalog;
    } catch (e) {
      // 빌드 실패 시 만료된 캐시라도 폴백
      const stale = await this.cache.getEntry(key);
      if (stale && stale.data && stale.data.records) {
        this.catalog = stale.data;
        this._attachIcons();
        return this.catalog;
      }
      throw e;
    }
  }

  /** 최초 1회 초기화: 리그 → (캐시된)카탈로그 → ready */
  async initialize() {
    if (this.building) return;
    this.building = true;
    try {
      this._emit('loading', '리그 정보 확인 중…');
      await this._getLeagues();
      await this._ensureCatalog(false);
      this.building = false;
      this._emit('ready', '준비 완료');
    } catch (e) {
      this.building = false;
      this._emit('error', '데이터 로드 실패: ' + (e && e.message ? e.message : e));
    }
  }

  /** 강제 갱신(시세 새로고침). */
  async refresh() {
    if (this.building) return;
    this.building = true;
    try {
      ggg.clearCache(); // 실시간 시세 캐시도 강제 갱신
      await this._getLeagues(false);
      await this._ensureCatalog(true);
      this.building = false;
      this._emit('ready', '갱신 완료');
    } catch (e) {
      this.building = false;
      this._emit('error', '갱신 실패: ' + (e && e.message ? e.message : e));
    }
  }

  /** 리그 변경 후 해당 리그 카탈로그 로드. */
  async setLeague(name) {
    if (!name || name === this.selectedLeague) return;
    if (this.building) return; // initialize/refresh 와 동시 빌드 방지(레이스 차단)
    this.building = true; // 첫 await 이전에 동기적으로 잠금
    this.selectedLeague = name;
    ggg.clearCache(); // 리그가 바뀌면 이전 리그 시세는 무효
    try {
      await this.setSetting('league', name);
      this._emit('loading', `${name} 로 전환 중…`);
      await this._ensureCatalog(false);
      this.building = false;
      this._emit('ready', '리그 전환 완료');
    } catch (e) {
      this.building = false;
      this._emit('error', '리그 전환 실패: ' + (e && e.message ? e.message : e));
    }
  }

  /**
   * 레어/매직 아이템: 붙은 옵션(모드)으로 "동급 이상" 실시세를 구해 표시용으로 가공.
   * @returns {Promise<object>}
   */
  async _priceRare(parsed) {
    let price = null;
    try {
      const idx = await this._getStatIndex();
      price = await ggg.priceByMods(this.selectedLeague, parsed, idx, {
        category: ggg.gggCategoryId(parsed.category),
      });
    } catch (e) {
      /* 네트워크/레이트리밋 → 시세 없음 */
    }
    const name = parsed.base || parsed.name;
    const hasPrice = price && (price.divine != null || price.exalted != null || price.altAmount != null);
    if (!price || price.rateLimited || price.empty || !hasPrice) {
      const reason = price && price.rateLimited ? '조회 한도(30분) — 잠시 후 다시' : '동급 매물 없음';
      return { found: false, rare: true, name, reason };
    }
    const record = {
      kr: name,
      en: parsed.name,
      labelKr: '레어',
      baseType: parsed.base || '',
      corrupted: parsed.corrupted,
      valueDivine: price.divine,
      valueExalted: price.exalted,
      valueChaos: null,
      change7d: null,
      listingCount: price.listingCount,
      altPrice: price.altAmount ? { amount: price.altAmount, currency: price.altCurrency } : null,
    };
    return {
      found: true,
      rare: true,
      record,
      live: price,
      ref: this.catalog.ref,
      name,
      subnote: `옵션 ${price.usedMods.length}/${price.totalExplicit}개 기준`,
      searchUrl: price.searchUrl,
    };
  }

  /**
   * Shift+F9 인터랙티브: 클립 텍스트 → 아이템 메타 + 토글 가능한 모드 목록.
   * @returns {Promise<null | {name,base,category,rarity,itemLevel,corrupted, mods:Array}>}
   */
  async inspectItem(clipText) {
    const parsed = parseItem(clipText);
    if (!parsed) return null;
    let mods = [];
    try {
      const idx = await this._getStatIndex();
      mods = ggg.matchItemMods(parsed, idx);
    } catch (e) {
      /* 스탯 사전 실패 → 메타만 */
    }
    // 유니크는 옵션만으론 다른 아이템과 섞인다 → 카탈로그로 한글명→영문명 해석해 이름까지 검색.
    let uniqueName = null;
    if (parsed.rarity === 'unique' && this.catalog && parsed.name) {
      try {
        const results = search(this.catalog.records, parsed.name, 5);
        const uni = results.find((r) => this._isUnique(r));
        if (uni) uniqueName = uni.en;
      } catch (e) {
        /* 카탈로그 매칭 실패 → 이름 없이 옵션으로만 검색 */
      }
    }
    return {
      name: parsed.name,
      base: parsed.base,
      category: parsed.category,
      categoryId: ggg.gggCategoryId(parsed.category), // GGG 타입 필터용(없으면 null)
      rarity: parsed.rarity,
      uniqueName, // 유니크 영문명(카탈로그 해석) — 있으면 이름으로 검색
      itemLevel: parsed.itemLevel,
      corrupted: parsed.corrupted,
      sockets: parsed.sockets, // 룬 소켓(홈) 개수 — 검색 필터용
      mods,
      currencyIcons: (this.dict && this.dict.currencyIcons) || null,
    };
  }

  /**
   * 인터랙티브: 고른 옵션(필터)으로 동급이상 실시세. 옵션 없이 카테고리/아이템레벨만으로도 검색(베이스).
   * @param {Array<{id:string, min?:number, max?:number}>} picks
   * @param {{category?:string, ilvl?:number, rarity?:string}} [opts]
   */
  async priceByFilters(picks, opts = {}) {
    if (!this.selectedLeague) return null;
    const filters = (Array.isArray(picks) ? picks : [])
      .filter((p) => p && p.id)
      .map((p) => {
        const value = {};
        if (p.min != null && p.min !== '') value.min = Number(p.min);
        if (p.max != null && p.max !== '') value.max = Number(p.max);
        return { id: p.id, value: Object.keys(value).length ? value : undefined };
      });
    if (!filters.length && !opts.category && !opts.name) return null;
    try {
      return await ggg.priceByStatFilters(this.selectedLeague, filters, opts || {});
    } catch (e) {
      return null;
    }
  }

  /** 검색. 카탈로그 미준비면 빈 배열. */
  query(text, limit = 40) {
    if (!this.catalog) return [];
    return search(this.catalog.records, text, limit);
  }

  /** 장착 장비(유니크)인가 — GGG 실시세 대상. 그 외(화폐·룬·우상 등 commodity)는 ninja. */
  _isUnique(rec) {
    return !!(rec && typeof rec.categoryKey === 'string' && rec.categoryKey.startsWith('unique'));
  }

  /**
   * 카탈로그 레코드의 시세.
   *  - 유니크(장착 장비) → GGG 거래소 실시세(아이템별).
   *  - 화폐/룬/우상/소모품(commodity) → ninja 집계값(즉시, 빠름).
   * @returns {Promise<null | {exalted, divine, listingCount}>}
   */
  async _priceRecord(rec) {
    if (this._isUnique(rec)) {
      return ggg.priceItem(this.selectedLeague, rec);
    }
    if (rec.valueExalted == null && rec.valueDivine == null) return null;
    return { exalted: rec.valueExalted, divine: rec.valueDivine, listingCount: null };
  }

  // ---- 즐겨찾기 (메인창 적재 워치리스트) ----

  /** 저장된 즐겨찾기 목록. */
  async getFavorites() {
    const s = await this.getSettings();
    return Array.isArray(s.favorites) ? s.favorites : [];
  }

  async _saveFavorites(list) {
    await this.setSetting('favorites', list);
    this.emit('favorites', list); // 메인창 실시간 갱신(인게임에서 담아도 반영)
    return list;
  }

  /** 카탈로그 아이템(유니크/통화)을 즐겨찾기에 추가(+즉시 시세 1회). */
  async addCatalogFavorite(rec) {
    if (!rec || !rec.en) return this.getFavorites();
    const enNorm = rec.enNorm || normEn(rec.en);
    const key = 'cat:' + [rec.categoryKey, enNorm, rec.baseType || '', rec.corrupted ? 1 : 0].join('|');
    const list = await this.getFavorites();
    if (list.some((f) => f.key === key)) return list;
    let lastPrice = null;
    try {
      lastPrice = priceSnapshot(await this._priceRecord(rec));
    } catch (e) {
      /* 가격 실패해도 즐겨찾기는 저장 */
    }
    const fav = {
      key, kind: 'catalog',
      kr: rec.kr || rec.en, en: rec.en, base: rec.baseType || '', icon: rec.icon || '', labelKr: rec.labelKr || '',
      rec: { en: rec.en, enNorm, categoryKey: rec.categoryKey, baseType: rec.baseType || '', corrupted: !!rec.corrupted },
      lastPrice, savedAt: Date.now(),
    };
    return this._saveFavorites([...list, fav]);
  }

  /** 레어(옵션) 또는 베이스(옵션 없이 타입+ilvl) 검색을 즐겨찾기에 추가.
   *  data:{name,base,categoryId,ilvl,rarity,filters:[{id,min}],mods:[text],price} */
  async addRareFavorite(data) {
    const hasFilters = data && Array.isArray(data.filters) && data.filters.length;
    if (!data || (!hasFilters && !data.categoryId)) return this.getFavorites();
    const fsig = (data.filters || []).map((f) => f.id + ':' + (f.min != null ? f.min : '')).sort().join(',');
    const sig = fsig + '|il' + (data.ilvl || '') + '|sk' + (data.sockets ?? '') + '|r' + (data.rarity || '');
    const key = 'rare:' + (data.base || data.name || '') + '|' + sig;
    const list = await this.getFavorites();
    if (list.some((f) => f.key === key)) return list;
    const fav = {
      key, kind: 'rare',
      kr: data.base || data.name || '레어', en: data.name || '', base: data.base || '',
      categoryId: data.categoryId || null, ilvl: data.ilvl || null, sockets: data.sockets || null,
      uniqueName: data.uniqueName || null, rarity: data.rarity || null,
      filters: data.filters || [], mods: Array.isArray(data.mods) ? data.mods : [],
      lastPrice: data.price || null, savedAt: Date.now(),
    };
    return this._saveFavorites([...list, fav]);
  }

  /**
   * 거래 검색 URL(사용자가 크롬 즐겨찾기처럼 보던 것)을 즐겨찾기에 추가.
   * URL → 저장된 검색을 실행해 현재 최저가를 붙인다. 도메인 화이트리스트로 SSRF 차단.
   * @returns {Promise<{ok:boolean, error?:string, favorites:Array}>}
   */
  async addUrlFavorite(url) {
    const parsed = ggg.parseTradeUrl(url);
    if (!parsed) return { ok: false, error: 'invalid', favorites: await this.getFavorites() };
    // 키는 apiBase(realm) 기준 — www/비www 같은 host 별칭이 같은 검색을 중복 등록하지 않게.
    const key = 'url:' + parsed.apiBase + '|' + parsed.id;
    const list = await this.getFavorites();
    if (list.some((f) => f.key === key)) return { ok: false, error: 'duplicate', favorites: list };
    let lastPrice = null;
    try {
      const p = await ggg.fetchSavedSearch(parsed);
      // 매물 0건이면 '매물 없음'으로 저장(reprice 와 동일 표기). 조회 자체 실패면 null('미조회').
      lastPrice = priceSnapshot(p) || (p && p.empty ? { empty: true } : null);
    } catch (e) {
      /* 가격 실패해도 즐겨찾기는 저장(다음에 새로고침) */
    }
    const fav = {
      key, kind: 'url', url: parsed.url, host: parsed.host, league: parsed.league, id: parsed.id,
      kr: parsed.league, labelKr: '거래 URL', base: parsed.id,
      lastPrice, savedAt: Date.now(),
    };
    const favorites = await this._saveFavorites([...list, fav]);
    return { ok: true, favorites };
  }

  async removeFavorite(key) {
    const list = await this.getFavorites();
    return this._saveFavorites(list.filter((f) => f.key !== key));
  }

  /** 즐겨찾기에 사용자 라벨(메모)을 설정/해제. 빈 문자열이면 라벨 제거. */
  async setFavoriteLabel(key, label) {
    const list = await this.getFavorites();
    if (!list.some((f) => f.key === key)) return list;
    const clean = typeof label === 'string' ? label.trim().slice(0, 60) : '';
    return this._saveFavorites(list.map((f) => (f.key === key ? { ...f, label: clean || undefined } : f)));
  }

  /** 즐겨찾기 종류별 현재 시세 조회(최저가 매물). 갱신·귓속말 양쪽이 공유. */
  async _favoritePrice(fav) {
    if (!fav) return null;
    if (fav.kind === 'catalog') return this._priceRecord(fav.rec);
    if (fav.kind === 'url') {
      const parsed = ggg.parseTradeUrl(fav.url);
      return parsed ? ggg.fetchSavedSearch(parsed) : null;
    }
    const filters = (fav.filters || []).map((f) => ({ id: f.id, value: f.min != null ? { min: Number(f.min) } : undefined }));
    return ggg.priceByStatFilters(this.selectedLeague, filters, {
      category: fav.categoryId || undefined, ilvl: fav.ilvl || undefined, sockets: fav.sockets || undefined,
      name: fav.uniqueName || undefined, rarity: fav.rarity || undefined,
    });
  }

  /** 즐겨찾기 한 건의 시세를 다시 조회해 갱신. */
  async repriceFavorite(key) {
    const list = await this.getFavorites();
    const fav = list.find((f) => f.key === key);
    if (!fav) return list;
    let price = null;
    try {
      price = await this._favoritePrice(fav);
    } catch (e) {
      /* 실패 → 기존 값 유지 */
    }
    let lastPrice = fav.lastPrice;
    const snap = priceSnapshot(price);
    if (snap) lastPrice = snap;
    else if (price && price.empty) lastPrice = { empty: true };
    return this._saveFavorites(list.map((f) => (f.key === key ? { ...f, lastPrice } : f)));
  }

  /**
   * 즐겨찾기 → "은신처로 이동" 실행 대상(거래 도메인·리그·검색조건).
   * URL 즐겨찾기는 그 도메인/저장검색을, 레어/카탈로그는 한국 서버에서 검색바디로 이동한다.
   * @returns {null | {host:string, league:string, savedId?:string, searchBody?:object}}
   */
  getTravelTarget(fav) {
    if (!fav) return null;
    if (fav.kind === 'url') {
      const parsed = ggg.parseTradeUrl(fav.url);
      if (!parsed) return null;
      return { host: parsed.host, league: parsed.league, savedId: parsed.id };
    }
    const league = this.selectedLeague;
    if (!league) return null;
    if (fav.kind === 'catalog') {
      return { host: TRAVEL_HOST, league, searchBody: ggg.buildQuery(fav.rec) };
    }
    // rare: 옵션 필터 + 카테고리/ilvl/소켓/이름
    const filters = (fav.filters || [])
      .filter((f) => f && f.id)
      .map((f) => ({ id: f.id, value: f.min != null ? { min: Number(f.min) } : undefined }));
    const searchBody = ggg.buildStatQuery(filters, {
      category: fav.categoryId || undefined, ilvl: fav.ilvl || undefined,
      sockets: fav.sockets || undefined, name: fav.uniqueName || undefined, rarity: fav.rarity || undefined,
    });
    return { host: TRAVEL_HOST, league, searchBody };
  }

  /** 키로 즐겨찾기를 찾아 이동 대상을 반환. */
  async resolveTravelTarget(key) {
    const list = await this.getFavorites();
    return this.getTravelTarget(list.find((f) => f.key === key));
  }

  /**
   * 즐겨찾기의 현재 최저가 매물 "귓속말"(거래 메시지)을 구한다 — "은신처로 이동"용.
   * 최저가 매물은 수시로 바뀌므로 항상 새로 조회한다(캐시 스냅샷엔 귓속말을 저장하지 않음).
   * @returns {Promise<{ok:boolean, whisper?:string, seller?:string, reason?:string}>}
   */
  async getFavoriteWhisper(key) {
    const list = await this.getFavorites();
    const fav = list.find((f) => f.key === key);
    if (!fav) return { ok: false, reason: 'not_found' };
    let price = null;
    try {
      price = await this._favoritePrice(fav);
    } catch (e) {
      return { ok: false, reason: 'error' };
    }
    if (price && price.rateLimited) return { ok: false, reason: 'rate_limited' };
    if (!price || price.empty || !price.whisper) return { ok: false, reason: 'no_listing' };
    return { ok: true, whisper: price.whisper, seller: price.seller || null };
  }

  /**
   * 단일 레코드의 GGG 실시간 시세(메인 창에서 행 클릭 시).
   * @returns {Promise<object|null>} {exalted, divine, listingCount, ...} 또는 null
   */
  async livePrice(rec) {
    if (!rec || !this.selectedLeague) return null;
    try {
      return await this._priceRecord(rec);
    } catch (e) {
      return null;
    }
  }

  /**
   * 인게임 가격체크: 클립보드 아이템 텍스트 → 이름 추출 → 카탈로그 정확 매칭 →
   * GGG 거래소 실시간 시세 부착(async).
   * @returns {Promise<{found:boolean, record?:object, live?:object|null, ref?:object, name?:string, reason?:string}>}
   */
  async priceCheck(clipText) {
    if (!this.catalog) return { found: false, reason: '준비 중' };

    // 레어/매직(랜덤 옵션 아이템)은 이름으로 시세가 안 나온다 → 붙은 옵션으로 "동급 이상" 검색.
    const parsed = parseItem(clipText);
    if (parsed && (parsed.rarity === 'rare' || parsed.rarity === 'magic') && parsed.mods.length) {
      return this._priceRare(parsed);
    }

    const name = extractItemName(clipText);
    if (!name) return { found: false, name: '' };
    const results = search(this.catalog.records, name, 5);
    if (!results.length) return { found: false, name };
    // 호버한 아이템은 정확한 이름이므로 완전 일치를 우선
    const qK = normKr(name);
    const qE = normEn(name);
    const best = results.find((r) => r.krNorm === qK || r.enNorm === qE) || results[0];
    // 유니크(장비)만 GGG 실시세, 화폐·룬·우상 등은 ninja 값 그대로(빠름).
    if (this._isUnique(best)) {
      let live = null;
      try {
        live = await ggg.priceItem(this.selectedLeague, best);
      } catch (e) {
        /* 네트워크 오류 → 시세 없음 */
      }
      if (live && live.rateLimited) {
        return { found: false, name, reason: '조회 한도(30분) — 잠시 후 다시' };
      }
      return { found: true, record: withLivePrice(best, live), live, ref: this.catalog.ref, name };
    }
    return { found: true, record: best, ref: this.catalog.ref, name, source: 'ninja' };
  }

  /**
   * 화면 OCR 라인들에서 인식된 아이템들의 시세를 GGG 거래소에서 한 번에 조회.
   * 수량×단가 합계 기준 비싼 순으로 정렬해 반환.
   * @param {string[]} ocrLines  OCR 인식 라인들
   * @param {(rec:object)=>Promise<object|null>} [pricer]  시세 조회자(테스트 주입용). 기본=GGG 거래소.
   * @returns {Promise<{scan:true, items:Array<{qty:number, record:object, live:object}>, ref:object, partial?:boolean, reason?:string}>}
   */
  async scanRecipe(ocrLines, pricer) {
    if (!this.catalog) return { scan: true, items: [], reason: '준비 중' };
    const price = pricer || ((rec) => this._priceRecord(rec));
    const parsed = parseRecipeLines(ocrLines);

    // (A) "Nx 아이템" 형식(조합/목록 행): 수량이 의미 있고, 유니크면 GGG 실시간 조회가 필요.
    const explicitUnique = [];
    const explicitSeen = new Set();
    for (const { qty, name, explicit } of parsed) {
      if (!explicit) continue;
      const rec = this._matchOcrName(name);
      if (!rec) continue;
      // 이름+수량 기준 중복제거: 같은 아이템이라도 수량이 다르면(6x·4x) 별개 행으로 유지한다.
      // 진짜 OCR 중복(같은 줄이 여러 타일/배율에서 읽힘)은 수량까지 같으므로 합쳐진다.
      const key = rec.categoryKey + '|' + rec.enNorm + '|' + qty;
      if (explicitSeen.has(key)) continue;
      explicitSeen.add(key);
      explicitUnique.push({ qty, record: rec });
    }

    // (B) 수량 없는 맨이름(화폐 거래소 등): 강하게 매칭된 commodity(화폐/룬/우상…)만 채택.
    // 카탈로그가 화이트리스트 역할 → 화면 잡텍스트는 매칭되지 않는다. ninja 캐시값으로 즉시 표시.
    const explicitKeys = new Set(explicitUnique.map((m) => m.record.categoryKey + '|' + m.record.enNorm));
    const bareSeen = new Set();
    const bareRecords = [];
    for (const { name, explicit } of parsed) {
      if (explicit) continue;
      const rec = this._matchCommodity(name);
      if (!rec) continue;
      const k = rec.categoryKey + '|' + rec.enNorm;
      if (explicitKeys.has(k) || bareSeen.has(k)) continue; // 조합행에 이미 잡힌 건 제외
      bareSeen.add(k);
      bareRecords.push(rec);
    }

    // GGG 레이트리밋·지연 한계 → 조합행은 상위 MAX_SCAN_PRICE 건만 실시간 조회.
    const capped = explicitUnique.slice(0, MAX_SCAN_PRICE);
    let partial = explicitUnique.length > capped.length;

    // 동시 조회: ggg 내부 스로틀이 버킷별로 직렬화하므로 안전.
    const explicitPriced = await Promise.all(
      capped.map(async (it) => {
        let live = null;
        try {
          live = await price(it.record);
        } catch (e) {
          /* 개별 실패는 제외 */
        }
        return live && live.exalted != null ? { qty: it.qty, record: withLivePrice(it.record, live), live } : null;
      })
    );

    // 맨이름 화폐는 GGG 조회 없이 ninja 집계값(레코드에 이미 있음)으로 즉시 — 수십 개라도 빠르고 안전.
    const barePriced = bareRecords.map((rec) => {
      const live = { exalted: rec.valueExalted, divine: rec.valueDivine, listingCount: null };
      return live.exalted == null && live.divine == null ? null : { qty: 1, record: withLivePrice(rec, live), live };
    });

    let items = [...explicitPriced, ...barePriced].filter(Boolean);
    items.sort((a, b) => b.qty * (b.live.exalted || 0) - a.qty * (a.live.exalted || 0));
    // 오버레이 표시 한계(너무 많으면 화면을 넘김) → 비싼 순 상위 MAX_SCAN_DISPLAY 만.
    if (items.length > MAX_SCAN_DISPLAY) {
      items = items.slice(0, MAX_SCAN_DISPLAY);
      partial = true;
    }
    return { scan: true, items, ref: this.catalog.ref, partial };
  }

  /**
   * 수량 없는 맨이름(화폐 거래소 라벨)에 대한 commodity 매칭.
   * OCR 오인식은 특정 케이스가 아니라 "글자수에 비례해 여러 글자가 틀리는" 일반적 현상이므로,
   * 자모 편집거리에 **길이 비례 허용 오차**를 적용한다(짧으면 1자, 길면 더). 카탈로그가
   * 화이트리스트라 화면 잡텍스트는 걸러지고, 허용 오차를 ~20%로 제한해 등급 변형
   * (하위/상위/완벽한 …, 접두어가 편집거리를 크게 늘림)은 서로 섞이지 않는다.
   * 유니크(장착 장비)는 제외 — 그건 F9/GGG 실시간 경로가 담당한다.
   * @returns {object|null} commodity 레코드 또는 null.
   */
  _matchCommodity(name) {
    const qKr = normKr(name);
    const qEn = normEn(name);
    if (qKr.length < 2 && qEn.length < 4) return null;
    const qJamo = qKr ? decomposeHangul(qKr) : '';
    let best = null;
    let bestScore = -Infinity;
    for (const rec of this.catalog.records) {
      if (this._isUnique(rec)) continue;
      if (rec.valueExalted == null && rec.valueDivine == null) continue; // 시세 없는 건 제외
      let s = -Infinity;
      if (qKr && rec.krNorm && rec.krNorm === qKr) s = 1000;
      else if (qEn && rec.enNorm && rec.enNorm.length >= 4 && rec.enNorm === qEn) s = 980;
      else if (
        qKr.length >= 2 &&
        rec.krNorm &&
        rec.krNorm.length >= 2 &&
        Math.abs(rec.krNorm.length - qKr.length) <= 4 // 음절 길이 사전 필터(편집거리 계산 절약)
      ) {
        const rJamo = decomposeHangul(rec.krNorm);
        const maxLen = Math.max(qJamo.length, rJamo.length) || 1;
        const edits = levenshtein(qJamo, rJamo);
        // 허용 오차 = 이름 길이의 ~20%(최소 1). 다중 글자 오인식도 비례해 흡수하되,
        // 편집거리가 곧 길이차 상한이라 등급 접두어(상위/완벽한 …)는 예산을 넘겨 자연 배제된다.
        const budget = Math.max(1, Math.round(maxLen * 0.2));
        if (edits <= budget) s = 800 - Math.round((edits / maxLen) * 300); // 적게 틀릴수록 높은 점수
      }
      if (s === -Infinity) continue;
      if (s > bestScore) {
        bestScore = s;
        best = rec;
      }
    }
    return best;
  }

  /**
   * OCR 이름(노이즈 포함)에 대한 관대한 최적 매칭.
   * 기존 점수(아이템명이 쿼리를 포함) + 역방향(쿼리가 아이템명을 포함, OCR 앞뒤 노이즈 흡수).
   * 임계값 미만이면 null(헤더/오인식 라인 제외).
   */
  _matchOcrName(name) {
    const qKr = normKr(name);
    const qEn = normEn(name);
    if (qKr.length < 2 && qEn.length < 2) return null;
    let best = null;
    let bestAdj = -Infinity;
    for (const rec of this.catalog.records) {
      let s = scoreRecord(rec, qKr, qEn);
      // OCR 앞뒤 노이즈/잘림 흡수: 쿼리가 아이템명을 포함하는 경우도 인정
      if (rec.krNorm.length >= 3 && qKr.includes(rec.krNorm)) s = Math.max(s, 700);
      if (rec.enNorm.length >= 4 && qEn.includes(rec.enNorm)) s = Math.max(s, 680);
      // OCR 오인식(룬→른, 으→오 등) 흡수: 자모 단위 유사도. 정확 매칭이 약할 때만 적용하고
      // 점수를 500~700 으로 제한해 실제 정확 매칭(700+)이 항상 우선되게 한다.
      if (s < 700 && qKr.length >= 3 && rec.krNorm.length >= 3) {
        const sim = jamoSimilarity(qKr, rec.krNorm);
        if (sim >= 0.8) s = Math.max(s, Math.round(500 + (sim - 0.8) * 1000));
      }
      if (s < 500) continue; // 약한 매칭 제외
      // 길이 근접 우선: 잘린 이름이 여러 아이템에 포함될 때 가장 가까운 쪽 선택
      // (예: "하위 정신" → "하위 정신 룬"(diff 1) vs "하위 정신의 에센스"(diff 4))
      const lenDiff = qKr
        ? Math.abs(rec.krNorm.length - qKr.length)
        : Math.abs(rec.enNorm.length - qEn.length);
      const adj = s - lenDiff * 6;
      if (adj > bestAdj) {
        bestAdj = adj;
        best = rec;
      }
    }
    return best;
  }
}

module.exports = { Store };
