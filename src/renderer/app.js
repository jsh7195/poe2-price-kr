'use strict';

/* 렌더러 UI 로직. window.api(preload) 만 사용한다. */

const $ = (id) => document.getElementById(id);
const el = {
  league: $('league'),
  refresh: $('refresh'),
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
  urlAdd: $('url-add'),
  urlAddInput: $('url-add-input'),
  urlAddBtn: $('url-add-btn'),
  urlAddMsg: $('url-add-msg'),
  results: $('results'),
  statusMsg: $('status-msg'),
  reportError: $('report-error'),
  statusMeta: $('status-meta'),
  overlay: $('overlay'),
  overlayMsg: $('overlay-msg'),
};

let ref = null; // 기준 통화(divine/exalted 아이콘)
let lastLeaguesKey = '';
let currentQuery = '';
let lastStatus = null; // 신고 버튼이 참조할 최근 상태(메시지·카테고리 오류)
let favorites = []; // 즐겨찾기(메인창 워치리스트)

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

function curShort(c) {
  return c === 'divine' ? 'div' : c === 'exalted' || c === 'exalt' ? 'ex' : c;
}
function currencyIcon(c) {
  return (ref && ref.currencyIcons && ref.currencyIcons[c]) || '';
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
  if (isUniqueRec(rec)) {
    // 유니크(장착 장비) → 클릭 시 GGG 거래소 실매물 조회(목록 전체 라이브는 레이트리밋).
    renderRowPrice(valWrap, rec, 'idle');
  } else {
    // 화폐/룬/우상/소모품 → ninja 집계값 인라인(즉시).
    renderRowPrice(valWrap, rec, 'done', {
      exalted: rec.valueExalted, divine: rec.valueDivine, listingCount: null, change7d: rec.change7d,
    });
  }

  row.appendChild(icon);
  row.appendChild(main);
  row.appendChild(valWrap);
  row.appendChild(starButton(rec));
  return row;
}

function isUniqueRec(rec) {
  return !!(rec.categoryKey && typeof rec.categoryKey === 'string' && rec.categoryKey.startsWith('unique'));
}

// ---------- 즐겨찾기 ----------
function catKey(rec) {
  return 'cat:' + [rec.categoryKey, rec.enNorm, rec.baseType || '', rec.corrupted ? 1 : 0].join('|');
}
function favDescriptor(rec) {
  return {
    en: rec.en, enNorm: rec.enNorm, categoryKey: rec.categoryKey,
    baseType: rec.baseType || '', corrupted: !!rec.corrupted,
    kr: rec.kr, icon: rec.icon || '', labelKr: rec.labelKr || '',
  };
}
function starButton(rec) {
  const b = document.createElement('button');
  b.className = 'star';
  b.type = 'button';
  const key = catKey(rec);
  const sync = () => {
    const on = favorites.some((f) => f.key === key);
    b.textContent = on ? '★' : '☆';
    b.classList.toggle('on', on);
    b.title = on ? '즐겨찾기 해제' : '즐겨찾기에 추가';
  };
  sync();
  b.addEventListener('click', async (e) => {
    e.stopPropagation();
    b.disabled = true;
    const on = favorites.some((f) => f.key === key);
    try {
      favorites = on
        ? await window.api.favorites.remove(key)
        : await window.api.favorites.addCatalog(favDescriptor(rec));
    } catch (err) {
      /* noop */
    }
    b.disabled = false;
    sync();
  });
  return b;
}

function renderFavPrice(val, lp) {
  val.replaceChildren();
  const hasPrice = lp && !lp.empty && (lp.divine != null || lp.exalted != null || lp.altAmount != null);
  if (!hasPrice) {
    const e = document.createElement('div');
    e.className = 'val-secondary';
    e.textContent = lp && lp.empty ? '매물 없음' : '미조회';
    val.appendChild(e);
    return;
  }
  let { primary, secondary } = valueParts({ valueDivine: lp.divine, valueExalted: lp.exalted });
  if (!primary && lp.altAmount != null) {
    primary = { num: lp.altAmount, unit: curShort(lp.altCurrency), icon: currencyIcon(lp.altCurrency) };
  }
  if (primary) val.appendChild(valueLine(primary, 'val-primary'));
  if (secondary) val.appendChild(valueLine(secondary, 'val-secondary'));
  if (lp.listingCount) {
    const lc = document.createElement('div');
    lc.className = 'row-listings';
    lc.textContent = '거래소 ' + (lp.listingCount >= 100 ? '100+' : lp.listingCount) + '개';
    val.appendChild(lc);
  }
}

