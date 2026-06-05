'use strict';

// 실제 OCR 출력(노이즈 포함)으로 scanRecipe 전체 파이프라인을 검증.
const os = require('os');
const { Store } = require('../src/main/services/store');
const { fetchLeagues } = require('../src/main/services/leagues');
const { buildDictionary } = require('../src/main/services/dictionary');
const { buildCatalog } = require('../src/main/services/catalog');

(async () => {
  const { current } = await fetchLeagues();
  const dict = await buildDictionary();
  const cat = await buildCatalog(current.name, dict);
  const store = new Store(os.tmpdir());
  store.catalog = cat;

  // Windows OCR 이 실제로 뱉은 라인(헤더/수량 노이즈 포함)
  const ocrLines = ['살변囷', '루형티| 조합', '6x 대장장이의 숫돌', '1)(보호의 합금', 'lx 카오스 오브 니'];
  const res = store.scanRecipe(ocrLines);

  console.log(`인식·매칭된 아이템: ${res.items.length}건 (비싼 순)`);
  for (const it of res.items) {
    const r = it.record;
    const unit = r.valueExalted != null ? r.valueExalted.toFixed(2) : '–';
    const total = r.valueExalted != null ? (it.qty * r.valueExalted).toFixed(2) : '–';
    console.log(`  ${it.qty}x ${r.kr} [${r.en}]  단가=${unit}ex  합계=${total}ex  (${r.labelKr})`);
  }
})().catch((e) => {
  console.error('실패:', e.stack || e);
  process.exit(1);
});
