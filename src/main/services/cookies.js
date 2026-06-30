'use strict';

/**
 * 쿠키 헤더 문자열에 응답 Set-Cookie 갱신을 병합한다(슬라이딩 세션 자동 연장).
 * 거래 API 는 매 응답에 `Set-Cookie: POESESSID=...` 를 주므로, 성공한 요청의 Set-Cookie 로
 * 저장된 쿠키의 해당 항목을 갱신하면 세션이 만료되지 않고 계속 살아있다.
 *
 * @param {string} cookieHeader  현재 저장된 쿠키 헤더("a=1; b=2")
 * @param {string[]} setCookies  응답 Set-Cookie 원문 배열(["POESESSID=xyz; path=/; ...", ...])
 * @returns {string} 갱신 병합된 쿠키 헤더
 */
function mergeSetCookies(cookieHeader, setCookies) {
  const map = new Map();
  for (const pair of String(cookieHeader || '').split(';')) {
    const i = pair.indexOf('=');
    if (i > 0) {
      const name = pair.slice(0, i).trim();
      if (name) map.set(name, pair.slice(i + 1).trim());
    }
  }
  for (const sc of Array.isArray(setCookies) ? setCookies : []) {
    const first = String(sc || '').split(';')[0]; // "name=value" (속성 제외)
    const i = first.indexOf('=');
    if (i > 0) {
      const name = first.slice(0, i).trim();
      const value = first.slice(i + 1).trim();
      if (name && value) map.set(name, value); // 갱신 또는 추가
    }
  }
  return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
}

module.exports = { mergeSetCookies };
