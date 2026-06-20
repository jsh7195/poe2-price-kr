'use strict';

/* 인터랙티브 옵션 시세 창 렌더러: 아이템 모드를 체크박스로 보여주고,
   고른 옵션으로 GGG 거래소 "동급 이상" 실시세를 조회한다. */

const itemNameEl = document.getElementById('itemName');
const itemSubEl = document.getElementById('itemSub');
const modsEl = document.getElementById('mods');
const searchBtn = document.getElementById('search');
const resultEl = document.getElementById('result');

let currentMods = []; // [{cb, minEl, id, matched, text}]
let currentItem = null;
let lastFilters = [];
let currencyIcons = {}; // 통화 id → 아이콘 URL
let ilvlCb = null; // 아이템 레벨 필터 체크박스
let ilvlEl = null; // 아이템 레벨 최소 입력
let socketCb = null; // 룬 소켓(홈) 개수 필터 체크박스
let socketEl = null; // 룬 소켓 최소 개수 입력

const RARITY_OPT = { normal: 'normal', magic: 'magic', rare: 'rare' };

// 모드의 "거래 타입"(카테고리). prefix/suffix/explicit 는 모두 비고정. 웹 거래소와 동일한 구분.
const TYPE_LABEL = { implicit: '고정', rune: '룬', enchant: '인챈트', crafted: '제작' };
function modType(affix) { return TYPE_LABEL[affix] || '비고정'; }
function modTypeClass(affix) { return TYPE_LABEL[affix] ? affix : 'explicit'; }
// 비고정(explicit)의 접두/접미 위치 — 타입과 별개의 보조 표기(접두 위·접미 아래 정렬과 연동).
const POS_LABEL = { prefix: '접두', suffix: '접미' };

function fmt(n) {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a >= 100) return String(Math.round(n));
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return n.toFixed(1).replace(/\.0$/, '');
  if (a >= 0.01) return n.toFixed(2);
  return String(n);
}

