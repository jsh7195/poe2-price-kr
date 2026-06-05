'use strict';

/* 렌더러 UI 로직. window.api(preload) 만 사용한다. */

const $ = (id) => document.getElementById(id);
const el = {
  league: $('league'),
  refresh: $('refresh'),
  testOverlay: $('test-overlay'),
  hideTray: $('hide-tray'),
  checkUpdate: $('check-update'),
  updateBar: $('update-bar'),
  updateMsg: $('update-msg'),
  updateAction: $('update-action'),
  appVersion: $('app-version'),
  adminHint: $('admin-hint'),
  relaunchAdmin: $('relaunch-admin'),
  search: $('search'),
  clear: $('clear'),
  hint: $('hint'),
  results: $('results'),
  statusMsg: $('status-msg'),
  statusMeta: $('status-meta'),
  overlay: $('overlay'),
  overlayMsg: $('overlay-msg'),
};

let ref = null; // 기준 통화(divine/exalted 아이콘)
let lastLeaguesKey = '';
let currentQuery = '';

// ---------- 포맷 유틸 ----------
function fmtNum(n) {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 10000) return Math.round(n / 1000) + 'k';
  if (a >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a >= 100) return String(Math.round(n));
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return n.toFixed(2).replace(/\.?0+$/, '');
  if (a >= 0.01) return n.toFixed(2);
  if (a > 0) return n.toFixed(4).replace(/\.?0+$/, '') || '0'; // 과학표기(5e-10) 방지
  return '0';
}

function timeAgo(ts) {
  if (!ts) return '';
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return '방금 전';
  const m = Math.floor(s / 60);
  if (m < 60) return m + '분 전';
  const h = Math.floor(m / 60);
  if (h < 24) return h + '시간 전';
  return Math.floor(h / 24) + '일 전';
}

// divine/exalted 적응형 표기 데이터 생성
function valueParts(rec) {
  const d = rec.valueDivine;
  const x = rec.valueExalted;
  const divIcon = ref && ref.divine ? ref.divine.icon : '';
  const exIcon = ref && ref.exalted ? ref.exalted.icon : '';
  let primary = null, secondary = null;
  if (d != null && d >= 1) {
    primary = { num: d, unit: 'div', icon: divIcon };
    if (x != null) secondary = { num: x, unit: 'ex', icon: exIcon };
  } else if (x != null) {
    primary = { num: x, unit: 'ex', icon: exIcon };
    if (d != null && d >= 0.005) secondary = { num: d, unit: 'div', icon: divIcon };
  } else if (d != null) {
    primary = { num: d, unit: 'div', icon: divIcon };
  }
  return { primary, secondary };
}

// ---------- DOM 생성 ----------
function curIcon(part) {
  if (part.icon) {
    const img = document.createElement('img');
    img.className = 'cur-icon';
    img.src = part.icon;
    img.alt = part.unit;
    img.title = part.unit;
    img.onerror = () => { img.replaceWith(unitText(part.unit)); };
    return img;
  }
  return unitText(part.unit);
}
function unitText(unit) {
  const s = document.createElement('span');
  s.className = 'cur-unit';
  s.textContent = unit;
  return s;
}

function valueLine(part, cls) {
  const line = document.createElement('div');
  line.className = 'val-line ' + cls;
  const num = document.createElement('span');
  num.textContent = fmtNum(part.num);
  line.appendChild(num);
  line.appendChild(curIcon(part));
  return line;
}

