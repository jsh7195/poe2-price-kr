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

// Windows "이 프로그램을 관리자 권한으로 실행" 호환성 플래그가 저장되는 키(사용자 단위, 비상승).
const APPCOMPAT_KEY = 'HKCU\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Layers';

/**
 * 이 exe 가 "항상 관리자 권한으로 실행"으로 설정돼 있는지.
 * 설정돼 있으면 Windows 가 매 실행마다(업데이트 후 재실행 포함) 자동으로 UAC 상승한다.
 * @param {string} exePath
 * @returns {Promise<boolean>}
 */
function isRunAsAdminSet(exePath) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !exePath) return resolve(false);
    execFile('reg', ['query', APPCOMPAT_KEY, '/v', exePath], { windowsHide: true, timeout: 6000 }, (err, stdout) => {
      if (err) return resolve(false); // 값 없음 = 미설정
      resolve(/RUNASADMIN/i.test(String(stdout)));
    });
  });
}

/**
 * "항상 관리자 권한으로 실행" 플래그를 설정/해제(HKCU — 상승 불필요).
 * @param {string} exePath
 * @param {boolean} on
 * @returns {Promise<boolean>} 성공 여부
 */
function setRunAsAdmin(exePath, on) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !exePath) return resolve(false);
    const args = on
      ? ['add', APPCOMPAT_KEY, '/v', exePath, '/t', 'REG_SZ', '/d', '~ RUNASADMIN', '/f']
      : ['delete', APPCOMPAT_KEY, '/v', exePath, '/f'];
    execFile('reg', args, { windowsHide: true, timeout: 6000 }, (err) => {
      // 해제 시 값이 원래 없으면 reg 가 오류를 내지만 결과적으로 미설정이므로 성공으로 간주.
      resolve(on ? !err : true);
    });
  });
}

module.exports = { isElevated, isRunAsAdminSet, setRunAsAdmin };
