// Color parsing and OKLab math. No DOM: the palette and commands feed it the
// strings that getComputedStyle and stylesheets return.

export interface ParsedColor {
  /** Opaque part as lowercase #rrggbb. */
  hex: string;
  /** 0 (transparent) to 1 (opaque). */
  alpha: number;
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const toHex2 = (v: number) => Math.round(clamp01(v) * 255).toString(16).padStart(2, "0");
const round2 = (v: number) => Math.round(v * 100) / 100;

/** sRGB gamma encode / decode. */
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);

/** OKLCH (L 0–1, C, H in degrees) to #rrggbb, clipping out-of-gamut channels. */
export function oklchToHex(l: number, c: number, h: number): string {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = l - 0.0894841775 * a - 1.291485548 * b;
  const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
  const r = 4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
  const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
  const bl = -0.0041960863 * L - 0.7034186147 * M + 1.707612701 * S;
  return "#" + toHex2(encode(clamp01(r))) + toHex2(encode(clamp01(g))) + toHex2(encode(clamp01(bl)));
}

function hexToOklab(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => decode(v / 255)) as [number, number, number];
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
  ];
}

/** Perceived distance between two colors (Euclidean in OKLab). */
export function deltaE(hexA: string, hexB: string): number {
  if (hexA === hexB) return 0;
  const [a, b] = [hexToOklab(hexA), hexToOklab(hexB)];
  return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
}

/** A number token that may be a percentage ("62.3%" → 0.623 when `percentOf` is 100). */
function num(token: string | undefined, percentOf = 100): number | null {
  if (token === undefined) return null;
  if (token.trim() === "none") return 0; // CSS "missing component", e.g. the hue of a gray
  const v = parseFloat(token);
  if (Number.isNaN(v)) return null;
  return token.trim().endsWith("%") ? v / percentOf : v;
}

/** Splits "a b c / d" or "a, b, c, d" into channel tokens and an optional alpha token. */
function channels(inner: string): { parts: string[]; alpha?: string } | null {
  const [main, slashAlpha] = inner.split("/");
  const parts = main!.trim().split(/[\s,]+/).filter(Boolean);
  if (slashAlpha !== undefined) return { parts, alpha: slashAlpha.trim() };
  if (parts.length === 4) return { parts: parts.slice(0, 3), alpha: parts[3] };
  return { parts };
}

/** Reads #hex, rgb()/rgba(), oklch() and transparent. Returns null for anything else. */
export function parseColor(css: string): ParsedColor | null {
  const s = css.trim().toLowerCase();
  if (s === "transparent") return { hex: "#000000", alpha: 0 };

  const hex = s.match(/^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/)?.[1];
  if (hex) {
    const full = hex.length <= 4 ? [...hex].map((c) => c + c).join("") : hex;
    const alpha = full.length === 8 ? round2(parseInt(full.slice(6), 16) / 255) : 1;
    return { hex: "#" + full.slice(0, 6), alpha };
  }

  const fn = s.match(/^(rgba?|oklch)\((.*)\)$/);
  if (!fn) return null;
  const ch = channels(fn[2]!);
  if (!ch || ch.parts.length !== 3) return null;
  const alpha = ch.alpha === undefined ? 1 : num(ch.alpha, 100);
  if (alpha === null) return null;

  if (fn[1] === "oklch") {
    const [l, c, h] = [num(ch.parts[0], 100), num(ch.parts[1], 100 / 0.4), num(ch.parts[2])];
    if (l === null || c === null || h === null) return null;
    return { hex: oklchToHex(l, c, h), alpha: round2(clamp01(alpha)) };
  }

  const rgb = ch.parts.map((p) => num(p, 100 / 255));
  if (rgb.some((v) => v === null)) return null;
  return { hex: "#" + rgb.map((v) => toHex2(v! / 255)).join(""), alpha: round2(clamp01(alpha)) };
}
