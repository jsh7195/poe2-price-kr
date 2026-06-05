'use strict';

// 임의의 한글/영문 이름들이 카탈로그에서 잡히는지 라이브로 확인.
// 사용: node scripts/lookup.js "카오스 오브" "대장장이의 숫돌" ...
const { fetchLeagues } = require('../src/main/services/leagues');
const { buildDictionary } = require('../src/main/services/dictionary');
const { buildCatalog } = require('../src/main/services/catalog');
const { search } = require('../src/main/services/search');

(async () => {
  const queries = process.argv.slice(2);
  if (!queries.length) {
    console.log('인자로 검색어를 주세요.');
    process.exit(1);
  }
  const { current } = await fetchLeagues();
  const dict = await buildDictionary();
  const cat = await buildCatalog(current.name, dict);
  console.log(`리그=${current.name} 레코드=${cat.records.length}\n`);
  for (const q of queries) {
    const r = search(cat.records, q, 3);
    console.log(`"${q}" → ${r.length}건`);
    for (const x of r) {
      console.log(`   · ${x.kr} [${x.en}] div=${x.valueDivine} ex=${x.valueExalted} (${x.labelKr})`);
    }
    if (!r.length) console.log('   (없음)');
  }
})().catch((e) => {
  console.error('실패:', e.message);
  process.exit(1);
});
