/**
 * A tiny PNG encoder for the mock backend: `cmd_read_vault_asset` returns
 * a generated picture instead of reading files. Uncompressed (stored)
 * deflate blocks keep it dependency-free; the images are small anyway.
 */

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const b of bytes) crc = CRC_TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function adler32(bytes: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (const byte of bytes) {
    a = (a + byte) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function u32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function chunk(type: string, data: Uint8Array): number[] {
  const typed = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) typed[i] = type.charCodeAt(i);
  typed.set(data, 4);
  return [...u32(data.length), ...typed, ...u32(crc32(typed))];
}

/** zlib stream of stored (uncompressed) deflate blocks. */
function zlibStore(raw: Uint8Array): Uint8Array {
  const out: number[] = [0x78, 0x01];
  for (let offset = 0; offset < raw.length; offset += 65535) {
    const block = raw.subarray(offset, Math.min(raw.length, offset + 65535));
    const final = offset + 65535 >= raw.length ? 1 : 0;
    out.push(final, block.length & 0xff, block.length >>> 8, ~block.length & 0xff, (~block.length >>> 8) & 0xff);
    for (const b of block) out.push(b);
  }
  out.push(...u32(adler32(raw)));
  return Uint8Array.from(out);
}

/** Encode an RGB image (`pixel(x, y)` → `[r, g, b]`) as PNG bytes. */
export function encodePng(width: number, height: number, pixel: (x: number, y: number) => [number, number, number]): Uint8Array {
  const raw = new Uint8Array(height * (1 + width * 3));
  let i = 0;
  for (let y = 0; y < height; y++) {
    raw[i++] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixel(x, y);
      raw[i++] = r;
      raw[i++] = g;
      raw[i++] = b;
    }
  }
  const header = new Uint8Array([...u32(width), ...u32(height), 8, 2, 0, 0, 0]);
  const bytes = [
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk("IHDR", header),
    ...chunk("IDAT", zlibStore(raw)),
    ...chunk("IEND", new Uint8Array()),
  ];
  return Uint8Array.from(bytes);
}

function hash(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * A calm placeholder landscape (sky, sun, two ridges) whose palette is
 * derived from `seed`, so different files look different.
 */
export function mockPicture(seed: string, width = 160, height = 96): Uint8Array {
  const h = hash(seed);
  const hue = (h % 360) / 360;
  const rgb = (hh: number, s: number, l: number): [number, number, number] => {
    const f = (n: number) => {
      const k = (n + hh * 12) % 12;
      const a = s * Math.min(l, 1 - l);
      return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
    };
    return [f(0), f(8), f(4)];
  };
  const sunX = width * (0.25 + ((h >>> 8) % 50) / 100);
  const sunY = height * 0.34;
  const sunR = height * 0.14;
  return encodePng(width, height, (x, y) => {
    const ridgeA = height * (0.62 + 0.08 * Math.sin((x / width) * Math.PI * 2 + (h % 7)));
    const ridgeB = height * (0.78 + 0.05 * Math.sin((x / width) * Math.PI * 3 + (h % 5)));
    if (y > ridgeB) return rgb(hue + 0.05, 0.28, 0.3);
    if (y > ridgeA) return rgb(hue + 0.03, 0.24, 0.44);
    if ((x - sunX) ** 2 + (y - sunY) ** 2 < sunR ** 2) return rgb(0.1, 0.7, 0.82);
    return rgb(hue, 0.32, 0.86 - (y / height) * 0.18);
  });
}

/** Standard base64 of bytes. */
export function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}
