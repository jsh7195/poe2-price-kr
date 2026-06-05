'use strict';

const { ipcMain, screen } = require('electron');

/**
 * 렌더러 ↔ 메인 IPC 핸들러 등록.
 * 모든 핸들러는 try/catch 로 감싸 렌더러에 일관된 형태로 반환한다.
 */
function registerIpc(store, overlay) {
  ipcMain.handle('app:getStatus', () => store.status());

  // 오버레이 동작 테스트: 커서 옆에 샘플 시세 툴팁을 띄운다(F9 경로와 무관하게 표시 확인).
  ipcMain.handle('overlay:test', () => {
    if (!overlay) return { ok: false };
    const point = screen.getCursorScreenPoint();
    const sample = store.priceCheck('아이템 종류: 중첩 가능한 화폐\n희귀도: 화폐\n신성한 오브\n--------\n');
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
}

module.exports = { registerIpc };
