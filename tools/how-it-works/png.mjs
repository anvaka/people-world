// A minimal PNG writer (8-bit grey or RGBA, no filtering), returned as a data: URI.
import {deflateSync} from 'node:zlib';

const CRC = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; ++n) { let c = n; for (let k = 0; k < 8; ++k) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
const crc32 = buf => { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'latin1');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
// pixels: Uint8Array of w*h*channels; channels 1 (grey) or 4 (RGBA)
export function pngDataUri(w, h, channels, pixels) {
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4);
  head[8] = 8; head[9] = channels === 4 ? 6 : 0; head[10] = 0; head[11] = 0; head[12] = 0;
  const raw = Buffer.alloc((w * channels + 1) * h);
  for (let y = 0; y < h; ++y) {
    raw[y * (w * channels + 1)] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * channels, w * channels).copy(raw, y * (w * channels + 1) + 1);
  }
  const png = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', head), chunk('IDAT', deflateSync(raw, {level: 9})), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + png.toString('base64');
}
