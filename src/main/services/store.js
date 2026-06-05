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
const { isElevated } = require('./elevation');

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

  /** 검색. 카탈로그 미준비면 빈 배열. */
  query(text, limit = 40) {
    if (!this.catalog) return [];
    return search(this.catalog.records, text, limit);
  }

  /**
   * 인게임 가격체크: 클립보드 아이템 텍스트 → 이름 추출 → 카탈로그 정확 매칭.
   * @returns {{found:boolean, record?:object, ref?:object, name?:string, reason?:string}}
   */
  priceCheck(clipText) {
    if (!this.catalog) return { found: false, reason: '준비 중' };
    const name = extractItemName(clipText);
    if (!name) return { found: false, name: '' };
    const results = search(this.catalog.records, name, 5);
    if (!results.length) return { found: false, name };
    // 호버한 아이템은 정확한 이름이므로 완전 일치를 우선
    const qK = normKr(name);
    const qE = normEn(name);
    const best = results.find((r) => r.krNorm === qK || r.enNorm === qE) || results[0];
    return { found: true, record: best, ref: this.catalog.ref, name };
  }

  /**
   * 화면 OCR 라인들에서 인식된 아이템들의 시세를 한 번에 조회.
   * 수량×단가 합계 기준 비싼 순으로 정렬해 반환.
   * @returns {{scan:true, items:Array<{qty:number, record:object}>, ref:object, reason?:string}}
   */
  scanRecipe(ocrLines) {
    if (!this.catalog) return { scan: true, items: [], reason: '준비 중' };
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

    const items = [];
    const seen = new Set();
    for (const m of chosen) {
      const key = m.record.categoryKey + '|' + m.record.enNorm;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ qty: m.qty, record: m.record });
    }
    items.sort(
      (a, b) => b.qty * (b.record.valueDivine || 0) - a.qty * (a.record.valueDivine || 0)
    );
    return { scan: true, items, ref: this.catalog.ref };
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
    let bestScore = 0;
    for (const rec of this.catalog.records) {
      let s = scoreRecord(rec, qKr, qEn);
      if (rec.krNorm.length >= 3 && qKr.includes(rec.krNorm)) s = Math.max(s, 700);
      if (rec.enNorm.length >= 4 && qEn.includes(rec.enNorm)) s = Math.max(s, 680);
      if (s > bestScore) {
        bestScore = s;
        best = rec;
      }
    }
    return bestScore >= 500 ? best : null;
  }
}

module.exports = { Store };
