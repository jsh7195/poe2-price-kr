'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normEn, normKr, isSubsequence, decomposeHangul, jamoSimilarity } = require('../src/main/services/normalize');
const { makeValueCalc, parseExchange, parseStash } = require('../src/main/services/ninja');
const { buildFromRaw } = require('../src/main/services/dictionary');
const { search } = require('../src/main/services/search');
const { toRecord, dedupe } = require('../src/main/services/catalog');
const { extractItemName, looksLikeItem, parseRecipeLines } = require('../src/main/services/itemtext');
const { normalizeAccelerator, isRegisterable, mergeHotkeys, validateHotkeyMap, DEFAULT_HOTKEYS } = require('../src/main/services/accelerator');
const { Store } = require('../src/main/services/store');
const ggg = require('../src/main/services/ggg');
const { redact } = require('../src/main/services/redact');
const errorReport = require('../src/main/services/errorReport');
const os = require('node:os');

// ---------- normalize ----------
test('normEn: 소문자화 + 영숫자만', () => {
  assert.equal(normEn("Soul Core of Azcapa"), 'soulcoreofazcapa');
  assert.equal(normEn("Yriel's Fostering"), 'yrielsfostering');
  assert.equal(normEn('신성한 오브'), '');
});

test('normKr: 공백·구두점 제거, 한글 유지', () => {
  assert.equal(normKr('영혼 핵'), '영혼핵');
  assert.equal(normKr('Mageblood'), 'mageblood');
  assert.equal(normKr('  신성한  오브 '), '신성한오브');
});

test('isSubsequence: 부분 수열 매칭', () => {
  assert.equal(isSubsequence('영핵', '영혼핵'), true);
  assert.equal(isSubsequence('핵영', '영혼핵'), false);
});

// ---------- ninja value calc ----------
test('makeValueCalc: divine 기준 + 환율 변환', () => {
  const calc = makeValueCalc({ primary: 'divine', rates: { exalted: 80, chaos: 16 } });
  const v = calc(0.5);
  assert.equal(v.divine, 0.5);
  assert.equal(v.exalted, 40);
  assert.equal(v.chaos, 8);
  assert.equal(calc(undefined), null);
});

test('parseExchange: items 조인 + 아이콘 절대경로', () => {
  const json = {
    core: { primary: 'divine', rates: { exalted: 80, chaos: 16 }, items: [] },
    items: [{ id: 'a', name: 'Orb A', image: '/gen/x.png', category: 'Currency' }],
    lines: [{ id: 'a', primaryValue: 2, sparkline: { totalChange: 5 }, volumePrimaryValue: 100 }],
  };
  const { records } = parseExchange(json);
  assert.equal(records.length, 1);
  assert.equal(records[0].en, 'Orb A');
  assert.equal(records[0].value.divine, 2);
  assert.equal(records[0].value.exalted, 160);
  assert.equal(records[0].icon, 'https://web.poecdn.com/gen/x.png');
  assert.equal(records[0].change7d, 5);
});

test('parseExchange: 가치 0 레코드 제외', () => {
  const json = {
    core: { primary: 'divine', rates: { exalted: 80 }, items: [] },
    items: [
      { id: 'a', name: 'Orb A', image: '/a.png' },
      { id: 'z', name: 'Zero Orb', image: '/z.png' },
    ],
    lines: [
      { id: 'a', primaryValue: 1 },
      { id: 'z', primaryValue: 0 },
    ],
  };
  const { records } = parseExchange(json);
  assert.equal(records.length, 1);
  assert.equal(records[0].en, 'Orb A');
});

test('parseStash: 유니크 라인 파싱', () => {
  const json = {
    core: { primary: 'divine', rates: { exalted: 80 }, items: [] },
    lines: [{ name: 'Mageblood', baseType: 'Heavy Belt', icon: 'https://web.poecdn.com/i.png', primaryValue: 50, listingCount: 12, corrupted: false, sparkLine: { totalChange: -3 } }],
  };
  const { records } = parseStash(json);
  assert.equal(records[0].en, 'Mageblood');
  assert.equal(records[0].baseType, 'Heavy Belt');
  assert.equal(records[0].value.divine, 50);
  assert.equal(records[0].value.exalted, 4000);
});

// ---------- dictionary join ----------
test('buildFromRaw static: id 조인(순서 무관)', () => {
  const staticEn = { result: [{ id: 'Currency', entries: [{ id: 'divine', text: 'Divine Orb' }, { id: 'alch', text: 'Orb of Alchemy' }] }] };
  const staticKr = { result: [{ id: 'Currency', entries: [{ id: 'alch', text: '연금술 오브' }, { id: 'divine', text: '신성한 오브' }] }] };
  const { enToKr } = buildFromRaw(staticEn, staticKr, { result: [] }, { result: [] });
  assert.equal(enToKr[normEn('Divine Orb')], '신성한 오브');
  assert.equal(enToKr[normEn('Orb of Alchemy')], '연금술 오브');
});

test('buildFromRaw items: 유니크만 인덱스 조인(개수/순서 불일치에 견고)', () => {
  // EN: 비유니크 2 + 유니크 1, KR: 비유니크 순서 다름 + 여분 1개 → 유니크끼리만 정렬되어야 함
  const itemsEn = { result: [{ id: 'weapon', entries: [{ type: 'Sword' }, { type: 'Gold Ring', name: 'Andvarius' }, { type: 'Axe' }] }] };
  const itemsKr = { result: [{ id: 'weapon', entries: [{ type: '도끼' }, { type: '검' }, { type: '황금 반지', name: '안드바리우스' }, { type: '여분아이템' }] }] };
  const { enToKr } = buildFromRaw({ result: [] }, { result: [] }, itemsEn, itemsKr);
  assert.equal(enToKr[normEn('Andvarius')], '안드바리우스');
});

// ---------- search ranking ----------
function rec(kr, en, valueDivine, labelKr = '화폐') {
  return { kr, en, krNorm: normKr(kr), enNorm: normEn(en), valueDivine, valueExalted: valueDivine ? valueDivine * 80 : null, labelKr, volume: 0 };
}
test('search: 한글 정확 매칭이 부분 매칭보다 우선', () => {
  const records = [rec('신성한 오브', 'Divine Orb', 1), rec('하급 신성한 오브 조각', 'Lesser Divine Shard', 0.1)];
  const r = search(records, '신성한 오브');
  assert.equal(r[0].en, 'Divine Orb');
});

