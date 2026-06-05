'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { spawn } = require('child_process');
const path = require('path');
const { Store } = require('./services/store');
const { registerIpc } = require('./ipc');
const { Overlay } = require('./overlay');
const { setupHotkey, teardownHotkey } = require('./hotkey');

const ASSET = (f) => path.join(__dirname, '..', '..', 'assets', f);

let mainWindow = null;
let store = null;
let overlay = null;
let tray = null;
let isQuiting = false;
let notifiedTray = false;

// 단일 인스턴스 보장(중복 실행 시 기존 창 표시). 스크린샷/개발 모드(POE_SHOT)는 우회.
if (!process.env.POE_SHOT && !app.requestSingleInstanceLock()) {
  app.quit();
} else {
  if (!process.env.POE_SHOT) app.on('second-instance', () => showMainWindow());
  start();
}

function createWindow(startHidden = false) {
  mainWindow = new BrowserWindow({
    width: 1120,
    height: 780,
    minWidth: 760,
    minHeight: 520,
    show: !startHidden, // 트레이 모드면 숨긴 채 시작
    backgroundColor: '#0e0c08',
    title: 'PoE2 시세검색',
    icon: ASSET('icon.png'),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));

  store.on('status', (s) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:status', s);
  });

  // 창 닫기 = 트레이로 숨김(앱은 계속 실행 → F9 유지). 실제 종료는 트레이 메뉴에서.
  mainWindow.on('close', (e) => {
    if (!isQuiting) {
      e.preventDefault();
      mainWindow.hide();
      if (tray && !notifiedTray) {
        notifiedTray = true;
        try {
          tray.displayBalloon({
            title: 'PoE2 시세검색 — 백그라운드 실행 중',
            content: '창을 닫아도 F9 가격체크는 계속 동작합니다. 완전 종료는 트레이 아이콘 우클릭 → 종료.',
          });
        } catch (_) {}
      }
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

/** 현재 앱을 관리자 권한으로 다시 실행하고 비상승 인스턴스는 종료. */
function relaunchElevated() {
  const psQuote = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const exe = process.execPath;
  const cmd = app.isPackaged
    ? `Start-Process -FilePath ${psQuote(exe)} -Verb RunAs`
    : `Start-Process -FilePath ${psQuote(exe)} -ArgumentList ${psQuote(app.getAppPath())} -Verb RunAs`;
  spawn('powershell.exe', ['-NoProfile', '-WindowStyle', 'Hidden', '-Command', cmd], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  }).unref();
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    mainWindow.show();
    mainWindow.focus();
  }
}

function createTray() {
  let img = nativeImage.createFromPath(ASSET('tray.png'));
  if (img.isEmpty()) img = nativeImage.createEmpty();
  tray = new Tray(img);
  tray.setToolTip('PoE2 시세검색 — F9 시세 / F10 화면 스캔');
  rebuildTrayMenu();
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
}

function rebuildTrayMenu() {
  if (!tray) return;
  const startInTray = !!(store && store._settings && store._settings.startInTray);
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '창 열기', click: showMainWindow },
      {
        label: '시작 시 트레이로 시작',
        type: 'checkbox',
        checked: startInTray,
        click: async (item) => {
          await store.setSetting('startInTray', item.checked);
          rebuildTrayMenu();
        },
      },
      { type: 'separator' },
      { label: '종료', click: () => { isQuiting = true; app.quit(); } },
    ])
  );
}

function start() {
  app.whenReady().then(async () => {
    store = new Store(app.getPath('userData'));

    overlay = new Overlay();
    overlay.create();

    registerIpc(store, overlay); // overlay:test 핸들러 포함

    // 트레이 모드: 설정이 켜져 있으면 창을 숨긴 채 시작
    const settings = await store.getSettings();
    createWindow(!!settings.startInTray);
    createTray();

    // 창을 트레이로 숨기기
    ipcMain.handle('app:hideToTray', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      return { ok: true };
    });

    // 관리자 권한으로 재실행(비상승 → 상승). UAC 수락 시 상승 인스턴스가 락을 인수.
    ipcMain.handle('app:relaunchElevated', () => {
      if (process.platform !== 'win32') return { ok: false };
      try {
        app.releaseSingleInstanceLock();
        relaunchElevated();
        isQuiting = true;
        setTimeout(() => app.exit(0), 400);
        return { ok: true };
      } catch (e) {
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });

    if (process.platform === 'win32' && !process.env.POE_SHOT) {
      store.setHotkeyOk(setupHotkey(store, overlay)); // 등록 실패 시 UI 경고
      store.checkElevation(); // 관리자 권한 여부 확인(게임 위 F9용)
    }
    console.log('[main] F9 디버그 로그:', path.join(app.getPath('userData'), 'f9-debug.log'));

    mainWindow.webContents.once('did-finish-load', () => {
      store.initialize().catch((err) => console.error('[store] initialize 실패:', err));
      if (process.env.POE_SHOT) {
        try {
          const { runScreenshots } = require('../../scripts/devshot');
          runScreenshots(app, mainWindow, store, overlay, path.join(__dirname, '..', '..', '.research'));
        } catch (e) {
          console.error('[devshot] 사용 불가(패키지 빌드에는 미포함):', e.message);
        }
      }
    });

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  // 트레이 상주: 모든 창이 닫혀도 앱을 종료하지 않는다(트레이 메뉴로만 종료).
  app.on('window-all-closed', () => {});

  app.on('before-quit', () => {
    isQuiting = true;
  });

  app.on('will-quit', () => {
    teardownHotkey();
    if (overlay) overlay.destroy();
    if (tray) tray.destroy();
  });
}
