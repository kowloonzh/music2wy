// qr.mjs — QR 码渲染（终端半块字符 + PNG 落盘），零外部依赖（除 vendored qrcode-generator）。
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import qrcode from '../vendor/qrcode.mjs';
import { stringToBytes as utf8Bytes } from '../vendor/qrcode_utf8.mjs';

// 让 qrcode-generator 使用 UTF-8 字节编码（默认按 charCode 截断，非 ASCII 会坏）
qrcode.stringToBytes = utf8Bytes;

/**
 * 生成 QR 模块矩阵。
 * @returns {{count:number, isDark:(r:number,c:number)=>boolean}}
 */
export function makeQr(text, { ecl = 'M' } = {}) {
  // typeNumber 0 = 自动选择版本
  const qr = qrcode(0, ecl);
  qr.addData(text);
  qr.make();
  return qr;
}

/**
 * 终端渲染：用 "▀" 半块字符，一个字符表示上下两个模块，并强制黑/白前景背景，
 * 这样无论终端是深色还是浅色主题都能扫得动。
 */
export function renderTerminal(text, { quiet = 2, ecl = 'M' } = {}) {
  const qr = makeQr(text, { ecl });
  const n = qr.getModuleCount();
  const size = n + quiet * 2;
  const dark = (r, c) => {
    const rr = r - quiet, cc = c - quiet;
    if (rr < 0 || cc < 0 || rr >= n || cc >= n) return false; // 静默区=浅色
    return qr.isDark(rr, cc);
  };
  // ANSI: 前景(字)色 = 上半块颜色, 背景色 = 下半块颜色。30=黑字 37=白字 40=黑底 47=白底
  const RESET = '\x1b[0m';
  const lines = [];
  for (let r = 0; r < size; r += 2) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const top = dark(r, c);
      const bot = r + 1 < size ? dark(r + 1, c) : false;
      const fg = top ? 30 : 37;
      const bg = bot ? 40 : 47;
      line += `\x1b[${fg};${bg}m\u2580`;
    }
    lines.push(line + RESET);
  }
  return lines.join('\n');
}

/**
 * 纯文本渲染（不依赖 ANSI 颜色），每个模块用两个字符宽。
 * 适合日志/网页会把 ANSI 颜色剥掉、或终端不支持真彩色的场景。
 * @param {boolean} invert 深色背景终端可传 true，让深色模块显示为亮块。
 */
export function renderAscii(text, { quiet = 2, ecl = 'M', invert = false } = {}) {
  const qr = makeQr(text, { ecl });
  const n = qr.getModuleCount();
  const size = n + quiet * 2;
  const on = invert ? '\u2588\u2588' : '  ';
  const off = invert ? '  ' : '\u2588\u2588';
  const lines = [];
  for (let r = 0; r < size; r++) {
    let line = '';
    for (let c = 0; c < size; c++) {
      const rr = r - quiet, cc = c - quiet;
      const isDark = rr >= 0 && cc >= 0 && rr < n && cc < n && qr.isDark(rr, cc);
      line += isDark ? on : off;
    }
    lines.push(line);
  }
  return lines.join('\n');
}

/** 最小 PNG 编码器：8 位灰度，每模块 1 像素（scale 倍放大）。 */
export function writePng(matrix, outPath, { quiet = 4, scale = 8 } = {}) {
  const n = matrix.getModuleCount();
  const size = (n + quiet * 2) * scale;
  const raw = Buffer.alloc((size + 1) * size, 0xff); // 全白（浅色 0xff）
  for (let y = 0; y < size; y++) {
    raw[y * (size + 1)] = 0; // filter type 0
    for (let x = 0; x < size; x++) {
      const mr = Math.floor(y / scale) - quiet;
      const mc = Math.floor(x / scale) - quiet;
      const isDark = mr >= 0 && mc >= 0 && mr < n && mc < n && matrix.isDark(mr, mc);
      raw[y * (size + 1) + 1 + x] = isDark ? 0x00 : 0xff;
    }
  }

  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 0;  // color type: grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true });
  fs.writeFileSync(outPath, png);
  return { outPath, size };
}

let CRC_TABLE = null;
function crc32(buf) {
  if (!CRC_TABLE) {
    CRC_TABLE = new Int32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[i] = c;
    }
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ CRC_TABLE[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

/** 渲染并落盘，返回终端文本与 png 路径。 */
export function renderQr(text, { pngPath, quiet = 2, ecl = 'M' } = {}) {
  const m = makeQr(text, { ecl });
  const out = { text: renderTerminal(text, { quiet, ecl }), pngPath: null };
  if (pngPath) out.pngPath = writePng(m, pngPath).outPath;
  return out;
}

export const _self = fileURLToPath(import.meta.url);
