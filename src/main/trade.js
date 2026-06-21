'use strict';

const { BrowserWindow, session } = require('electron');

/**
 * 거래소 인증 세션 + "은신처로 이동" 실행.
 *
 * "은신처로 이동"은 거래 사이트가 로그인된 세션으로 GGG/카카오 서버에 명령을 보내
 * 게임 클라이언트를 이동시키는 기능이라 인증이 필요하다(POST /api/trade2/whisper → 401 미인증).
 *
 * 구현: 거래 도메인(poe.kakaogames.com 등)에 **영속 세션(partition)** 을 가진 BrowserWindow 를
 * 띄워 사용자가 한 번 로그인하면 쿠키가 유지된다. 이후 그 창의 페이지 컨텍스트에서 직접
 * fetch 를 실행(executeJavaScript)하면 쿠키·Origin 이 자동으로 맞아 인증 API 를 그대로 호출할 수 있다.
 *
 * 흐름: (저장검색 또는 검색바디) → 재검색(가격 오름차순) → 최저가 매물 fetch(whisper_token) →
 *        POST /api/trade2/whisper {token} → 게임 내 은신처 이동.
 */

// 허용 거래 도메인(웹 host → 정규 host). 그 외는 거부(임의 URL 로드 차단).
const REALM_HOSTS = Object.freeze({
  'poe.kakaogames.com': 'poe.kakaogames.com',
  'www.pathofexile.com': 'www.pathofexile.com',
  'pathofexile.com': 'www.pathofexile.com',
});
const DEFAULT_HOST = 'poe.kakaogames.com'; // 한국 서버 기본

function canonHost(host) {
  return REALM_HOSTS[String(host || '').toLowerCase()] || null;
}

class TradeSession {
  constructor(logger) {
    this.windows = new Map(); // host → BrowserWindow
    this.log = typeof logger === 'function' ? logger : () => {};
    this.loggedIn = new Set(); // 로그인 감지된 host
    this.onLoggedIn = null; // (host) => void — 로그인 완료 시 렌더러 알림(main 이 주입)
  }

  _ensureWindow(host, landingUrl) {
    let win = this.windows.get(host);
    if (win && !win.isDestroyed()) return win;
    const part = session.fromPartition('persist:trade-' + host); // 도메인별 영속 세션(로그인 유지)
    win = new BrowserWindow({
      width: 980,
      height: 760,
      show: false,
      title: '거래소 로그인',
      autoHideMenuBar: true,
      webPreferences: {
        session: part,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
      },
    });
    win.on('closed', () => {
      if (this.windows.get(host) === win) this.windows.delete(host);
    });
    // 로그인 완료 감지: 로그인 리다이렉트(member.kakaogames.com/login, /login/kakao …)를 거쳐
    // 거래 도메인 본문으로 돌아오면 로그인된 것으로 본다 → 창을 숨기고 렌더러에 알린다.
    win.webContents.on('did-navigate', (_e, url) => {
      try {
        const u = new URL(url);
        if (u.hostname.toLowerCase() === host && !u.pathname.toLowerCase().startsWith('/login')) {
          if (!this.loggedIn.has(host)) {
            this.loggedIn.add(host);
            this.log('[trade] 로그인 감지: ' + host);
            if (typeof this.onLoggedIn === 'function') this.onLoggedIn(host);
          }
          if (win.isVisible()) setTimeout(() => { if (!win.isDestroyed()) win.hide(); }, 800);
        }
      } catch (_) {
        /* noop */
      }
    });
    win.loadURL(landingUrl).catch(() => {});
    this.windows.set(host, win);
    return win;
  }

  /** 로그인 창을 사용자에게 보여준다(이미 있으면 표시·포커스). */
  showLogin(host, landingUrl) {
    const win = this._ensureWindow(host, landingUrl);
    if (win.webContents.getURL() === '' || win.webContents.getURL() === 'about:blank') {
      win.loadURL(landingUrl).catch(() => {});
    }
    win.show();
    win.focus();
    return win;
  }

