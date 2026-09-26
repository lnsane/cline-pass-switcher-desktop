// 生成应用图标（零依赖，纯 Node）：build/icon.png（512）与 build/tray.png（64）
// 图形与渲染层的内联 SVG 品牌标记一致：圆角方块 + 向上的箭头 + 圆点。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'build');

const BLUE_TOP = [0x53, 0x9b, 0xef];
const BLUE_BOTTOM = [0x2c, 0x6d, 0xc9];
const INK = [0x0b, 0x11, 0x16];
const SS = 3; // 每像素 3x3 超采样

// ---------- 距离场 ----------
const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);

function sdSegment(px, py, ax, ay, bx, by) {
  const abx = bx - ax, aby = by - ay;
  const apx = px - ax, apy = py - ay;
  const h = clamp((apx * abx + apy * aby) / (abx * abx + aby * aby || 1), 0, 1);
  const dx = apx - abx * h, dy = apy - aby * h;
  return Math.hypot(dx, dy);
}

function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
}

// 覆盖率：距离 < 0 为内部，边缘 1px 内做线性过渡
const cover = (d) => clamp(0.5 - d, 0, 1);

// ---------- 图形（坐标按 512 画布，viewBox 32 × 16）----------
function sample(x, y, size) {
  const k = size / 512;
  const px = x / k, py = y / k;

  const bg = cover(sdRoundRect(px, py, 256, 256, 256, 256, 128));

  const chevron = Math.min(
    sdSegment(px, py, 144, 344, 256, 160),
    sdSegment(px, py, 256, 160, 368, 344)
  ) - 25.6; // 描边半宽（约 51/2）
  const dot = Math.hypot(px - 256, py - 384) - 38.4;
  const mark = cover(Math.min(chevron, dot));

  const t = clamp(py / 512, 0, 1);
  const rgb = [
    BLUE_TOP[0] + (BLUE_BOTTOM[0] - BLUE_TOP[0]) * t,
    BLUE_TOP[1] + (BLUE_BOTTOM[1] - BLUE_TOP[1]) * t,
    BLUE_TOP[2] + (BLUE_BOTTOM[2] - BLUE_TOP[2]) * t,
  ];

  const a = bg;
  const r = rgb[0] * (1 - mark) + INK[0] * mark;
  const g = rgb[1] * (1 - mark) + INK[1] * mark;
  const b = rgb[2] * (1 - mark) + INK[2] * mark;
  return [r, g, b, a * 255];
}

function render(size, { transparentBg = false } = {}) {
  const rgba = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const [pr, pg, pb, pa] = sample(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, size);
          const w = transparentBg && pa < 8 ? 0 : 1;
          r += pr * w; g += pg * w; b += pb * w; a += pa * w;
        }
      }
      const n = SS * SS;
      const i = (y * size + x) * 4;
      rgba[i] = Math.round(clamp(r / n, 0, 255));
      rgba[i + 1] = Math.round(clamp(g / n, 0, 255));
      rgba[i + 2] = Math.round(clamp(b / n, 0, 255));
      rgba[i + 3] = Math.round(clamp(a / n, 0, 255));
    }
  }
  return rgba;
}

// ---------- 最小 PNG 编码器 ----------
const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

function png(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;    // bit depth
  ihdr[9] = 6;    // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'icon.png'), png(render(512), 512));
console.log('已生成 build/icon.png (512x512)');