test('search: 영문 질의', () => {
  const records = [rec('마법사의 피', 'Mageblood', 50)];
  const r = search(records, 'mageblood');
  assert.equal(r.length, 1);
  assert.equal(r[0].kr, '마법사의 피');
});

test('search: 빈 질의 → 빈 결과', () => {
  assert.deepEqual(search([rec('x', 'y', 1)], '   '), []);
});

test('search: 유니크명+기반 전체 이름으로 쳐도 매칭(역접두)', () => {
  // 인게임 표기 "꼬인혀 갈라진 창"(유니크명 꼬인혀 + 기반 갈라진 창)을 통째로 검색
  const records = [
    { kr: '꼬인혀', en: 'Tangletongue', baseType: 'Forked Spear',
      krNorm: normKr('꼬인혀'), enNorm: normEn('Tangletongue'), labelKr: '유니크 무기', volume: 100 },
    { kr: '신성한 오브', en: 'Divine Orb', baseType: '',
      krNorm: normKr('신성한 오브'), enNorm: normEn('Divine Orb'), labelKr: '화폐', volume: 5 },
  ];
  const r = search(records, '꼬인혀 갈라진 창');
  assert.equal(r.length >= 1, true);
  assert.equal(r[0].en, 'Tangletongue');
});

test('search: 같은 이름의 변형이면 거래량 많은(시장 대표가)을 우선', () => {
  const mk = (base, vDiv, vol) => ({
    kr: '번개 도선', en: 'Lightning Coil', baseType: base,
    krNorm: normKr('번개 도선'), enNorm: normEn('Lightning Coil'),
    valueDivine: vDiv, valueExalted: vDiv * 80, labelKr: '유니크 방어구', volume: vol,
  });
  // 비싸지만 희귀(거래량 16, 32ex) vs 싸지만 시장 대표(거래량 3074, 1ex)
  const records = [mk('Runemastered Ancestral Mail', 0.3654, 16), mk('Ancestral Mail', 0.0114, 3074)];
  const r = search(records, '번개 도선');
  assert.equal(r[0].baseType, 'Ancestral Mail'); // 거래량 많은 쪽이 위 (가격 낮아도)
  assert.equal(r[1].baseType, 'Runemastered Ancestral Mail');
});

// ---------- OCR 스캔 (목록 시세) ----------
test('parseRecipeLines: 수량+이름 추출(OCR 노이즈 허용)', () => {
  const p = parseRecipeLines(['6x 대장장이의 숫돌', '1)(보호의 합금', 'lx 카오스 오브 니', 'Divine Orb']);
  assert.equal(p[0].qty, 6);
  assert.equal(p[0].name, '대장장이의 숫돌');
  assert.equal(p[1].qty, 1);
  assert.equal(p[1].name, '보호의 합금');
  assert.equal(p[2].qty, 1); // lx → 1 (OCR 혼동)
  assert.equal(p[3].qty, 1); // 수량 없는 영문도 그대로
  assert.equal(p[3].name, 'Divine Orb');
  assert.equal(p[0].explicit, true); // "6x" 수량 명시
  assert.equal(p[3].explicit, false); // 수량 없음
});

// 테스트용 시세 주입자: 레코드의 ninja 값을 그대로 GGG 라이브 가격처럼 반환(네트워크 없이 정렬·합산 검증).
const fakePricer = (rec) => ({
  exalted: rec.valueExalted,
  divine: rec.valueDivine,
  listingCount: 1,
});

test('scanRecipe: 조합행(수량) + 맨이름 화폐 매칭 + 비싼순 정렬', async () => {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: cat, labelKr: cat, valueDivine: vDiv, valueExalted: vDiv * 80,
  });
  store.catalog = {
    ref: {},
    records: [
      rec('카오스 오브', 'Chaos Orb', '화폐', 0.06),
      rec('보호의 합금', 'Protective Alloy', '베리시움', 0.07),
      rec('대장장이의 숫돌', "Blacksmith's Whetstone", '화폐', 0.002),
      rec('유리직공의 방울', "Glassblower's Bauble", '화폐', 0.02),
    ],
  };
  // 헤더 잡텍스트('룬형태 조합')는 어떤 레코드와도 매칭 안 됨, 수량 없는 화폐('유리직공의 방울')는 시세 표시.
  const res = await store.scanRecipe([
    '룬형태 조합',
    '6x 대장장이의 숫돌',
    '1)(보호의 합금',
    'lx 카오스 오브 니',
    '유리직공의 방울',
  ], fakePricer);
  assert.equal(res.items.length, 4); // 맨이름 화폐 포함, 헤더 잡텍스트 제외
  assert.ok(res.items.some((i) => i.record.en === "Glassblower's Bauble"));
  const bauble = res.items.find((i) => i.record.en === "Glassblower's Bauble");
  assert.equal(bauble.qty, 1); // 수량 없는 맨이름은 qty 1
  // 합계 비싼 순: 보호의합금(0.07) > 카오스(0.06) > 유리직공(0.02) > 숫돌(6*0.002=0.012)
  assert.equal(res.items[0].record.en, 'Protective Alloy');
  assert.equal(res.items[3].record.en, "Blacksmith's Whetstone");
  assert.equal(res.items[3].qty, 6);
});

test('scanRecipe: 잘린 이름은 길이 가까운 아이템으로 매칭', async () => {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: cat, labelKr: cat, valueDivine: vDiv, valueExalted: vDiv * 80,
  });
  store.catalog = {
    ref: {},
    records: [
      rec('하위 정신 룬', 'Lesser Mind Rune', '룬', 0.005),
      rec('하위 정신의 에센스', 'Lesser Essence of the Mind', '에센스', 0.5),
    ],
  };
  // OCR 이 "룬"을 잘라먹어 "하위 정신"만 읽힌 경우 → 더 가까운 "하위 정신 룬"
  const res = await store.scanRecipe(['1x 하위 정신'], fakePricer);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].record.en, 'Lesser Mind Rune');
});

