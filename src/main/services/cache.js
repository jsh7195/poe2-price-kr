'use strict';

const fs = require('fs/promises');
const path = require('path');

/**
 * 디스크 캐시 (JSON 파일, TTL 기반).
 * cacheDir 는 호출측에서 주입(Electron: app.getPath('userData'), 테스트: 임시폴더).
 * 보안 주의: cacheDir 는 반드시 신뢰된 출처(app.getPath 등)여야 하며 사용자 입력이면 안 된다.
 * 키는 _file()에서 영숫자 외 문자를 치환해 파일명 경로 이탈을 막는다.
 */
class DiskCache {
  constructor(cacheDir) {
    this.dir = cacheDir;
  }

  _file(key) {
    const safe = key.replace(/[^a-z0-9_-]/gi, '_');
    return path.join(this.dir, `cache_${safe}.json`);
  }

  /** 신선한 캐시면 data 반환, 없거나 만료면 null. */
  async get(key, ttlMs) {
    try {
      const raw = await fs.readFile(this._file(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.t !== 'number') return null;
      if (Date.now() - parsed.t > ttlMs) return null;
      return parsed.data;
    } catch {
      return null;
    }
  }

  /** 캐시 메타(저장시각)까지 반환. 만료여도 stale 데이터를 폴백으로 쓰고 싶을 때. */
  async getEntry(key) {
    try {
      const raw = await fs.readFile(this._file(key), 'utf8');
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.t !== 'number') return null;
      return { data: parsed.data, savedAt: parsed.t };
    } catch {
      return null;
    }
  }

  async set(key, data) {
    await fs.mkdir(this.dir, { recursive: true });
    const payload = JSON.stringify({ t: Date.now(), data });
    await fs.writeFile(this._file(key), payload, 'utf8');
  }
}

module.exports = { DiskCache };
