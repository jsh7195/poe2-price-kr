'use strict';

const { ipcMain, screen, shell, app } = require('electron');
const { redact } = require('./services/redact');
const { DEFAULT_HOTKEYS } = require('./services/accelerator');
const errorReport = require('./services/errorReport');

// 공개 배포 리포(시크릿 아님 — 자동 신고가 향할 곳).
const REPORT_REPO = { owner: 'jsh7195', repo: 'poe2-price-kr' };

// 외부 브라우저로 열 수 있는 공식 PoE2 거래소 도메인(한국 카카오게임즈 + 글로벌 GGG)만 허용.
const TRADE_URL_RE = /^https:\/\/(poe\.kakaogames\.com|(www\.)?pathofexile\.com)\//;

async function openTradeExternal(url) {
  try {
    if (typeof url === 'string' && TRADE_URL_RE.test(url)) {
      await shell.openExternal(url);
      return { ok: true };
    }
  } catch (e) {
    /* noop */
  }
  return { ok: false };
}

/**
 * 렌더러 ↔ 메인 IPC 핸들러 등록.
 * 모든 핸들러는 try/catch 로 감싸 렌더러에 일관된 형태로 반환한다.
 */
function registerIpc(store, overlay, pricer, hotkeys) {
  ipcMain.handle('app:getStatus', () => store.status());

  // --- 설정: 전역 단축키 변경 ---
  ipcMain.handle('settings:getHotkeys', () => ({
    hotkeys: hotkeys ? hotkeys.getCurrent() : { ...DEFAULT_HOTKEYS },
    defaults: { ...DEFAULT_HOTKEYS },
  }));
  // 검증·재등록·영속은 컨트롤러가 담당. 무효/중복/등록실패는 결과 객체로 알린다.
  ipcMain.handle('settings:setHotkeys', async (_evt, map) => {
    try {
      if (!hotkeys) return { ok: false, hotkeys: { ...DEFAULT_HOTKEYS } };
      return await hotkeys.apply(map || {});
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });
  ipcMain.handle('settings:resetHotkeys', async () => {
    try {
      if (!hotkeys) return { ok: false, hotkeys: { ...DEFAULT_HOTKEYS } };
      return await hotkeys.apply({ ...DEFAULT_HOTKEYS });
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e) };
    }
  });

  // --- 인터랙티브 옵션 시세 창(Shift+F9) ---
  // 선택한 옵션 필터로 동급이상 실시세.
  ipcMain.handle('pricer:price', async (_evt, filters, opts) => {
    try {
      if (!Array.isArray(filters)) return null;
      return await store.priceByFilters(filters, opts || {});
    } catch (e) {
      return null;
    }
  });
  // 거래 페이지 열기 — 공식 PoE2 거래소 도메인만 허용(한국 카카오게임즈 + 글로벌 GGG).
  ipcMain.handle('pricer:openUrl', (_evt, url) => openTradeExternal(url));
  ipcMain.handle('app:openTradeUrl', (_evt, url) => openTradeExternal(url));
  ipcMain.handle('pricer:close', () => {
    if (pricer) pricer.hide();
    return { ok: true };
  });

  // --- 즐겨찾기(메인창 워치리스트) ---
  ipcMain.handle('favorites:list', () => store.getFavorites());
  ipcMain.handle('favorites:addCatalog', (_evt, rec) => store.addCatalogFavorite(rec));
  ipcMain.handle('favorites:addRare', (_evt, data) => store.addRareFavorite(data));
  ipcMain.handle('favorites:remove', (_evt, key) => store.removeFavorite(key));
  ipcMain.handle('favorites:reprice', (_evt, key) => store.repriceFavorite(key));
  ipcMain.handle('favorites:addUrl', (_evt, url) => store.addUrlFavorite(typeof url === 'string' ? url : ''));

  // 오버레이 동작 테스트: 커서 옆에 샘플 시세 툴팁을 띄운다(F9 경로와 무관하게 표시 확인).
  ipcMain.handle('overlay:test', async () => {
    if (!overlay) return { ok: false };
    const point = screen.getCursorScreenPoint();
    const sample = await store.priceCheck('아이템 종류: 중첩 가능한 화폐\n희귀도: 화폐\n신성한 오브\n--------\n');
    overlay.show(point, sample.found ? sample : { found: false, reason: '테스트' });
    return { ok: true, found: sample.found };
  });

  ipcMain.handle('catalog:search', (_evt, query) => {
    try {
      const results = store.query(typeof query === 'string' ? query : '', 40);
      return { ok: true, results };
    } catch (e) {
      return { ok: false, error: String(e && e.message ? e.message : e), results: [] };
    }
  });

  // 단일 아이템 GGG 실시간 시세(메인 창에서 행 클릭 시 온디맨드 조회).
  // 목록 전체를 라이브 조회하면 레이트리밋에 걸리므로, 클릭한 한 건만 조회한다.
  ipcMain.handle('catalog:priceItem', async (_evt, rec) => {
    try {
      if (!rec || typeof rec !== 'object') return { ok: false, price: null };
      const price = await store.livePrice(rec);
      return { ok: true, price };
    } catch (e) {
      return { ok: false, price: null, error: String(e && e.message ? e.message : e) };
    }
  });

  ipcMain.handle('catalog:refresh', async () => {
    await store.refresh();
    return store.status();
  });

  ipcMain.handle('league:set', async (_evt, name) => {
    // 렌더러가 보낸 리그명은 이미 로드된 목록에 대해 화이트리스트 검증한다.
    if (typeof name !== 'string' || name.length > 200 || !store.leagues.some((l) => l.name === name)) {
      return store.status();
    }
    await store.setLeague(name);
    return store.status();
  });

  // 가격 조회 실패를 GitHub 이슈로 신고: 마스킹된 본문을 만들어 기본 브라우저로 프리필 새 이슈를 연다.
  // (토큰 0 — 사용자가 본인 GitHub 로그인으로 직접 Submit. 본문은 redact() 통과분만 포함.)
  ipcMain.handle('app:reportError', async (_evt, payload) => {
    try {
      const message = payload && typeof payload.message === 'string' ? payload.message : '';
      const categoryErrors = payload && Array.isArray(payload.errors) ? payload.errors : [];
      const recent = errorReport.dump();
      const seedMsg = message || (recent.length ? recent[recent.length - 1].message : '');
      const body = errorReport.buildIssueBody({
        version: app.getVersion(),
        platform: process.platform,
        arch: process.arch,
        league: store.selectedLeague,
        recent,
        categoryErrors,
      });
      const url = errorReport.buildIssueUrl({
        owner: REPORT_REPO.owner,
        repo: REPORT_REPO.repo,
        title: errorReport.buildTitle(seedMsg),
        labels: 'price-fail',
        body,
      });
      await shell.openExternal(url);
      return { ok: true };
    } catch (e) {
      return { ok: false, error: redact(String(e && e.message ? e.message : e)) };
    }
  });
}

module.exports = { registerIpc };
