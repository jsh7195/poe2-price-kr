'use strict';

// 0.5.5 시즌 대응: 리그 선택·자동 전환, 비유니크 사전 조인, 서판 variant, 카테고리 정리.

const test = require('node:test');
const assert = require('node:assert/strict');

const { pickCurrent, resolveLeague } = require('../src/main/services/leagues');
const { buildFromRaw, joinTypesByAnchors } = require('../src/main/services/dictionary');
const { toRecord, dedupe } = require('../src/main/services/catalog');
const { parseStash } = require('../src/main/services/ninja');
const { normEn } = require('../src/main/services/normalize');
const { CATEGORIES, ENDPOINTS } = require('../src/main/config');

// poe.ninja index-state 실측(2026-09-16): 새 시즌이 맨 위에 indexed=false 로 등장
const LEAGUES = [
  { name: 'Forbidden Rites', hardcore: false, indexed: false },
  { name: 'Runes of Aldur', hardcore: false, indexed: true },
  { name: 'HC Forbidden Rites', hardcore: true, indexed: false },
  { name: 'HC Runes of Aldur', hardcore: true, indexed: false },
  { name: 'Standard', hardcore: false, indexed: false },
  { name: 'Hardcore', hardcore: true, indexed: false },
];
const CUR = LEAGUES[0];

// ---------- pickCurrent ----------
test('pickCurrent: indexed=false 여도 맨 위 소프트코어 챌린지 리그가 현재 시즌', () => {
  assert.equal(pickCurrent(LEAGUES).name, 'Forbidden Rites');
});

test('pickCurrent: 상설 리그만 있으면 indexed 소프트코어 → indexed → 첫 항목 순', () => {
  assert.equal(pickCurrent([{ name: 'Hardcore', hardcore: true, indexed: true }, { name: 'Standard', hardcore: false, indexed: true }]).name, 'Standard');
  assert.equal(pickCurrent([{ name: 'Hardcore', hardcore: true, indexed: true }, { name: 'Standard', hardcore: false, indexed: false }]).name, 'Hardcore');
  assert.equal(pickCurrent([{ name: 'Standard', hardcore: false, indexed: false }]).name, 'Standard');
  assert.equal(pickCurrent([]), null);
  assert.equal(pickCurrent(null), null);
});

// ---------- resolveLeague ----------
test('resolveLeague: 저장된 리그가 없거나 목록에 없으면 현재 시즌', () => {
  assert.equal(resolveLeague({ wanted: null, prevCurrent: null, leagues: LEAGUES, current: CUR }), 'Forbidden Rites');
  assert.equal(resolveLeague({ wanted: 'Dawn of the Hunt', prevCurrent: 'Dawn of the Hunt', leagues: LEAGUES, current: CUR }), 'Forbidden Rites');
});

test('resolveLeague: 새 시즌 감지 시 직전 시즌에 머물던 사용자는 새 시즌으로 자동 이동', () => {
  assert.equal(resolveLeague({ wanted: 'Runes of Aldur', prevCurrent: 'Runes of Aldur', leagues: LEAGUES, current: CUR }), 'Forbidden Rites');
  // 구버전 업그레이드(prevCurrent 미기록)도 새 시즌으로
  assert.equal(resolveLeague({ wanted: 'Runes of Aldur', prevCurrent: undefined, leagues: LEAGUES, current: CUR }), 'Forbidden Rites');
  // 직전 시즌 HC → 새 시즌 HC
  assert.equal(resolveLeague({ wanted: 'HC Runes of Aldur', prevCurrent: 'Runes of Aldur', leagues: LEAGUES, current: CUR }), 'HC Forbidden Rites');
});

test('resolveLeague: 상설 리그 선택은 새 시즌이 와도 존중', () => {
  assert.equal(resolveLeague({ wanted: 'Standard', prevCurrent: 'Runes of Aldur', leagues: LEAGUES, current: CUR }), 'Standard');
  assert.equal(resolveLeague({ wanted: 'Hardcore', prevCurrent: undefined, leagues: LEAGUES, current: CUR }), 'Hardcore');
});

test('resolveLeague: 시즌이 바뀌지 않았으면 사용자가 고른 옛 리그도 유지', () => {
  assert.equal(resolveLeague({ wanted: 'Runes of Aldur', prevCurrent: 'Forbidden Rites', leagues: LEAGUES, current: CUR }), 'Runes of Aldur');
  assert.equal(resolveLeague({ wanted: 'Forbidden Rites', prevCurrent: 'Forbidden Rites', leagues: LEAGUES, current: CUR }), 'Forbidden Rites');
});

test('resolveLeague: 현재 시즌을 못 정하면 저장값 → 첫 항목 → null', () => {
  assert.equal(resolveLeague({ wanted: 'Standard', prevCurrent: null, leagues: LEAGUES, current: null }), 'Standard');
  assert.equal(resolveLeague({ wanted: 'Nope', prevCurrent: null, leagues: LEAGUES, current: null }), 'Forbidden Rites');
  assert.equal(resolveLeague({ wanted: null, prevCurrent: null, leagues: [], current: null }), null);
});

