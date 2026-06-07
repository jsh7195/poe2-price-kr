'use strict';

const { redact } = require('./redact');

/**
 * 가격 조회 실패를 메모리 링버퍼에 적재하고, 사용자가 "버그 신고"를 누르면
 * 마스킹된 내용으로 GitHub "새 이슈(프리필)" URL을 만든다.
 *
 * 설계 의도:
 *  - 토큰/시크릿 0 — 공개 앱이라 토큰을 넣을 수 없다. 인증은 사용자 본인 GitHub 로그인에 위임.
 *  - 사람이 버튼을 눌러야만 전송 → 자동 스팸 구조적으로 불가.
 *  - 본문 조립을 앱이 통제하므로 redact()로 사용자명·절대경로를 한 곳에서 제거.
 */

const MAX_ENTRIES = 12; // 최근 실패 N건만 유지(링버퍼)
const MAX_MSG_CHARS = 300; // 개별 메시지 길이 상한
const MAX_BODY_CHARS = 5500; // 본문(원문) 1차 상한
// 최종 URL 안전선: body 는 encodeURIComponent 로 한글이 ~3배 늘어나므로
// "인코딩된 길이" 기준으로 잘라야 GitHub/브라우저 URL 한계에 안 걸린다.
const MAX_BODY_ENCODED = 6000;

const _buffer = [];

/**
 * 실패 1건 적재(민감정보 마스킹 후). 동일 메시지·리그가 직전과 같으면 중복 적재하지 않는다.
 * @param {{ts?:string, message?:string, league?:string}} entry
 * @returns {{ts:string, message:string, league:string}}
 */
function record(entry = {}) {
  const safe = {
    ts: entry.ts || new Date().toISOString(),
    message: redact(entry.message || '').replace(/\s+/g, ' ').trim().slice(0, MAX_MSG_CHARS),
    league: redact(entry.league || ''),
  };
  const last = _buffer[_buffer.length - 1];
  if (last && last.message === safe.message && last.league === safe.league) {
    return last; // 연속 중복(같은 실패가 재시도로 반복) 억제
  }
  _buffer.push(safe);
  while (_buffer.length > MAX_ENTRIES) _buffer.shift();
  return safe;
}

/** 적재된 실패들의 불변 복사본(오래된→최신). */
function dump() {
  return _buffer.map((e) => ({ ...e }));
}

/** 버퍼 비우기(주로 테스트/신고 완료 후). */
function clear() {
  _buffer.length = 0;
}

/**
 * 프리필 이슈 본문(마크다운) 생성.
 * @param {{version?:string, platform?:string, arch?:string, league?:string,
 *          recent?:Array, categoryErrors?:Array}} info
 */
function buildIssueBody(info = {}) {
  const { version, platform, arch, league } = info;
  const recent = Array.isArray(info.recent) ? info.recent : [];
  const categoryErrors = Array.isArray(info.categoryErrors) ? info.categoryErrors : [];

  const lines = [
    '<!-- 자동 생성된 오류 신고입니다. 제출 전 동일한 이슈가 이미 있는지 검색해 주세요. -->',
    '',
    '### 환경',
    `- 앱 버전: ${redact(version) || '-'}`,
    `- OS: ${redact(platform) || '-'}${arch ? ' (' + redact(arch) + ')' : ''}`,
    `- 리그: ${redact(league) || '-'}`,
    '',
    '### 최근 실패 로그',
  ];

  if (!recent.length) {
    lines.push('(기록된 실패 없음)');
  } else {
    for (const e of recent.slice(-MAX_ENTRIES)) {
      const ts = redact(String(e && e.ts != null ? e.ts : '')).slice(0, 40);
      const tag = e && e.league ? ` [${redact(e.league)}]` : '';
      const msg = redact(String(e && e.message != null ? e.message : '')).slice(0, MAX_MSG_CHARS);
      lines.push(`- \`${ts}\`${tag} ${msg}`.trimEnd());
    }
  }

  if (categoryErrors.length) {
    lines.push('', '### 일부 카테고리 로드 실패');
    // 렌더러가 보낸 값이라 타입을 신뢰하지 않는다: String() 강제 + 개별 길이 제한.
    for (const c of categoryErrors.slice(0, MAX_ENTRIES)) {
      const cat = redact(String(c && c.category != null ? c.category : '?')).slice(0, 60) || '?';
      const msg = redact(String(c && c.message != null ? c.message : '')).slice(0, MAX_MSG_CHARS);
      lines.push(`- \`${cat}\`: ${msg}`.trimEnd());
    }
  }

  lines.push('', '### 추가 설명', '<!-- 어떤 상황에서 발생했는지 자유롭게 적어주세요. -->', '');

  let body = lines.join('\n');
  if (body.length > MAX_BODY_CHARS) body = body.slice(0, MAX_BODY_CHARS) + '\n…(생략)';
  return body;
}

/**
 * body 를 인코딩하되, 인코딩 결과가 한계를 넘으면 원문을 비율로 잘라 재인코딩한다.
 * (인코딩된 문자열을 직접 자르면 퍼센트 이스케이프 중간이 잘려 깨지므로 원문을 자른다.)
 */
function encodeBodyCapped(raw) {
  const enc = encodeURIComponent(raw || '');
  if (enc.length <= MAX_BODY_ENCODED) return enc;
  const ratio = MAX_BODY_ENCODED / enc.length;
  const cut = Math.max(0, Math.floor((raw || '').length * ratio) - 16);
  return encodeURIComponent((raw || '').slice(0, cut) + '\n…(생략)');
}

/**
 * 프리필 "새 이슈" URL. owner/repo 는 호출측(패키지 설정)에서 전달.
 * @param {{owner:string, repo:string, title?:string, labels?:string, body?:string}} opts
 */
function buildIssueUrl(opts = {}) {
  const { owner, repo } = opts;
  const base = `https://github.com/${owner}/${repo}/issues/new`;
  const title = (opts.title || '[price-fail] 가격 조회 실패').slice(0, 120);
  const params = ['title=' + encodeURIComponent(title)];
  if (opts.labels) params.push('labels=' + encodeURIComponent(opts.labels));
  params.push('body=' + encodeBodyCapped(opts.body || ''));
  return base + '?' + params.join('&');
}

/** 본문 첫 실패 메시지로 짧은 제목을 만든다. */
function buildTitle(message) {
  const m = redact(message).replace(/\s+/g, ' ').trim().slice(0, 60);
  return '[price-fail] ' + (m || '가격 조회 실패');
}

module.exports = {
  record,
  dump,
  clear,
  buildIssueBody,
  buildIssueUrl,
  buildTitle,
  MAX_ENTRIES,
  MAX_BODY_CHARS,
};
