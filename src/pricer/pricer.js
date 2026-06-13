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

const AFFIX_LABEL = { implicit: '고정', prefix: '접두', suffix: '접미', explicit: '비고정', rune: '룬', crafted: '제작', enchant: '인챈트' };

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
    const tag = document.createElement('span');
    tag.className = 'mod-tag ' + m.affix;
    tag.textContent = AFFIX_LABEL[m.affix] || m.affix;
    txt.append(tag, document.createTextNode(m.text));
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

async function runSearch() {
  const chosen = chosenMods();
  const filters = chosen.map((m) => ({
    id: m.id,
    min: m.minEl && m.minEl.value !== '' ? Number(m.minEl.value) : undefined,
  }));
  lastFilters = filters;
  // 직전 "제외" 표시 초기화
  currentMods.forEach((m) => m.row && m.row.classList.remove('dropped'));
  resultEl.replaceChildren();
  if (!filters.length) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '옵션을 하나 이상 선택하세요.';
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
    res = await window.pricerApi.price(filters, currentItem ? currentItem.categoryId : null);
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
  if (res.empty || res.exalted == null) {
    const e = document.createElement('div');
    e.className = 'empty';
    e.textContent = '이 조건의 매물이 없습니다. 옵션을 줄이거나 최소값을 낮춰보세요.';
    resultEl.appendChild(e);
    if (res.searchUrl) resultEl.appendChild(glink(res.searchUrl));
    return;
  }
  const price = document.createElement('div');
  price.className = 'price';
  price.textContent = fmt(res.exalted);
  const unit = document.createElement('span');
  unit.className = 'unit';
  unit.textContent = 'ex' + (res.divine != null && res.divine >= 0.1 ? '  ·  ' + fmt(res.divine) + ' div' : '');
  price.appendChild(unit);
  resultEl.appendChild(price);

  const sub = document.createElement('div');
  sub.className = 'sub';
  sub.textContent = `옵션 ${nFilters}개 · 매물 ${res.listingCount >= 100 ? '100+' : res.listingCount}개 · 최저 ${fmt(res.min)}ex (미끼 제외)`;
  resultEl.appendChild(sub);

  const actions = document.createElement('div');
  actions.className = 'res-actions';
  if (res.searchUrl) actions.appendChild(glink(res.searchUrl));
  actions.appendChild(favBtn(res));
  resultEl.appendChild(actions);
}

function favBtn(res) {
  const b = document.createElement('button');
  b.className = 'glink fav';
  b.type = 'button';
  b.textContent = '⭐ 즐겨찾기';
  b.addEventListener('click', async () => {
    const mods = currentMods.filter((m) => m.matched && m.cb.checked).map((m) => m.text);
    try {
      await window.pricerApi.addFavorite({
        name: currentItem ? currentItem.name : '',
        base: currentItem ? currentItem.base : '',
        categoryId: currentItem ? currentItem.categoryId : null,
        filters: lastFilters,
        mods,
        price: { exalted: res.exalted, divine: res.divine, listingCount: res.listingCount },
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
  a.textContent = 'GGG 거래소에서 보기 ↗';
  a.addEventListener('click', () => window.pricerApi.openUrl(url));
  return a;
}

searchBtn.addEventListener('click', runSearch);
document.getElementById('close').addEventListener('click', () => window.pricerApi.close());
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') window.pricerApi.close();
});

window.pricerApi.onItem(renderItem);
