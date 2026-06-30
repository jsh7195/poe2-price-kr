'use strict';

/* 단축키 설정 모달. window.api.settings(preload)만 사용. app.js 와 독립적으로 동작한다. */

const sEl = {
  open: document.getElementById('open-settings'),
  modal: document.getElementById('settings-modal'),
  close: document.getElementById('settings-close'),
  cancel: document.getElementById('settings-cancel'),
  save: document.getElementById('settings-save'),
  reset: document.getElementById('settings-reset'),
  msg: document.getElementById('settings-msg'),
  captures: Array.from(document.querySelectorAll('.hk-capture')),
  kbd: {
    price: document.getElementById('kbd-price'),
    scan: document.getElementById('kbd-scan'),
    pricer: document.getElementById('kbd-pricer'),
  },
  // 은신처 이동 쿠키
  tcInput: document.getElementById('tc-input'),
  tcSave: document.getElementById('tc-save'),
  tcClear: document.getElementById('tc-clear'),
  tcStatus: document.getElementById('tc-status'),
  tcMsg: document.getElementById('tc-msg'),
};

const ACTIONS = ['price', 'scan', 'pricer'];
let pending = { price: '', scan: '', pricer: '' }; // 정규형 accelerator(저장될 값)
let capturing = null; // 현재 키 입력을 기다리는 동작(price|scan|pricer) 또는 null
let closeTimer = null; // 저장 후 자동 닫기 타이머(중복 방지)

// ---------- 표시 변환 ----------
/** 저장형(Control+Alt+P) → 보기 좋은 표기(Ctrl+Alt+P). */
function displayAccel(accel) {
  if (!accel) return '—';
  return accel.replace(/Control/g, 'Ctrl');
}

/** 키보드 이벤트의 물리 키(code)를 accelerator 키 토큰으로. 펑션키/글자/숫자만. */
function codeToKey(code) {
  if (/^F([1-9]|1[0-9]|2[0-4])$/.test(code)) return code;
  let m = code.match(/^Key([A-Z])$/);
  if (m) return m[1];
  m = code.match(/^Digit([0-9])$/);
  if (m) return m[1];
  return null;
}

function isModifierCode(code) {
  return /^(Control|Shift|Alt|Meta)(Left|Right)$/.test(code) || code === 'OSLeft' || code === 'OSRight';
}

// ---------- 렌더 ----------
function syncCaptureLabels() {
  for (const btn of sEl.captures) {
    const action = btn.dataset.action;
    if (capturing === action) {
      btn.textContent = '키를 누르세요…';
      btn.classList.add('capturing');
    } else {
      btn.textContent = displayAccel(pending[action]);
      btn.classList.remove('capturing');
    }
  }
}

function setMsg(text, kind) {
  sEl.msg.textContent = text || '';
  sEl.msg.className = 'settings-msg' + (kind ? ' ' + kind : '');
}

/** 메인 화면 힌트의 <kbd> 표기도 현재 단축키로 갱신. */
function syncHintKbd(hotkeys) {
  for (const action of ACTIONS) {
    if (sEl.kbd[action] && hotkeys[action]) sEl.kbd[action].textContent = displayAccel(hotkeys[action]);
  }
}

// ---------- 열기/닫기 ----------
async function openModal() {
  setMsg('');
  capturing = null;
  try {
    const res = await window.api.settings.getHotkeys();
    const hk = (res && res.hotkeys) || {};
    pending = { price: hk.price || '', scan: hk.scan || '', pricer: hk.pricer || '' };
  } catch (e) {
    pending = { price: '', scan: '', pricer: '' };
  }
  syncCaptureLabels();
  refreshCookieStatus();
  sEl.tcInput.value = '';
  sEl.tcMsg.textContent = '';
  sEl.modal.classList.remove('hidden');
}

async function refreshCookieStatus() {
  let set = false;
  try {
    const s = await window.api.tradeCookieStatus();
    set = !!(s && s.set);
  } catch (e) { /* noop */ }
  sEl.tcStatus.textContent = set ? '설정됨 ✓' : '미설정';
  sEl.tcStatus.className = 'tc-status' + (set ? ' on' : '');
}

function closeModal() {
  clearTimeout(closeTimer);
  capturing = null;
  sEl.modal.classList.add('hidden');
}

// ---------- 키 캡처 ----------
function startCapture(action) {
  capturing = action;
  setMsg('');
  syncCaptureLabels();
}

// 모달이 열려 있을 때만 키를 가로챈다. Esc=취소/닫기, 그 외는 캡처 중에만.
document.addEventListener('keydown', (e) => {
  if (sEl.modal.classList.contains('hidden')) return;
  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    if (capturing) { capturing = null; syncCaptureLabels(); }
    else closeModal();
    return;
  }
  if (!capturing) return;
  e.preventDefault();
  e.stopPropagation();
  if (isModifierCode(e.code)) return; // 수정자만으로는 확정하지 않음
  const key = codeToKey(e.code);
  if (!key) {
    setMsg('지원하지 않는 키입니다. 펑션키(F1~F24) 또는 글자/숫자 키를 쓰세요.', 'error');
    return;
  }
  const mods = [];
  if (e.ctrlKey) mods.push('Ctrl');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  // 펑션키가 아니면 수정자 필수(맨 글자키는 전역 타이핑을 가로챔).
  if (!/^F([1-9]|1[0-9]|2[0-4])$/.test(key) && !mods.length) {
    setMsg('글자·숫자 키는 Ctrl·Alt·Shift 와 함께 눌러야 합니다.', 'error');
    return;
  }
  pending[capturing] = [...mods, key].join('+');
  capturing = null;
  setMsg('');
  syncCaptureLabels();
}, true);