function renderItem(item) {
  currentMods = [];
  currentItem = item;
  currencyIcons = (item && item.currencyIcons) || {};
  resultEl.replaceChildren();
  if (!item) {
    itemNameEl.textContent = '아이템 없음';
    itemSubEl.textContent = '';
    modsEl.replaceChildren();
    searchBtn.disabled = true;
    return;
  }
  // 제목 = 타입(아이템 종류). 레어의 랜덤 이름은 검색에 무의미하므로 표시에서 뺀다.
  itemNameEl.textContent = item.category || item.base || '아이템';
  const bits = [];
  if (item.rarity) bits.push({ rare: '레어', magic: '매직', unique: '유니크', normal: '일반' }[item.rarity] || item.rarity);
  if (item.categoryId) bits.push('타입 검색 ✓');
  else if (item.category) bits.push('타입 필터 없음');
  if (item.itemLevel) bits.push('아이템 레벨 ' + item.itemLevel);
  if (item.corrupted) bits.push('타락');
  itemSubEl.textContent = bits.join(' · ');

  modsEl.replaceChildren();

  // 아이템 레벨 필터(베이스/일반 아이템에 특히 유용 — 높은 ilvl 베이스가 비쌈). 항상 맨 위.
  const matchedCount = (item.mods || []).filter((m) => m.matched).length;
  ilvlCb = document.createElement('input');
  ilvlCb.type = 'checkbox';
  ilvlCb.checked = matchedCount === 0 && !!item.itemLevel; // 옵션 없으면(베이스) 기본 ON
  ilvlEl = document.createElement('input');
  ilvlEl.className = 'mod-min';
  ilvlEl.type = 'number';
  ilvlEl.value = item.itemLevel || '';
  ilvlEl.title = '아이템 레벨 최소';
  const ilvlRow = document.createElement('div');
  ilvlRow.className = 'mod ilvl-row';
  const ilvlBody = document.createElement('div');
  ilvlBody.className = 'mod-body';
  const ilvlTxt = document.createElement('div');
  ilvlTxt.className = 'mod-text';
  const ilvlTag = document.createElement('span');
  ilvlTag.className = 'mod-tag';
  ilvlTag.textContent = 'ilvl';
  ilvlTxt.append(ilvlTag, document.createTextNode('아이템 레벨 이상'));
  ilvlBody.appendChild(ilvlTxt);
  ilvlRow.append(ilvlCb, ilvlBody, ilvlEl);
  modsEl.appendChild(ilvlRow);

  // 룬 소켓(홈) 개수 — 장비 검색의 핵심 필수조건. 아이템이 실제로 소켓을 가질 때만 표시
  // (소켓 없는 아이템에 빈 입력칸을 띄워 실수로 잘못된 필터가 저장되는 것 방지).
  socketCb = null;
  socketEl = null;
  if (item.sockets != null) {
    socketCb = document.createElement('input');
    socketCb.type = 'checkbox';
    socketCb.checked = !!item.sockets && item.sockets > 0; // 소켓이 있으면 기본 포함
    socketEl = document.createElement('input');
    socketEl.className = 'mod-min';
    socketEl.type = 'number';
    socketEl.min = '0';
    socketEl.value = item.sockets != null ? item.sockets : '';
    socketEl.title = '룬 소켓(홈) 최소 개수';
    const sRow = document.createElement('div');
    sRow.className = 'mod ilvl-row';
    const sBody = document.createElement('div');
    sBody.className = 'mod-body';
    const sTxt = document.createElement('div');
    sTxt.className = 'mod-text';
    const sTag = document.createElement('span');
    sTag.className = 'mod-tag';
    sTag.textContent = '홈';
    sTxt.append(sTag, document.createTextNode('룬 소켓(홈) 개수 이상'));
    sBody.appendChild(sTxt);
    sRow.append(socketCb, sBody, socketEl);
    modsEl.appendChild(sRow);
  }

  if (matchedCount === 0) {
    const note = document.createElement('div');
    note.className = 'base-note';
    note.textContent = '옵션 없음 — 타입(+아이템 레벨)으로 베이스 시세를 검색합니다.';
    modsEl.appendChild(note);
  }

  for (const m of item.mods || []) {
    const row = document.createElement('div');
    row.className = 'mod' + (m.matched ? '' : ' disabled');

    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!m.checked && m.matched;
    cb.disabled = !m.matched;

    const body = document.createElement('div');
    body.className = 'mod-body';
    const txt = document.createElement('div');
    txt.className = 'mod-text';
    // 타입 태그(비고정/고정/룬/인챈트/제작) — 웹 거래소의 stat 타입 구분.
    const tag = document.createElement('span');
    tag.className = 'mod-tag type-' + modTypeClass(m.affix);
    tag.textContent = modType(m.affix);
    txt.appendChild(tag);
    // 비고정의 접두/접미는 별도 보조 배지(타입과 다른 레벨).
    const pos = POS_LABEL[m.affix];
    if (pos) {
      const pb = document.createElement('span');
      pb.className = 'mod-pos ' + m.affix;
      pb.textContent = pos;
      txt.appendChild(pb);
    }
    txt.appendChild(document.createTextNode(m.text));
    body.appendChild(txt);
    if (!m.matched) {
      const nm = document.createElement('div');
      nm.className = 'mod-nomatch';
      nm.textContent = '거래 검색 불가(매칭 없음)';
      body.appendChild(nm);
    }

    row.append(cb, body);

    let minEl = null;
    if (m.matched) {
      minEl = document.createElement('input');
      minEl.className = 'mod-min';
      minEl.type = 'number';
      // 기본 min = 굴림값×0.8 (인게임 "아이템으로 검색"과 동일 — 살짝 낮은 동급 매물도 잡히게)
      minEl.value = m.defaultMin != null && m.defaultMin !== '' ? m.defaultMin : '';
      minEl.title = '최소값 (굴림값의 80%)';
      row.appendChild(minEl);
    }

    modsEl.appendChild(row);
    currentMods.push({ cb, minEl, id: m.id, matched: m.matched, text: m.text, row });
  }
  searchBtn.disabled = false;
  // 기본 선택으로 즉시 1회 검색
  runSearch();
}

function chosenMods() {
  return currentMods.filter((m) => m.matched && m.cb.checked);
}

function searchOpts(filterCount) {
  const ilvlOn = ilvlCb && ilvlCb.checked && ilvlEl && ilvlEl.value !== '';
  const socketOn = socketCb && socketCb.checked && socketEl && socketEl.value !== '';
  return {
    category: currentItem ? currentItem.categoryId : undefined,
    ilvl: ilvlOn ? Number(ilvlEl.value) : undefined,
    sockets: socketOn ? Number(socketEl.value) : undefined,
    // 옵션 없이 베이스 검색 시엔 같은 등급(일반/매직)으로 좁힌다.
    rarity: filterCount === 0 && currentItem ? RARITY_OPT[currentItem.rarity] : undefined,
  };
}

async function runSearch() {
  const chosen = chosenMods();
  const filters = chosen.map((m) => ({
    id: m.id,
    min: m.minEl && m.minEl.value !== '' ? Number(m.minEl.value) : undefined,
  }));
  lastFilters = filters;
  const opts = searchOpts(filters.length);
  currentMods.forEach((m) => m.row && m.row.classList.remove('dropped'));
  resultEl.replaceChildren();
  // 옵션도 없고 타입필터도 없으면 검색 불가.
  if (!filters.length && !opts.category) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '옵션을 선택하거나 타입을 인식할 수 없습니다.';
    resultEl.appendChild(e);
    return;
  }
  const loading = document.createElement('div');
  loading.className = 'loading';
  loading.textContent = '조회 중…';
  resultEl.appendChild(loading);
  searchBtn.disabled = true;

  let res = null;
  try {
    res = await window.pricerApi.price(filters, opts);
  } catch (e) {
    res = null;
  }
  searchBtn.disabled = false;
  renderResult(res, filters.length);
}