test('decomposeHangul: 음절을 자모로 분해(룬↔른은 자모 1개 차이)', () => {
  assert.equal(decomposeHangul('룬'), 'ㄹㅜㄴ');
  assert.equal(decomposeHangul('른'), 'ㄹㅡㄴ');
  assert.equal(decomposeHangul('정신룬'), 'ㅈㅓㅇㅅㅣㄴㄹㅜㄴ');
  assert.equal(decomposeHangul('Rune'), 'Rune'); // 비한글 보존
});

test('jamoSimilarity: OCR 오인식(룬→른)은 높은 유사도', () => {
  assert.equal(jamoSimilarity('정신룬', '정신룬'), 1);
  assert.ok(jamoSimilarity('정신룬', '정신른') >= 0.85); // 자모 1/9 차이 ≈ 0.889
  assert.ok(jamoSimilarity('카오스오브', '전혀다른말') < 0.5);
});

test('scanRecipe: OCR 오인식(룬→른)도 퍼지 매칭으로 시세 조회', async () => {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: cat, labelKr: cat, valueDivine: vDiv, valueExalted: vDiv * 80,
  });
  store.catalog = {
    ref: {},
    records: [
      rec('하위 정신 룬', 'Lesser Mind Rune', '룬', 0.005),
      rec('대장장이의 숫돌', "Blacksmith's Whetstone", '화폐', 0.002),
    ],
  };
  // FHD 저선명 OCR 이 "룬"을 "른"으로 오인식 → 자모 퍼지 매칭으로 구제
  const res = await store.scanRecipe(['3x 하위 정신 른'], fakePricer);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].record.en, 'Lesser Mind Rune');
  assert.equal(res.items[0].qty, 3);
});

test('scanRecipe: 같은 아이템 다른 수량(6x·4x)은 별개 행으로 유지', async () => {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: cat, labelKr: cat, valueDivine: vDiv, valueExalted: vDiv * 80,
  });
  store.catalog = {
    ref: {},
    records: [
      rec('대장장이의 숫돌', "Blacksmith's Whetstone", '화폐', 0.002),
      rec('신비학자의 식각기', "Arcanist's Etcher", '화폐', 0.01),
    ],
  };
  // 룬 조합창처럼 같은 아이템이 6x·4x 두 번 등장 → 합쳐지지 않고 4행 유지
  const res = await store.scanRecipe([
    '6x 대장장이의 숫돌',
    '6x 신비학자의 식각기',
    '4x 대장장이의 숫돌',
    '4x 신비학자의 식각기',
  ], fakePricer);
  assert.equal(res.items.length, 4);
  const whet = res.items.filter((i) => i.record.en === "Blacksmith's Whetstone");
  assert.equal(whet.length, 2);
  assert.deepEqual(whet.map((i) => i.qty).sort((a, b) => a - b), [4, 6]);
});

test('scanRecipe: 진짜 OCR 중복(같은 수량·이름)은 한 행으로 합침', async () => {
  const store = new Store(os.tmpdir());
  store.catalog = {
    ref: {},
    records: [
      { kr: '카오스 오브', en: 'Chaos Orb', krNorm: normKr('카오스 오브'), enNorm: normEn('Chaos Orb'),
        categoryKey: '화폐', labelKr: '화폐', valueDivine: 0.06, valueExalted: 4.8 },
    ],
  };
  // 같은 줄이 타일/배율에서 두 번 읽힌 경우(수량까지 동일) → 1행
  const res = await store.scanRecipe(['3x 카오스 오브', '3x 카오스 오브'], fakePricer);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].qty, 3);
});

// ---------- F10 화폐 거래소(맨이름) 시세 ----------
function commodityStore() {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv, unique = false) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: unique ? 'uniqueArmours' : cat, labelKr: cat,
    valueDivine: vDiv, valueExalted: vDiv != null ? vDiv * 80 : null,
  });
  store.catalog = {
    ref: {},
    records: [
      rec('신성한 오브', 'Divine Orb', '화폐', 1),
      rec('카오스 오브', 'Chaos Orb', '화폐', 0.06),
      rec('엑잘티드 오브', 'Exalted Orb', '화폐', 0.012),
      rec('빛의 징조', 'Omen of Light', '징조', 0.1),
      rec('마법사의 피', 'Mageblood', '유니크 방어구', 5, true), // 유니크는 맨이름 매칭 제외
    ],
  };
  return store;
}

test('scanRecipe: 화폐 거래소 맨이름 모두 시세 표시(수량 없음, 비싼 순)', async () => {
  const store = commodityStore();
  // 화폐 거래소처럼 수량 없는 라벨이 줄줄이. ninja 캐시값으로 즉시 표시(pricer 주입 불필요).
  const res = await store.scanRecipe(['신성한 오브', '카오스 오브', '엑잘티드 오브', '빛의 징조']);
  assert.equal(res.items.length, 4);
  assert.ok(res.items.every((i) => i.qty === 1));
  assert.equal(res.items[0].record.en, 'Divine Orb'); // 1div(80ex) 최고가
  assert.ok(res.items.some((i) => i.record.en === 'Omen of Light'));
});

test('scanRecipe: 맨이름은 유니크(장착 장비) 제외 — F9/GGG 경로 담당', async () => {
  const store = commodityStore();
  const res = await store.scanRecipe(['마법사의 피', '신성한 오브']);
  assert.ok(!res.items.some((i) => i.record.en === 'Mageblood')); // 유니크 제외
  assert.ok(res.items.some((i) => i.record.en === 'Divine Orb'));
});

test('scanRecipe: 맨이름 FHD 오인식(엑잘티드→엑찰티드)도 자모 퍼지 매칭', async () => {
  const store = commodityStore();
  const res = await store.scanRecipe(['엑찰티드 오브']);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].record.en, 'Exalted Orb');
});

test('scanRecipe: 짧은 맨이름 단일 자모 오인식(룬→른)도 흡수(유사도 0.9 미만이어도)', async () => {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: cat, labelKr: cat, valueDivine: vDiv, valueExalted: vDiv * 80,
  });
  store.catalog = {
    ref: {},
    records: [rec('정신 룬', 'Mind Rune', '룬', 0.01), rec('카오스 오브', 'Chaos Orb', '화폐', 0.06)],
  };
  // '정신 룬'(3음절)을 '정신 른'으로 오인식 → 자모 유사도 0.889(<0.9)이지만 1글자 차이라 흡수.
  assert.ok(jamoSimilarity('정신룬', '정신른') < 0.9, '전제: 짧아서 유사도는 0.9 미만');
  const res = await store.scanRecipe(['정신 른']);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].record.en, 'Mind Rune');
});

