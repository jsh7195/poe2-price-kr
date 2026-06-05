'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const WIDTH = 220;
const HEIGHT = 118; // 이름+1차+2차+변동률 모두 표시돼도 잘리지 않도록 여유(투명 영역)
const OFFSET_X = 30; // 커서 오른쪽으로(커서에 가리지 않게)
const OFFSET_Y = 34; // 커서 아래로
const AUTO_HIDE_MS = 4000;

/**
 * 커서 옆에 뜨는 가격 툴팁 오버레이.
 * - 투명/프레임리스/포커스 불가/클릭 통과 → 게임 입력을 절대 가로채지 않는다.
 * - showInactive() 로 게임 포커스를 빼앗지 않고 표시.
 */
class Overlay {
  constructor() {
    this.win = null;
    this.ready = false;
    this.pending = null; // 로드 완료 전에 들어온 표시 요청
    this.hideTimer = null;
  }

  create() {
    this.win = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'overlay', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.setIgnoreMouseEvents(true); // 클릭 통과
    this.win.loadFile(path.join(__dirname, '..', 'overlay', 'overlay.html'));

    this.win.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.pending) {
        const { point, payload } = this.pending;
        this.pending = null;
        this.show(point, payload);
      }
    });

    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
  }

  _sizeFor(payload) {
    if (payload && payload.scan) {
      const n = (payload.items || []).length;
      if (!n) return { w: 240, h: 84 };
      return { w: 344, h: 16 + Math.min(n, 9) * 31 + 12 };
    }
    return { w: WIDTH, h: HEIGHT };
  }

  _position(point, size) {
    const disp = screen.getDisplayNearestPoint(point);
    const wa = disp.workArea;
    const W = size.w;
    const H = size.h;
    let x = point.x + OFFSET_X;
    let y = point.y + OFFSET_Y;
    if (x + W > wa.x + wa.width) x = point.x - W - 12; // 오른쪽 공간 없으면 왼쪽
    if (y + H > wa.y + wa.height) y = point.y - H - 12; // 아래 공간 없으면 위
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width - W));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - H));
    this.win.setBounds({ x: Math.round(x), y: Math.round(y), width: W, height: H });
  }

  /** @param {{x:number,y:number}} point 화면 좌표(커서) */
  show(point, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.ready) {
      this.pending = { point, payload };
      return;
    }
    this._position(point, this._sizeFor(payload));
    this.win.webContents.send('overlay:price', payload);
    // 게임(테두리 없는 전체화면) 위로 확실히 올라오도록 최상위 재확정 후 비활성 표시
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.showInactive(); // 포커스 빼앗지 않음
    this.win.moveTop();
    clearTimeout(this.hideTimer);
    const hideMs = payload && payload.scan ? 8000 : AUTO_HIDE_MS; // 스캔은 더 오래
    this.hideTimer = setTimeout(() => this.hide(), hideMs);
  }

  hide() {
    clearTimeout(this.hideTimer);
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy() {
    clearTimeout(this.hideTimer);
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Overlay };
