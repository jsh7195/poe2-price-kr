'use strict';
// OCR 덤프(.research/ocrscale.txt)의 여러 배율 라인을 합쳐 scanRecipe 매칭률을 검증.
const fs = require('fs');
const os = require('os');
const { Store } = require('../src/main/services/store');
const { fetchLeagues } = require('../src/main/services/leagues');
const { buildDictionary } = require('../src/main/services/dictionary');
const { buildCatalog } = require('../src/main/services/catalog');

function linesForScales(txt, scales) {
  const out = [];
  const parts = txt.split(/=== SCALE ([0-9.]+) \([0-9x]+\) ===/);
  // parts: [pre, scaleNum, block, scaleNum, block, ...]
  for (let i = 1; i < parts.length; i += 2) {
    const s = parts[i];
    if (scales.includes(s)) out.push(...parts[i + 1].split('\n').map((l) => l.trim()).filter(Boolean));
  }
  return out;
}

(async () => {
  const txt = fs.readFileSync('./.research/ocrscale.txt', 'utf8');
  const { current } = await fetchLeagues();
  const dict = await buildDictionary();
  const cat = await buildCatalog(current.name, dict);
  const store = new Store(os.tmpdir());
  store.catalog = cat;

  for (const combo of [['1'], ['1.5'], ['1', '1.5'], ['1', '1.5', '0.5']]) {
    const lines = linesForScales(txt, combo);
    const res = store.scanRecipe(lines);
    console.log(`배율 [${combo.join(', ')}] → ${res.items.length}개 매칭`);
    for (const it of res.items) console.log(`   ${it.qty}x ${it.record.kr} [${it.record.en}]`);
  }
})().catch((e) => { console.error(e.stack || e); process.exit(1); });
