'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { normEn, normKr, isSubsequence } = require('../src/main/services/normalize');
const { makeValueCalc, parseExchange, parseStash } = require('../src/main/services/ninja');
const { buildFromRaw } = require('../src/main/services/dictionary');
const { search } = require('../src/main/services/search');
const { toRecord, dedupe } = require('../src/main/services/catalog');
const { extractItemName, looksLikeItem, parseRecipeLines } = require('../src/main/services/itemtext');
const { Store } = require('../src/main/services/store');
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

test('scanRecipe: 노이즈 매칭 + 수량 + 비싼순 정렬', () => {
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
  // 화면 잡텍스트(수량 없는 "유리직공의 방울")가 섞여도 제외돼야 함
  const res = store.scanRecipe([
    '룬형태 조합',
    '6x 대장장이의 숫돌',
    '1)(보호의 합금',
    'lx 카오스 오브 니',
    '유리직공의 방울',
  ]);
  assert.equal(res.items.length, 3); // 수량 없는 잡텍스트 제외
  assert.ok(!res.items.some((i) => i.record.en === "Glassblower's Bauble"));
  // 합계 비싼 순: 보호의합금(0.07) > 카오스(0.06) > 숫돌(6*0.002=0.012)
  assert.equal(res.items[0].record.en, 'Protective Alloy');
  assert.equal(res.items[2].record.en, "Blacksmith's Whetstone");
  assert.equal(res.items[2].qty, 6);
});

test('scanRecipe: 잘린 이름은 길이 가까운 아이템으로 매칭', () => {
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
  const res = store.scanRecipe(['1x 하위 정신']);
  assert.equal(res.items.length, 1);
  assert.equal(res.items[0].record.en, 'Lesser Mind Rune');
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
