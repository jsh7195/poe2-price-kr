'use strict';

/* 오버레이 렌더러: 메인이 보내는 가격 페이로드를 받아 컴팩트 위젯으로 표시. */

const card = document.getElementById('card');
const nameEl = document.getElementById('name');
const rowsEl = document.getElementById('rows');
const noitemEl = document.getElementById('noitem');

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
  rowsEl.classList.remove('scan');
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
  const { primary, secondary } = valueParts(rec, ref);
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
  if (rec.change7d != null && Math.abs(rec.change7d) >= 1) {
    const ch = document.createElement('div');
    ch.className = 'change ' + (rec.change7d >= 0 ? 'up' : 'down');
    ch.textContent = (rec.change7d >= 0 ? '▲ ' : '▼ ') + Math.abs(Math.round(rec.change7d)) + '%';
    rowsEl.appendChild(ch);
  }
  card.classList.remove('hidden');
}

// 다중 아이템(화면 OCR 스캔) 렌더링: 비싼 순 목록, 각 줄 = 수량×단가 합계
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
  const ref = payload.ref || {};
  for (const it of items) {
    const r = it.record;
    const row = document.createElement('div');
    row.className = 'scan-row';

    const left = document.createElement('div');
    left.className = 'sr-name';
    const q = document.createElement('span');
    q.className = 'sr-qty';
    q.textContent = it.qty + '×';
    const nm = document.createElement('span');
    nm.className = 'sr-kr';
    nm.textContent = r.kr;
    left.append(q, nm);

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
