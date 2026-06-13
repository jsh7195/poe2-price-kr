'use strict';

/**
 * PoE2 가 Ctrl+C 로 복사하는 "아이템 전체 텍스트"를 구조화한다.
 * (이름만 뽑는 itemtext.extractItemName 보다 풍부 — 옵션 기반 거래 검색용)
 *
 * 실측 형식(한글, 고급 설명 ON — 각 모드 위에 `{ ... }` 접사 주석):
 *   아이템 종류: 허리띠
 *   아이템 희귀도: 희귀
 *   고통 혁대               <- 레어 이름(레어/유니크는 이름+기반 2줄)
 *   넓은 허리띠             <- 기반 타입
 *   --------
 *   요구 사항: 레벨 56
 *   --------
 *   아이템 레벨: 81
 *   --------
 *   { 고정 속성 부여 }                       <- implicit
 *   플라스크 충전량 23(20-30)% 증가
 *   { 접두어 속성 부여 "경감하는" (등급: 2) — 방어도 }   <- prefix(explicit), 티어2
 *   방어도 +272(268-311)
 *   { 접미어 속성 부여 ... }                  <- suffix(explicit)
 *   번개 저항 +34(31-35)%
 *
 * 고급 설명 OFF(주석 `{ }` 없음)도 최대한 처리: 마지막 모드 블록을 explicit 로 본다.
 */

const DIVIDER = /^[-—–]{2,}$/;

// 헤더 키(한/영). 값 라인이거나 메타라인 식별.
const RE_CLASS = /^(아이템 종류|item class)\s*[:：]\s*(.+)$/i;
const RE_RARITY = /^(아이템 희귀도|희귀도|rarity)\s*[:：]\s*(.+)$/i;
const RE_ILVL = /^(아이템 레벨|item level)\s*[:：]\s*(\d+)/i;
// PoE2 KR 은 "품질" 이 아니라 "퀄리티" 로 표기 → 둘 다 인식(이 줄은 모드가 아님).
const RE_QUALITY = /^(퀄리티|품질|quality)\s*[:：]\s*\+?(\d+)/i;
const RE_REQ = /^(요구 사항|requirements|요구사항)\s*[:：]/i;
// "키: 값" 형식의 속성/메타 라인(모드 아님). 콜론 뒤 값이 오는 줄을 광범위하게 배제.
// (콜론 필수 → "방어도, 회피 18% 증가" 같은 실제 모드는 콜론이 없어 걸리지 않는다)
const RE_META = /^(소켓|sockets|홈|아이템 레벨|item level|퀄리티|품질|quality|요구 사항|requirements|요구사항|무기 종류|무기 등급|물리 피해|화염 피해|냉기 피해|번개 피해|카오스 피해|원소 피해|치명타|초당 공격|공격 속도|방어도|회피|회피 등급|에너지 보호막|넓은 막기 확률|이동 속도|스택)\s*[:：]/i;

// 모드 줄 끝의 접사 표기 "(rune)"/"(augmented)" 등 → 접사 판별 + 본문에서 제거.
// (이 표기가 붙으면 사전 텍스트와 안 맞아 매칭 실패하므로 반드시 떼야 한다)
const TRAIL_AFFIX = /\s*\((rune|룬|augmented|증강|enchant|인챈트|crafted|제작|implicit|고정)\)\s*$/i;
function stripTrailingAffix(line) {
  const m = line.match(TRAIL_AFFIX);
  if (!m) return { line, affix: null };
  const w = m[1].toLowerCase();
  let affix = null;
  if (/rune|룬/.test(w)) affix = 'rune';
  else if (/enchant|인챈트/.test(w)) affix = 'enchant';
  else if (/crafted|제작/.test(w)) affix = 'crafted';
  else if (/implicit|고정/.test(w)) affix = 'implicit';
  // augmented/증강 = 품질·방어 속성 표기(모드 아님) → affix 없이 본문만 정리.
  return { line: line.replace(TRAIL_AFFIX, '').trim(), affix };
}
const RE_CORRUPT = /^(타락됨|타락|corrupted)$/i;

// 희귀도 정규화
const RARITY_MAP = {
  일반: 'normal', 마법: 'magic', 희귀: 'rare', 고유: 'unique',
  통화: 'currency', 화폐: 'currency',
  normal: 'normal', magic: 'magic', rare: 'rare', unique: 'unique', currency: 'currency',
};

// `{ ... }` 접사 주석 → 우리 접사 타입(거래 검색 stat id prefix 와 매핑)
function affixFromAnnotation(s) {
  if (/고정 속성|implicit/i.test(s)) return 'implicit';
  if (/접두어|prefix/i.test(s)) return 'prefix';
  if (/접미어|suffix/i.test(s)) return 'suffix';
  if (/룬 속성|rune/i.test(s)) return 'rune';
  if (/제작|crafted/i.test(s)) return 'crafted';
  if (/인챈트|enchant/i.test(s)) return 'enchant';
  return 'explicit';
}

