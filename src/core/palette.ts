// The palette the picker shows: Tailwind's stock colors with the site's own
// overrides laid on top, resolved at one element (a `.dark` subtree can give
// `accent` a different value than the page root). Also works out which
// Tailwind class is painting an element's color right now.
import { deltaE, oklchToHex, parseColor } from "./color";
import { STEPS, STOCK_PALETTE, type Step } from "./palette-data";

export type ColorProperty = "background-color" | "color" | "border-color";
export const PREFIX: Record<ColorProperty, "bg-" | "text-" | "border-"> = {
  "background-color": "bg-",
  color: "text-",
  "border-color": "border-",
};

export interface Swatch {
  /** "zinc-900" or a custom name like "accent". */
  token: string;
  hex: string;
  alpha: number;
  /** False for a step a site-overridden family doesn't define. */
  defined: boolean;
}

export interface Family {
  name: string;
  swatches: Swatch[];
}

export interface Palette {
  siteFamilies: Family[];
  siteSingles: Swatch[];
  stockFamilies: Family[];
  /** Tailwind's black and white. */
  stockSingles: Swatch[];
  /** Every swatch by token; site colors come first so ties favour them. */
  byToken: Map<string, Swatch>;
}

/** Returns a custom property's computed text at some element, or "" when unset. */
export type VarResolver = (name: string) => string;

export interface ClassMatch {
  className: string;
  /** Variant prefix including the trailing colon ("dark:"), or "". */
  variant: string;
  token: string;
  opacity: number | null;
}

/** Colors closer than this (OKLab) count as the same color. */
const SAME = 0.002;
const SKIP_SINGLES = new Set(["black", "white", "transparent", "current", "inherit"]);
/** Stock colors outside the 50–950 families. black and white are skipped as site singles and live here. */
const STOCK_SINGLES: [string, string][] = [["black", "#000000"], ["white", "#ffffff"]];

let stockHex: Record<string, Record<Step, string>> | null = null;
function stock(): Record<string, Record<Step, string>> {
  if (stockHex) return stockHex;
  stockHex = {};
  for (const [family, steps] of Object.entries(STOCK_PALETTE)) {
    const out = {} as Record<Step, string>;
    for (const step of STEPS) out[step] = parseColor(steps[step])!.hex;
    stockHex[family] = out;
  }
  return stockHex;
}

/** Every stock custom-property name, so unused Tailwind colors still resolve. */
export function stockVarNames(): string[] {
  return [...Object.keys(STOCK_PALETTE).flatMap((f) => STEPS.map((s) => `--color-${f}-${s}`)), ...STOCK_SINGLES.map(([t]) => `--color-${t}`)];
}

/** Collects every `--color-*` name declared in these sheets, including inside @media and @layer. */
export function collectColorVarNames(sheets: Iterable<CSSStyleSheet>): Set<string> {
  const names = new Set<string>();
  const walk = (rules: CSSRuleList) => {
    for (const rule of Array.from(rules)) {
      const style = (rule as CSSStyleRule).style;
      if (style) for (let i = 0; i < style.length; i++) if (style[i]!.startsWith("--color-")) names.add(style[i]!);
      const inner = (rule as CSSGroupingRule).cssRules;
      if (inner) walk(inner);
    }
  };
  for (const sheet of sheets) {
    try {
      walk(sheet.cssRules);
    } catch {
      // Cross-origin sheets can't be read.
    }
  }
  return names;
}

export function resolverFor(el: Element): VarResolver {
  const style = getComputedStyle(el);
  return (name) => style.getPropertyValue(name).trim();
}

const familyStep = (key: string): { family: string; step: Step } | null => {
  const m = key.match(/^([a-z]+)-(\d+)$/);
  if (!m || !STOCK_PALETTE[m[1]!] || !(STEPS as readonly string[]).includes(m[2]!)) return null;
  return { family: m[1]!, step: m[2] as Step };
};