test('scanRecipe: 맨이름 다중 글자 오인식(길이 비례 허용)도 흡수, 등급 변형은 안 섞임', async () => {
  const store = new Store(os.tmpdir());
  const rec = (kr, en, cat, vDiv) => ({
    kr, en, krNorm: normKr(kr), enNorm: normEn(en),
    categoryKey: cat, labelKr: cat, valueDivine: vDiv, valueExalted: vDiv * 80,
  });
  store.catalog = {
    ref: {},
    records: [
      rec('신성한 오브', 'Divine Orb', '화폐', 1),
      rec('상위 카오스 오브', 'Greater Chaos Orb', '화폐', 0.5),
      rec('카오스 오브', 'Chaos Orb', '화폐', 0.06),
    ],
  };
  // 6음절 이름에서 2글자 오인식(성→섬, 브→부) → 길이 비례 허용으로 흡수.
  const a = await store.scanRecipe(['신섬한 오부']);
  assert.equal(a.items.length, 1);
  assert.equal(a.items[0].record.en, 'Divine Orb');
  // '카오스 오브'는 '상위 카오스 오브'(등급 변형)와 절대 섞이면 안 됨 — 정확 일치 우선.
  const b = await store.scanRecipe(['카오스 오브']);
  assert.equal(b.items.length, 1);
  assert.equal(b.items[0].record.en, 'Chaos Orb');
});

test('scanRecipe: 화면 잡텍스트 맨이름은 매칭 안 됨', async () => {
  const store = commodityStore();
  const res = await store.scanRecipe(['키워드를 입력하십시오', '인기', '화폐', '거래 한도 초과']);
  assert.equal(res.items.length, 0);
});

// ---------- 쿠키 병합(은신처 이동 세션 자동 갱신) ----------
const { mergeSetCookies } = require('../src/main/services/cookies');
test('mergeSetCookies: Set-Cookie 로 저장 쿠키 갱신(POESESSID 회전)', () => {
  // 기존 POESESSID 가 새 값으로 갱신되고, cf_clearance 등 다른 쿠키는 유지
  const out = mergeSetCookies('cf_clearance=abc; POESESSID=old123', ['POESESSID=new999; path=/; HttpOnly; SameSite=Lax']);
  assert.ok(/POESESSID=new999/.test(out));
  assert.ok(/cf_clearance=abc/.test(out));
  assert.ok(!/old123/.test(out));
  // 새 쿠키 추가
  assert.ok(/extra=1/.test(mergeSetCookies('a=1', ['extra=1; path=/'])));
  // 빈 입력 안전
  assert.equal(mergeSetCookies('a=1', []), 'a=1');
  assert.equal(mergeSetCookies('a=1', null), 'a=1');
});

// ---------- 단축키(accelerator) 정규화·검증 ----------
test('normalizeAccelerator: 별칭·순서·대소문자 정규화', () => {
  assert.equal(normalizeAccelerator('f9'), 'F9');
  assert.equal(normalizeAccelerator('shift+f9'), 'Shift+F9');
  assert.equal(normalizeAccelerator('ctrl + alt + p'), 'Control+Alt+P');
  assert.equal(normalizeAccelerator('control+shift+1'), 'Control+Shift+1');
  // 수정자 순서는 항상 Control, Alt, Shift
  assert.equal(normalizeAccelerator('shift+ctrl+f10'), 'Control+Shift+F10');
});

test('normalizeAccelerator: 무효 입력 → null', () => {
  assert.equal(normalizeAccelerator('F25'), null); // 범위 밖 펑션키
  assert.equal(normalizeAccelerator('Ctrl+Alt'), null); // 키 없음(수정자만)
  assert.equal(normalizeAccelerator('A+B'), null); // 키 둘
  assert.equal(normalizeAccelerator(''), null);
  assert.equal(normalizeAccelerator(null), null);
  assert.equal(normalizeAccelerator('Win+P'), null); // 미허용 수정자
});

test('isRegisterable: 맨 글자/숫자키는 금지, 펑션키·수정자조합은 허용', () => {
  assert.equal(isRegisterable('F9'), true);
  assert.equal(isRegisterable('Shift+F9'), true);
  assert.equal(isRegisterable('Control+P'), true);
  assert.equal(isRegisterable('P'), false); // 맨 글자키는 전역 타이핑 가로챔
  assert.equal(isRegisterable('1'), false);
});

test('mergeHotkeys: 누락/무효는 기본값으로 채움', () => {
  assert.deepEqual(mergeHotkeys(null), { price: 'F9', scan: 'F10', pricer: 'Shift+F9' });
  assert.deepEqual(mergeHotkeys({ price: 'ctrl+q' }), { price: 'Control+Q', scan: 'F10', pricer: 'Shift+F9' });
  assert.deepEqual(mergeHotkeys({ scan: '쓰레기' }).scan, 'F10');
  assert.deepEqual(DEFAULT_HOTKEYS, { price: 'F9', scan: 'F10', pricer: 'Shift+F9' });
});

test('validateHotkeyMap: 유효 맵 → 정규형', () => {
  const v = validateHotkeyMap({ price: 'f9', scan: 'f10', pricer: 'shift+f9' });
  assert.deepEqual(v.map, { price: 'F9', scan: 'F10', pricer: 'Shift+F9' });
  assert.equal(v.errors, undefined);
});

test('validateHotkeyMap: 무효/맨글자/중복 검출', () => {
  // 맨 글자키(price=P) → needsModifier, scan 무효, pricer 정상
  const a = validateHotkeyMap({ price: 'P', scan: 'F99', pricer: 'Shift+F9' });
  assert.equal(a.map, undefined);
  assert.equal(a.errors.price, 'needsModifier');
  assert.equal(a.errors.scan, 'invalid');
  // 같은 키를 두 동작에 → 둘 다 duplicate
  const b = validateHotkeyMap({ price: 'F9', scan: 'F9', pricer: 'Shift+F9' });
  assert.equal(b.errors.price, 'duplicate');
  assert.equal(b.errors.scan, 'duplicate');
});

