'use strict';

const { app, globalShortcut, clipboard, screen } = require('electron');
const fs = require('fs');
const path = require('path');
const { sendCtrlC } = require('./services/sendcopy');
const { scanScreen } = require('./services/ocr');
const { looksLikeItem } = require('./services/itemtext');
const { ACTIONS, DEFAULT_HOTKEYS, mergeHotkeys, validateHotkeyMap } = require('./services/accelerator');

const POLL_BUDGET_MS = 900;
const POLL_INTERVAL_MS = 40;

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 호버한 아이템 텍스트를 비파괴적으로 가져온다(클립보드 복원).
 * 게임에 Ctrl+C 전송 → 클립보드 변화 폴링 → 아이템 형식이면 채택 → 원본 복원.
 * @returns {Promise<{text:string, sendErr:Error|null, before:string}>}
 */
async function grabItemText() {
  const before = clipboard.readText();
  let sendErr = null;
  try {
    await sendCtrlC();
  } catch (e) {
    sendErr = e; // 키 전송 실패해도 수동 폴백으로 진행
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
  // 수동 폴백: 변화 없어도 현재 클립보드가 아이템이면 사용
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
  return { text, sendErr, before };
}

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

  // 클립보드 폴링(최대 ~900ms) 동안 로딩 스피너 표시. 결과가 나오면 곧 교체된다.
  overlay.show(point, { loading: true });

  const { text, sendErr } = await grabItemText();

  // 복사 실패(아이템 형식 아님) vs 시세 없음(아이템 인식했으나 미집계) 구분
  let result;
  const copied = looksLikeItem(text);
  if (!copied) {
    result = { found: false, reason: '복사 실패' };
  } else {
    result = await store.priceCheck(text);
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
  // F10 누르는 즉시 로딩 표시(PowerShell 콜드스타트가 길어도 먹통처럼 보이지 않게).
  // 캡처 직전(__CAPTURING__)에 잠깐 숨겨 스피너가 스크린샷에 안 찍히게 하고, 캡처 후 다시 표시.
  overlay.show(point, { loading: true });
  try {
    const { lines, noLang, dim, lang } = await scanScreen({
      onCapturing: () => overlay.hide(),
      onCaptured: () => overlay.show(screen.getCursorScreenPoint(), { loading: true }),
    });
    if (noLang) {
      dbg('[F10] OCR 언어(한글) 없음');
      overlay.show(screen.getCursorScreenPoint(), { scan: true, items: [], reason: '한글 OCR 없음' });
      return;
    }
    const res = await store.scanRecipe(lines);
    dbg(
      `[F10] scan ${dim || '?'} lang=${lang || '?'} lines=${lines.length} priced=${res.items.length}${res.partial ? '(부분)' : ''}`
    );
    overlay.show(screen.getCursorScreenPoint(), res);
  } catch (e) {
    dbg('[F10] scan 실패: ' + (e && e.message ? e.message : e));
    overlay.show(screen.getCursorScreenPoint(), { scan: true, items: [], reason: '스캔 실패' });
  }
}

/**
 * Shift+F9 인터랙티브 옵션 시세: 호버 아이템 텍스트 → 모드 파싱 →
 * 포커스 가능한 창에서 사용자가 옵션을 골라 동급이상 시세 검색.
 */
async function runPricer(store, overlay, pricer) {
  if (!pricer) return;
  const point = screen.getCursorScreenPoint();
  if (!store.catalog) {
    overlay.show(point, { found: false, reason: '준비 중' });
    return;
  }
  // 클립보드 폴링 동안 빠른 로딩 표시(스탯사전 첫 로드 시 수 초 걸릴 수 있음).
  overlay.show(point, { loading: true });
  const { text } = await grabItemText();
  if (!looksLikeItem(text)) {
    dbg('[ShiftF9] 아이템 복사 실패');
    overlay.show(point, { found: false, reason: '복사 실패' });
    return;
  }
  const item = await store.inspectItem(text);
  // 장비(카테고리 있음)면 옵션이 없어도(일반/베이스) 타입+아이템레벨로 시세 조회 가능.
  if (!item || (!item.mods.length && !item.categoryId)) {
    dbg(`[ShiftF9] 장비 아님 rarity=${item ? item.rarity : '?'}`);
    overlay.show(point, { found: false, reason: '장비 아님' });
    return;
  }
  dbg(`[ShiftF9] fired rarity=${item.rarity} mods=${item.mods.length} cat=${item.categoryId || '-'}`);
  overlay.hide(); // 빠른 로딩 오버레이 닫고 인터랙티브 창으로
  pricer.show(point, item);
}

/**
 * 동작별 핸들러를 만든다. 각 핸들러는 자체 재진입 가드(running 플래그)를 가져
 * 누름이 겹쳐도 중복 실행되지 않는다. 재등록해도 같은 핸들러를 재사용한다.
 */
function makeHandlers(store, overlay, pricer) {
  let running9 = false;
  let running10 = false;
  let runningP = false;
  return {
    price: () => {
      if (running9) return;
      running9 = true;
      runPriceCheck(store, overlay)
        .catch((e) => console.error('[hotkey] 가격체크 실패:', e))
        .finally(() => { running9 = false; });
    },
    scan: () => {
      if (running10) return;
      running10 = true;
      runScan(store, overlay)
        .catch((e) => console.error('[hotkey] 스캔 실패:', e))
        .finally(() => { running10 = false; });
    },
    pricer: () => {
      if (runningP) return;
      runningP = true;
      runPricer(store, overlay, pricer)
        .catch((e) => console.error('[hotkey] 옵션 시세 실패:', e))
        .finally(() => { runningP = false; });
    },
  };
}

/**
 * 주어진 accelerator 맵으로 세 동작을 (재)등록한다.
 * 이전 맵(previous)이 있으면 그 세 키만 골라 해제한다 — 앱의 다른 globalShortcut 은 건드리지 않는다.
 * @returns {{price:boolean, scan:boolean, pricer:boolean}} 동작별 등록 성공 여부.
 */
function registerAll(map, handlers, previous) {
  if (previous) {
    for (const action of ACTIONS) {
      try {
        globalShortcut.unregister(previous[action]); // 미등록 키 해제는 무해(no-op)
      } catch (e) {
        /* noop */
      }
    }
  }
  const results = {};
  for (const action of ACTIONS) {
    const accel = map[action];
    let ok = false;
    try {
      ok = globalShortcut.register(accel, handlers[action]);
    } catch (e) {
      ok = false;
    }
    results[action] = ok;
    dbg(`[hotkey] ${action}=${accel} 등록 ${ok ? '성공' : '실패(다른 프로그램이 점유 중일 수 있음)'}`);
  }
  return results;
}

/**
 * 전역 단축키 컨트롤러. 설정에서 읽어 등록하고, 설정 화면 변경 시 재등록한다.
 * @returns {{ init:Function, apply:Function, getCurrent:Function, teardown:Function }}
 */
function createHotkeyController(store, overlay, pricer) {
  const handlers = makeHandlers(store, overlay, pricer);
  let current = { ...DEFAULT_HOTKEYS };
  let applying = false; // 동시 적용(중복 저장/이중 클릭) 직렬화 — 재등록이 서로 덮어쓰지 않게.

  return {
    /** 저장된 설정(또는 기본값)으로 최초 등록. @returns {Promise<object>} 동작별 결과. */
    async init() {
      const settings = await store.getSettings();
      const next = mergeHotkeys(settings.hotkeys);
      const results = registerAll(next, handlers, current);
      current = next;
      return results;
    },

    /** 현재 적용 중인 정규형 단축키 맵(불변 복사). */
    getCurrent() {
      return { ...current };
    },

    /**
     * 렌더러가 보낸 맵을 검증 → 재등록 → 영속 저장. 동시 호출은 거절(busy)해 레이스를 막는다.
     * @returns {Promise<{ok:boolean, hotkeys:object, results?:object, errors?:object}>}
     */
    async apply(rawMap) {
      if (applying) return { ok: false, hotkeys: { ...current }, error: 'busy' };
      applying = true;
      try {
        const v = validateHotkeyMap(rawMap);
        if (v.errors) return { ok: false, errors: v.errors, hotkeys: { ...current } };
        const results = registerAll(v.map, handlers, current);
        current = v.map;
        await store.setSetting('hotkeys', v.map);
        return { ok: ACTIONS.every((a) => results[a]), hotkeys: { ...current }, results };
      } finally {
        applying = false;
      }
    },

    teardown() {
      globalShortcut.unregisterAll();
    },
  };
}

module.exports = { createHotkeyController };
