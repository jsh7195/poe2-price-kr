'use strict';

/**
 * PoE/PoE2 가 Ctrl+C 로 클립보드에 복사하는 아이템 텍스트에서 검색용 이름을 추출한다.
 * 한국/영문 클라이언트 모두 지원 (희귀도 라인: "Rarity:" 또는 "희귀도:").
 *
 * 형식 예 (한글, 화폐):
 *   아이템 종류: 중첩 가능한 화폐
 *   희귀도: 화폐
 *   신성한 오브            <- 이름(추출 대상)
 *   --------
 *
 * 유니크:
 *   희귀도: 고유
 *   마법사의 피            <- 유니크 이름(추출 대상)
 *   무거운 허리띠          <- 기반 타입
 *   --------
 */

const DIVIDER = /^[-—–]+$/;
const RARITY = /^(rarity|희귀도|稀有度|Seltenheit|Rareté|Rareza|Раритет|Rarità|등급)\s*[:：]/i;
const ITEM_MARKER = /^(item class|아이템 종류|rarity|희귀도)\s*[:：]/im;

/** 텍스트가 PoE 아이템 클립보드 형식처럼 보이는지(헤더 마커 존재). 수동 Ctrl+C 폴백 판별용. */
function looksLikeItem(text) {
  return typeof text === 'string' && ITEM_MARKER.test(text);
}

/**
 * @param {string} clipText 클립보드 전체 텍스트
 * @returns {string} 검색에 사용할 이름(없으면 빈 문자열)
 */
function extractItemName(clipText) {
  if (!clipText || typeof clipText !== 'string') return '';
  const lines = clipText.split(/\r?\n/).map((l) => l.trim());

  const rarityIdx = lines.findIndex((l) => RARITY.test(l));
  if (rarityIdx >= 0) {
    for (let i = rarityIdx + 1; i < lines.length; i++) {
      const l = lines[i];
      if (l && !DIVIDER.test(l)) return l;
    }
  }

  // 폴백: 구분선/키:값 라인이 아닌 첫 비어있지 않은 라인
  const fallback = lines.find((l) => l && !DIVIDER.test(l) && !/[:：]/.test(l));
  return fallback || '';
}

/**
 * OCR 로 읽은 화면 라인들에서 "수량 + 아이템 이름"을 뽑는다.
 * 예) "6x 대장장이의 숫돌" → {qty:6, name:"대장장이의 숫돌"}
 *     "1)(보호의 합금"     → {qty:1, name:"보호의 합금"}   (OCR 노이즈 허용)
 *     "lx 카오스 오브 니"  → {qty:1, name:"카오스 오브 니"} (뒤 노이즈는 검색이 흡수)
 * 한글/영문 글자가 2자 미만인 라인은 버린다.
 */
function parseRecipeLines(lines) {
  const out = [];
  for (const raw of lines || []) {
    let line = String(raw || '').trim();
    if (!line) continue;
    // 선두 수량: 숫자(또는 OCR 혼동 l/I/|/i→1) + 구분자(x/×/)/(/. 등). 구분자 필수.
    let qty = 1;
    let explicit = false; // 줄 앞에 "Nx" 수량이 실제로 있었는지(조합 목록 식별용)
    const m = line.match(/^\s*([0-9lI|i]{1,3})\s*[x×X*).\(\]\[|·]+\s*/);
    if (m) {
      const n = parseInt(m[1].replace(/[lI|i]/g, '1'), 10);
      if (!isNaN(n) && n > 0 && n < 1000) {
        qty = n;
        explicit = true;
        line = line.slice(m[0].length);
      }
    }
    // 선두 비(非)한글/영숫자 노이즈 제거
    line = line.replace(/^[^0-9A-Za-z가-힣]+/, '').trim();
    // 이름에 한글/영문 글자가 최소 2자 이상 있어야 함
    const letters = (line.match(/[A-Za-z가-힣]/g) || []).length;
    if (letters < 2) continue;
    out.push({ qty, name: line, explicit });
  }
  return out;
}

module.exports = { extractItemName, looksLikeItem, parseRecipeLines };
