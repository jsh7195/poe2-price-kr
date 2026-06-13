'use strict';

const { BrowserWindow, screen } = require('electron');
const path = require('path');

const W = 460;
const H = 580;

/**
 * Shift+F9 인터랙티브 옵션 시세 창.
 * 가격 오버레이(클릭통과·비포커스)와 달리 이 창은 **포커스·클릭 가능** —
 * 사용자가 어떤 옵션으로 검색할지 체크박스로 고른다.
 */
class Pricer {
  constructor() {
    this.win = null;
    this.ready = false;
    this.pending = null;
    this._destroying = false;
  }

  create() {
    this.win = new BrowserWindow({
      width: W,
      height: H,
      show: false,
      frame: false,
      resizable: true,
      minWidth: 380,
      minHeight: 380,
      backgroundColor: '#0e0c08',
      title: '옵션 시세',
      skipTaskbar: true,
      fullscreenable: false,
      webPreferences: {
        preload: path.join(__dirname, '..', 'pricer', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
      },
    });

    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    this.win.loadFile(path.join(__dirname, '..', 'pricer', 'pricer.html'));

    this.win.webContents.once('did-finish-load', () => {
      this.ready = true;
      if (this.pending) {
        const { point, item } = this.pending;
        this.pending = null;
        this.show(point, item);
      }
    });

    // 닫기(Alt+F4 등) = 파괴 대신 숨김. 실제 파괴는 앱 종료 시에만.
    this.win.on('close', (e) => {
      if (!this._destroying) {
        e.preventDefault();
        this.win.hide();
      }
    });
    this.win.on('closed', () => {
      this.win = null;
      this.ready = false;
    });
  }

  /** 커서 근처에 아이템 옵션 패널을 띄운다(포커스 획득). */
  show(point, item) {
    if (!this.win || this.win.isDestroyed()) return;
    if (!this.ready) {
      this.pending = { point, item };
      return;
    }
    this._position(point);
    this.win.webContents.send('pricer:item', item);
    this.win.setAlwaysOnTop(true, 'screen-saver');
    this.win.show();
    this.win.focus();
  }

  _position(point) {
    const disp = screen.getDisplayNearestPoint(point);
    const wa = disp.workArea;
    const b = this.win.getBounds();
    let x = point.x + 24;
    let y = point.y + 24;
    if (x + b.width > wa.x + wa.width) x = wa.x + wa.width - b.width - 8;
    if (y + b.height > wa.y + wa.height) y = wa.y + wa.height - b.height - 8;
    x = Math.max(wa.x, x);
    y = Math.max(wa.y, y);
    this.win.setPosition(Math.round(x), Math.round(y));
  }

  hide() {
    if (this.win && !this.win.isDestroyed() && this.win.isVisible()) this.win.hide();
  }

  destroy() {
    this._destroying = true;
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { Pricer };
