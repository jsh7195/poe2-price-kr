'use strict';

const { spawn } = require('child_process');

/**
 * 커서가 있는 화면을 캡처해 Windows 내장 OCR(한글)로 텍스트 라인을 인식한다.
 * - 네이티브 모듈/외부 설치 불필요(Windows.Media.Ocr + GDI 캡처).
 * - PowerShell 스크립트를 -EncodedCommand 로 실행(패키지 asar 안에서도 외부 파일 불필요).
 *
 * 인식 언어가 없으면 lines 에 '__NO_OCR_LANG__' 가 포함된다.
 */

// PowerShell 스크립트. 템플릿 리터럴이라 백틱은 \` 로 이스케이프. ${ 는 사용하지 않음.
const PS = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$pos = [System.Windows.Forms.Cursor]::Position
$scr = [System.Windows.Forms.Screen]::FromPoint($pos)
$b = $scr.Bounds
$bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $bmp.Size)
$tmp = [System.IO.Path]::Combine($env:TEMP, 'poe2_ocr_scan.png')
$bmp.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null
$file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
$stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
$decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
$bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output '__NO_OCR_LANG__'; exit 0 }
$result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
foreach ($line in $result.Lines) { Write-Output $line.Text }
`;

/**
 * @returns {Promise<{lines:string[], noLang:boolean, err:string}>}
 */
function scanScreen(timeoutMs = 9000) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'win32') {
      reject(new Error('OCR 스캔은 Windows 전용'));
      return;
    }
    const b64 = Buffer.from(PS, 'utf16le').toString('base64');
    const ps = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', b64], {
      windowsHide: true,
    });
    let out = '';
    let err = '';
    const timer = setTimeout(() => {
      ps.kill();
      reject(new Error('OCR 시간초과'));
    }, timeoutMs);
    ps.stdout.setEncoding('utf8');
    ps.stdout.on('data', (d) => (out += d));
    ps.stderr.setEncoding('utf8');
    ps.stderr.on('data', (d) => (err += d));
    ps.on('close', () => {
      clearTimeout(timer);
      const lines = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      resolve({ lines: lines.filter((l) => l !== '__NO_OCR_LANG__'), noLang: lines.includes('__NO_OCR_LANG__'), err });
    });
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

module.exports = { scanScreen };