function rowEl(rec) {
  const row = document.createElement('div');
  row.className = 'row';

  const icon = document.createElement('img');
  icon.className = 'row-icon';
  icon.loading = 'lazy';
  icon.src = rec.icon || '';
  icon.alt = '';
  let swapped = false;
  icon.onerror = () => {
    if (!swapped && rec.icon && rec.icon.includes('web.poecdn.com')) {
      swapped = true;
      icon.src = rec.icon.replace('web.poecdn.com', 'poe.ninja');
    } else {
      icon.classList.add('broken');
    }
  };

  const main = document.createElement('div');
  main.className = 'row-main';
  const kr = document.createElement('div');
  kr.className = 'row-kr';
  kr.textContent = rec.kr;
  if (rec.corrupted) {
    const b = document.createElement('span');
    b.className = 'tag badge-corrupt';
    b.textContent = '타락';
    kr.appendChild(document.createTextNode(' '));
    kr.appendChild(b);
  }
  const en = document.createElement('div');
  en.className = 'row-en';
  const cat = document.createElement('span');
  cat.className = 'tag';
  cat.textContent = rec.labelKr;
  en.appendChild(cat);
  en.appendChild(document.createTextNode(rec.en + (rec.baseType ? ' · ' + rec.baseType : '')));
  main.appendChild(kr);
  main.appendChild(en);

  const valWrap = document.createElement('div');
  valWrap.className = 'row-value';
  const { primary, secondary } = valueParts(rec);
  if (primary) valWrap.appendChild(valueLine(primary, 'val-primary'));
  if (secondary) valWrap.appendChild(valueLine(secondary, 'val-secondary'));
  if (!primary) {
    const none = document.createElement('div');
    none.className = 'val-secondary';
    none.textContent = '시세 없음';
    valWrap.appendChild(none);
  }
  if (rec.change7d != null && Math.abs(rec.change7d) >= 1) {
    const ch = document.createElement('div');
    ch.className = 'change ' + (rec.change7d >= 0 ? 'up' : 'down');
    ch.textContent = (rec.change7d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(rec.change7d)) + '%';
    valWrap.appendChild(ch);
  }

  row.appendChild(icon);
  row.appendChild(main);
  row.appendChild(valWrap);
  return row;
}

function renderResults(list, query) {
  el.results.replaceChildren();
  el.hint.classList.toggle('is-hidden', !!query);
  if (!query) return;
  if (!list.length) {
    // innerHTML 미사용(외부 데이터 주입 경로 차단): DOM API 로만 구성
    const empty = document.createElement('div');
    empty.className = 'empty';
    const big = document.createElement('div');
    big.className = 'big';
    big.textContent = '🔍';
    const hint = document.createElement('span');
    hint.className = 'en-hint';
    hint.textContent = 'poe.ninja에 시세가 없거나, 이름 일부만 입력해 보세요.';
    empty.append(big, '검색 결과가 없습니다.', document.createElement('br'), hint);
    el.results.appendChild(empty);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const rec of list) frag.appendChild(rowEl(rec));
  el.results.appendChild(frag);
}

// ---------- 검색 ----------
let debounceTimer = null;
async function doSearch() {
  const q = el.search.value.trim();
  currentQuery = q;
  el.clear.classList.toggle('hidden', !q);
  if (!q) { renderResults([], ''); return; }
  try {
    const res = await window.api.search(q);
    // 입력이 그 사이 바뀌었으면 무시(레이스 방지)
    if (q !== el.search.value.trim()) return;
    renderResults(res && res.ok ? res.results : [], q);
  } catch (err) {
    if (q !== el.search.value.trim()) return;
    el.statusMsg.className = 'status-msg error';
    el.statusMsg.textContent = '검색 오류: ' + (err && err.message ? err.message : '알 수 없는 오류');
  }
}

function onInput() {
  clearTimeout(debounceTimer);
  debounceTimer = setTimeout(doSearch, 110);
}

// ---------- 상태 반영 ----------
function applyStatus(s) {
  if (!s) return;
  ref = s.ref || ref;

  // 리그 드롭다운(목록 바뀔 때만 재구성)
  const leaguesKey = (s.leagues || []).map((l) => l.name).join('|');
  if (leaguesKey && leaguesKey !== lastLeaguesKey) {
    lastLeaguesKey = leaguesKey;
    el.league.replaceChildren();
    for (const l of s.leagues) {
      const opt = document.createElement('option');
      opt.value = l.name;
      opt.textContent = l.displayName + (l.hardcore ? '' : '');
      el.league.appendChild(opt);
    }
  }
  if (s.leagueName) el.league.value = s.leagueName;

  // 관리자 권한 아님 → 게임 위 F9 안내 표시
  el.adminHint.classList.toggle('hidden', s.elevated !== false);

  // 오버레이는 "최초 로딩(데이터 0개)" 동안만. 이후 갱신은 버튼 스피너로만 표시.
  const busy = s.building || s.phase === 'loading';
  const initialLoading = (busy || s.phase === 'idle') && !(s.count > 0);
  el.overlay.classList.toggle('hidden', !initialLoading);
  el.overlay.setAttribute('aria-hidden', initialLoading ? 'false' : 'true');
  el.overlayMsg.textContent = s.message || '불러오는 중…';
  el.refresh.classList.toggle('spinning', busy);
  el.refresh.disabled = busy;

  // 상태바
  const hotkeyFailed = s.hotkeyOk === false;
  el.statusMsg.className =
    'status-msg' + (s.phase === 'error' ? ' error' : (hotkeyFailed || (s.errors && s.errors.length) ? ' warn' : ''));
  if (s.phase === 'error') {
    el.statusMsg.textContent = '⚠ ' + (s.message || '오류');
  } else if (hotkeyFailed) {
    el.statusMsg.textContent = '⚠ F9 단축키 등록 실패 — 다른 프로그램이 F9를 사용 중일 수 있습니다';
  } else if (s.errors && s.errors.length) {
    el.statusMsg.textContent = `일부 카테고리 로드 실패 (${s.errors.length}개)`;
  } else {
    el.statusMsg.textContent = s.message || '';
  }
  const parts = [];
  if (s.count) parts.push(`${s.count.toLocaleString()}개 아이템`);
  if (s.updatedAt) parts.push(`업데이트 ${timeAgo(s.updatedAt)}`);
  el.statusMeta.textContent = parts.join('  ·  ');

  // 시세가 갱신되면 현재 검색 재실행 (디바운스 타이머와 합쳐 중복 실행 방지)
  if (s.phase === 'ready' && currentQuery) {
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(doSearch, 0);
  }
}

