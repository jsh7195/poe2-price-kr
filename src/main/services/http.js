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
async function getJson(url, { timeoutMs = HTTP.timeoutMs, retries = HTTP.retries } = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        signal: controller.signal,
        headers: {
          'User-Agent': USER_AGENT,
          Accept: 'application/json',
          'Accept-Language': 'ko,en;q=0.8',
        },
      });
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

module.exports = { getJson, mapLimit, sleep };
