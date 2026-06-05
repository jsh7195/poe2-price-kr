'use strict';

// 트레이/창 아이콘(금화) PNG 를 생성한다. 외부 의존성 없이 zlib 로 PNG 인코딩.
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (~c) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([t, data])));
  return Buffer.concat([len, t, data, crc]);
}

function makeIcon(size) {
  const W = size, H = size;
  const raw = Buffer.alloc(H * (1 + W * 4));
  const cx = (W - 1) / 2, cy = (H - 1) / 2, R = W / 2 - 1;
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // filter: none
    for (let x = 0; x < W; x++) {
      const o = y * (1 + W * 4) + 1 + x * 4;
      const d = Math.hypot(x - cx, y - cy);
      if (d <= R) {
        const t = d / R;
        raw[o] = Math.round(232 - 60 * t); // R
        raw[o + 1] = Math.round(201 - 70 * t); // G
        raw[o + 2] = Math.round(94 - 40 * t); // B
        raw[o + 3] = 255;
      } else {
        raw[o] = raw[o + 1] = raw[o + 2] = raw[o + 3] = 0;
      }
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  const idat = zlib.deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const outDir = path.join(__dirname, '..', 'assets');
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'tray.png'), makeIcon(32));
fs.writeFileSync(path.join(outDir, 'icon.png'), makeIcon(256));
console.log('아이콘 생성: assets/tray.png (32), assets/icon.png (256)');