// ---------- ggg (실시간 시세 클라이언트, 순수 함수만) ----------
test('ggg.median: 홀수/짝수/빈 배열', () => {
  assert.equal(ggg.median([3, 1, 2]), 2);
  assert.equal(ggg.median([4, 1, 2, 3]), 2.5);
  assert.equal(ggg.median([]), null);
});

test('ggg.buildQuery: 유니크는 이름만(기반 미지정), 그 외는 type', () => {
  const uniq = ggg.buildQuery({ categoryKey: 'uniqueArmours', en: 'Solar Soul', baseType: 'Crucible Plate' });
  assert.equal(uniq.query.name, 'Solar Soul');
  assert.equal(uniq.query.type, undefined); // 고유 아이템은 이름만 — 기반 필터 제거
  assert.equal(uniq.query.status.option, 'any'); // 평가 → 오프라인 포함
  assert.equal(uniq.sort.price, 'asc');

  const curr = ggg.buildQuery({ categoryKey: 'currency', en: 'Chaos Orb', baseType: '' });
  assert.equal(curr.query.type, 'Chaos Orb');
  assert.equal(curr.query.name, undefined);
});

test('ggg.buildTermQuery: 자유 텍스트 폴백', () => {
  const q = ggg.buildTermQuery({ en: 'Lesser Mind Rune' });
  assert.equal(q.query.term, 'Lesser Mind Rune');
  assert.equal(q.query.status.option, 'any');
});

test('ggg.tradeUrl: 한국(카카오게임즈) 거래소 도메인 + 리그명 인코딩', () => {
  const url = ggg.tradeUrl('Runes of Aldur', 'ky6rVX25I5');
  assert.equal(url, 'https://poe.kakaogames.com/trade2/search/poe2/Runes%20of%20Aldur/ky6rVX25I5');
  assert.ok(url.startsWith('https://poe.kakaogames.com/'));
  assert.ok(!url.includes('pathofexile.com')); // 글로벌 GGG 도메인 아님
});

test('ggg.parseTradeUrl: 한국/글로벌 거래 URL 파싱 + API base 매핑', () => {
  const kr = ggg.parseTradeUrl('https://poe.kakaogames.com/trade2/search/poe2/Runes%20of%20Aldur/8rVmKDRnFV');
  assert.equal(kr.host, 'poe.kakaogames.com');
  assert.equal(kr.apiBase, 'https://poe.kakaogames.com/api/trade2');
  assert.equal(kr.league, 'Runes of Aldur'); // 디코딩됨
  assert.equal(kr.id, '8rVmKDRnFV');
  const gl = ggg.parseTradeUrl('https://www.pathofexile.com/trade2/search/poe2/Standard/abcDEF123');
  assert.equal(gl.apiBase, 'https://www.pathofexile.com/api/trade2');
  assert.equal(gl.league, 'Standard');
});

test('ggg.parseTradeUrl: 화이트리스트 밖/형식오류는 null (SSRF·주입 차단)', () => {
  assert.equal(ggg.parseTradeUrl('https://evil.com/trade2/search/poe2/x/y'), null); // 허용 안 된 도메인
  assert.equal(ggg.parseTradeUrl('https://poe.kakaogames.com.evil.com/trade2/search/poe2/x/y'), null); // 서브도메인 사칭
  assert.equal(ggg.parseTradeUrl('http://poe.kakaogames.com/trade2/search/poe2/x/y'), null); // https 아님
  assert.equal(ggg.parseTradeUrl('https://poe.kakaogames.com/trade2/search/poe2/L/bad..id'), null); // id 영숫자 아님
  assert.equal(ggg.parseTradeUrl('https://poe.kakaogames.com/other/path'), null); // 경로 형식 불일치
  assert.equal(ggg.parseTradeUrl('https://poe.kakaogames.com/trade2/search/poe2/L/ID/extra'), null); // 꼬리 경로
  assert.equal(ggg.parseTradeUrl('not a url'), null);
  assert.equal(ggg.parseTradeUrl(null), null);
});

test('ggg.signature: 카테고리+이름+기반+타락 조합', () => {
  const a = ggg.signature({ categoryKey: 'currency', enNorm: 'chaosorb', baseType: '', corrupted: false });
  const b = ggg.signature({ categoryKey: 'currency', enNorm: 'chaosorb', baseType: '', corrupted: true });
  assert.notEqual(a, b); // 타락 여부로 분리
  assert.equal(a, 'currency|chaosorb||0');
});

// ---------- catalog dedupe ----------
function urec(en, baseType, valueDivine, volume, corrupted = false) {
  return {
    en, baseType, enNorm: normEn(en), corrupted, volume, valueDivine,
    categoryKey: 'uniqueArmours',
  };
}
test('dedupe: 같은 이름·기반의 변형은 거래량 많은 쪽만 남김', () => {
  const out = dedupe([urec('Soul Mantle', 'Sacrificial Mantle', 0.05, 49), urec('Soul Mantle', 'Sacrificial Mantle', 0.007, 4174)]);
  assert.equal(out.length, 1);
  assert.equal(out[0].volume, 4174); // 거래량 많은 쪽
});
test('dedupe: 타락/비타락은 별개로 유지', () => {
  const out = dedupe([urec('X', 'Belt', 10, 5, false), urec('X', 'Belt', 3, 5, true)]);
  assert.equal(out.length, 2);
});
test('dedupe: 다른 기반은 별개로 유지', () => {
  const out = dedupe([urec('Soul Mantle', 'Sacrificial Mantle', 0.007, 4174), urec('Soul Mantle', 'Runemastered Sacrificial Mantle', 0.05, 49)]);
  assert.equal(out.length, 2);
});