export function buildPalette(names: Iterable<string>, resolve: VarResolver): Palette {
  const siteValues: Record<string, Partial<Record<Step, { hex: string; alpha: number }>>> = {};
  const overridden = new Set<string>();
  const singles: Swatch[] = [];
  const seen = new Set<string>();

  for (const name of names) {
    if (seen.has(name) || !name.startsWith("--color-")) continue;
    seen.add(name);
    const key = name.slice("--color-".length);
    const value = parseColor(resolve(name));
    if (!value) continue;
    const fs = familyStep(key);
    if (fs) {
      (siteValues[fs.family] ??= {})[fs.step] = value;
      if (deltaE(value.hex, stock()[fs.family]![fs.step]) >= SAME || value.alpha !== 1) overridden.add(fs.family);
    } else if (!SKIP_SINGLES.has(key) && /^[a-z][a-z0-9-]*$/.test(key)) {
      singles.push({ token: key, hex: value.hex, alpha: value.alpha, defined: true });
    }
  }

  const siteFamilies: Family[] = [];
  const stockFamilies: Family[] = [];
  for (const family of Object.keys(STOCK_PALETTE)) {
    if (overridden.has(family)) {
      siteFamilies.push({
        name: family,
        swatches: STEPS.map((step) => {
          const v = siteValues[family]?.[step];
          return v
            ? { token: `${family}-${step}`, hex: v.hex, alpha: v.alpha, defined: true }
            : { token: `${family}-${step}`, hex: "#000000", alpha: 0, defined: false };
        }),
      });
    } else {
      stockFamilies.push({
        name: family,
        swatches: STEPS.map((step) => ({ token: `${family}-${step}`, hex: stock()[family]![step], alpha: 1, defined: true })),
      });
    }
  }

  const stockSingles: Swatch[] = STOCK_SINGLES.map(([token, fallback]) => {
    const v = parseColor(resolve(`--color-${token}`)) ?? { hex: fallback, alpha: 1 };
    return { token, hex: v.hex, alpha: v.alpha, defined: true };
  });

  const byToken = new Map<string, Swatch>();
  for (const s of [...siteFamilies.flatMap((f) => f.swatches), ...singles, ...stockFamilies.flatMap((f) => f.swatches), ...stockSingles])
    byToken.set(s.token, s);
  return { siteFamilies, siteSingles: singles, stockFamilies, stockSingles, byToken };
}

/** The palette as it resolves at `el`: every declared or stock `--color-*` name. */
export function paletteFor(el: Element): Palette {
  const names = collectColorVarNames(Array.from(document.styleSheets));
  return buildPalette([...names, ...stockVarNames()], resolverFor(el));
}

/** "zinc-800", "zinc-800/50" or "accent". Returns null for hex and anything else. */
export function parseToken(input: string): { token: string; opacity: number | null } | null {
  const m = input.trim().match(/^([a-z][a-z0-9]*(?:-[a-z0-9]+)*)(?:\/(\d{1,3}))?$/);
  if (!m) return null;
  return { token: m[1]!, opacity: m[2] === undefined ? null : Number(m[2]) };
}

/**
 * Finds the class on the element that paints `computed` for this property.
 * Ties go to the longest variant (the one that won the cascade). `others` are
 * the remaining palette classes for the same property.
 */
export function detectClass(
  classList: Iterable<string>,
  property: ColorProperty,
  computed: { hex: string; alpha: number },
  palette: Palette,
): { match: ClassMatch | null; others: string[] } {
  const prefix = PREFIX[property];
  const candidates: { m: ClassMatch; paints: boolean }[] = [];
  for (const className of classList) {
    const cut = className.lastIndexOf(":") + 1;
    const variant = className.slice(0, cut);
    const base = className.slice(cut);
    if (!base.startsWith(prefix)) continue;
    const parsed = parseToken(base.slice(prefix.length));
    const swatch = parsed && palette.byToken.get(parsed.token);
    if (!parsed || !swatch) continue;
    const alpha = swatch.alpha * (parsed.opacity === null ? 1 : parsed.opacity / 100);
    const paints = swatch.defined && deltaE(swatch.hex, computed.hex) < SAME && Math.abs(alpha - computed.alpha) <= 0.01;
    candidates.push({ m: { className, variant, token: parsed.token, opacity: parsed.opacity }, paints });
  }
  const painting = candidates.filter((c) => c.paints).sort((a, b) => b.m.variant.length - a.m.variant.length);
  const match = painting[0]?.m ?? null;
  return { match, others: candidates.filter((c) => c.m !== match).map((c) => c.m.className) };
}

/** The class to write for a new token, keeping the old class's variant and opacity unless told otherwise. */
export function newClassName(property: ColorProperty, token: string, keep: ClassMatch | null, opacity?: number | null): string {
  const op = opacity !== undefined ? opacity : (keep?.opacity ?? null);
  return `${keep?.variant ?? ""}${PREFIX[property]}${token}${op === null ? "" : `/${op}`}`;
}

/** The defined, visible swatch closest to `hex`. */
export function nearest(hex: string, palette: Palette): Swatch {
  let best: Swatch | null = null;
  let bestD = Infinity;
  for (const s of palette.byToken.values()) {
    if (!s.defined || s.alpha === 0) continue;
    const d = deltaE(hex, s.hex);
    if (d < bestD) [best, bestD] = [s, d];
  }
  return best!;
}

/** True when two colors are the same for the picker's purposes. */
export const sameColor = (a: { hex: string; alpha: number }, b: { hex: string; alpha: number }) =>
  deltaE(a.hex, b.hex) < SAME && Math.abs(a.alpha - b.alpha) <= 0.01;

export { oklchToHex };
