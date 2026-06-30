'use strict';

const { USER_AGENT, HTTP } = require('../config');

/**
 * 공통 HTTP 클라이언트.
 * - Node/Electron 메인 프로세스의 전역 fetch(undici) 사용 → CORS 없음, gzip 자동 해제.
 * - 타임아웃(AbortController), 지수 백오프 재시도, 공통 User-Agent.
 */

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * JSON GET. 실패 시 HTTP.retries 만큼 재시도.
 * @returns {Promise<any>} 파싱된 JSON
 */
/** 응답의 Set-Cookie 원문들을 jar(배열)에 모은다(슬라이딩 세션 갱신용). */
function collectSetCookies(res, jar) {
  if (!Array.isArray(jar)) return;
  try {
    const sc =
      typeof res.headers.getSetCookie === 'function'
        ? res.headers.getSetCookie()
        : res.headers.get('set-cookie')
          ? [res.headers.get('set-cookie')]
          : [];
    for (const c of sc) jar.push(c);
  } catch (e) {
    /* noop */
  }
}

async function getJson(url, { timeoutMs = HTTP.timeoutMs, retries = HTTP.retries, redirect, cookie, userAgent, cookieJar } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        // redirect:'error' = 신뢰 호스트가 예기치 않게 3xx 로 리다이렉트하면 따라가지 않고 실패(SSRF 방어).
        ...(redirect ? { redirect } : {}),
        headers: {
          'User-Agent': userAgent || USER_AGENT,
          Accept: 'application/json',
          'Accept-Language': 'ko,en;q=0.8',
          ...(cookie ? { Cookie: cookie } : {}), // 사용자가 붙여넣은 거래소 로그인 쿠키(은신처 이동용)
        },
      });
      collectSetCookies(res, cookieJar);
      if (!res.ok) {
        // 404 등 클라이언트 오류는 재시도 무의미 → 즉시 던진다.
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        if (res.status >= 400 && res.status < 500) throw err;
        lastErr = err;
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
  }
  throw lastErr || new Error(`요청 실패: ${url}`);
}

/**
 * JSON POST. GGG trade2 검색 등에 사용.
 * 429(레이트리밋)는 Retry-After 헤더만큼 대기 후 재시도한다.
 * @returns {Promise<any>} 파싱된 JSON
 */
async function postJson(url, body, { timeoutMs = HTTP.timeoutMs, retries = HTTP.retries, redirect, cookie, userAgent, cookieJar } = {}) {
  const payload = JSON.stringify(body || {});
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method: 'POST',
        signal: controller.signal,
        ...(redirect ? { redirect } : {}), // 신뢰 호스트의 예기치 않은 리다이렉트 차단(SSRF 방어)
        headers: {
          'User-Agent': userAgent || USER_AGENT,
          Accept: 'application/json',
          'Accept-Language': 'ko,en;q=0.8',
          'Content-Type': 'application/json',
          'X-Requested-With': 'XMLHttpRequest',
          ...(cookie ? { Cookie: cookie } : {}),
        },
        body: payload,
      });
      collectSetCookies(res, cookieJar);
      if (res.status === 429) {
        // 레이트리밋: Retry-After(초) 만큼 대기 후 재시도.
        const ra = Number(res.headers.get('retry-after')) || 5;
        lastErr = new Error(`HTTP 429 for ${url}`);
        lastErr.status = 429;
        if (attempt < retries) {
          await sleep(Math.min(ra, 15) * 1000);
          continue;
        }
        throw lastErr;
      }
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} for ${url}`);
        err.status = res.status;
        // 400/404 등은 재시도 무의미(429 는 위에서 처리) → 즉시 던진다.
        if (res.status >= 400 && res.status < 500) throw err;
        lastErr = err;
      } else {
        return await res.json();
      }
    } catch (e) {
      lastErr = e;
      if (e.status && e.status >= 400 && e.status < 500 && e.status !== 429) throw e;
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(400 * Math.pow(2, attempt));
  }
  throw lastErr || new Error(`요청 실패: ${url}`);
}

/**
 * 동시성 제한 map. 외부 API 부하/레이트리밋 보호.
 */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (cursor < items.length) {
      const idx = cursor++;
      results[idx] = await worker(items[idx], idx);
    }
  });
  await Promise.all(runners);
  return results;
}

module.exports = { getJson, postJson, mapLimit, sleep };