// ---------- 이벤트 ----------
el.search.addEventListener('input', onInput);
el.clear.addEventListener('click', () => { el.search.value = ''; el.search.focus(); doSearch(); });
el.refresh.addEventListener('click', () => { if (!el.refresh.disabled) window.api.refresh(); });
el.testOverlay.addEventListener('click', () => { window.api.testOverlay(); });
el.hideTray.addEventListener('click', () => { window.api.hideToTray(); });
el.relaunchAdmin.addEventListener('click', () => {
  el.relaunchAdmin.textContent = '재실행 중…';
  el.relaunchAdmin.disabled = true;
  window.api.relaunchElevated();
});
el.league.addEventListener('change', () => { window.api.setLeague(el.league.value); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); el.search.focus(); el.search.select(); }
  if (e.key === 'Escape' && document.activeElement === el.search) { el.search.value = ''; doSearch(); }
});

// 업데이트 시각 상대표기 갱신
setInterval(() => {
  window.api.getStatus().then((s) => {
    if (s && s.updatedAt && !s.building) {
      const parts = [];
      if (s.count) parts.push(`${s.count.toLocaleString()}개 아이템`);
      parts.push(`업데이트 ${timeAgo(s.updatedAt)}`);
      el.statusMeta.textContent = parts.join('  ·  ');
    }
  });
}, 30000);

// ---------- 자동 업데이트 ----------
let updateHideTimer = null;
function applyUpdate(s) {
  if (!s || !s.state) return;
  const act = el.updateAction;
  act.classList.add('hidden');
  act.onclick = null;
  let text = '';
  let actionLabel = '';
  let actionFn = null;
  let autoHide = false;
  switch (s.state) {
    case 'checking': text = '업데이트 확인 중…'; break;
    case 'latest': text = `최신 버전입니다 (v${s.version || ''})`; autoHide = true; break;
    case 'available':
      text = `새 버전 v${s.version} 이(가) 있습니다.`;
      actionLabel = '다운로드'; actionFn = () => window.api.downloadUpdate();
      break;
    case 'downloading': text = `다운로드 중… ${s.percent || 0}%`; break;
    case 'downloaded':
      text = `v${s.version} 다운로드 완료.`;
      actionLabel = '재시작하여 적용'; actionFn = () => window.api.installUpdate();
      break;
    case 'unsupported': text = '자동 업데이트는 설치 버전(setup.exe)에서만 동작합니다.'; autoHide = true; break;
    case 'error': text = '업데이트 확인 실패: ' + (s.message || '알 수 없는 오류'); autoHide = true; break;
    default: return;
  }
  el.updateMsg.textContent = text;
  if (actionLabel && actionFn) {
    act.textContent = actionLabel;
    act.onclick = actionFn;
    act.classList.remove('hidden');
  }
  el.updateBar.classList.remove('hidden');
  clearTimeout(updateHideTimer);
  if (autoHide) updateHideTimer = setTimeout(() => el.updateBar.classList.add('hidden'), 6000);
}
el.checkUpdate.addEventListener('click', () => window.api.checkUpdate());
window.api.onUpdateStatus(applyUpdate);
window.api.getVersion().then((v) => { if (v) el.appVersion.textContent = 'v' + v; });

// ---------- 시작 ----------
window.api.onStatus(applyStatus);
window.api.getStatus().then(applyStatus);
el.search.focus();