/** 접사 → 거래 stat id 그룹 prefix. prefix/suffix 는 모두 explicit. */
function affixToStatType(affix) {
  if (affix === 'implicit') return 'implicit';
  if (affix === 'rune') return 'rune';
  if (affix === 'crafted') return 'explicit'; // 제작 모드도 explicit id 로 검색되는 경우가 많음
  if (affix === 'enchant') return 'enchant';
  return 'explicit'; // prefix/suffix/explicit
}

// 값 범위 "(20-30)" / "(268-311)" 제거 → 현재값만 남긴다.
const RANGE = /\((\d+(?:\.\d+)?)\s*[-~]\s*(\d+(?:\.\d+)?)\)/g;

/** 모드 라인에서 범위 표기를 제거한 "정규 텍스트"와 현재 수치 목록을 분리. */
function cleanModLine(raw) {
  const clean = raw.replace(RANGE, '').replace(/\s{2,}/g, ' ').trim();
  const values = (clean.match(/[+\-]?\d+(?:\.\d+)?/g) || []).map(Number);
  return { clean, values };
}

function parseAnnotation(s) {
  const inner = s.replace(/^\{\s*/, '').replace(/\s*\}$/, '');
  const affix = affixFromAnnotation(inner);
  const tierM = inner.match(/등급\s*[:：]\s*(\d+)|\btier\s*[:：]?\s*(\d+)/i);
  const nameM = inner.match(/"([^"]+)"/);
  return {
    affix,
    statType: affixToStatType(affix),
    tier: tierM ? Number(tierM[1] || tierM[2]) : null,
    affixName: nameM ? nameM[1].trim() : null,
  };
}

/**
 * @param {string} clipText 클립보드 전체 텍스트
 * @returns {null | {
 *   category:string, rarity:string, name:string, base:string,
 *   itemLevel:number|null, quality:number, corrupted:boolean,
 *   mods: Array<{affix:string, statType:string, tier:number|null, affixName:string|null,
 *                raw:string, clean:string, values:number[]}>
 * }}
 */
function parseItem(clipText) {
  if (!clipText || typeof clipText !== 'string') return null;
  const lines = clipText.split(/\r?\n/).map((l) => l.trim());

  let rarity = null;
  let category = '';
  let itemLevel = null;
  let quality = 0;
  let corrupted = false;
  let rarityIdx = -1;

  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    let m;
    if ((m = l.match(RE_RARITY)) && rarity == null) {
      rarity = RARITY_MAP[m[2].trim()] || m[2].trim();
      rarityIdx = i;
    } else if ((m = l.match(RE_CLASS))) {
      category = m[2].trim();
    } else if ((m = l.match(RE_ILVL))) {
      itemLevel = Number(m[2]);
    } else if ((m = l.match(RE_QUALITY))) {
      quality = Number(m[2]);
    } else if (RE_CORRUPT.test(l)) {
      corrupted = true;
    }
  }
  if (rarity == null) return null;

  // 이름/기반: 희귀도 라인 다음 ~ 첫 구분선 전까지의 비메타 라인.
  const nameLines = [];
  for (let i = rarityIdx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (DIVIDER.test(l)) break;
    if (!l || RE_META.test(l) || l.startsWith('{')) continue;
    nameLines.push(l);
  }
  const name = nameLines[0] || '';
  const base = nameLines.length > 1 ? nameLines[nameLines.length - 1] : '';

  // 모드: `{ ... }` 주석 + 다음 모드 라인. 주석 없는 라인도 모드 후보(고급설명 OFF).
  const mods = [];
  let pending = null; // 직전 `{ }` 주석
  // 모드 영역은 ilvl/요구 이후가 보통이지만, 안전하게 전 구간에서 주석-모드 쌍을 수집.
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || DIVIDER.test(l)) {
      pending = null;
      continue;
    }
    if (l.startsWith('{')) {
      pending = parseAnnotation(l);
      continue;
    }
    // 헤더/메타/이름 라인은 모드가 아님
    if (RE_CLASS.test(l) || RE_RARITY.test(l) || RE_META.test(l) || RE_REQ.test(l)) {
      pending = null;
      continue;
    }
    if (i <= rarityIdx) continue;
    if (nameLines.includes(l) && !pending) continue; // 이름/기반 라인
    // 숫자(수치 모드)이거나 주석이 선행된 라인만 모드로 채택 → 무작위 텍스트 배제
    const hasNum = /\d/.test(l);
    if (!pending && !hasNum) continue;
    // 끝의 "(rune)" 등 접사 표기 제거(+무주석 룬/인챈트 모드의 접사 판별)
    const stripped = stripTrailingAffix(l);
    const affix = pending ? pending.affix : stripped.affix || 'explicit';
    const statType = pending ? pending.statType : affixToStatType(affix);
    const { clean, values } = cleanModLine(stripped.line);
    mods.push({
      affix,
      statType,
      tier: pending ? pending.tier : null,
      affixName: pending ? pending.affixName : null,
      raw: l,
      clean,
      values,
    });
    pending = null;
  }

  return { category, rarity, name, base, itemLevel, quality, corrupted, mods };
}

module.exports = { parseItem, cleanModLine, affixFromAnnotation, affixToStatType };