// ---------- itemtext (클립보드 파싱) ----------
test('extractItemName: 한글 화폐', () => {
  const clip = '아이템 종류: 중첩 가능한 화폐\n희귀도: 화폐\n신성한 오브\n--------\n중첩 크기: 3/10\n';
  assert.equal(extractItemName(clip), '신성한 오브');
});
test('extractItemName: 한글 유니크(이름 우선)', () => {
  const clip = '아이템 종류: 장갑\n희귀도: 고유\n마법사의 피\n무거운 허리띠\n--------\n';
  assert.equal(extractItemName(clip), '마법사의 피');
});
test('extractItemName: 영문 클라이언트', () => {
  const clip = 'Item Class: Stackable Currency\nRarity: Currency\nDivine Orb\n--------\n';
  assert.equal(extractItemName(clip), 'Divine Orb');
});
test('extractItemName: 희귀도 없으면 폴백/빈값', () => {
  assert.equal(extractItemName('그냥 텍스트'), '그냥 텍스트');
  assert.equal(extractItemName(''), '');
  assert.equal(extractItemName('키: 값\n키2: 값2'), '');
});
test('looksLikeItem: 아이템 형식 판별', () => {
  assert.equal(looksLikeItem('아이템 종류: 장갑\n희귀도: 고유\n마법사의 피'), true);
  assert.equal(looksLikeItem('Rarity: Currency\nDivine Orb'), true);
  assert.equal(looksLikeItem('hello world'), false);
  assert.equal(looksLikeItem(''), false);
  assert.equal(looksLikeItem(null), false);
});

// ---------- itemparse (전체 아이템 텍스트 구조화) ----------
const fs = require('node:fs');
const path = require('node:path');
const { parseItem, cleanModLine } = require('../src/main/services/itemparse');
const RARE_BELT = fs.readFileSync(path.join(__dirname, 'fixtures', 'item-rare-belt.txt'), 'utf8');

test('parseItem: 레어 허리띠 헤더(희귀도/기반/아이템레벨)', () => {
  const it = parseItem(RARE_BELT);
  assert.equal(it.rarity, 'rare');
  assert.equal(it.category, '허리띠');
  assert.equal(it.name, '고통 혁대');
  assert.equal(it.base, '넓은 허리띠');
  assert.equal(it.itemLevel, 81);
  assert.equal(it.corrupted, false);
});

test('parseItem: 접사 종류 분류(implicit/prefix/suffix)', () => {
  const it = parseItem(RARE_BELT);
  // implicit 2 + prefix 3 + suffix 3 = 8개 모드
  assert.equal(it.mods.length, 8);
  const implicit = it.mods.filter((m) => m.affix === 'implicit');
  const prefix = it.mods.filter((m) => m.affix === 'prefix');
  const suffix = it.mods.filter((m) => m.affix === 'suffix');
  assert.equal(implicit.length, 2);
  assert.equal(prefix.length, 3);
  assert.equal(suffix.length, 3);
  // prefix/suffix 는 거래 검색에서 explicit id
  assert.equal(prefix[0].statType, 'explicit');
  assert.equal(implicit[0].statType, 'implicit');
});

test('parseItem: 값 범위 제거 + 현재값 추출', () => {
  const it = parseItem(RARE_BELT);
  const lightRes = it.mods.find((m) => m.raw.includes('번개 저항'));
  assert.equal(lightRes.clean, '번개 저항 +34%'); // (31-35) 제거
  assert.deepEqual(lightRes.values, [34]);
  const armour = it.mods.find((m) => m.raw.includes('방어도'));
  assert.equal(armour.clean, '방어도 +272');
  assert.deepEqual(armour.values, [272]);
  // 티어 파싱
  assert.equal(armour.tier, 2);
});

test('cleanModLine: 멀티값/범위 처리', () => {
  assert.deepEqual(cleanModLine('물리 피해 5(3-7)~12(9-15) 추가'), {
    clean: '물리 피해 5~12 추가',
    values: [5, 12],
  });
});

const RARE_BOOTS = fs.readFileSync(path.join(__dirname, 'fixtures', 'item-rare-boots.txt'), 'utf8');

test('parseItem: 레어 장화 — 랜덤이름 vs 기반, 품질/홈/속성 제외', () => {
  const it = parseItem(RARE_BOOTS);
  assert.equal(it.category, '장화');
  assert.equal(it.name, '불사조 몰이 막대'); // 랜덤 이름
  assert.equal(it.base, '속박된 샌들'); // 진짜 장화 기반
  assert.equal(it.quality, 20);
  assert.equal(it.itemLevel, 81);
  assert.equal(it.sockets, 1); // "홈: S" → 룬 소켓 1개
  // 모드 = 룬1 + explicit6 = 7 (퀄리티/ES속성/"홈: S"/요구사항 은 제외)
  assert.equal(it.mods.length, 7);
  assert.ok(!it.mods.some((m) => /퀄리티|^에너지 보호막:|^홈/.test(m.raw)));
});

test('parseItem: 룬 모드 — 끝의 "(rune)" 표기 제거 + 접사 rune', () => {
  const it = parseItem(RARE_BOOTS);
  const rune = it.mods.find((m) => m.affix === 'rune');
  assert.ok(rune, '룬 모드가 있어야');
  assert.equal(rune.clean, '방어도, 회피, 에너지 보호막 18% 증가'); // (rune) 제거됨
  assert.deepEqual(rune.values, [18]);
  assert.equal(rune.statType, 'rune');
});

test('ggg.buildStatQuery: 룬 소켓(홈)·아이템레벨·카테고리 필터', () => {
  const q = ggg.buildStatQuery([{ id: 'explicit.stat_x', value: { min: 10 } }], { category: 'armour.boots', ilvl: 80, sockets: 2 });
  assert.equal(q.filters.equipment_filters.filters.rune_sockets.min, 2);
  assert.equal(q.filters.misc_filters.filters.ilvl.min, 80);
  assert.equal(q.filters.type_filters.filters.category.option, 'armour.boots');
  // 소켓 0/무효는 필터에서 제외, 상한(10)으로 캡
  assert.equal(ggg.buildStatQuery([], { sockets: 0 }).filters, undefined);
  assert.equal(ggg.buildStatQuery([], { category: 'x', sockets: 99 }).filters.equipment_filters.filters.rune_sockets.min, 10);
  assert.equal(ggg.buildStatQuery([], { category: 'x', sockets: 'abc' }).filters.equipment_filters, undefined);
});

