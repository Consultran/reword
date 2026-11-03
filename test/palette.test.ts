import { describe, expect, it } from 'vitest';
import { buildPalette, collectColorVarNames, detectClass, nearest, newClassName, parseToken } from '../src/core/palette';

// Kabob-style values as they'd resolve on an element inside `.dark`.
const kabobVars: Record<string, string> = {
  '--color-zinc-900': '#1f1c19',
  '--color-zinc-800': '#2b2723',
  '--color-accent': '#cfc3a0',
  '--color-blue-500': 'oklch(62.3% .214 259.815)',
};
const resolve = (n: string) => kabobVars[n] ?? '';
const p = buildPalette(Object.keys(kabobVars), resolve);

describe('buildPalette', () => {
  it('marks families the site overrides and keeps stock families', () => {
    expect(p.siteFamilies.map((f) => f.name)).toEqual(['zinc']);
    expect(p.byToken.get('zinc-900')!.hex).toBe('#1f1c19');
    expect(p.byToken.get('zinc-50')!.defined).toBe(false);
    expect(p.stockFamilies.some((f) => f.name === 'zinc')).toBe(false);
    expect(p.stockFamilies.find((f) => f.name === 'blue')!.swatches).toHaveLength(11);
    expect(p.siteSingles.map((s) => s.token)).toEqual(['accent']);
  });

  it('resolves a name per element scope', () => {
    const light = buildPalette(['--color-accent'], () => '#9c3a22');
    expect(light.byToken.get('accent')!.hex).toBe('#9c3a22');
    expect(p.byToken.get('accent')!.hex).toBe('#cfc3a0');
  });

  it('keeps black and white as stock colors and skips values it cannot read', () => {
    const q = buildPalette(['--color-black', '--color-white', '--color-brand'], (n) => (n === '--color-brand' ? 'var(--x)' : ''));
    expect(q.siteSingles).toEqual([]);
    expect(q.stockSingles.map((s) => [s.token, s.hex])).toEqual([['black', '#000000'], ['white', '#ffffff']]);
  });
});

describe('detectClass', () => {
  it('detects the class that is rendering, including variants', () => {
    const r = detectClass(['bg-zinc-50', 'dark:bg-zinc-900', 'border-e'], 'background-color', { hex: '#1f1c19', alpha: 1 }, p);
    expect(r.match).toMatchObject({ className: 'dark:bg-zinc-900', variant: 'dark:', token: 'zinc-900' });
    expect(r.others).toEqual(['bg-zinc-50']);
    expect(newClassName('background-color', 'zinc-800', r.match)).toBe('dark:bg-zinc-800');
  });

  it('keeps an opacity suffix', () => {
    const r = detectClass(['bg-zinc-900/50'], 'background-color', { hex: '#1f1c19', alpha: 0.5 }, p);
    expect(r.match).toMatchObject({ token: 'zinc-900', opacity: 50 });
    expect(newClassName('background-color', 'zinc-800', r.match)).toBe('bg-zinc-800/50');
  });

  it('detects bg-white and a /10 opacity on it', () => {
    expect(detectClass(['bg-white'], 'background-color', { hex: '#ffffff', alpha: 1 }, p).match).toMatchObject({ className: 'bg-white' });
    expect(detectClass(['bg-white/10'], 'background-color', { hex: '#ffffff', alpha: 0.1 }, p).match).toMatchObject({ token: 'white', opacity: 10 });
  });

  it('returns no match when no class renders the computed color', () => {
    expect(detectClass(['text-zinc-400'], 'color', { hex: '#b9b3a3', alpha: 1 }, p).match).toBeNull();
  });

  it('only looks at classes for the asked property', () => {
    const r = detectClass(['text-zinc-900', 'border-zinc-900'], 'background-color', { hex: '#1f1c19', alpha: 1 }, p);
    expect(r.match).toBeNull();
    expect(r.others).toEqual([]);
  });
});

describe('nearest and parseToken', () => {
  it('finds the nearest swatch and parses tokens', () => {
    expect(nearest('#2c2824', p).token).toBe('zinc-800'); // stock stone-800 (#292524) is the near miss
    expect(parseToken('zinc-800/50')).toEqual({ token: 'zinc-800', opacity: 50 });
    expect(parseToken('accent')).toEqual({ token: 'accent', opacity: null });
    expect(parseToken('#fff')).toBeNull();
  });

  it('builds a plain class when nothing is kept', () => {
    expect(newClassName('border-color', 'accent', null)).toBe('border-accent');
    expect(newClassName('color', 'zinc-800', null, 75)).toBe('text-zinc-800/75');
  });
});

describe('collectColorVarNames', () => {
  it('collects --color-* names from nested rules', () => {
    const style = document.createElement('style');
    style.textContent = ':root{--color-zinc-900:#1f1c19;--spacing:4px} @media (min-width:1px){.dark{--color-accent:#cfc3a0}}';
    document.head.append(style);
    const names = collectColorVarNames(Array.from(document.styleSheets));
    expect(names.has('--color-zinc-900')).toBe(true);
    expect(names.has('--color-accent')).toBe(true);
    expect(names.has('--spacing')).toBe(false);
    style.remove();
  });
});
