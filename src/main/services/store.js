'use strict';

const { EventEmitter } = require('events');
const { TTL } = require('../config');
const { DiskCache } = require('./cache');
const { fetchLeagues } = require('./leagues');
const { buildDictionary } = require('./dictionary');
const { buildCatalog } = require('./catalog');
const { search, scoreRecord } = require('./search');
const { normKr, normEn } = require('./normalize');
const { extractItemName, parseRecipeLines } = require('./itemtext');
const { parseItem } = require('./itemparse');
const { isElevated } = require('./elevation');
const ggg = require('./ggg');
const { fetchRawStats, buildStatIndex } = require('./stats');
const errorReport = require('./errorReport');

// F10 스캔에서 GGG 실시간 조회할 최대 아이템 수(레이트리밋·지연 한계). 초과분은 partial 표시.
const MAX_SCAN_PRICE = 8;

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
      const cached = await this.cache.get('dictionary', TTL.dictionary);
      if (cached && cached.enToKr) {
        this.dict = cached;
        return this.dict;
      }
    }
    this._emit('loading', '한글 사전 받는 중…');
    const dict = await buildDictionary();
    await this.cache.set('dictionary', dict);
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
        return cached;
      }
    }
    this._emit('loading', `${this.selectedLeague} 시세 받는 중…`);
    const dict = await this._getDict();
    try {
      const catalog = await buildCatalog(this.selectedLeague, dict);
      await this.cache.set(key, catalog);
      this.catalog = catalog;
      return catalog;
    } catch (e) {
      // 빌드 실패 시 만료된 캐시라도 폴백
      const stale = await this.cache.getEntry(key);
      if (stale && stale.data && stale.data.records) {
        this.catalog = stale.data;
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
    if (!price || price.rateLimited || price.empty || price.exalted == null) {
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
    return {
      name: parsed.name,
      base: parsed.base,
      category: parsed.category,
      categoryId: ggg.gggCategoryId(parsed.category), // GGG 타입 필터용(없으면 null)
      rarity: parsed.rarity,
      itemLevel: parsed.itemLevel,
      corrupted: parsed.corrupted,
      mods,
    };
  }

  /**
   * 인터랙티브: 사용자가 고른 옵션(필터)으로 동급이상 실시세.
   * @param {Array<{id:string, min?:number, max?:number}>} picks
   */
  async priceByFilters(picks, category) {
    if (!this.selectedLeague || !Array.isArray(picks) || !picks.length) return null;
    const filters = picks
      .filter((p) => p && p.id)
      .map((p) => {
        const value = {};
        if (p.min != null && p.min !== '') value.min = Number(p.min);
        if (p.max != null && p.max !== '') value.max = Number(p.max);
        return { id: p.id, value: Object.keys(value).length ? value : undefined };
      });
    try {
      return await ggg.priceByStatFilters(this.selectedLeague, filters, { category: category || undefined });
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
      const p = await this._priceRecord(rec);
      if (p && p.exalted != null) lastPrice = { exalted: p.exalted, divine: p.divine, listingCount: p.listingCount };
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

  /** 레어(옵션 선택) 검색을 즐겨찾기에 추가. data:{name,base,filters:[{id,min}],mods:[text],price} */
  async addRareFavorite(data) {
    if (!data || !Array.isArray(data.filters) || !data.filters.length) return this.getFavorites();
    const sig = data.filters.map((f) => f.id + ':' + (f.min != null ? f.min : '')).sort().join(',');
    const key = 'rare:' + (data.base || data.name || '') + '|' + sig;
    const list = await this.getFavorites();
    if (list.some((f) => f.key === key)) return list;
    const fav = {
      key, kind: 'rare',
      kr: data.base || data.name || '레어', en: data.name || '', base: data.base || '',
      categoryId: data.categoryId || null,
      filters: data.filters, mods: Array.isArray(data.mods) ? data.mods : [],
      lastPrice: data.price || null, savedAt: Date.now(),
    };
    return this._saveFavorites([...list, fav]);
  }

  async removeFavorite(key) {
    const list = await this.getFavorites();
    return this._saveFavorites(list.filter((f) => f.key !== key));
  }

  /** 즐겨찾기 한 건의 시세를 다시 조회해 갱신. */
  async repriceFavorite(key) {
    const list = await this.getFavorites();
    const fav = list.find((f) => f.key === key);
    if (!fav) return list;
    let price = null;
    try {
      if (fav.kind === 'catalog') {
        price = await this._priceRecord(fav.rec);
      } else {
        const filters = fav.filters.map((f) => ({ id: f.id, value: f.min != null ? { min: Number(f.min) } : undefined }));
        price = await ggg.priceByStatFilters(this.selectedLeague, filters, { category: fav.categoryId || undefined });
      }
    } catch (e) {
      /* 실패 → 기존 값 유지 */
    }
    let lastPrice = fav.lastPrice;
    if (price && !price.empty && price.exalted != null) {
      lastPrice = { exalted: price.exalted, divine: price.divine, listingCount: price.listingCount };
    } else if (price && price.empty) {
      lastPrice = { empty: true };
    }
    return this._saveFavorites(list.map((f) => (f.key === key ? { ...f, lastPrice } : f)));
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
    const matched = [];
    for (const { qty, name, explicit } of parsed) {
      const rec = this._matchOcrName(name);
      if (!rec) continue;
      matched.push({ qty, explicit, record: rec });
    }
    // "Nx 아이템" 형식(조합/목록 행)만 채택 → 전체 화면을 스캔해도 목록 밖 텍스트는 제외.
    // (수량 없이 화면에 보이는 다른 아이템 이름은 explicit=false 라 걸러진다)
    const chosen = matched.filter((m) => m.explicit);

    const unique = [];
    const seen = new Set();
    for (const m of chosen) {
      // 이름+수량 기준 중복제거: 같은 아이템이라도 수량이 다르면(예: 6x·4x 대장장이의 숫돌)
      // 별개 행으로 유지한다. 진짜 OCR 중복(같은 줄이 여러 타일/배율에서 읽힘)은 수량까지
      // 같으므로 그대로 합쳐진다.
      const key = m.record.categoryKey + '|' + m.record.enNorm + '|' + m.qty;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push({ qty: m.qty, record: m.record });
    }

    // GGG 레이트리밋·지연 한계 → 상위 MAX_SCAN_PRICE 건만 실시간 조회.
    const capped = unique.slice(0, MAX_SCAN_PRICE);
    const partial = unique.length > capped.length;

    // 동시 조회: ggg 내부 스로틀이 버킷별로 직렬화하므로 안전.
    // (search/fetch 가 다른 버킷이라 아이템 간 검색-상세가 겹쳐 총 시간이 단축된다)
    const priced = await Promise.all(
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

    const items = priced.filter(Boolean);
    items.sort((a, b) => b.qty * (b.live.exalted || 0) - a.qty * (a.live.exalted || 0));
    return { scan: true, items, ref: this.catalog.ref, partial };
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