function favRow(f) {
  const row = document.createElement('div');
  row.className = 'row fav-row';

  const icon = document.createElement('img');
  icon.className = 'row-icon';
  icon.loading = 'lazy';
  icon.src = f.icon || '';
  icon.alt = '';
  if (!f.icon) icon.classList.add('broken');

  const main = document.createElement('div');
  main.className = 'row-main';
  const kr = document.createElement('div');
  kr.className = 'row-kr';
  kr.textContent = f.kr;
  const sub = document.createElement('div');
  sub.className = 'row-en';
  const tag = document.createElement('span');
  tag.className = 'tag';
  tag.textContent = f.kind === 'rare' ? '레어 옵션' : f.kind === 'url' ? '거래 URL' : f.labelKr || '';
  sub.appendChild(tag);
  let detail = '';
  if (f.kind === 'rare' && f.mods && f.mods.length) detail = f.mods.join(' · ');
  else if (f.kind === 'url') detail = '저장된 거래 검색 · ' + (f.id || '');
  else detail = f.base || '';
  if (detail) sub.appendChild(document.createTextNode(' ' + detail));
  main.append(kr, sub);

  const val = document.createElement('div');
  val.className = 'row-value';
  renderFavPrice(val, f.lastPrice);

  const actions = document.createElement('div');
  actions.className = 'fav-actions';
  const rb = document.createElement('button');
  rb.className = 'fav-btn';
  rb.type = 'button';
  rb.textContent = '↻';
  rb.title = '시세 갱신';
  rb.addEventListener('click', async () => {
    rb.disabled = true;
    val.replaceChildren();
    const l = document.createElement('span');
    l.className = 'price-loading';
    l.textContent = '조회 중…';
    val.appendChild(l);
    try {
      favorites = await window.api.favorites.reprice(f.key);
    } catch (e) {
      /* noop */
    }
    if (!currentQuery) renderFavorites();
  });
  const xb = document.createElement('button');
  xb.className = 'fav-btn';
  xb.type = 'button';
  xb.textContent = '✕';
  xb.title = '삭제';
  xb.addEventListener('click', async () => {
    try {
      favorites = await window.api.favorites.remove(f.key);
    } catch (e) {
      /* noop */
    }
    if (!currentQuery) renderFavorites();
  });
  // 거래 URL 즐겨찾기는 "웹에서 보기" 버튼으로 원본 검색 페이지를 연다.
  if (f.kind === 'url' && f.url) {
    const ob = document.createElement('button');
    ob.className = 'fav-btn';
    ob.type = 'button';
    ob.textContent = '↗';
    ob.title = '웹에서 보기';
    ob.addEventListener('click', () => window.api.openTradeUrl(f.url));
    actions.append(ob, rb, xb);
  } else {
    actions.append(rb, xb);
  }

  row.append(icon, main, val, actions);
  return row;
}

function renderFavorites() {
  el.results.replaceChildren();
  el.hint.classList.toggle('is-hidden', favorites.length > 0);
  if (!favorites.length) return;
  const head = document.createElement('div');
  head.className = 'fav-head';
  const title = document.createElement('span');
  title.className = 'fav-title';
  title.textContent = '⭐ 즐겨찾기 ' + favorites.length;
  const refreshAll = document.createElement('button');
  refreshAll.className = 'fav-refresh-all';
  refreshAll.type = 'button';
  refreshAll.textContent = '전체 새로고침';
  refreshAll.addEventListener('click', async () => {
    refreshAll.disabled = true;
    for (const f of [...favorites]) {
      try {
        favorites = await window.api.favorites.reprice(f.key);
      } catch (e) {
        /* noop */
      }
    }
    refreshAll.disabled = false;
    if (!currentQuery) renderFavorites();
  });
  head.append(title, refreshAll);
  el.results.appendChild(head);
  const frag = document.createDocumentFragment();
  for (const f of favorites) frag.appendChild(favRow(f));
  el.results.appendChild(frag);
}

/** GGG 조회에 보낼 최소 레코드 기술자(검색 쿼리 구성에 필요한 필드만). */
function priceDescriptor(rec) {
  return {
    en: rec.en,
    enNorm: rec.enNorm,
    categoryKey: rec.categoryKey,
    baseType: rec.baseType || '',
    corrupted: !!rec.corrupted,
  };
}

