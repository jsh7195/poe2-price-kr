'use strict';

const { execFile } = require('child_process');

/**
 * Windows 에서 현재 프로세스가 관리자 권한(상승)인지 확인.
 * WindowsPrincipal.IsInRole(Administrator) — 환경에 무관하게 신뢰성 높음.
 * (이전 `net session` 방식은 Server 서비스 상태 등에 따라 오탐이 있었음)
 * @returns {Promise<boolean|null>} win32 외에는 null, 확인 실패 시 null
 */
function isElevated() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(null);
    const ps =
      '[bool]([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent())' +
      '.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)';
    const b64 = Buffer.from(ps, 'utf16le').toString('base64');
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64],
      { windowsHide: true, timeout: 6000 },
      (err, stdout) => {
        if (err) return resolve(null);
        resolve(/true/i.test(String(stdout)));
      }
    );
  });
}

module.exports = { isElevated };
