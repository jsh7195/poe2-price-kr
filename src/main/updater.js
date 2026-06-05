'use strict';

const { ipcMain, app } = require('electron');

let autoUpdater = null;
try {
  ({ autoUpdater } = require('electron-updater'));
} catch (_) {
  autoUpdater = null;
}

const msg = (e) => String(e && e.message ? e.message : e);
// 포터블 exe 는 자기 자신을 교체할 수 없어 자동 업데이트 미지원
const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;

/**
 * GitHub Releases 기반 자동 업데이트 배선.
 * - 설치본(NSIS)에서만 동작. 개발/포터블에서는 'unsupported' 상태를 보낸다.
 * - autoDownload=false: 사용자가 "다운로드"를 눌러야 받는다.
 */
function setupUpdater(getWindow) {
  const send = (data) => {
    const w = getWindow();
    if (w && !w.isDestroyed()) w.webContents.send('update:status', data);
  };

  ipcMain.handle('update:check', async () => {
    if (!autoUpdater || !app.isPackaged || isPortable) {
      send({ state: 'unsupported' });
      return { ok: false, unsupported: true };
    }
    try {
      await autoUpdater.checkForUpdates();
      return { ok: true };
    } catch (e) {
      send({ state: 'error', message: msg(e) });
      return { ok: false, error: msg(e) };
    }
  });

  ipcMain.handle('update:download', async () => {
    if (!autoUpdater) return { ok: false };
    try {
      await autoUpdater.downloadUpdate();
      return { ok: true };
    } catch (e) {
      send({ state: 'error', message: msg(e) });
      return { ok: false, error: msg(e) };
    }
  });

  ipcMain.handle('update:install', () => {
    if (autoUpdater) setImmediate(() => autoUpdater.quitAndInstall());
    return { ok: true };
  });

  if (!autoUpdater) return;
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.on('checking-for-update', () => send({ state: 'checking' }));
  autoUpdater.on('update-available', (i) => send({ state: 'available', version: i.version }));
  autoUpdater.on('update-not-available', (i) => send({ state: 'latest', version: i.version }));
  autoUpdater.on('download-progress', (p) => send({ state: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', (i) => send({ state: 'downloaded', version: i.version }));
  autoUpdater.on('error', (e) => send({ state: 'error', message: msg(e) }));
}

module.exports = { setupUpdater };
