'use strict';

const { spawn } = require('child_process');

/**
 * 커서가 있는 화면을 캡처해 Windows 내장 OCR(한글)로 텍스트 라인을 인식한다.
 * - 네이티브 모듈/외부 설치 불필요(Windows.Media.Ocr + GDI 캡처).
 * - PowerShell 스크립트를 -EncodedCommand 로 실행(패키지 asar 안에서도 외부 파일 불필요).
 *
 * 배율/타일 전략(해상도 견고성):
 *  - 좁은 화면(폭 < 2400, 일반 1920·2560): 전체 native + 1.5x 보정 — 기존 검증된 동작 유지.
 *  - 넓은 화면(폭 ≥ 2400, 와이드·울트라와이드 3440·3840): 화면이 넓을수록 글자가 OCR 에
 *    불리하게 작아지므로, **겹치는 세로 타일**로 쪼개 각 타일을 native + 보정 배율로 OCR.
 *    (40% 겹침 → 조합 패널 한 행(~600px)이 항상 한 타일 안에 온전히 들어간다)
 *  - 게임 텍스트는 배율마다 다르게 오인식되므로(잘림/룬→문 등) 여러 패스 결과를 합친다.
 *
 * 인식 언어가 없으면 lines 에 '__NO_OCR_LANG__' 가 포함된다.
 * 진단용으로 '__OCR_DIM__ <w>x<h> max=<n>' 한 줄을 항상 출력한다(dim 으로 분리 반환).
 */

// PowerShell 스크립트. 템플릿 리터럴이라 백틱은 \` 로 이스케이프. ${ 는 사용하지 않음.
const PS = `
$OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1' })[0]
function Await($op, $type) { $t = $asTaskGeneric.MakeGenericMethod($type).Invoke($null, @($op)); $t.Wait(-1) | Out-Null; $t.Result }
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime] | Out-Null
[Windows.Media.Ocr.OcrEngine, Windows.Media, ContentType = WindowsRuntime] | Out-Null
$engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
if ($null -eq $engine) { Write-Output '__NO_OCR_LANG__'; exit 0 }
$max = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension
$pos = [System.Windows.Forms.Cursor]::Position
$scr = [System.Windows.Forms.Screen]::FromPoint($pos)
$b = $scr.Bounds
Write-Output ('__OCR_DIM__ ' + $b.Width + 'x' + $b.Height + ' max=' + $max)
$full = New-Object System.Drawing.Bitmap $b.Width, $b.Height
$g = [System.Drawing.Graphics]::FromImage($full)
$g.CopyFromScreen($b.X, $b.Y, 0, 0, $full.Size)
$g.Dispose()
$tmp = [System.IO.Path]::Combine($env:TEMP, 'poe2_ocr_scan.png')
function OcrBitmap($bitmap) {
  $bitmap.Save($tmp, [System.Drawing.Imaging.ImageFormat]::Png)
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($tmp)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sbm = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $stream.Dispose()
  $result = Await ($engine.RecognizeAsync($sbm)) ([Windows.Media.Ocr.OcrResult])
  foreach ($line in $result.Lines) { Write-Output $line.Text }
}
function OcrScaled($src, $scale, $max) {
  if ($scale -le 1.05) { return }
  $sw = [int]($src.Width * $scale)
  $sh = [int]($src.Height * $scale)
  if ($sw -gt $max -or $sh -gt $max) { return }
  $up = New-Object System.Drawing.Bitmap $sw, $sh
  $ug = [System.Drawing.Graphics]::FromImage($up)
  $ug.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $ug.DrawImage($src, 0, 0, $sw, $sh)
  $ug.Dispose()
  OcrBitmap $up
  $up.Dispose()
}
OcrBitmap $full
if ($b.Width -lt 2400) {
  OcrScaled $full ([Math]::Min(1.5, 3000.0 / $b.Width)) $max
} else {
  $tileW = 1800
  $step = [int]($tileW * 0.6)
  for ($x = 0; $x -lt $b.Width; $x += $step) {
    $w = [Math]::Min($tileW, $b.Width - $x)
    if ($w -lt 700) { break }
    $rect = New-Object System.Drawing.Rectangle $x, 0, $w, $b.Height
    $tile = $full.Clone($rect, $full.PixelFormat)
    OcrBitmap $tile
    OcrScaled $tile ([Math]::Min(1.5, 2700.0 / $w)) $max
    $tile.Dispose()
  }
}
$full.Dispose()
`;

/**
 * @returns {Promise<{lines:string[], noLang:boolean, dim:string, err:string}>}
 */
function scanScreen(timeoutMs = 22000) {
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
      const raw = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
      let dim = '';
      let noLang = false;
      const lines = [];
      for (const l of raw) {
        if (l === '__NO_OCR_LANG__') { noLang = true; continue; }
        if (l.startsWith('__OCR_DIM__')) { dim = l.replace('__OCR_DIM__', '').trim(); continue; }
        lines.push(l);
      }
      // 여러 배율/타일 패스의 중복 라인을 합친다.
      resolve({ lines: [...new Set(lines)], noLang, dim, err });
    });
    ps.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

module.exports = { scanScreen };