  /**
   * 거래 창의 페이지 컨텍스트에서 "은신처로 이동" 전체 흐름을 한 번에 실행한다.
   * @param {{host:string, league:string, savedId?:string, searchBody?:object}} target
   * @returns {Promise<{ok:boolean, reason?:string, seller?:string}>}
   *   reason: login_needed | no_listing | no_token | rate_limited | error
   */
  async travel(target) {
    const host = canonHost(target && target.host) || DEFAULT_HOST;
    const league = target && target.league;
    if (!league) return { ok: false, reason: 'error' };
    const landing = target.savedId
      ? `https://${host}/trade2/search/poe2/${encodeURIComponent(league)}/${encodeURIComponent(target.savedId)}`
      : `https://${host}/trade2`;
    const win = this._ensureWindow(host, landing);

    // 페이지 로드 완료 보장(처음 생성 직후일 수 있음).
    await this._waitLoaded(win);

    // 보안: 인증 fetch 를 실행할 페이지가 반드시 "거래 도메인"이어야 한다.
    // (로그인 미완료면 카카오 SSO 등 다른 도메인에 있을 수 있음 → 그 컨텍스트에서 실행 금지.)
    // 현재 URL 이 거래 도메인이 아니면 랜딩으로 되돌리고 한 번 더 기다린 뒤, 그래도 아니면 로그인 필요.
    if (!this._isOnHost(win, host)) {
      win.loadURL(landing).catch(() => {});
      await this._waitLoaded(win);
      if (!this._isOnHost(win, host)) {
        this.showLogin(host, landing);
        return { ok: false, reason: 'login_needed' };
      }
    }

    let result;
    try {
      result = await win.webContents.executeJavaScript(
        buildTravelScript({
          league,
          savedId: target.savedId || null,
          searchBody: target.searchBody || null,
        }),
        true
      );
    } catch (e) {
      this.log('[travel] 스크립트 실행 오류: ' + (e && e.message ? e.message : e));
      return { ok: false, reason: 'error' };
    }
    this.log(`[travel] host=${host} league=${league} → ${JSON.stringify(result)}`);

    if (result && result.reason === 'login_needed') {
      this.showLogin(host, landing); // 로그인 창 표시 → 사용자가 로그인 후 다시 시도
    }
    return result || { ok: false, reason: 'error' };
  }

  /** 창의 현재 문서가 주어진 거래 도메인(origin)인지 — 인증 fetch 실행 전 안전 확인. */
  _isOnHost(win, host) {
    try {
      if (!win || win.isDestroyed()) return false;
      const u = win.webContents.getURL();
      if (!u) return false;
      return new URL(u).hostname.toLowerCase() === host;
    } catch (e) {
      return false;
    }
  }

  _waitLoaded(win) {
    return new Promise((resolve) => {
      if (!win || win.isDestroyed()) return resolve();
      if (!win.webContents.isLoading()) return resolve();
      const done = () => resolve();
      win.webContents.once('did-finish-load', done);
      win.webContents.once('did-fail-load', done);
      setTimeout(done, 8000); // 안전망
    });
  }

  destroy() {
    for (const win of this.windows.values()) {
      try {
        if (!win.isDestroyed()) win.destroy();
      } catch (_) {
        /* noop */
      }
    }
    this.windows.clear();
  }
}

/**
 * 거래 창(로그인된 origin)에서 실행할 자체 완결 스크립트 문자열.
 * 같은 origin 이라 fetch 에 쿠키가 자동 포함되고 CORS 가 없다. 결과 객체를 반환.
 */
