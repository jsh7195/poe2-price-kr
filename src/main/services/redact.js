'use strict';

/**
 * 공개(GitHub 이슈 등)로 내보내기 전에 로그/에러 문자열의 민감정보를 가린다.
 *
 * 주 타깃은 Windows 사용자 폴더에 박히는 사용자명이다.
 * (예: 로그의 exe 경로 `C:\Users\jsh71\AppData\...` → `C:\Users\<user>\AppData\...`)
 * GitHub 이슈는 전세계 공개이므로, 자동 신고 본문에 들어가는 모든 문자열은 이 함수를 거친다.
 */
function redact(input) {
  if (input == null) return '';
  return String(input)
    // Windows: C:\Users\name  또는  \Users\name → 사용자명만 마스킹(이후 경로는 유지)
    .replace(/([A-Za-z]:)?\\Users\\[^\\\r\n]+/gi, '$1\\Users\\<user>')
    // Unix(혹시 모를 크로스플랫폼): /Users/name, /home/name
    .replace(/\/(Users|home)\/[^/\r\n]+/g, '/$1/<user>');
}

module.exports = { redact };
