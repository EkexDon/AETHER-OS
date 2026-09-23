/**
 * Color parsing for color clips. Accepts the forms the backend classifies
 * as `color`: `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` and
 * `hsl()/hsla()` in comma or space syntax. Parsed colors are re-serialised
 * from numbers, so a clip can never inject arbitrary CSS into a style.
 */

/** An sRGB color with alpha (channels 0–255, alpha 0–1). */
export interface Rgba {
  r: number;
  g: number;
  b: number;
  a: number;
}

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

function parseChannel(raw: string): number | null {
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return null;
  return raw.trim().endsWith("%") ? clamp((value / 100) * 255, 0, 255) : clamp(value, 0, 255);
}

function parseAlpha(raw: string | undefined): number | null {
  if (raw === undefined) return 1;
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return null;
  return raw.trim().endsWith("%") ? clamp(value / 100, 0, 1) : clamp(value, 0, 1);
}

function parseHue(raw: string): number | null {
  const value = parseFloat(raw);
  if (Number.isNaN(value)) return null;
  const unit = raw.trim().replace(/^[+-]?[\d.]+/, "");
  const degrees = unit === "turn" ? value * 360 : unit === "rad" ? (value * 180) / Math.PI : value;
  return ((degrees % 360) + 360) % 360;
}

function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  const chroma = (1 - Math.abs(2 * l - 1)) * s;
  const x = chroma * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - chroma / 2;
  const [r, g, b] =
    h < 60 ? [chroma, x, 0] : h < 120 ? [x, chroma, 0] : h < 180 ? [0, chroma, x] : h < 240 ? [0, x, chroma] : h < 300 ? [x, 0, chroma] : [chroma, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Split `a, b, c` / `a b c / d` function arguments. */
function functionArgs(body: string): string[] | null {
  let parts: string[];
  if (body.includes(",")) {
    parts = body.split(",").map((p) => p.trim());
  } else {
    const sections = body.split("/");
    if (sections.length > 2) return null;
    parts = sections[0].trim().split(/\s+/).filter(Boolean);
    if (sections.length === 2) {
      if (parts.length !== 3) return null;
      parts.push(sections[1].trim());
    }
  }
  if (parts.length < 3 || parts.length > 4 || parts.some((p) => p === "")) return null;
  return parts;
}

/** Parse a CSS color string; `null` when it is not a supported color. */
export function parseColor(input: string): Rgba | null {
  const text = input.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(text);
  if (hex) {
    let digits = hex[1];
    if (digits.length <= 4) digits = digits.replace(/./g, (c) => c + c);
    const value = (i: number) => parseInt(digits.slice(i, i + 2), 16);
    return { r: value(0), g: value(2), b: value(4), a: digits.length === 8 ? value(6) / 255 : 1 };
  }
  const fn = /^(rgba?|hsla?)\((.*)\)$/.exec(text);
  if (!fn) return null;
  const args = functionArgs(fn[2]);
  if (!args) return null;
  const alpha = parseAlpha(args[3]);
  if (alpha === null) return null;
  if (fn[1].startsWith("rgb")) {
    const [r, g, b] = args.slice(0, 3).map(parseChannel);
    if (r === null || g === null || b === null) return null;
    return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alpha };
  }
  const h = parseHue(args[0]);
  const s = parseFloat(args[1]);
  const l = parseFloat(args[2]);
  if (h === null || Number.isNaN(s) || Number.isNaN(l)) return null;
  const [r, g, b] = hslToRgb(h, clamp(s / 100, 0, 1), clamp(l / 100, 0, 1));
  return { r: Math.round(r), g: Math.round(g), b: Math.round(b), a: alpha };
}

const hex2 = (n: number) => Math.round(n).toString(16).padStart(2, "0");
const alphaText = (a: number) => String(Math.round(a * 100) / 100);

/** `#3fb0a3` (or `#3fb0a380` with alpha). */
export function toHex({ r, g, b, a }: Rgba): string {
  return `#${hex2(r)}${hex2(g)}${hex2(b)}${a < 1 ? hex2(a * 255) : ""}`;
}

/** `rgb(63 176 163)` (or `rgb(63 176 163 / 0.5)`). */
export function toRgb({ r, g, b, a }: Rgba): string {
  return a < 1 ? `rgb(${r} ${g} ${b} / ${alphaText(a)})` : `rgb(${r} ${g} ${b})`;
}

/** `hsl(173 48% 47%)` (or with `/ alpha`). */
export function toHsl({ r, g, b, a }: Rgba): string {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  let h = 0;
  let s = 0;
  if (d !== 0) {
    s = d / (1 - Math.abs(2 * l - 1));
    if (max === rn) h = 60 * (((gn - bn) / d) % 6);
    else if (max === gn) h = 60 * ((bn - rn) / d + 2);
    else h = 60 * ((rn - gn) / d + 4);
  }
  const hue = Math.round((h + 360) % 360);
  const body = `${hue} ${Math.round(s * 100)}% ${Math.round(l * 100)}%`;
  return a < 1 ? `hsl(${body} / ${alphaText(a)})` : `hsl(${body})`;
}

/** Safe CSS value for a swatch background. */
export function toCss(color: Rgba): string {
  return `rgba(${color.r}, ${color.g}, ${color.b}, ${alphaText(color.a)})`;
}