// ---------- 저장/복원 ----------
async function save() {
  // 클라이언트단 중복 1차 검사(서버가 최종 검증).
  const vals = ACTIONS.map((a) => pending[a]).filter(Boolean);
  if (vals.length < ACTIONS.length) {
    setMsg('세 단축키를 모두 지정하세요.', 'error');
    return;
  }
  if (new Set(vals).size !== vals.length) {
    setMsg('같은 키를 두 동작에 쓸 수 없습니다.', 'error');
    return;
  }
  sEl.save.disabled = true;
  setMsg('적용 중…');
  let res;
  try {
    res = await window.api.settings.setHotkeys({ ...pending });
  } catch (e) {
    res = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  sEl.save.disabled = false;
  applyResult(res);
}

const ERR_TEXT = {
  invalid: '인식할 수 없는 키',
  duplicate: '다른 동작과 중복',
  needsModifier: 'Ctrl·Alt·Shift 필요',
};
const ACTION_LABEL = { price: '단일 시세', scan: '화면 스캔', pricer: '옵션 시세' };

function applyResult(res) {
  if (!res) {
    setMsg('저장 실패', 'error');
    return;
  }
  if (res.errors) {
    const parts = ACTIONS.filter((a) => res.errors[a]).map((a) => `${ACTION_LABEL[a]}(${ERR_TEXT[res.errors[a]] || '오류'})`);
    setMsg('확인이 필요합니다: ' + parts.join(', '), 'error');
    return;
  }
  // 검증 통과도 결과(results)도 없는데 실패 → 일반 오류(예: 동시 적용 거절). 성공으로 오인하지 않게.
  if (!res.ok && !res.results) {
    setMsg('적용하지 못했습니다. 잠시 후 다시 시도하세요.', 'error');
    return;
  }
  // 적용됨(등록 성공/실패 안내). hotkeys 는 정규형.
  if (res.hotkeys) {
    pending = { ...res.hotkeys };
    syncCaptureLabels();
    syncHintKbd(res.hotkeys);
  }
  if (res.results && !res.ok) {
    const failed = ACTIONS.filter((a) => res.results[a] === false).map((a) => ACTION_LABEL[a]);
    setMsg(`저장됨. 단, ${failed.join('·')} 단축키는 다른 프로그램이 사용 중이라 등록되지 않았습니다.`, 'warn');
  } else {
    setMsg('저장되었습니다.', 'ok');
    clearTimeout(closeTimer);
    closeTimer = setTimeout(() => { if (!capturing) closeModal(); }, 700);
  }
}

async function reset() {
  sEl.reset.disabled = true;
  setMsg('기본값으로 복원 중…');
  let res;
  try {
    res = await window.api.settings.resetHotkeys();
  } catch (e) {
    res = { ok: false, error: String(e && e.message ? e.message : e) };
  }
  sEl.reset.disabled = false;
  applyResult(res);
}

// ---------- 이벤트 ----------
sEl.open.addEventListener('click', openModal);
sEl.close.addEventListener('click', closeModal);
sEl.cancel.addEventListener('click', closeModal);
sEl.save.addEventListener('click', save);
sEl.reset.addEventListener('click', reset);
sEl.modal.addEventListener('click', (e) => { if (e.target === sEl.modal) closeModal(); });
for (const btn of sEl.captures) {
  btn.addEventListener('click', () => startCapture(btn.dataset.action));
}

// 은신처 이동 쿠키 저장/지우기
sEl.tcSave.addEventListener('click', async () => {
  const v = sEl.tcInput.value.trim();
  if (!v) { sEl.tcMsg.textContent = '붙여넣은 쿠키가 없습니다.'; sEl.tcMsg.className = 'tc-msg error'; return; }
  sEl.tcSave.disabled = true;
  try {
    const r = await window.api.tradeSetCookie(v);
    sEl.tcMsg.textContent = r && r.set ? '저장됨 — 이제 🏠 은신처 이동이 됩니다.' : '저장 실패';
    sEl.tcMsg.className = 'tc-msg' + (r && r.set ? ' ok' : ' error');
    sEl.tcInput.value = '';
  } catch (e) {
    sEl.tcMsg.textContent = '저장 실패';
    sEl.tcMsg.className = 'tc-msg error';
  }
  sEl.tcSave.disabled = false;
  refreshCookieStatus();
});
sEl.tcClear.addEventListener('click', async () => {
  try { await window.api.tradeSetCookie(''); } catch (e) { /* noop */ }
  sEl.tcInput.value = '';
  sEl.tcMsg.textContent = '쿠키를 지웠습니다.';
  sEl.tcMsg.className = 'tc-msg';
  refreshCookieStatus();
});

// 시작 시 메인 힌트의 단축키 표기를 실제 설정값으로 맞춘다.
window.api.settings.getHotkeys().then((res) => {
  if (res && res.hotkeys) syncHintKbd(res.hotkeys);
}).catch(() => { /* noop */ });
