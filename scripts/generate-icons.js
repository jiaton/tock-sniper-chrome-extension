const fs = require("fs");
const zlib = require("zlib");

const crcTable = new Uint32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(buffers) {
  let c = 0xffffffff;
  for (const buffer of buffers) {
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const name = Buffer.from(type);
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  name.copy(out, 4);
  data.copy(out, 8);
  out.writeUInt32BE(crc32([name, data]), 8 + data.length);
  return out;
}

function smoothstep(edge0, edge1, value) {
  const t = Math.max(0, Math.min(1, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

function roundedBoxAlpha(x, y, cx, cy, w, h, r) {
  const qx = Math.abs(x - cx) - w / 2 + r;
  const qy = Math.abs(y - cy) - h / 2 + r;
  const outside = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inside = Math.min(Math.max(qx, qy), 0);
  const dist = outside + inside - r;
  return 1 - smoothstep(-0.75, 0.75, dist);
}

function ringAlpha(x, y, cx, cy, radius, stroke) {
  const dist = Math.abs(Math.hypot(x - cx, y - cy) - radius) - stroke / 2;
  return 1 - smoothstep(-0.7, 0.7, dist);
}

function lineAlpha(x, y, x1, y1, x2, y2, stroke) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const len = dx * dx + dy * dy;
  const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (y - y1) * dy) / len)) : 0;
  const px = x1 + t * dx;
  const py = y1 + t * dy;
  const dist = Math.hypot(x - px, y - py) - stroke / 2;
  return 1 - smoothstep(-0.65, 0.65, dist);
}

function blend(pixel, color, alpha) {
  const a = Math.max(0, Math.min(1, alpha)) * (color[3] / 255);
  const inv = 1 - a;
  pixel[0] = Math.round(color[0] * a + pixel[0] * inv);
  pixel[1] = Math.round(color[1] * a + pixel[1] * inv);
  pixel[2] = Math.round(color[2] * a + pixel[2] * inv);
  pixel[3] = Math.round(255 * (a + (pixel[3] / 255) * inv));
}

function render(size) {
  const width = size;
  const height = size;
  const raw = Buffer.alloc((width * 4 + 1) * height);
  const box = size * 0.75;
  const radius = size * 0.17;
  const cx = size / 2;
  const cy = size / 2;

  for (let y = 0; y < height; y++) {
    const row = y * (width * 4 + 1);
    raw[row] = 0;
    for (let x = 0; x < width; x++) {
      const pixel = [0, 0, 0, 0];
      const px = x + 0.5;
      const py = y + 0.5;
      const boxA = roundedBoxAlpha(px, py, cx, cy, box, box, radius);
      const t = (px + py) / (size * 2);
      const blue = [37, 99, 235, 255];
      const green = [22, 163, 74, 255];
      const bg = [
        Math.round(blue[0] * (1 - t) + green[0] * t),
        Math.round(blue[1] * (1 - t) + green[1] * t),
        Math.round(blue[2] * (1 - t) + green[2] * t),
        255,
      ];
      blend(pixel, bg, boxA);

      const ring = ringAlpha(px, py, cx, cy, size * 0.235, Math.max(1.3, size * 0.055));
      const vertical = lineAlpha(px, py, cx, cy - size * 0.29, cx, cy + size * 0.29, Math.max(1.1, size * 0.045));
      const horizontal = lineAlpha(px, py, cx - size * 0.29, cy, cx + size * 0.29, cy, Math.max(1.1, size * 0.045));
      const center = ringAlpha(px, py, cx, cy, size * 0.04, Math.max(1, size * 0.04));
      blend(pixel, [255, 255, 255, 255], Math.max(ring, vertical, horizontal, center) * boxA);

      const offset = row + 1 + x * 4;
      raw[offset] = pixel[0];
      raw[offset + 1] = pixel[1];
      raw[offset + 2] = pixel[2];
      raw[offset + 3] = pixel[3];
    }
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = 6;
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", zlib.deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

for (const size of [16, 48, 128]) {
  fs.writeFileSync(`icons/icon${size}.png`, render(size));
}