// ---------- joinTypesByAnchors ----------
test('joinTypesByAnchors: 앵커 사이 길이가 같은 구간만 인덱스 조인, 다른 구간은 건너뜀', () => {
  // EN: A(앵커) x y B(앵커) z w | KR: A' x' y' B' z' (w 누락 → 꼬리 구간 길이 불일치)
  const en = [{ type: 'Chaos Orb' }, { type: 'Stoat Idol' }, { type: 'Hawk Idol' }, { type: 'Divine Orb' }, { type: 'Panther Idol' }, { type: 'Owl Idol' }];
  const kr = [{ type: '카오스 오브' }, { type: '담비 우상' }, { type: '매 우상' }, { type: '신성한 오브' }, { type: '흑표 우상' }];
  const enToKr = { [normEn('Chaos Orb')]: '카오스 오브', [normEn('Divine Orb')]: '신성한 오브' };
  joinTypesByAnchors(en, kr, enToKr);
  assert.equal(enToKr[normEn('Stoat Idol')], '담비 우상');
  assert.equal(enToKr[normEn('Hawk Idol')], '매 우상');
  assert.equal(enToKr[normEn('Panther Idol')], undefined); // 꼬리 구간 EN 2 vs KR 1 → 조인 안 함
  assert.equal(enToKr[normEn('Owl Idol')], undefined);
});

test('joinTypesByAnchors: 앵커 앞에서 KR 에 항목이 하나 더 있어도 앵커 이후는 정상 조인', () => {
  const en = [{ type: 'Stoat Idol' }, { type: 'Chaos Orb' }, { type: 'Hawk Idol' }];
  const kr = [{ type: '여분' }, { type: '담비 우상' }, { type: '카오스 오브' }, { type: '매 우상' }];
  const enToKr = { [normEn('Chaos Orb')]: '카오스 오브' };
  joinTypesByAnchors(en, kr, enToKr);
  assert.equal(enToKr[normEn('Stoat Idol')], undefined); // 앞 구간 EN 1 vs KR 2
  assert.equal(enToKr[normEn('Hawk Idol')], '매 우상');
});

test('joinTypesByAnchors: 앵커가 없으면 전체 개수가 같을 때만 인덱스 조인', () => {
  const same = {};
  joinTypesByAnchors([{ type: 'Abyss Tablet' }, { type: 'Breach Tablet' }], [{ type: '심연 서판' }, { type: '균열 서판' }], same);
  assert.equal(same[normEn('Abyss Tablet')], '심연 서판');
  assert.equal(same[normEn('Breach Tablet')], '균열 서판');
  const diff = {};
  joinTypesByAnchors([{ type: 'Abyss Tablet' }, { type: 'Breach Tablet' }], [{ type: '심연 서판' }], diff);
  assert.deepEqual(diff, {});
});

test('joinTypesByAnchors: 이미 알려진 번역은 덮어쓰지 않음', () => {
  const enToKr = { [normEn('Chaos Orb')]: '카오스 오브', [normEn('Stoat Idol')]: '기존값' };
  joinTypesByAnchors([{ type: 'Chaos Orb' }, { type: 'Stoat Idol' }], [{ type: '카오스 오브' }, { type: '담비 우상' }], enToKr);
  assert.equal(enToKr[normEn('Stoat Idol')], '기존값');
});

test('buildFromRaw: static 앵커로 비유니크 기반 타입(우상)까지 한글화되고 유니크 조인은 그대로', () => {
  const staticEn = { result: [{ id: 'currency', entries: [{ id: 'chaos', text: 'Chaos Orb' }] }] };
  const staticKr = { result: [{ id: 'currency', entries: [{ id: 'chaos', text: '카오스 오브' }] }] };
  const itemsEn = { result: [{ id: 'currency', entries: [{ type: 'Chaos Orb' }, { type: 'Stoat Idol' }, { type: 'Gold Ring', name: 'Andvarius' }] }] };
  const itemsKr = { result: [{ id: 'currency', entries: [{ type: '카오스 오브' }, { type: '담비 우상' }, { type: '황금 반지', name: '안드바리우스' }] }] };
  const { enToKr } = buildFromRaw(staticEn, staticKr, itemsEn, itemsKr);
  assert.equal(enToKr[normEn('Stoat Idol')], '담비 우상');
  assert.equal(enToKr[normEn('Gold Ring')], '황금 반지');
  assert.equal(enToKr[normEn('Andvarius')], '안드바리우스');
});

// ---------- 서판 variant ----------
const TABLET_CAT = CATEGORIES.find((c) => c.key === 'precursorTablets');
const UNIQUE_CAT = CATEGORIES.find((c) => c.key === 'uniqueArmours');

