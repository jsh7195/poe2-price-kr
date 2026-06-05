'use strict';

const { execFile } = require('child_process');

/**
 * Windows 에서 현재 프로세스가 관리자 권한(상승)인지 확인.
 * `net session` 은 관리자일 때만 성공(exit 0)한다.
 * @returns {Promise<boolean|null>} win32 외에는 null
 */
function isElevated() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    execFile('net', ['session'], { windowsHide: true, timeout: 4000 }, (err) => resolve(!err));
  });
}

module.exports = { isElevated };