/** 행 시세 영역을 상태별로 렌더: idle(조회 버튼) → loading → done(가격/없음). */
function renderRowPrice(valWrap, rec, state, price) {
  valWrap.replaceChildren();
  if (state === 'loading') {
    const s = document.createElement('div');
    s.className = 'price-loading';
    s.textContent = '조회 중…';
    valWrap.appendChild(s);
    return;
  }
  if (state === 'done') {
    if (price && price.rateLimited) {
      const rl = document.createElement('div');
      rl.className = 'val-secondary';
      rl.textContent = '조회 한도 — 잠시 후';
      valWrap.appendChild(rl);
      return;
    }
    let { primary, secondary } = price
      ? valueParts({ valueDivine: price.divine, valueExalted: price.exalted })
      : { primary: null, secondary: null };
    if (!primary && price && price.altAmount != null) {
      primary = { num: price.altAmount, unit: curShort(price.altCurrency), icon: currencyIcon(price.altCurrency) };
    }
    if (primary) valWrap.appendChild(valueLine(primary, 'val-primary'));
    if (secondary) valWrap.appendChild(valueLine(secondary, 'val-secondary'));
    if (!primary) {
      const none = document.createElement('div');
      none.className = 'val-secondary';
      none.textContent = '시세 없음';
      valWrap.appendChild(none);
    } else if (price.listingCount) {
      const lc = document.createElement('div');
      lc.className = 'row-listings';
      lc.textContent = '거래소 ' + (price.listingCount >= 100 ? '100+' : price.listingCount) + '개';
      valWrap.appendChild(lc);
    } else if (price.change7d != null && Math.abs(price.change7d) >= 1) {
      // ninja commodity 7일 변동
      const ch = document.createElement('div');
      ch.className = 'change ' + (price.change7d >= 0 ? 'up' : 'down');
      ch.textContent = (price.change7d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(price.change7d)) + '%';
      valWrap.appendChild(ch);
    }
    return;
  }
  // idle: 클릭하여 실시간 조회
  const btn = document.createElement('button');
  btn.className = 'price-btn';
  btn.type = 'button';
  btn.textContent = '시세 조회';
  btn.addEventListener('click', async () => {
    renderRowPrice(valWrap, rec, 'loading');
    let price = null;
    try {
      const r = await window.api.priceItem(priceDescriptor(rec));
      price = r && r.ok ? r.price : null;
    } catch (e) {
      price = null;
    }
    renderRowPrice(valWrap, rec, 'done', price);
  });
  valWrap.appendChild(btn);
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
  el.urlAdd.classList.toggle('hidden', !!q); // 검색 중엔 URL 추가 바 숨김(즐겨찾기/빈 화면에서만)
  if (!q) { el.hint.classList.remove('is-hidden'); renderFavorites(); return; }
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

// ---------- 거래 URL 즐겨찾기 추가 ----------
const URL_ADD_ERR = {
  invalid: '유효한 PoE2 거래 URL이 아닙니다 (poe.kakaogames.com · pathofexile.com).',
  duplicate: '이미 추가된 URL입니다.',
};
async function submitUrl() {
  const url = el.urlAddInput.value.trim();
  if (!url) return;
  el.urlAddBtn.disabled = true;
  el.urlAddMsg.className = 'url-add-msg';
  el.urlAddMsg.textContent = '추가하는 중… (거래소 조회)';
  let res;
  try {
    res = await window.api.favorites.addUrl(url);
  } catch (e) {
    res = { ok: false, error: 'fail' };
  }
  el.urlAddBtn.disabled = false;
  if (res && res.ok) {
    favorites = res.favorites || favorites;
    el.urlAddInput.value = '';
    el.urlAddMsg.textContent = '';
    if (!currentQuery) renderFavorites();
  } else {
    el.urlAddMsg.className = 'url-add-msg error';
    el.urlAddMsg.textContent = (res && URL_ADD_ERR[res.error]) || '추가 실패 — 잠시 후 다시 시도하세요.';
  }
}

// ---------- 상태 반영 ----------
function applyStatus(s) {
  if (!s) return;
  ref = s.ref || ref;
  lastStatus = s;

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
  // 가격 조회 실패(전체 실패 또는 일부 카테고리 실패) 시에만 "버그 신고" 버튼 노출
  const hasFailure = s.phase === 'error' || !!(s.errors && s.errors.length);
  el.reportError.classList.toggle('hidden', !hasFailure);

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
el.urlAddBtn.addEventListener('click', submitUrl);
el.urlAddInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submitUrl(); } });
el.clear.addEventListener('click', () => { el.search.value = ''; el.search.focus(); doSearch(); });
el.refresh.addEventListener('click', () => { if (!el.refresh.disabled) window.api.refresh(); });
el.hideTray.addEventListener('click', () => { window.api.hideToTray(); });
el.relaunchAdmin.addEventListener('click', () => {
  el.relaunchAdmin.textContent = '재실행 중…';
  el.relaunchAdmin.disabled = true;
  window.api.relaunchElevated();
});
el.reportError.addEventListener('click', () => {
  const s = lastStatus || {};
  const message = (s.phase === 'error' ? s.message : '') || el.statusMsg.textContent || '';
  el.reportError.disabled = true;
  const done = () => { el.reportError.disabled = false; };
  window.api
    .reportError({ message, errors: s.errors || [] })
    .then((res) => {
      if (res && res.ok) el.statusMsg.textContent = '브라우저에서 신고 페이지를 열었습니다 — 내용 확인 후 제출해 주세요.';
      done();
    })
    .catch(done);
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

// ---------- 즐겨찾기 초기 로드 + 실시간 구독 ----------
window.api.onFavorites((list) => {
  favorites = list || [];
  if (!currentQuery) renderFavorites();
});
window.api.favorites.list().then((list) => {
  favorites = list || [];
  if (!currentQuery) renderFavorites();
});

// ---------- 시작 ----------
window.api.onStatus(applyStatus);
window.api.getStatus().then(applyStatus);
el.search.focus();