test('parseStash: variant 를 레코드에 전달', () => {
  const json = { core: { primary: 'divine', rates: { exalted: 100 } }, lines: [{ name: 'Abyss Tablet', baseType: 'Abyss Tablet', variant: 'Magic', primaryValue: 0.5, listingCount: 10 }] };
  const { records } = parseStash(json);
  assert.equal(records[0].variant, 'Magic');
});

test('toRecord: keepVariants 카테고리는 한글명에 등급을 붙이고 영문명은 그대로(거래 검색용)', () => {
  const raw = { en: 'Abyss Tablet', baseType: 'Abyss Tablet', variant: 'Magic', value: { divine: 0.5, exalted: 50, chaos: null } };
  const r = toRecord(raw, TABLET_CAT, { [normEn('Abyss Tablet')]: '심연 서판' });
  assert.equal(r.kr, '심연 서판 (마법)');
  assert.equal(r.en, 'Abyss Tablet');
  assert.equal(r.variant, 'Magic');
});

test('toRecord: 유니크 카테고리는 variant 를 무시(링크/티어 변형은 dedupe 로 합침)', () => {
  const raw = { en: 'Soul Mantle', baseType: 'Sacrificial Mantle', variant: '5L', value: { divine: 1, exalted: 100, chaos: null } };
  const r = toRecord(raw, UNIQUE_CAT, {});
  assert.equal(r.kr, 'Soul Mantle');
  assert.equal(r.variant, '');
});

test('dedupe: 서판은 등급(variant)별로 별개 레코드 유지, 유니크 변형은 여전히 합쳐짐', () => {
  const mk = (variant, cat) => toRecord({ en: 'Abyss Tablet', baseType: 'Abyss Tablet', variant, value: { divine: 1, exalted: 100, chaos: null }, volume: 1 }, cat, {});
  assert.equal(dedupe([mk('Normal', TABLET_CAT), mk('Magic', TABLET_CAT), mk('Rare', TABLET_CAT)]).length, 3);
  assert.equal(dedupe([mk('5L', UNIQUE_CAT), mk('6L', UNIQUE_CAT)]).length, 1);
});

// ---------- 카테고리·엔드포인트 정리 ----------
test('CATEGORIES: 404 인 UniqueMaps 제거, PrecursorTablets 추가', () => {
  assert.ok(!CATEGORIES.some((c) => c.type === 'UniqueMaps'));
  assert.deepEqual({ ...TABLET_CAT }, { key: 'precursorTablets', labelKr: '선구자 서판', endpoint: 'stash', type: 'PrecursorTablets', keepVariants: true });
});

test('ENDPOINTS: 한글 데이터는 카카오게임즈 호스트(daum 은 301 이전됨)', () => {
  assert.ok(ENDPOINTS.gggKr.startsWith('https://poe.kakaogames.com/'));
});

// ---------- 즐겨찾기: 서판 등급별 별개 키 ----------
const os = require('node:os');
const fsx = require('node:fs');
const pathx = require('node:path');
const { Store, catalogFavoriteKey } = require('../src/main/services/store');

test('catalogFavoriteKey: 등급(variant)이 다르면 다른 키, 같으면 같은 키', () => {
  const a = { categoryKey: 'precursorTablets', en: 'Abyss Tablet', baseType: 'Abyss Tablet', variant: 'Normal' };
  const b = { ...a, variant: 'Magic' };
  assert.notEqual(catalogFavoriteKey(a), catalogFavoriteKey(b));
  assert.equal(catalogFavoriteKey(a), catalogFavoriteKey({ ...a, enNorm: normEn(a.en) }));
});

test('addCatalogFavorite: 서판 일반/마법/희귀를 각각 즐겨찾기에 담을 수 있고 재조회는 현재 카탈로그 값을 쓴다', async () => {
  const store = new Store(fsx.mkdtempSync(pathx.join(os.tmpdir(), 'poe-fav-')));
  const mk = (variant, divine) =>
    toRecord({ en: 'Abyss Tablet', baseType: 'Abyss Tablet', variant, value: { divine, exalted: divine * 100, chaos: null }, volume: 1 }, TABLET_CAT, {});
  let list = await store.addCatalogFavorite(mk('Normal', 0.6));
  list = await store.addCatalogFavorite(mk('Magic', 0.5));
  list = await store.addCatalogFavorite(mk('Magic', 0.5)); // 중복은 무시
  assert.equal(list.length, 2);
  assert.deepEqual(list.map((f) => f.rec.variant), ['Normal', 'Magic']);
  assert.equal(list[1].kr, 'Abyss Tablet (마법)');
  // 카탈로그가 갱신되면 즐겨찾기 재조회는 저장 시점 값이 아니라 현재 카탈로그의 같은 등급 값을 사용
  store.catalog = { records: [mk('Normal', 0.9), mk('Magic', 0.7)], ref: null, errors: [] };
  const after = await store.repriceFavorite(list[1].key);
  assert.equal(after.find((f) => f.key === list[1].key).lastPrice.divine, 0.7);
});
