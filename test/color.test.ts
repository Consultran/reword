import { describe, expect, it } from 'vitest';
import { deltaE, parseColor } from '../src/core/color';
import { STOCK_PALETTE } from '../src/core/palette-data';

describe('parseColor', () => {
  it('reads hex, rgb and transparent', () => {
    expect(parseColor('#9C3A22')).toEqual({ hex: '#9c3a22', alpha: 1 });
    expect(parseColor('#abc')).toEqual({ hex: '#aabbcc', alpha: 1 });
    expect(parseColor('rgb(31, 28, 25)')).toEqual({ hex: '#1f1c19', alpha: 1 });
    expect(parseColor('rgba(0 0 0 / 0.5)')).toEqual({ hex: '#000000', alpha: 0.5 });
    expect(parseColor('transparent')).toEqual({ hex: '#000000', alpha: 0 });
  });

  it('converts Tailwind v4 oklch values to hex', () => {
    expect(parseColor('oklch(62.3% .214 259.815)')!.hex).toBe('#2b7fff'); // v4 blue-500
    expect(parseColor('oklch(21% 0.006 285.885)')!.hex).toBe('#18181b'); // zinc-900
  });

  it('treats a none channel as zero, as Tailwind neutral grays use it', () => {
    expect(parseColor('oklch(98.5% 0 none)')!.hex).toBe('#fafafa'); // neutral-50
  });

  it('returns null for formats it does not read', () => {
    expect(parseColor('hsl(0 0% 0%)')).toBeNull();
    expect(parseColor('not-a-color')).toBeNull();
  });
});

describe('deltaE', () => {
  it('is zero for the same color and grows with perceived difference', () => {
    expect(deltaE('#1f1c19', '#1f1c19')).toBe(0);
    expect(deltaE('#1f1c19', '#2b2723')).toBeLessThan(deltaE('#1f1c19', '#2b7fff'));
  });
});

describe('STOCK_PALETTE', () => {
  it('has all 26 Tailwind v4 families as oklch', () => {
    expect(Object.keys(STOCK_PALETTE)).toHaveLength(26);
    expect(STOCK_PALETTE.zinc!['900']).toBe('oklch(21% 0.006 285.885)');
  });
});
