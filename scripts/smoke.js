'use strict';

/**
 * 라이브 end-to-end 스모크: 실제 API(poe.ninja + GGG)로 전체 파이프라인을 검증한다.
 * Electron 없이 순수 Node 로 실행 → `npm run smoke`.
 */

const { fetchLeagues } = require('../src/main/services/leagues');
const { buildDictionary } = require('../src/main/services/dictionary');
const { buildCatalog } = require('../src/main/services/catalog');
const { search } = require('../src/main/services/search');

(async () => {
  const t0 = Date.now();

  console.log('1) 리그 목록…');
  const { leagues, current } = await fetchLeagues();
  console.log(`   현재 리그: ${current && current.name}  |  전체 ${leagues.length}개`);
  if (!current) throw new Error('현재 리그를 찾지 못함');

  console.log('2) 한글 사전(GGG)…');
  const dict = await buildDictionary();
  console.log(`   enToKr 항목: ${dict.size}`);
  if (dict.size < 500) throw new Error('사전 크기가 비정상적으로 작음');

  console.log(`3) 카탈로그(${current.name})…`);
  const cat = await buildCatalog(current.name, dict);
  console.log(`   레코드: ${cat.records.length}  |  실패 카테고리: ${cat.errors.length}` +
    (cat.errors.length ? ' (' + cat.errors.map((e) => e.category).join(', ') + ')' : ''));
  console.log(`   기준통화 divine아이콘: ${!!(cat.ref && cat.ref.divine && cat.ref.divine.icon)}  |  exalted환율: ${cat.ref && cat.ref.rates && cat.ref.rates.exalted}`);

  const translated = cat.records.filter((r) => r.kr !== r.en).length;
  console.log(`   한글 커버리지: ${translated}/${cat.records.length} (${(100 * translated / cat.records.length).toFixed(1)}%)`);

  console.log('\n4) 한글 검색 샘플:');
  const queries = ['신성한 오브', '영혼 핵', '헤드헌터', '마법사의 피', '에센스', '징조', '기폭제', '액체 감정', '영혼의 외투'];
  for (const q of queries) {
    const r = search(cat.records, q, 3);
    console.log(`\n   "${q}" → ${r.length}건`);
    for (const x of r) {
      const ex = x.valueExalted != null ? x.valueExalted.toFixed(1) : '–';
      const dv = x.valueDivine != null ? x.valueDivine.toFixed(3) : '–';
      console.log(`     · ${x.kr}  [${x.en}]  div=${dv} ex=${ex}  (${x.labelKr})`);
    }
  }

  console.log(`\n✅ 스모크 통과 (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  process.exit(0);
})().catch((e) => {
  console.error('\n❌ 스모크 실패:', e && e.stack ? e.stack : e);
  process.exit(1);
});