function buildTravelScript({ league, savedId, searchBody }) {
  // JS 줄종결자(U+2028/2029)는 JSON.stringify 가 이스케이프하지 않고 정상 리그/ID 엔 없음
  // → 제거해 주입 스크립트가 깨지지 않게 한다(보안 리뷰 반영).
  const args = JSON.stringify({ league, savedId, searchBody })
    .split(String.fromCharCode(0x2028)).join("").split(String.fromCharCode(0x2029)).join("");
  return `(async () => {
    const A = ${args};
    const base = location.origin + '/api/trade2';
    const lg = encodeURIComponent(A.league);
    const J = { 'content-type': 'application/json', 'x-requested-with': 'XMLHttpRequest' };
    const d = { step: 'start' }; // 진단: 어디까지 갔고 각 단계 상태코드
    try {
      // 1) 검색 쿼리 확보: 저장검색이면 GET, 아니면 전달받은 검색바디.
      let query = A.searchBody;
      if (!query && A.savedId) {
        d.step = 'getQuery';
        const g = await fetch(base + '/search/' + lg + '/' + encodeURIComponent(A.savedId), { credentials: 'include' });
        d.getStatus = g.status;
        if (g.status === 401) return { ok:false, reason:'login_needed', diag:d };
        const gj = await g.json().catch(() => null);
        query = gj && gj.query;
      }
      if (!query) return { ok:false, reason:'error', diag:d };
      // 2) 가격 오름차순 재검색.
      d.step = 'search';
      const s = await fetch(base + '/search/' + lg, { method:'POST', credentials:'include', headers:J,
        body: JSON.stringify({ query: query, sort: { price: 'asc' } }) });
      d.searchStatus = s.status;
      if (s.status === 401) return { ok:false, reason:'login_needed', diag:d };
      if (s.status === 429) return { ok:false, reason:'rate_limited', diag:d };
      const sj = await s.json().catch(() => null);
      d.total = sj && sj.total;
      d.resultN = sj && Array.isArray(sj.result) ? sj.result.length : 0;
      if (!sj || !d.resultN) return { ok:false, reason:'no_listing', diag:d };
      // 3) 최저가 매물 상세(인증 시 whisper_token 포함).
      d.step = 'fetch';
      const ids = sj.result.slice(0, 1).join(',');
      const f = await fetch(base + '/fetch/' + ids + '?query=' + sj.id, { credentials: 'include' });
      d.fetchStatus = f.status;
      if (f.status === 401) return { ok:false, reason:'login_needed', diag:d };
      if (f.status === 429) return { ok:false, reason:'rate_limited', diag:d };
      const fj = await f.json().catch(() => null);
      const L = fj && fj.result && fj.result[0] && fj.result[0].listing;
      d.hasListing = !!L;
      d.listingKeys = L ? Object.keys(L).join(',') : null; // whisper_token 필드명 확인용
      // 토큰 후보(필드명이 다를 수 있어 여러 곳 탐색).
      const token = L && (L.whisper_token || L.hideout_token || (L.whisper && L.whisper.token));
      const seller = L && L.account && (L.account.lastCharacterName || L.account.name) || null;
      d.hasToken = !!token;
      if (!L) return { ok:false, reason:'no_listing', diag:d };
      if (!token) return { ok:false, reason:'no_token', seller, diag:d };
      // 4) 은신처 이동(거래 귓속말 토큰 전송).
      d.step = 'whisper';
      const w = await fetch(base + '/whisper', { method:'POST', credentials:'include', headers:J,
        body: JSON.stringify({ token: token }) });
      d.whisperStatus = w.status;
      if (w.status === 401) return { ok:false, reason:'login_needed', seller, diag:d };
      if (w.status === 429) return { ok:false, reason:'rate_limited', seller, diag:d };
      if (!w.ok) {
        d.whisperBody = (await w.text().catch(() => '')).slice(0, 200);
        return { ok:false, reason:'whisper_failed', seller, diag:d };
      }
      return { ok:true, seller, diag:d };
    } catch (e) {
      d.error = String(e && e.message ? e.message : e).slice(0, 200);
      return { ok:false, reason:'error', diag:d };
    }
  })()`;
}

module.exports = { TradeSession, canonHost, DEFAULT_HOST };