function renderResult(res, nFilters) {
  resultEl.replaceChildren();
  if (res && res.rateLimited) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = 'GGG 조회 한도에 걸렸습니다 (짧은 시간에 너무 많이 조회). 잠시 후 다시 시도하세요.';
    resultEl.appendChild(e);
    return;
  }
  if (!res) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '조회 실패(잠시 후 다시 시도).';
    resultEl.appendChild(e);
    return;
  }
  const pl = priceLabel(res);
  if (res.empty || !pl) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '이 조건의 매물이 없습니다. 옵션을 줄이거나 최소값을 낮춰보세요.';
    resultEl.appendChild(e);
    // 매물이 없어도 검색 조건을 즐겨찾기에 담아 메인창에서 추적 가능하게.
    const actions = document.createElement('div');
    actions.className = 'res-actions';
    if (res.searchUrl) actions.appendChild(glink(res.searchUrl));
    actions.appendChild(favBtn(res));
    resultEl.appendChild(actions);
    return;
  }
  // 최저가 매물 원본 통화 + 아이콘으로 표시(환율 변환 없음).
  const price = document.createElement('div');
  price.className = 'price';
  const num = document.createElement('span');
  num.textContent = fmt(pl.num);
  price.appendChild(num);
  price.appendChild(curEl(pl.currency, pl.unit, 22));
  resultEl.appendChild(price);

  const sub = document.createElement('div');
  sub.className = 'sub';
  const head = nFilters === 0 ? '베이스 시세' : `옵션 ${nFilters}개`;
  sub.append(`${head} · 매물 ${res.listingCount >= 100 ? '100+' : res.listingCount}개`);
  const lows = (res.low || []).slice(0, 5);
  if (lows.length) {
    sub.append('  ·  최저 ');
    lows.forEach((l, i) => {
      if (i) sub.append(' · ');
      const span = document.createElement('span');
      span.className = 'lowitem';
      span.append(fmt(l.amount));
      span.appendChild(curEl(l.currency, curShort(l.currency), 14));
      sub.appendChild(span);
    });
  }
  resultEl.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'res-actions';
  if (res.searchUrl) actions.appendChild(glink(res.searchUrl));
  actions.appendChild(favBtn(res));
  resultEl.appendChild(actions);
}

function curShort(c) {
  return c === 'divine' ? 'div' : c === 'exalted' || c === 'exalt' ? 'ex' : c;
}
function priceLabel(res) {
  if (res.divine != null) return { num: res.divine, unit: 'div', currency: 'divine' };
  if (res.exalted != null) return { num: res.exalted, unit: 'ex', currency: 'exalted' };
  if (res.altAmount != null) return { num: res.altAmount, unit: curShort(res.altCurrency), currency: res.altCurrency };
  return null;
}
/** 통화 아이콘 img(없으면 텍스트 fallback). size=px. */
function curEl(currency, fallbackText, size) {
  const icon = currencyIcons[currency];
  if (icon) {
    const img = document.createElement('img');
    img.className = 'cur-img';
    img.src = icon;
    img.alt = fallbackText;
    img.title = fallbackText;
    img.width = size;
    img.height = size;
    img.onerror = () => img.replaceWith(unitText(fallbackText));
    return img;
  }
  return unitText(fallbackText);
}
function unitText(t) {
  const s = document.createElement('span');
  s.className = 'unit';
  s.textContent = ' ' + t;
  return s;
}

function favBtn(res) {
  const b = document.createElement('button');
  b.className = 'glink fav';
  b.type = 'button';
  b.textContent = '⭐ 즐겨찾기';
  b.addEventListener('click', async () => {
    const mods = currentMods.filter((m) => m.matched && m.cb.checked).map((m) => m.text);
    const opts = searchOpts(lastFilters.length);
    try {
      await window.pricerApi.addFavorite({
        name: currentItem ? currentItem.name : '',
        base: currentItem ? currentItem.base : '',
        categoryId: opts.category || null,
        ilvl: opts.ilvl || null,
        sockets: opts.sockets || null,
        rarity: opts.rarity || null,
        filters: lastFilters,
        mods,
        price: {
          divine: res.divine, exalted: res.exalted,
          altAmount: res.altAmount, altCurrency: res.altCurrency,
          listingCount: res.listingCount,
        },
      });
      b.textContent = '⭐ 메인창에 담김';
      b.disabled = true;
    } catch (e) {
      b.textContent = '담기 실패';
    }
  });
  return b;
}

function glink(url) {
  const a = document.createElement('button');
  a.className = 'glink';
  a.type = 'button';
  a.textContent = '웹에서 보기 ↗';
  a.addEventListener('click', () => window.pricerApi.openUrl(url));
  return a;
}

searchBtn.addEventListener('click', runSearch);
document.getElementById('close').addEventListener('click', () => window.pricerApi.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pricerApi.close();
});

window.pricerApi.onItem(renderItem);
