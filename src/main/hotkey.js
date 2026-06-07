'use strict';

const { app, globalShortcut, clipboard, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { sendCtrlC } = require('./services/sendcopy');
const { scanScreen } = require('./services/ocr');
const { looksLikeItem } = require('./services/itemtext');

const HOTKEY = 'F9'; // 단일 아이템(호버) 시세
const SCAN_HOTKEY = 'F10'; // 화면 OCR 다중 시세 스캔
const POLL_BUDGET_MS = 900;
const POLL_INTERVAL_MS = 40;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/** 콘솔 + 파일(userData/f9-debug.log) 동시 로깅 — 터미널을 못 봐도 진단 가능하게. */
function dbg(msg) {
  console.log(msg);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'f9-debug.log'), `${new Date().toISOString()} ${msg}\n`);
  } catch (_) {
    /* noop */
  }
}

/**
 * F9 가격체크 흐름 (클립보드를 미리 덮어쓰지 않는 비파괴 방식):
 *  1) 현재 클립보드를 기억(before).
 *  2) 게임에 Ctrl+C 전송 -> 게임이 호버 아이템 텍스트를 클립보드에 복사.
 *  3) 클립보드가 before 에서 바뀌면 그것을 사용.
 *  4) 변하지 않았더라도 현재 클립보드가 아이템 형식이면 사용(직접 Ctrl+C 한 수동 폴백).
 *  5) 사용자의 원래 클립보드를 복원.
 *  6) 파싱/조회해 오버레이로 표시. 아이템이 아니거나 시세가 없으면 No Item.
 */
async function runPriceCheck(store, overlay) {
  const point = screen.getCursorScreenPoint();

  if (!store.catalog) {
    overlay.show(point, { found: false, reason: '준비 중' });
    return;
  }

  const before = clipboard.readText();

  let sendErr = null;
  try {
    await sendCtrlC();
  } catch (e) {
    sendErr = e; // 키 전송 실패해도 아래 수동 폴백으로 진행
  }

  let text = '';
  const start = Date.now();
  while (Date.now() - start < POLL_BUDGET_MS) {
    await delay(POLL_INTERVAL_MS);
    const cur = clipboard.readText();
    if (cur && cur !== before) {
      text = cur;
      break;
    }
  }
  // 수동 폴백: 변화가 없어도 현재 클립보드가 아이템이면 사용
  if (!looksLikeItem(text)) {
    const cur = clipboard.readText();
    if (looksLikeItem(cur)) text = cur;
  }

  // 사용자 클립보드 복원
  try {
    if (clipboard.readText() !== before) {
      if (before) clipboard.writeText(before);
      else clipboard.clear();
    }
  } catch (e) {
    /* noop */
  }

  // 복사 실패(아이템 형식 아님) vs 시세 없음(아이템 인식했으나 미집계) 구분
  let result;
  const copied = looksLikeItem(text);
  if (!copied) {
    result = { found: false, reason: '복사 실패' };
  } else {
    result = store.priceCheck(text);
    if (!result.found) result.reason = '시세 없음';
  }

  // 진단 로그 (콘솔 + userData/f9-debug.log)
  dbg(
    `[F9] fired copied=${copied} name="${result.name || ''}" found=${result.found}` +
      ` clipLen=${text.length} cursor=${point.x},${point.y} sendErr=${sendErr ? sendErr.message : '-'}`
  );

  overlay.show(point, result);
}

/**
 * F10 화면 OCR 스캔: 오버레이를 잠시 숨기고(캡처 오염 방지) 화면을 OCR →
 * 인식된 아이템들의 시세를 다중 오버레이로 표시.
 */
async function runScan(store, overlay) {
  const point = screen.getCursorScreenPoint();
  if (!store.catalog) {
    overlay.show(point, { scan: true, items: [], reason: '준비 중' });
    return;
  }
  overlay.hide(); // 오버레이가 캡처에 찍히지 않도록
  try {
    const { lines, noLang, dim } = await scanScreen();
    if (noLang) {
      dbg('[F10] OCR 언어(한글) 없음');
      overlay.show(screen.getCursorScreenPoint(), { scan: true, items: [], reason: '한글 OCR 없음' });
      return;
    }
    const res = store.scanRecipe(lines);
    dbg(`[F10] scan ${dim || '?'} lines=${lines.length} matched=${res.items.length}`);
    overlay.show(screen.getCursorScreenPoint(), res);
  } catch (e) {
    dbg('[F10] scan 실패: ' + (e && e.message ? e.message : e));
    overlay.show(screen.getCursorScreenPoint(), { scan: true, items: [], reason: '스캔 실패' });
  }
}

function setupHotkey(store, overlay) {
  if (process.platform !== 'win32') return false;

  let running9 = false;
  const ok = globalShortcut.register(HOTKEY, () => {
    if (running9) return;
    running9 = true;
    runPriceCheck(store, overlay)
      .catch((e) => console.error('[hotkey] 가격체크 실패:', e))
      .finally(() => {
        running9 = false;
      });
  });
  dbg(`[hotkey] ${HOTKEY} 등록 ${ok ? '성공' : '실패(다른 프로그램이 F9 점유 중일 수 있음)'}`);

  let running10 = false;
  const okScan = globalShortcut.register(SCAN_HOTKEY, () => {
    if (running10) return;
    running10 = true;
    runScan(store, overlay)
      .catch((e) => console.error('[hotkey] 스캔 실패:', e))
      .finally(() => {
        running10 = false;
      });
  });
  dbg(`[hotkey] ${SCAN_HOTKEY} 등록 ${okScan ? '성공' : '실패'}`);

  return ok;
}

function teardownHotkey() {
  globalShortcut.unregisterAll();
}

module.exports = { setupHotkey, teardownHotkey, HOTKEY };
