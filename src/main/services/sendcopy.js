'use strict';

const { execFile } = require('child_process');

/**
 * 현재 포그라운드 창(게임)에 Ctrl+C 를 보낸다.
 * PoE/PoE2 는 아이템에 마우스를 올린 상태에서 Ctrl+C 를 누르면 아이템 텍스트를
 * 클립보드에 복사한다. 네이티브 모듈 없이 PowerShell SendKeys 로 키 입력을 전송.
 *
 * globalShortcut 핸들러에서 호출되며, 이때 게임이 여전히 포그라운드이므로
 * SendKeys 가 게임 창으로 전달된다.
 */
function sendCtrlC() {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('Ctrl+C 전송은 Windows 에서만 지원'));
      return;
    }
    const script =
      "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.SendKeys]::SendWait('^c')";
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-WindowStyle', 'Hidden', '-Command', script],
      { windowsHide: true, timeout: 1500 },
      (err) => (err ? reject(err) : resolve())
    );
  });
}

module.exports = { sendCtrlC };