test('ggg.buildStatQuery: 유니크는 이름으로 검색(카테고리/등급 필터 생략)', () => {
  const q = ggg.buildStatQuery([{ id: 'explicit.stat_x', value: { min: 5 } }], { name: 'Mageblood', category: 'accessory.belt', rarity: 'unique' });
  assert.equal(q.name, 'Mageblood'); // 이름으로 그 유니크만
  assert.equal(q.filters, undefined); // 이름이 있으면 카테고리/등급 type_filters 생략
  assert.equal(q.stats[0].filters[0].id, 'explicit.stat_x'); // 옵션 필터는 유지(변동 굴림)
  // 이름 없으면 종전대로 카테고리 필터
  const q2 = ggg.buildStatQuery([], { category: 'accessory.belt' });
  assert.equal(q2.name, undefined);
  assert.equal(q2.filters.type_filters.filters.category.option, 'accessory.belt');
});

test('ggg.affixRank: 접두 위·접미 아래 (고정 최상·룬 최하)', () => {
  // implicit/enchant(0) < prefix(1) < explicit(2) < suffix(3) < rune(4)
  assert.ok(ggg.affixRank('prefix') < ggg.affixRank('suffix'));
  assert.ok(ggg.affixRank('implicit') < ggg.affixRank('prefix'));
  assert.ok(ggg.affixRank('explicit') < ggg.affixRank('suffix'));
  assert.ok(ggg.affixRank('suffix') < ggg.affixRank('rune'));
  assert.equal(ggg.affixRank('enchant'), ggg.affixRank('implicit'));
});

test('ggg.gggCategoryId: 한글 아이템종류 → GGG 카테고리', () => {
  assert.equal(ggg.gggCategoryId('장화'), 'armour.boots');
  assert.equal(ggg.gggCategoryId('신발'), 'armour.boots');
  assert.equal(ggg.gggCategoryId('허리띠'), 'accessory.belt');
  assert.equal(ggg.gggCategoryId('반지'), 'accessory.ring');
  assert.equal(ggg.gggCategoryId('알수없는종류'), null);
});

// ---------- stats (모드텍스트 → stat id 매처) ----------
const { normKey, buildStatIndex, matchMod } = require('../src/main/services/stats');
const SAMPLE_STATS = {
  result: [
    { label: '비고정', entries: [
      { id: 'explicit.stat_fire', text: '화염 저항 #%' },
      { id: 'explicit.stat_life', text: '생명력 최대치 #' },
      { id: 'explicit.stat_phys', text: '물리 피해 #~# 추가' },
    ] },
    { label: '고정', entries: [{ id: 'implicit.stat_fire', text: '화염 저항 #%' }] },
    { label: '비고정2', entries: [
      { id: 'explicit.stat_esmax_global', text: '에너지 보호막 최대치 #' }, // 글로벌(0건)
      { id: 'explicit.stat_esmax_local', text: '에너지 보호막 최대치 #(특정)' }, // 로컬(장비)
    ] },
  ],
};

test('stats.normKey: 숫자(부호/범위)를 #로 정규화', () => {
  assert.equal(normKey('번개 저항 +34%'), '번개 저항 #%');
  assert.equal(normKey('방어도 +272'), '방어도 #');
  assert.equal(normKey('물리 피해 5~12 추가'), '물리 피해 #~# 추가');
});

test('stats.matchMod: 라인 → stat id + 값, 접사로 모호성 해소', () => {
  const idx = buildStatIndex(SAMPLE_STATS);
  const fireExp = matchMod(idx, '화염 저항 35%', 'explicit');
  assert.equal(fireExp.id, 'explicit.stat_fire');
  assert.deepEqual(fireExp.values, [35]);
  // 같은 텍스트라도 접사 종류로 implicit id 선택
  const fireImp = matchMod(idx, '화염 저항 20%', 'implicit');
  assert.equal(fireImp.id, 'implicit.stat_fire');
  // 멀티값
  const phys = matchMod(idx, '물리 피해 5~12 추가', 'explicit');
  assert.equal(phys.id, 'explicit.stat_phys');
  assert.deepEqual(phys.values, [5, 12]);
  // 사전에 없는 모드 → null
  assert.equal(matchMod(idx, '존재하지 않는 옵션 99', 'explicit'), null);

  // 로컬("특정") 방어 모드: 클립보드엔 "(특정)" 없지만 로컬 id 를 골라야 검색됨(글로벌은 0건)
  const esmax = matchMod(idx, '에너지 보호막 최대치 +50', 'explicit');
  assert.equal(esmax.id, 'explicit.stat_esmax_local');
  assert.deepEqual(esmax.values, [50]);
});

test('ggg.statFilterValue / modWeight', () => {
  // 검색 min = 아이템 실제 굴림값(기준값). 자동으로 낮추지 않는다.
  assert.deepEqual(ggg.statFilterValue([34]), { min: 34 });
  assert.deepEqual(ggg.statFilterValue([100]), { min: 100 });
  assert.deepEqual(ggg.statFilterValue([5, 15]), { min: 10 }); // 평균
  assert.ok(ggg.modWeight('생명력 최대치 +80') > ggg.modWeight('소환수 효과 범위 12% 증가'));
});

// ---------- favorites (즐겨찾기 워치리스트) ----------
test('favorites: addRare 추가/중복방지/삭제 + 디스크 영속', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favtest-'));
  const store = new Store(dir);
  const data = {
    name: '고통 혁대', base: '넓은 허리띠',
    filters: [{ id: 'explicit.stat_x', min: 10 }, { id: 'explicit.stat_y', min: 5 }],
    mods: ['소환수 피해', '저항'], price: { exalted: 5, divine: 0.04, listingCount: 100 },
  };
  let events = 0;
  store.on('favorites', () => { events++; });

  await store.addRareFavorite(data);
  let list = await store.getFavorites();
  assert.equal(list.length, 1);
  assert.equal(list[0].kind, 'rare');
  assert.equal(list[0].lastPrice.exalted, 5);

  // 같은 base+필터 → 중복 추가 안 됨
  await store.addRareFavorite(data);
  assert.equal((await store.getFavorites()).length, 1);

  // 디스크 영속: 새 인스턴스가 같은 디렉터리에서 읽음
  const store2 = new Store(dir);
  assert.equal((await store2.getFavorites()).length, 1);

  // 삭제
  await store2.removeFavorite(list[0].key);
  assert.equal((await store2.getFavorites()).length, 0);

  assert.ok(events >= 1); // 변경 시 이벤트 방출
});

