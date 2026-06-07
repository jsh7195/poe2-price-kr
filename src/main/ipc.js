'use strict';

const { ipcMain, screen, shell, app } = require('electron');
const { redact } = require('./services/redact');
const errorReport = require('./services/errorReport');

// 공개 배포 리포(시크릿 아님 — 자동 신고가 향할 곳).
const REPORT_REPO = { owner: 'jsh7195', repo: 'poe2-price-kr' };

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
