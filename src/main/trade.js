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
   * 로그인된 거래 창에서 사이트의 진짜 "은신처로 이동" 버튼을 눌러 실제로 이동시킨다.
   * (직접 API 추측 대신 사이트 자체 기능을 그대로 사용 — KR 에서 동작 확인된 방식.)
   * @param {{host:string, league:string, savedId?:string, searchBody?:object}} target
   * @returns {Promise<{ok:boolean, reason?:string}>}
   *   reason: login_needed | no_listing | no_button | in_progress | error
   */
  async travel(target) {
    const host = canonHost(target && target.host) || DEFAULT_HOST;
    const league = target && target.league;
    if (!league) return { ok: false, reason: 'error' };
    const base = `https://${host}/trade2/search/poe2/${encodeURIComponent(league)}`;
    const win = this._ensureWindow(host, base);
    await this._waitLoaded(win);

    // 이동할 검색 결과 URL 결정: 저장검색이면 그 URL, 아니면 검색바디로 새 검색 id 생성.
    let searchUrl = null;
    if (target.savedId) {
      searchUrl = base + '/' + encodeURIComponent(target.savedId);
    } else if (target.searchBody) {
      const id = await this._createSearch(win, host, league, target.searchBody);
      if (id === 'login') { this.showLogin(host, base); return { ok: false, reason: 'login_needed' }; }
      if (!id) return { ok: false, reason: 'no_listing' };
      searchUrl = base + '/' + id;
    } else {
      return { ok: false, reason: 'error' };
    }

    // 검색 결과 페이지로 이동(이미 그 페이지면 생략).
    if (this._urlNoQuery(win.webContents.getURL()) !== searchUrl) {
      win.loadURL(searchUrl).catch(() => {});
      await this._waitLoaded(win);
    }

    let result;
    try {
      result = await win.webContents.executeJavaScript(buildClickScript(host), true);
    } catch (e) {
      this.log('[travel] 클릭 스크립트 오류: ' + (e && e.message ? e.message : e));
      result = { ok: false, reason: 'error' };
    }
    this.log(`[travel] host=${host} → ${JSON.stringify(result)} url=${win.webContents.getURL()}`);

    // 실패(특히 로그인 필요)면 창을 보여줘 사용자가 직접 로그인/클릭할 수 있게 한다.
    if (!result || !result.ok) {
      this.showLogin(host, searchUrl);
    }
    return result || { ok: false, reason: 'error' };
  }

  /** 로그인된 창에서 검색바디를 POST 해 검색 id 를 만든다(레어/카탈로그 즐겨찾기용). */
  async _createSearch(win, host, league, searchBody) {
    if (!this._isOnHost(win, host)) return 'login';
    const lit = JSON.stringify({ league, searchBody })
      .split(String.fromCharCode(0x2028)).join('').split(String.fromCharCode(0x2029)).join('');
    const script = `(async () => { try {
      const A = ${lit};
      const r = await fetch(location.origin + '/api/trade2/search/' + encodeURIComponent(A.league),
        { method:'POST', credentials:'include', headers:{'content-type':'application/json','x-requested-with':'XMLHttpRequest'},
          body: JSON.stringify({ query: A.searchBody, sort: { price: 'asc' } }) });
      if (r.status === 401) return 'login';
      const j = await r.json().catch(() => null);
      return (j && j.id) || null;
    } catch (e) { return null; } })()`;
    try {
      return await win.webContents.executeJavaScript(script, true);
    } catch (e) {
      return null;
    }
  }

  _urlNoQuery(u) {
    try {
      const x = new URL(u);
      return x.origin + x.pathname;
    } catch (e) {
      return u;
    }
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
 * 거래 결과 페이지(로그인됨)에서 사이트의 "은신처로 이동" 버튼을 찾아 클릭하는 스크립트.
 * 결과가 렌더될 때까지 잠시 폴링하고, 최상단(최저가) 매물의 버튼을 누른다.
 * @param {string} host 거래 도메인(로그인/리다이렉트 판별용)
 */
function buildClickScript(host) {
  const hostLit = JSON.stringify(host);
  return `(async () => {
    const HOST = ${hostLit};
    const LABELS = ['은신처로 이동', 'Travel to Hideout'];
    // 실제 클릭 가능한 요소만(텍스트 래퍼 div 오클릭 방지). 정확히 라벨 텍스트인 것.
    const find = () => Array.from(document.querySelectorAll('button, a, [role="button"]'))
      .find(e => LABELS.includes((e.innerText || e.textContent || '').trim()) && e.offsetParent !== null);
    for (let i = 0; i < 48; i++) { // 최대 ~12초: SPA 검색+렌더 대기
      if (location.hostname.toLowerCase() !== HOST || location.pathname.toLowerCase().startsWith('/login')) {
        return { ok:false, reason:'login_needed' };
      }
      const b = find();
      if (b) { b.click(); return { ok:true }; }
      await new Promise(r => setTimeout(r, 250));
    }
    const t = document.body ? document.body.innerText : '';
    if (/로그인/.test(t) && !/은신처로 이동|순간이동/.test(t)) return { ok:false, reason:'login_needed' };
    if (/순간이동/.test(t)) return { ok:false, reason:'in_progress' }; // 이미 이동 중인 매물만 있음
    return { ok:false, reason:'no_button' }; // 매물 없음/페이지 구조 변경
  })()`;
}

module.exports = { TradeSession, canonHost, DEFAULT_HOST };
