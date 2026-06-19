'use strict';

const { app, BrowserWindow, Tray, Menu, nativeImage, ipcMain } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

function logMain(msg) {
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'f9-debug.log'), new Date().toISOString() + ' ' + msg + '\n');
  } catch (_) {
    /* noop */
  }
}
const { Store } = require('./services/store');
const { redact } = require('./services/redact');
const { registerIpc } = require('./ipc');
const { Overlay } = require('./overlay');
const { Pricer } = require('./pricer');
const { createHotkeyController } = require('./hotkey');
const { setupUpdater } = require('./updater');

const ASSET = (f) => path.join(__dirname, '..', '..', 'assets', f);

// 시세 자동 갱신 주기: 1시간. 화폐는 변동성이 낮아 자주 받을 필요 없고, 백그라운드에서
// 조용히 최신화한다(첫 로딩이 아니면 전체화면 오버레이는 뜨지 않고 갱신 버튼만 돈다).
const AUTO_REFRESH_MS = 60 * 60 * 1000;

let mainWindow = null;
let store = null;
let overlay = null;
let pricer = null;
let hotkeyController = null;
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
  // 즐겨찾기 변경(인게임 Shift+F9 에서 담아도 메인창 실시간 반영)
  store.on('favorites', (list) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('app:favorites', list);
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

/**
 * 현재 앱을 관리자 권한으로 다시 실행한다.
 * - 한글 경로 보존: -EncodedCommand(UTF-16).
 * - 락 경쟁 방지: PowerShell 이 700ms 대기(그 사이 이 앱은 종료) 후 RunAs 실행.
 * - detached + unref: 이 앱이 종료돼도 PowerShell 은 살아남아 UAC/상승 실행을 진행.
 */
function relaunchElevated() {
  const q = (s) => "'" + String(s).replace(/'/g, "''") + "'";
  const exe = process.execPath;
  const inner = app.isPackaged
    ? `Start-Sleep -Milliseconds 700; Start-Process -FilePath ${q(exe)} -Verb RunAs`
    : `Start-Sleep -Milliseconds 700; Start-Process -FilePath ${q(exe)} -ArgumentList ${q(app.getAppPath())} -Verb RunAs`;
  const b64 = Buffer.from(inner, 'utf16le').toString('base64');
  const child = spawn('powershell.exe', ['-NoProfile', '-EncodedCommand', b64], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
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

    // 시세 조회 실패를 디스크 로그(f9-debug.log)에 영구 기록 → 게임 중 문제 발생 후 원인 분석용.
    // (개인정보는 redact 로 가리고, 같은 메시지 연속 반복은 한 번만 기록)
    let lastLoggedError = '';
    store.on('status', (s) => {
      if (s && s.phase === 'error' && s.message && s.message !== lastLoggedError) {
        lastLoggedError = s.message;
        logMain('[price-error]' + (s.leagueName ? ' [' + redact(s.leagueName) + ']' : '') + ' ' + redact(s.message));
      } else if (s && s.phase === 'ready') {
        lastLoggedError = ''; // 복구되면 다음 실패를 다시 기록할 수 있도록 리셋
      }
    });

    overlay = new Overlay();
    overlay.create();

    pricer = new Pricer(); // Shift+F9 인터랙티브 옵션 시세 창
    pricer.create();

    hotkeyController = createHotkeyController(store, overlay, pricer); // 설정에서 바꿀 수 있는 전역 단축키
    registerIpc(store, overlay, pricer, hotkeyController); // overlay:test, pricer:*, settings:* 핸들러 포함

    // 트레이 모드: 설정이 켜져 있으면 창을 숨긴 채 시작
    const settings = await store.getSettings();
    createWindow(!!settings.startInTray);
    createTray();

    // 창을 트레이로 숨기기
    ipcMain.handle('app:hideToTray', () => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.hide();
      return { ok: true };
    });

    ipcMain.handle('app:getVersion', () => app.getVersion());

    // GitHub Releases 자동 업데이트 (설치본 전용)
    setupUpdater(() => mainWindow);

    // 관리자 권한으로 재실행(비상승 → 상승). UAC 수락 시 상승 인스턴스가 락을 인수.
    ipcMain.handle('app:relaunchElevated', () => {
      if (process.platform !== 'win32') return { ok: false };
      try {
        logMain(`[relaunch] 요청 isPackaged=${app.isPackaged} exe=${process.execPath}`);
        relaunchElevated();
        isQuiting = true;
        try { app.releaseSingleInstanceLock(); } catch (_) { /* noop */ }
        setTimeout(() => app.exit(0), 250); // PowerShell 이 700ms 대기하므로 먼저 종료해도 안전
        return { ok: true };
      } catch (e) {
        logMain('[relaunch] 오류: ' + (e && e.message ? e.message : e));
        return { ok: false, error: String(e && e.message ? e.message : e) };
      }
    });

    if (process.platform === 'win32' && !process.env.POE_SHOT) {
      const results = await hotkeyController.init(); // 설정된 단축키로 등록
      store.setHotkeyOk(!!results.price); // 단일 시세(기본 F9) 등록 실패 시 UI 경고
      store.checkElevation(); // 관리자 권한 여부 확인(게임 위 F9용)
    }
    console.log('[main] F9 디버그 로그:', path.join(app.getPath('userData'), 'f9-debug.log'));

    mainWindow.webContents.once('did-finish-load', () => {
      store.initialize().catch((err) => console.error('[store] initialize 실패:', err));
      // 1시간마다 백그라운드 자동 갱신(refresh 는 building 중이면 스스로 무시 → 첫 로딩과 충돌 없음).
      if (!process.env.POE_SHOT) {
        setInterval(() => {
          store.refresh().catch((err) => console.error('[store] 자동 갱신 실패:', err));
        }, AUTO_REFRESH_MS);
      }
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
    if (hotkeyController) hotkeyController.teardown();
    if (overlay) overlay.destroy();
    if (pricer) pricer.destroy();
    if (tray) tray.destroy();
  });
}