test('favorites: setFavoriteLabel 라벨 설정/해제(+길이 제한)', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'favlabel-'));
  const store = new Store(dir);
  await store.addRareFavorite({ name: '고통 혁대', base: '넓은 허리띠', filters: [{ id: 'explicit.stat_x', min: 10 }], mods: [] });
  const key = (await store.getFavorites())[0].key;
  // 라벨 설정
  let list = await store.setFavoriteLabel(key, '  내 메인 벨트  ');
  assert.equal(list[0].label, '내 메인 벨트'); // trim 적용
  // 디스크 영속
  assert.equal((await new Store(dir).getFavorites())[0].label, '내 메인 벨트');
  // 길이 제한(60)
  list = await store.setFavoriteLabel(key, 'x'.repeat(100));
  assert.equal(list[0].label.length, 60);
  // 빈 문자열 → 라벨 제거
  list = await store.setFavoriteLabel(key, '   ');
  assert.equal(list[0].label, undefined);
  // 없는 키는 무변경
  const before = await store.getFavorites();
  const after = await store.setFavoriteLabel('nope', 'x');
  assert.equal(after.length, before.length);
});

// ---------- catalog record ----------
test('toRecord: 사전에 없으면 영문 폴백', () => {
  const cat = { key: 'currency', labelKr: '화폐', endpoint: 'exchange' };
  const r = toRecord({ en: 'Mystery Orb', value: { divine: 1, exalted: 80, chaos: 16 }, icon: '' }, cat, {});
  assert.equal(r.kr, 'Mystery Orb');
  const r2 = toRecord({ en: 'Divine Orb', value: { divine: 1, exalted: 80 }, icon: '' }, cat, { [normEn('Divine Orb')]: '신성한 오브' });
  assert.equal(r2.kr, '신성한 오브');
  assert.equal(r2.valueExalted, 80);
});

// ---------- redact (민감정보 마스킹) ----------
test('redact: Windows 사용자명 마스킹, 이후 경로는 유지', () => {
  assert.equal(
    redact('실패: C:\\Users\\jsh71\\AppData\\Local\\app.exe 없음'),
    '실패: C:\\Users\\<user>\\AppData\\Local\\app.exe 없음'
  );
  // 드라이브 없는 \Users\ 경로도 마스킹
  assert.equal(redact('\\Users\\bob\\x'), '\\Users\\<user>\\x');
});
test('redact: 일반 텍스트·null 안전', () => {
  assert.equal(redact('fetch failed (503)'), 'fetch failed (503)');
  assert.equal(redact(null), '');
  assert.equal(redact(undefined), '');
});

// ---------- errorReport (실패 버퍼 + 프리필 이슈) ----------
test('errorReport.record: 연속 중복 억제 + 마스킹', () => {
  errorReport.clear();
  errorReport.record({ ts: 't1', message: 'C:\\Users\\jsh71\\a 실패', league: 'Std' });
  errorReport.record({ ts: 't2', message: 'C:\\Users\\jsh71\\a 실패', league: 'Std' }); // 직전과 동일 → 무시
  errorReport.record({ ts: 't3', message: '다른 실패', league: 'Std' });
  const d = errorReport.dump();
  assert.equal(d.length, 2);
  assert.equal(d[0].message, 'C:\\Users\\<user>\\a 실패'); // 사용자명 마스킹됨
  assert.equal(d[1].message, '다른 실패');
});
test('errorReport.record: 링버퍼 최대 길이 유지', () => {
  errorReport.clear();
  for (let i = 0; i < errorReport.MAX_ENTRIES + 5; i++) {
    errorReport.record({ ts: 't' + i, message: 'fail ' + i });
  }
  const d = errorReport.dump();
  assert.equal(d.length, errorReport.MAX_ENTRIES);
  assert.equal(d[d.length - 1].message, 'fail ' + (errorReport.MAX_ENTRIES + 4)); // 최신 유지
});
test('errorReport.dump: 불변 복사본(외부 변형이 버퍼에 영향 없음)', () => {
  errorReport.clear();
  errorReport.record({ ts: 't1', message: 'x' });
  const d = errorReport.dump();
  d[0].message = 'mutated';
  assert.equal(errorReport.dump()[0].message, 'x');
});
test('errorReport.buildIssueBody: 환경·최근로그·카테고리오류 포함 + 마스킹', () => {
  const body = errorReport.buildIssueBody({
    version: '1.0.5',
    platform: 'win32',
    arch: 'x64',
    league: 'Standard',
    recent: [{ ts: 't1', message: 'C:\\Users\\jsh71\\x 실패', league: 'Standard' }],
    categoryErrors: [{ category: 'currency', message: 'HTTP 503' }],
  });
  assert.ok(body.includes('1.0.5'));
  assert.ok(body.includes('win32'));
  assert.ok(body.includes('HTTP 503'));
  assert.ok(body.includes('C:\\Users\\<user>\\x 실패')); // 마스킹 적용
  assert.ok(!body.includes('jsh71')); // 사용자명 누출 없음
});
test('errorReport.buildIssueUrl/buildTitle: 프리필 URL 형태', () => {
  const url = errorReport.buildIssueUrl({
    owner: 'jsh7195',
    repo: 'poe2-price-kr',
    title: errorReport.buildTitle('데이터 로드 실패: fetch failed'),
    labels: 'price-fail',
    body: 'hello world',
  });
  assert.ok(url.startsWith('https://github.com/jsh7195/poe2-price-kr/issues/new?'));
  assert.ok(url.includes('labels=price-fail'));
  assert.ok(url.includes('body=hello%20world'));
  assert.ok(url.includes(encodeURIComponent('[price-fail]')));
});
test('errorReport.buildIssueUrl: 한글 대용량 본문도 인코딩 길이 기준으로 제한', () => {
  const hugeKorean = '가'.repeat(20000); // 인코딩 시 ~3배(%EA%B0%80)로 폭증
  const url = errorReport.buildIssueUrl({
    owner: 'o', repo: 'r', body: hugeKorean,
  });
  const bodyParam = url.split('body=')[1] || '';
  assert.ok(bodyParam.length <= 6100, `encoded body too long: ${bodyParam.length}`);
  // 잘린 본문도 유효한 인코딩이어야 함(디코드가 throw 하지 않음)
  assert.doesNotThrow(() => decodeURIComponent(bodyParam));
});
