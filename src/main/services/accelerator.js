'use strict';

/**
 * 단축키(Electron accelerator) 정규화·검증 — 순수 함수 모듈(네트워크/Electron 의존 없음, 테스트 가능).
 *
 * 앱이 쓰는 전역 단축키는 세 가지 동작뿐이다:
 *   price  : 단일 아이템(호버) 시세      (기본 F9)
 *   scan   : 화면 OCR 다중 시세 스캔      (기본 F10)
 *   pricer : 인터랙티브 옵션(모드) 시세   (기본 Shift+F9)
 *
 * 사용자가 설정 화면에서 키를 바꾸면, 렌더러가 보낸 문자열을 여기서 정규화·검증한 뒤
 * globalShortcut 으로 재등록한다(hotkey.js). 위험한 조합(맨 글자키 전역 점유 등)은 거른다.
 */

const ACTIONS = Object.freeze(['price', 'scan', 'pricer']);

const DEFAULT_HOTKEYS = Object.freeze({
  price: 'F9',
  scan: 'F10',
  pricer: 'Shift+F9',
});

// 허용 수정자(별칭 → Electron 표준형). 안전을 위해 Ctrl/Alt/Shift 만 허용(Super/Win 제외 → OS 충돌 회피).
const MODIFIERS = Object.freeze({
  ctrl: 'Control',
  control: 'Control',
  shift: 'Shift',
  alt: 'Alt',
});

// 표준 수정자 표기 순서(항상 동일한 정규형을 내도록).
const MOD_ORDER = ['Control', 'Alt', 'Shift'];

/** 단일 키 토큰을 정규화. F1~F24 / A~Z / 0~9 만 허용. 그 외엔 null. */
function normalizeKey(token) {
  const up = String(token || '').toUpperCase();
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(up)) return up; // F1~F24
  if (/^[A-Z0-9]$/.test(up)) return up; // 단일 영문/숫자
  return null;
}

function isFunctionKey(key) {
  return /^F([1-9]|1[0-9]|2[0-4])$/.test(key);
}

/**
 * 'shift+f9', 'Ctrl + Alt + P', 'F10' 같은 입력을 Electron 표준 accelerator 로 정규화.
 * 유효하지 않으면 null.
 * @param {string} input
 * @returns {string|null}  예: 'Shift+F9', 'Control+Alt+P', 'F10'
 */
function normalizeAccelerator(input) {
  // 길이 상한: 유효 accelerator 는 길어야 'Control+Alt+Shift+F24'(21자). 거대 문자열로 인한
  // 메인 프로세스 동기 처리 지연을 차단(렌더러가 보낼 수 있는 입력은 신뢰하지 않는다).
  if (typeof input !== 'string' || input.length > 64) return null;
  const parts = input.split('+').map((p) => p.trim()).filter(Boolean);
  if (!parts.length) return null;

  const mods = [];
  let key = null;
  for (const p of parts) {
    const low = p.toLowerCase();
    if (Object.prototype.hasOwnProperty.call(MODIFIERS, low)) {
      const m = MODIFIERS[low];
      if (!mods.includes(m)) mods.push(m);
    } else {
      if (key) return null; // 비수정자 키가 둘 이상 → 무효
      key = normalizeKey(p);
      if (!key) return null;
    }
  }
  if (!key) return null;

  const ordered = mods.slice().sort((a, b) => MOD_ORDER.indexOf(a) - MOD_ORDER.indexOf(b));
  return [...ordered, key].join('+');
}

/** accelerator 의 키(마지막 토큰). */
function keyOf(accel) {
  return String(accel).split('+').pop();
}

/** 수정자가 하나라도 있는가. */
function hasModifier(accel) {
  return String(accel).split('+').length > 1;
}

/**
 * 전역 등록해도 안전한가. 맨 글자/숫자 키(F 키 아님 + 수정자 없음)는 전역 타이핑을 가로채므로 금지.
 * 펑션키(F9 등)는 수정자 없이도 허용(이 앱의 기본값).
 */
function isRegisterable(accel) {
  const key = keyOf(accel);
  return isFunctionKey(key) || hasModifier(accel);
}

/**
 * 저장된 설정(부분/누락/구형 표기 가능)을 세 동작 모두 채운 정규형 맵으로 병합.
 * 각 항목이 무효면 기본값으로 폴백.
 * @param {object} [stored]
 * @returns {{price:string, scan:string, pricer:string}}
 */
function mergeHotkeys(stored) {
  const src = stored && typeof stored === 'object' ? stored : {};
  const out = {};
  for (const action of ACTIONS) {
    out[action] = normalizeAccelerator(src[action]) || DEFAULT_HOTKEYS[action];
  }
  return out;
}

/**
 * 렌더러가 보낸 단축키 맵을 검증.
 * - 각 항목이 유효한 accelerator 인지
 * - 전역 등록 가능한지(맨 글자키 금지)
 * - 세 동작 간 중복이 없는지
 * @param {object} raw
 * @returns {{ map: object } | { errors: object }}  성공 시 정규형 map, 실패 시 동작별 사유.
 */
function validateHotkeyMap(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const errors = {};
  const normalized = {};
  for (const action of ACTIONS) {
    const accel = normalizeAccelerator(src[action]);
    if (!accel) {
      errors[action] = 'invalid';
      continue;
    }
    if (!isRegisterable(accel)) {
      errors[action] = 'needsModifier';
      continue;
    }
    normalized[action] = accel;
  }
  // 중복 검사(정규형 기준): 두 동작이 같은 키 조합이면 둘 다 오류.
  const seen = new Map();
  for (const action of ACTIONS) {
    const accel = normalized[action];
    if (!accel) continue;
    if (seen.has(accel)) {
      errors[action] = 'duplicate';
      errors[seen.get(accel)] = 'duplicate';
    } else {
      seen.set(accel, action);
    }
  }
  if (Object.keys(errors).length) return { errors };
  return { map: { price: normalized.price, scan: normalized.scan, pricer: normalized.pricer } };
}

module.exports = {
  ACTIONS,
  DEFAULT_HOTKEYS,
  normalizeAccelerator,
  isRegisterable,
  mergeHotkeys,
  validateHotkeyMap,
};
