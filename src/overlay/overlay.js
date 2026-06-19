'use strict';

/* 오버레이 렌더러: 메인이 보내는 가격 페이로드를 받아 컴팩트 위젯으로 표시. */

const card = document.getElementById('card');
const nameEl = document.getElementById('name');
const rowsEl = document.getElementById('rows');
const noitemEl = document.getElementById('noitem');
const loadingEl = document.getElementById('loading');

function fmtNum(n) {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 10000) return Math.round(n / 1000) + 'k';
  if (a >= 1000) return (n / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  if (a >= 100) return String(Math.round(n));
  if (a >= 10) return n.toFixed(1).replace(/\.0$/, '');
  if (a >= 1) return n.toFixed(2).replace(/\.?0+$/, '');
  if (a >= 0.01) return n.toFixed(2);
  if (a > 0) return n.toFixed(4).replace(/\.?0+$/, '') || '0';
  return '0';
}

// divine/exalted 적응형 표기 (메인 UI 와 동일 규칙)
function valueParts(rec, ref) {
  const d = rec.valueDivine;
  const x = rec.valueExalted;
  const divIcon = ref.divine ? ref.divine.icon : '';
  const exIcon = ref.exalted ? ref.exalted.icon : '';
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

function curIcon(part) {
  if (part.icon) {
    const img = document.createElement('img');
    img.className = 'cic';
    img.src = part.icon;
    img.alt = part.unit;
    img.onerror = () => img.replaceWith(unitText(part.unit));
    return img;
  }
  return unitText(part.unit);
}
function unitText(unit) {
  const s = document.createElement('span');
  s.className = 'unit';
  s.textContent = unit;
  return s;
}
function vrow(part, cls) {
  const row = document.createElement('div');
  row.className = 'vrow ' + cls;
  const num = document.createElement('span');
  num.className = 'num';
  num.textContent = fmtNum(part.num);
  row.append(num, curIcon(part));
  return row;
}

function showNoItem(text) {
  nameEl.textContent = '';
  rowsEl.replaceChildren();
  noitemEl.textContent = text;
  noitemEl.classList.remove('hidden');
  card.classList.remove('hidden');
}

function render(payload) {
  rowsEl.classList.remove('scan', 'grid');
  loadingEl.classList.add('hidden');
  card.classList.remove('compact');
  if (payload && payload.loading) {
    nameEl.textContent = '';
    rowsEl.replaceChildren();
    noitemEl.classList.add('hidden');
    loadingEl.classList.remove('hidden');
    card.classList.add('compact'); // 내용 크기로 → 글자 잘림 방지
    card.classList.remove('hidden');
    return;
  }
  if (payload && payload.scan) {
    renderScan(payload);
    return;
  }
  if (!payload || !payload.found || !payload.record) {
    showNoItem(payload && payload.reason ? payload.reason : 'No Item');
    return;
  }
  const rec = payload.record;
  const ref = payload.ref || {};
  let { primary, secondary } = valueParts(rec, ref);
  // 최저가 매물이 divine/exalted 가 아닌 통화면(chaos 등) 원본 통화 아이콘과 함께 표기.
  if (!primary && rec.altPrice) {
    const icons = ref.currencyIcons || {};
    primary = { num: rec.altPrice.amount, unit: rec.altPrice.currency, icon: icons[rec.altPrice.currency] || '' };
  }
  if (!primary) {
    showNoItem('시세 없음');
    return;
  }

  noitemEl.classList.add('hidden');
  // 이름 (+ 카테고리/타락 표기)
  nameEl.replaceChildren();
  nameEl.appendChild(document.createTextNode(rec.kr || rec.en || ''));
  if (rec.corrupted) {
    const c = document.createElement('span');
    c.className = 'cat';
    c.textContent = '타락';
    nameEl.append(' ', c);
  } else if (rec.labelKr) {
    const t = document.createElement('span');
    t.className = 'cat';
    t.textContent = rec.labelKr;
    nameEl.append(' ', t);
  }

  rowsEl.replaceChildren();
  rowsEl.appendChild(vrow(primary, 'primary'));
  if (secondary) rowsEl.appendChild(vrow(secondary, 'secondary'));
  // 레어 옵션검색이면 "옵션 N/M개 기준" 표기(근사 동급가임을 명확히).
  if (payload.subnote) {
    const sn = document.createElement('div');
    sn.className = 'listings';
    sn.textContent = payload.subnote;
    rowsEl.appendChild(sn);
  }
  // GGG 거래소 실매물 수(신뢰 신호). ninja 7일 변동은 더 이상 표시하지 않는다.
  if (rec.listingCount != null && rec.listingCount > 0) {
    const lc = document.createElement('div');
    lc.className = 'listings';
    lc.textContent = '거래소 ' + (rec.listingCount >= 100 ? '100+' : rec.listingCount) + '개';
    rowsEl.appendChild(lc);
  }
  card.classList.remove('hidden');
}

// 화면 스캔 아이템 수 → 열 개수. 화폐 거래소(~60종)는 한 열로 화면을 넘기므로 격자로 펼친다.
function scanCols(n) {
  return n <= 9 ? 1 : n <= 24 ? 2 : 3;
}

// 다중 아이템(화면 OCR 스캔) 렌더링: 비싼 순 목록(많으면 다중 열 격자), 각 줄 = 수량×단가 합계
function renderScan(payload) {
  nameEl.textContent = '';
  const items = payload.items || [];
  if (!items.length) {
    showNoItem(payload.reason || '인식된 시세 없음');
    return;
  }
  noitemEl.classList.add('hidden');
  rowsEl.replaceChildren();
  rowsEl.classList.add('scan');
  const cols = scanCols(items.length);
  rowsEl.classList.toggle('grid', cols > 1);
  rowsEl.style.setProperty('--cols', String(cols));
  const ref = payload.ref || {};
  for (const it of items) {
    const r = it.record;
    const row = document.createElement('div');
    row.className = 'scan-row';

    const left = document.createElement('div');
    left.className = 'sr-name';
    // 수량 1(화폐 거래소 등 맨이름)은 "1×" 표기가 군더더기 → 생략.
    if (it.qty > 1) {
      const q = document.createElement('span');
      q.className = 'sr-qty';
      q.textContent = it.qty + '×';
      left.appendChild(q);
    }
    const nm = document.createElement('span');
    nm.className = 'sr-kr';
    nm.textContent = r.kr;
    left.appendChild(nm);

    // 합계(수량×단가)로 적응형 표기
    const totals = {
      valueDivine: r.valueDivine != null ? it.qty * r.valueDivine : null,
      valueExalted: r.valueExalted != null ? it.qty * r.valueExalted : null,
    };
    const { primary } = valueParts(totals, ref);
    const right = document.createElement('div');
    right.className = 'sr-val';
    if (primary) {
      const num = document.createElement('span');
      num.className = 'num';
      num.textContent = fmtNum(primary.num);
      right.append(num, curIcon(primary));
    } else {
      right.textContent = '–';
    }

    row.append(left, right);
    rowsEl.appendChild(row);
  }
  card.classList.remove('hidden');
}

window.overlayApi.onPrice(render);
