'use strict';

/**
 * 개발용 스크린샷 하네스 (POE_SHOT 환경변수가 설정됐을 때만 main.js 에서 호출).
 * 데이터 준비 → 빈 화면 / 검색 결과 화면을 PNG 로 저장하고 앱을 종료한다.
 * 프로덕션 동작에는 영향이 없다.
 */

const fs = require('fs/promises');
const path = require('path');

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

function waitReady(store, timeoutMs = 45000) {
  return new Promise((resolve) => {
    if (store.phase === 'ready' || store.phase === 'error') return resolve();
    const onStatus = (s) => {
      if (s.phase === 'ready' || s.phase === 'error') {
        store.off('status', onStatus);
        resolve();
      }
    };
    store.on('status', onStatus);
    setTimeout(() => {
      store.off('status', onStatus);
      resolve();
    }, timeoutMs);
  });
}

async function runScreenshots(app, win, store, overlay, outDir) {
  try {
    await fs.mkdir(outDir, { recursive: true });
    const saveOf = (target) => async (name) => {
      const img = await target.webContents.capturePage();
      await fs.writeFile(path.join(outDir, name), img.toPNG());
      console.log('[shot] saved', name);
    };
    const save = saveOf(win);

    win.webContents.on('console-message', (_e, level, message) => {
      if (level >= 2) console.log('[renderer]', message);
    });
    await win.webContents.executeJavaScript(
      `window.__errs=[];addEventListener('error',e=>window.__errs.push(e.message+' @ '+(e.filename||'')+':'+e.lineno));addEventListener('unhandledrejection',e=>window.__errs.push('rej: '+((e.reason&&e.reason.stack)||e.reason)));true`
    );

    await waitReady(store);
    await delay(900);
    await save('shot_empty.png');

    const queries = ['영혼 핵', '헤드헌터', '없는아이템검색테스트'];
    for (let i = 0; i < queries.length; i++) {
      await win.webContents.executeJavaScript(
        `(() => { const s = document.getElementById('search'); s.value = ${JSON.stringify(
          queries[i]
        )}; s.dispatchEvent(new Event('input', { bubbles: true })); })()`
      );
      await delay(800);
      await save(`shot_search_${i}.png`);
    }

    // 거래 URL 즐겨찾기 — 메인 창에 표시(스토어 오염 없이 IPC 로 가짜 목록 주입)
    await win.webContents.executeJavaScript(
      `(() => { const s = document.getElementById('search'); s.value=''; s.dispatchEvent(new Event('input',{bubbles:true})); })()`
    );
    win.webContents.send('app:favorites', [
      {
        key: 'url:poe.kakaogames.com|8rVmKDRnFV', kind: 'url', kr: 'Runes of Aldur', labelKr: '거래 URL',
        id: '8rVmKDRnFV', base: '8rVmKDRnFV',
        url: 'https://poe.kakaogames.com/trade2/search/poe2/Runes%20of%20Aldur/8rVmKDRnFV',
        lastPrice: { divine: 2700, exalted: null, altAmount: null, altCurrency: null, listingCount: 1 },
      },
    ]);
    await delay(500);
    await save('shot_url_favorite.png');
    const errs = await win.webContents.executeJavaScript('JSON.stringify(window.__errs||[])');
    console.log('[renderer-errors]', errs);

    // 단축키 설정 모달
    await win.webContents.executeJavaScript(
      `document.getElementById('open-settings').click()`
    );
    await delay(700);
    await save('shot_settings.png');
    await win.webContents.executeJavaScript(
      `document.getElementById('settings-cancel').click()`
    );

    // 오버레이(가격 툴팁) 캡처 — 실제 priceCheck 경로를 통해 페이로드 생성
    if (overlay) {
      const saveOverlay = saveOf(overlay.win);
      const point = { x: 600, y: 360 };
      const cases = [
        ['shot_overlay_unique.png', '아이템 종류: 장갑\n희귀도: 고유\n마법사의 피\n무거운 허리띠\n--------\n'],
        ['shot_overlay_currency.png', '아이템 종류: 중첩 가능한 화폐\n희귀도: 화폐\n신성한 오브\n--------\n'],
        ['shot_overlay_soulcore.png', '희귀도: 화폐\n퀴폴라틀의 영혼 핵\n--------\n'],
      ];
      for (const [name, clip] of cases) {
        overlay.show(point, store.priceCheck(clip));
        await delay(600);
        await saveOverlay(name);
      }
      overlay.show(point, { found: false });
      await delay(500);
      await saveOverlay('shot_overlay_noitem.png');

      // 다중(스캔) 오버레이 — 실제 OCR 출력 샘플로 (조합 목록)
      const scan = await store.scanRecipe(['루형티| 조합', '6x 대장장이의 숫돌', '1)(보호의 합금', 'lx 카오스 오브 니']);
      overlay.show(point, scan);
      await delay(700);
      await saveOverlay('shot_overlay_scan.png');

      // F10 화폐 거래소: 카탈로그의 화폐류(commodity) 이름들을 수량 없이 한꺼번에(다중 열 격자).
      const commodityCats = new Set(['currency', 'fragments', 'runes', 'essences', 'soulCores', 'omens']);
      const names = ((store.catalog && store.catalog.records) || [])
        .filter((r) => commodityCats.has(r.categoryKey) && (r.valueExalted != null || r.valueDivine != null))
        .slice(0, 48)
        .map((r) => r.kr);
      const currencyScan = await store.scanRecipe(names);
      console.log('[shot] 화폐 거래소 스캔 인식:', currencyScan.items.length, '종');
      overlay.show({ x: 360, y: 220 }, currencyScan);
      await delay(800);
      await saveOverlay('shot_overlay_currency_board.png');
    }

    console.log('[shot] done');
  } catch (e) {
    console.error('[shot] error', e);
  } finally {
    app.quit();
  }
}

module.exports = { runScreenshots };
