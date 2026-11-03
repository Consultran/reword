# Color Picker Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Color action to Reword that recolors an element's background, text or border from the site's palette, stock Tailwind or a hex, with live preview and A/B compare, recorded as a normal Reword change that the prompt describes as a Tailwind class swap.

**Architecture:** Pure color math and palette logic live in two DOM-free modules (`color.ts`, `palette.ts`) that take a CSS-variable resolver as a parameter, so they unit-test without a browser. A new `color` change type flows through the existing pipeline: command → session patch → engine inline style → panel row → prompt block. The popover is its own UI module mounted by the overlay, and it previews with temporary inline styles that never touch the session.

**Tech Stack:** TypeScript, WXT (MV3), vitest + happy-dom (unit), Playwright (e2e). pnpm. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-30-color-picker-design.md`. Mockup: https://claude.ai/artifact/5o1ESR7xZtYboMoWHdkzQn

## Global Constraints

- Properties are exactly `"background-color" | "color" | "border-color"`; class prefixes `bg-`, `text-`, `border-`.
- Steps are exactly `50 100 200 300 400 500 600 700 800 900 950`.
- Stock palette = Tailwind **v4.3.3** `theme.css`: 26 families (red orange amber yellow lime green emerald teal cyan sky blue indigo violet purple fuchsia pink rose slate gray zinc neutral stone mauve olive mist taupe), as OKLCH strings.
- Palette values resolve on the **selected element** (`getComputedStyle(el).getPropertyValue("--color-…")`), rebuilt each time the picker opens. Never cached per page.
- Live preview uses inline styles with `!important`, never class swaps.
- "Closest" uses OKLab distance (ΔE OK), never RGB distance.
- Hex is stored lowercase `#rrggbb`; alpha is a separate `0..1` number.
- No new npm dependencies. Match existing code style: `h()` helper, tokens in `styles.ts`, store-driven render.
- Don't publish artifacts; don't touch kabob.

## Review Focus

1. **Element with no background (transparent).** Expect Now = "transparent" with a checkerboard swatch, and the prompt line `Old: transparent (no background set)`. Pinned in Task 2 (`describeCurrent` transparent case) and Task 4 (prompt test).
2. **Variant class is the one rendering** (`bg-zinc-50 dark:bg-zinc-900` under `.dark`). Expect Now = `dark:bg-zinc-900` and New keeps `dark:`. Pinned in Task 2 (`detectClass` variant test).
3. **Same name, different value by scope** (`--color-accent` redefined in `.dark`). Expect the swatch to show the value at the selected element. Pinned in Task 2 (`buildPalette` resolver test).
4. **Picking the original color again.** Expect the change to be dropped, the same rule as `edit_text`. Pinned in Task 3.
5. **Element removed or re-rendered while the picker is open** (SPA re-render, Livewire morph). Expect the preview to be restored and the picker to close without throwing. Pinned in Task 5 (picker closes when `elementOf(colorEditingId)` is null on render).

---

### Task 1: Color math and stock palette data

**Files:**
- Create: `src/core/color.ts`
- Create: `scripts/make-palette.mjs`
- Create: `src/core/palette-data.ts` (generated, committed)
- Test: `test/color.test.ts`

**Interfaces:**
- Produces:
  - `parseColor(css: string): { hex: string; alpha: number } | null`: accepts `#rgb`, `#rrggbb`, `#rrggbbaa`, `rgb()/rgba()` (comma or space syntax, `/ a`), `oklch(L% C H [/ a])` (L as % or 0–1), `transparent`. Returns null for anything else.
  - `oklchToHex(l: number, c: number, h: number): string`: L in 0–1, gamut-clipped by clamping linear sRGB to 0–1.
  - `deltaE(hexA: string, hexB: string): number`: Euclidean distance in OKLab.
  - `STOCK_PALETTE: Record<string, Record<Step, string>>` (OKLCH strings), `STEPS`, `type Step` from `palette-data.ts`.

- [ ] **Step 1: Write the failing tests** in `test/color.test.ts`

```ts
expect(parseColor('#9C3A22')).toEqual({ hex: '#9c3a22', alpha: 1 });
expect(parseColor('#abc')).toEqual({ hex: '#aabbcc', alpha: 1 });
expect(parseColor('rgb(31, 28, 25)')).toEqual({ hex: '#1f1c19', alpha: 1 });
expect(parseColor('rgba(0 0 0 / 0.5)')).toEqual({ hex: '#000000', alpha: 0.5 });
expect(parseColor('transparent')).toEqual({ hex: '#000000', alpha: 0 });
expect(parseColor('oklch(62.3% .214 259.815)')!.hex).toBe('#2b7fff'); // v4 blue-500
expect(parseColor('oklch(21% 0.006 285.885)')!.hex).toBe('#18181b');  // zinc-900
expect(parseColor('hsl(0 0% 0%)')).toBeNull();
expect(deltaE('#1f1c19', '#1f1c19')).toBe(0);
expect(deltaE('#1f1c19', '#2b2723')).toBeLessThan(deltaE('#1f1c19', '#2b7fff'));
expect(Object.keys(STOCK_PALETTE)).toHaveLength(26);
expect(STOCK_PALETTE.zinc['900']).toBe('oklch(21% 0.006 285.885)');
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/color.test.ts`
Expected: FAIL, cannot find module `../src/core/color`.

- [ ] **Step 3: Write `scripts/make-palette.mjs`**

Usage: `node scripts/make-palette.mjs <path/to/tailwindcss/theme.css>`. Read every `--color-<family>-<step>: oklch(...)` line and write `src/core/palette-data.ts` with `export const STEPS = [...] as const`, `export type Step = typeof STEPS[number]`, `export const STOCK_PALETTE = {...}`, and a header comment naming the Tailwind version found in the sibling `package.json`. Run it once against `~/code/kabob/node_modules/tailwindcss/theme.css` (v4.3.3) and commit the output. Reading kabob's file is read-only.

- [ ] **Step 4: Implement `src/core/color.ts`**

The conversion uses Björn Ottosson's OKLab matrices. These constants aren't determined by the tests:

```ts
// OKLCH → OKLab → LMS' → LMS → linear sRGB → sRGB
const a = c * Math.cos(h * Math.PI / 180), b = c * Math.sin(h * Math.PI / 180);
const l_ = l + 0.3963377774 * a + 0.2158037573 * b;
const m_ = l - 0.1055613458 * a - 0.0638541728 * b;
const s_ = l - 0.0894841775 * a - 1.2914855480 * b;
const L = l_ ** 3, M = m_ ** 3, S = s_ ** 3;
const r =  4.0767416621 * L - 3.3077115913 * M + 0.2309699292 * S;
const g = -1.2684380046 * L + 2.6097574011 * M - 0.3413193965 * S;
const bl = -0.0041960863 * L - 0.7034186147 * M + 1.7076127010 * S;
// gamma: v <= 0.0031308 ? 12.92 v : 1.055 v^(1/2.4) - 0.055; clamp 0..1; round to 0..255
```

For `deltaE`, go hex → linear sRGB → OKLab using the inverse matrices (`l = 0.4122214708 r + 0.5363325363 g + 0.0514459929 b`, `m = 0.2119034982 r + 0.6806995451 g + 0.1073969566 b`, `s = 0.0883024619 r + 0.2817188376 g + 0.6299787005 b`, cube-root each, then `L = 0.2104542553 l + 0.7936177850 m - 0.0040720468 s`, `A = 1.9779984951 l - 2.4285922050 m + 0.4505937099 s`, `B = 0.0259040371 l + 0.7827717662 m - 0.8086757660 s`).

- [ ] **Step 5: Run to verify it passes**

Run: `pnpm vitest run test/color.test.ts`
Expected: PASS. The expected hexes were computed with exactly these matrices, so a mismatch means a bug in the conversion, not in the test.

- [ ] **Step 6: Commit**

```bash
git add src/core/color.ts src/core/palette-data.ts scripts/make-palette.mjs test/color.test.ts
git commit -m "Add color parsing, OKLab distance and the Tailwind v4 stock palette"
```

---

### Task 2: Site palette, class detection, current value

**Files:**
- Create: `src/core/palette.ts`
- Test: `test/palette.test.ts`

**Interfaces:**
- Consumes: `parseColor`, `deltaE`, `oklchToHex`, `STOCK_PALETTE`, `STEPS` (Task 1).
- Produces:
  - `type ColorProperty = "background-color" | "color" | "border-color"`
  - `PREFIX: Record<ColorProperty, "bg-" | "text-" | "border-">`
  - `interface Swatch { token: string; hex: string; alpha: number; defined: boolean }` (`token` is `"zinc-900"` or `"accent"`; `defined=false` for steps a site family doesn't emit)
  - `interface Palette { siteFamilies: { name: string; swatches: Swatch[] }[]; siteSingles: Swatch[]; stockFamilies: { name: string; swatches: Swatch[] }[]; byToken: Map<string, Swatch> }`
  - `type VarResolver = (name: string) => string` (returns the computed custom-property text, `""` if unset)
  - `collectColorVarNames(sheets: Iterable<CSSStyleSheet>): Set<string>`: walks rules recursively (`cssRules` of grouping and layer rules), skips sheets whose `cssRules` throws.
  - `buildPalette(names: Iterable<string>, resolve: VarResolver): Palette`
  - `resolverFor(el: Element): VarResolver`: `(n) => getComputedStyle(el).getPropertyValue(n).trim()`
  - `interface ClassMatch { className: string; variant: string; token: string; opacity: number | null }` (`variant` is the prefix including the trailing colon, e.g. `"dark:"`, or `""`)
  - `detectClass(classList: Iterable<string>, property: ColorProperty, computed: { hex: string; alpha: number }, palette: Palette): { match: ClassMatch | null; others: string[] }`
  - `newClassName(property: ColorProperty, token: string, keep: ClassMatch | null, opacity?: number | null): string`
  - `nearest(hex: string, palette: Palette): Swatch` (skips `defined: false`)
  - `parseToken(input: string): { token: string; opacity: number | null } | null` (`"zinc-800"`, `"zinc-800/50"`, `"accent"`)

- [ ] **Step 1: Write the failing tests** in `test/palette.test.ts`, with a fake resolver built from a plain object.

```ts
const kabobVars = { '--color-zinc-900': '#1f1c19', '--color-zinc-800': '#2b2723', '--color-accent': '#cfc3a0',
  '--color-blue-500': 'oklch(62.3% .214 259.815)' };
const resolve = (n: string) => kabobVars[n] ?? '';
const p = buildPalette(Object.keys(kabobVars), resolve);

it('marks families the site overrides and keeps stock families', () => {
  expect(p.siteFamilies.map((f) => f.name)).toEqual(['zinc']);
  expect(p.byToken.get('zinc-900')!.hex).toBe('#1f1c19');
  expect(p.byToken.get('zinc-50')!.defined).toBe(false);          // site family, step not emitted
  expect(p.stockFamilies.some((f) => f.name === 'zinc')).toBe(false);
  expect(p.stockFamilies.find((f) => f.name === 'blue')!.swatches).toHaveLength(11);
  expect(p.siteSingles.map((s) => s.token)).toEqual(['accent']);
});

it('resolves a name per element scope', () => {
  const light = buildPalette(['--color-accent'], () => '#9c3a22');
  expect(light.byToken.get('accent')!.hex).toBe('#9c3a22');
  expect(p.byToken.get('accent')!.hex).toBe('#cfc3a0');
});

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

it('returns no match when no class renders the computed color', () => {
  expect(detectClass(['text-zinc-400'], 'color', { hex: '#b9b3a3', alpha: 1 }, p).match).toBeNull();
});

it('finds the nearest swatch and parses tokens', () => {
  expect(nearest('#2c2824', p).token).toBe('zinc-800'); // stock stone-800 (#292524) is the near miss
  expect(parseToken('zinc-800/50')).toEqual({ token: 'zinc-800', opacity: 50 });
  expect(parseToken('#fff')).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/palette.test.ts`
Expected: FAIL, cannot find module.

- [ ] **Step 3: Implement `src/core/palette.ts`**

A family is a site family when any of its names resolves (non-empty) to a hex different from the stock hex for that step. Names that don't match `<family>-<step>` and aren't stock become site singles; skip `--color-black`, `--color-white` and `--color-transparent`. Unresolvable values (`""`, unparseable) are ignored. Match candidates in `detectClass` by `deltaE < 0.002` and equal alpha (±0.01), not string equality. The `computed` input is opaque hex + alpha, so apply the opacity suffix to the candidate's alpha before comparing. Tie → the candidate with the longest `variant`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run test/palette.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core/palette.ts test/palette.test.ts
git commit -m "Add site palette merge and rendering-class detection"
```

---

### Task 3: Color change type, engine, session, set_color command

**Files:**
- Modify: `src/core/changes.ts` (union, `TYPES`)
- Modify: `src/core/engine.ts` (`apply`/`unapply` cases, preview helper)
- Modify: `src/core/session.ts` (`findColorChange`)
- Modify: `src/core/definitions.ts` (`set_color`)
- Modify: `src/core/commands.ts` (`set_color` handler)
- Test: `test/core.test.ts` (new `describe('set_color')`)

**Interfaces:**
- Consumes: Task 2 `ColorProperty`, `buildPalette`, `collectColorVarNames`, `resolverFor`, `detectClass`, `newClassName`, `nearest`, `parseToken`; Task 1 `parseColor`.
- Produces:
  - In `changes.ts`: `interface ColorValue { hex: string; alpha: number; className: string | null }`, `interface ColorChange extends BaseChange { type: "color"; property: ColorProperty; oldValue: ColorValue; newValue: ColorValue & { closest?: { className: string; hex: string } }; alsoOnElement: string[] }`.
  - In `engine.ts`: `previewColor(el: Element, property: ColorProperty): { set(css: string | null): void; end(): void }`. `set` writes an inline `!important` value (null restores), and `end` restores what was there when preview started.
  - In `session.ts`: `findColorChange(elementId: string, property: ColorProperty): ColorChange | undefined`.
  - Command `set_color({ elementId, property, color })` → `{ changed: boolean; changeId?: string; className: string | null; hex: string }`.

- [ ] **Step 1: Write the failing tests** in `test/core.test.ts`

The fixture body gains `<div id="side" class="bg-zinc-900">x</div>` and a `<style>:root{--color-zinc-900:#1f1c19;--color-zinc-800:#2b2723}</style>`. If happy-dom doesn't resolve custom properties or class rules through `getComputedStyle`, stub `resolverFor` and the computed color with `vi.spyOn` on the palette module, and say so in a comment. Don't drop the assertions.

```ts
it('sets a palette color live, records a class swap, and undoes', async () => {
  const id = await idFor('#side');
  const r = await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-800' });
  expect(r).toMatchObject({ ok: true, data: { changed: true, className: 'bg-zinc-800', hex: '#2b2723' } });
  const el = document.getElementById('side')!;
  expect(el.style.getPropertyValue('background-color')).not.toBe('');
  expect(el.style.getPropertyPriority('background-color')).toBe('important');
  const c = store.get().changes[0] as ColorChange;
  expect(c.oldValue).toMatchObject({ className: 'bg-zinc-900', hex: '#1f1c19' });
  await executeCommand('undo');
  expect(el.getAttribute('style')).toBeNull();
});

it('collapses repeat picks and drops a pick back to the original', async () => {
  const id = await idFor('#side');
  await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-800' });
  await executeCommand('set_color', { elementId: id, property: 'background-color', color: '#123456' });
  expect(store.get().changes).toHaveLength(1);
  expect((store.get().changes[0] as ColorChange).newValue).toMatchObject({ hex: '#123456', className: null });
  expect((store.get().changes[0] as ColorChange).newValue.closest).toBeDefined();
  await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-900' });
  expect(store.get().changes).toHaveLength(0);
});

it('keeps one change per property', async () => {
  const id = await idFor('#side');
  await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-800' });
  await executeCommand('set_color', { elementId: id, property: 'color', color: '#ffffff' });
  expect(store.get().changes.map((c) => (c as ColorChange).property)).toEqual(['background-color', 'color']);
});

it('rejects colors it cannot read', async () => {
  const id = await idFor('#side');
  expect(await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'not-a-color' }))
    .toMatchObject({ ok: false });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core.test.ts`
Expected: FAIL, `Unknown command "set_color"`.

- [ ] **Step 3: Implement**

- `changes.ts`: add the types; add `"color"` to `TYPES`.
- `engine.ts`: keep original inline values in `WeakMap<Element, Map<ColorProperty, { value: string; priority: string }>>`. `apply` for `"color"` writes `rgb(r g b / alpha)` built from `newValue` with `important`. `unapply` restores it and removes an empty `style` attribute, the same way `remove` does.
- `definitions.ts`: `set_color` with `elementId`, `property` (enum of the three), and `color` (string, described as "a hex like #2b2723, or a palette token like zinc-800, zinc-800/50 or accent"). Required: all three.
- `commands.ts`: build the palette for the element (`collectColorVarNames(document.styleSheets)` + `resolverFor(el)`). The Old value comes from `findColorChange(...)?.oldValue` if one exists. Otherwise read the computed property, run `detectClass` for `className` and `alsoOnElement`, and use `parseColor` for hex and alpha. The New value is a token via `parseToken` → `byToken`, with class from `newClassName(property, token, match, opacity)`. A hex (via `parseColor`) gets a class only if an exact palette match exists (`deltaE < 0.002`). Otherwise `className: null` plus `closest` from `nearest`. Same hex and alpha as Old → `after = null`. Commit label `"Color"`. Unreadable color → `CommandError("Color must be a hex like #2b2723 or a palette token like zinc-800")`.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run && pnpm compile`
Expected: all tests PASS, no type errors. `panel.ts` and `prompt.ts` will need `"color"` cases for exhaustiveness. Add minimal ones here and fill them out in Task 4.

- [ ] **Step 5: Commit**

```bash
git add src/core test/core.test.ts
git commit -m "Add the color change type and set_color command"
```

---

### Task 4: Prompt block and panel row

**Files:**
- Modify: `src/core/prompt.ts` (`describe` case, `RULES` line)
- Modify: `src/core/ui/panel.ts` (`detail`, `KIND_LABEL`, `KIND_ICON`)
- Modify: `src/core/ui/root.ts` (`color` icon in `ICON_SPECS`)
- Modify: `src/core/ui/styles.ts` (inline swatch chip in list rows)
- Test: `test/core.test.ts` (`describe('buildPrompt')`)

**Interfaces:**
- Consumes: `ColorChange` (Task 3).

- [ ] **Step 1: Write the failing test**

```ts
it('renders color changes as a class swap', () => {
  const color = (o: Partial<ColorChange>): ColorChange => ({ ...base, id: 'ch_9', type: 'color', property: 'background-color',
    oldValue: { hex: '#1f1c19', alpha: 1, className: 'dark:bg-zinc-900' },
    newValue: { hex: '#2b2723', alpha: 1, className: 'dark:bg-zinc-800' }, alsoOnElement: ['bg-zinc-50'], ...o });
  const p1 = buildPrompt([color({})]);
  expect(p1).toContain('CHANGE COLOR');
  expect(p1).toContain('Property: background-color');
  expect(p1).toContain('Old: dark:bg-zinc-900 (#1f1c19)');
  expect(p1).toContain('New: dark:bg-zinc-800 (#2b2723)');
  expect(p1).toContain('Swap the class `dark:bg-zinc-900` for `dark:bg-zinc-800`.');
  expect(p1).toContain('Also on the element: bg-zinc-50');
  expect(p1).toContain('CHANGE COLOR: swap the named Tailwind class');

  const p2 = buildPrompt([color({ oldValue: { hex: '#000000', alpha: 0, className: null },
    newValue: { hex: '#2a3b4c', alpha: 1, className: null, closest: { className: 'bg-slate-800', hex: '#1e293b' } }, alsoOnElement: [] })]);
  expect(p2).toContain('Old: transparent (no background set)');
  expect(p2).toContain('New: #2a3b4c (no matching Tailwind class; closest is bg-slate-800 #1e293b)');
  expect(p2).not.toContain('Swap the class');

  const p3 = buildPrompt([color({ property: 'color', oldValue: { hex: '#b9b3a3', alpha: 1, className: null }, alsoOnElement: [] })]);
  expect(p3).toContain('Old: #b9b3a3 (no Tailwind class on this element; the color comes from a component, a parent or CSS)');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run test/core.test.ts -t "color changes"`
Expected: FAIL

- [ ] **Step 3: Implement**

- `prompt.ts`: a `"color"` case giving `CHANGE COLOR`, then `elementLines`, `Property:`, `Old:`, `New:`, the swap line only when both class names exist, the `Also on the element:` line only when non-empty, then `Context HTML:`. Transparent wording is `(no background set)` / `(no text color set)` / `(no border)`. Add to `RULES` verbatim: `- CHANGE COLOR: swap the named Tailwind class. Use the class, not the hex, because the site may redefine palette colors. If Old has no class, set the color where it's defined (component prop, parent class or stylesheet).`
- `panel.ts`: `KIND_LABEL.color = "Color"` and `KIND_ICON.color = "color"`. `detail` shows a swatch span + struck old label → swatch + new label. The label is the class name, or the hex when there's none.
- `root.ts`: add a `color` icon (a droplet or a filled square with a ring) in the same spec format as its neighbours.

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run && pnpm compile`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/core test/core.test.ts
git commit -m "Describe color changes in the prompt and the changes panel"
```

---

### Task 5: The picker popover

**Files:**
- Create: `src/core/ui/colorPicker.ts`
- Modify: `src/core/store.ts` (`colorEditingId: string | null`, default `null`)
- Modify: `src/core/ui/overlay.ts` (Color button between Edit text and Remove, mount picker, position like the note editor)
- Modify: `src/core/ui/interceptor.ts` (Esc closes the picker before clearing selection)
- Modify: `src/core/ui/styles.ts` (popover, tabs, Now/A/B cards, grid, chips, checkerboard)

**Interfaces:**
- Consumes: `buildPalette`, `collectColorVarNames`, `resolverFor`, `detectClass`, `nearest`, `parseColor`, `previewColor`, `findColorChange`, `executeCommand("set_color", …)`.
- Produces: `createColorPicker(): { el: HTMLElement; render(state: State, prev: State): void }`. The overlay appends `el` to its layer and calls `render` from its own render.

Behaviour is the spec's "How it behaves" section and the mockup. The picker owns this state and never puts it in the store: `property`, `slots: { A: Partial<Record<ColorProperty, Pick>>; B: … }` where `Pick = { token: string | null; hex: string; alpha: number }`, `active: "A" | "B"`, `hover: Pick | null`, `previews: Map<ColorProperty, ReturnType<typeof previewColor>>`.

- [ ] **Step 1: Implement the open/close lifecycle**

Opening (`colorEditingId` set): build the palette for the element, start a `previewColor` for each of the three properties, and pick the default tab (background unless the computed background is transparent and the element has text). Closing (`colorEditingId` cleared, Cancel, Esc, outside click, or `elementOf(id)` null on render): call `end()` on every preview and reset the local state. Apply: end all previews first, then for each property in the active slot run `set_color` with the token (or the hex if `token` is null), in order bg → text → border, then clear `colorEditingId`.

- [ ] **Step 2: Implement the view**

Top to bottom, following the mockup: header, then tabs (each with a current swatch), then the Now / A / B cards. Under the cards goes the hint line, which uses the spec's exact copy. Then the hex field with the closest-class row and **Use it**. Then the grid: sticky step header, "This site" families (`defined: false` cells are disabled with a dashed outline), site single chips, then "Tailwind" families. A dot marks the current color and a ring marks the active slot's pick. The footer has Cancel and Apply / "Apply A" / "Apply B". Hover writes the preview for the active property. Mouse-leave on the grid restores the active slot's pick, or the original. The Text tab shows one line when the element has children: "Children with their own color won't change. Select one of them to recolor it." The Border tab says "No border on this element" when every `border-*-width` computes to `0px`.

- [ ] **Step 3: Implement keyboard**

Arrow keys move a roving focus through the grid (one `tabindex=0` cell), Enter/Space picks, and Esc cancels. Typing in the hex field must not trigger Reword's global shortcuts: check how the note textarea is exempted in `interceptor.ts` and use the same path.

- [ ] **Step 4: Verify by hand in the dev build**

Run: `pnpm compile && pnpm vitest run && pnpm build`
Expected: no type errors, tests pass, `.output/chrome-mv3` built. Load it and open `test/fixture.html` (Task 6 adds the color element). Check that hover previews, that A/B flip repaints, that Cancel restores, and that Apply adds one panel row per changed property.

- [ ] **Step 5: Commit**

```bash
git add src/core
git commit -m "Add the color picker popover with live preview and A/B compare"
```

---

### Task 6: End-to-end test, fixture and README

**Files:**
- Modify: `test/fixture.html` (themed element)
- Modify: `test/e2e.mjs` (color scenario inside `scenario()`)
- Modify: `README.md` (Use section bullet, prompt example block)

- [ ] **Step 1: Add to the fixture**

A `<style>` with `:root { --color-zinc-900: #1f1c19; --color-zinc-800: #2b2723; }`, `.dark { --color-accent: #cfc3a0; }` and `:root { --color-accent: #9c3a22; }`, plus rules for `.bg-zinc-900{background-color:var(--color-zinc-900)}` and `.dark\:bg-zinc-900` under `.dark`. Then `<aside id="side" class="dark bg-zinc-50 dark:bg-zinc-900">Sidebar</aside>`. Hand-written CSS stands in for Tailwind's output.

- [ ] **Step 2: Write the e2e steps** in `scenario()` after the existing ones

```js
await page.locator('#side').click();
await ov('.bar .color').click();
assert(await ov('.color-picker').isVisible(), 'color picker opens');
assert((await ov('.color-picker .now').textContent()).includes('dark:bg-zinc-900'), 'Now shows the rendering variant class');
await ov('.color-picker [data-token="zinc-800"]').hover();
const hoverBg = await page.locator('#side').evaluate((e) => getComputedStyle(e).backgroundColor);
assert(hoverBg === 'rgb(43, 39, 35)', 'hover previews zinc-800: ' + hoverBg);
await ov('.color-picker [data-token="zinc-800"]').click();
await ov('.color-picker .slot-b').click();
await ov('.color-picker [data-token="blue-900"]').click();
await ov('.color-picker .slot-a').click();
assert((await page.locator('#side').evaluate((e) => getComputedStyle(e).backgroundColor)) === 'rgb(43, 39, 35)', 'flip back to A');
await ov('.color-picker .apply').click();
assert(!(await ov('.color-picker').isVisible()), 'picker closes on apply');
const prompt = await getPrompt();
assert(prompt.includes('Swap the class `dark:bg-zinc-900` for `dark:bg-zinc-800`.'), 'prompt has the variant class swap');
await page.keyboard.press(`${MOD}+Z`);
assert((await page.locator('#side').getAttribute('style')) === null, 'undo restores the sidebar');
```

The class names `.color`, `.color-picker`, `.now`, `.slot-a`, `.slot-b`, `.apply` and the `data-token` attribute are this plan's contract with Task 5. Use them there.

- [ ] **Step 3: Run the e2e**

Run: `pnpm test:e2e`
Expected: every line PASS for both the extension run and the bookmarklet run, and no CSP violations logged. Inline `style` writes must work under the strict-CSP run. If they don't, use `el.style.setProperty`, which CSP allows. Never use `setAttribute('style')`.

- [ ] **Step 4: Update README**

Under **Use**, after Note, add a **Color** bullet: background, text or border; swatches from the site's palette and Tailwind; hex entry with closest class; hover to preview; A/B compare; the prompt asks for a class swap. Add a short `CHANGE COLOR` example to the prompt sample.

- [ ] **Step 5: Commit**

```bash
git add test/fixture.html test/e2e.mjs README.md
git commit -m "Cover the color picker end to end and document it"
```

---

### Task 7: Check it on kabob

No code. The extension build gets loaded in Chrome against kabob's dev server (`kabob.test`, served from source, not `public/build`).

- [ ] **Step 1:** Select the `[data-flux-sidebar]` element. Now reads `bg-zinc-900 #1f1c19`. "This site" lists `zinc` and `red` in house values, plus `accent` in khaki (the sidebar is `.dark`).
- [ ] **Step 2:** Fill A with `zinc-800` and B with a stock color, flip between them, then Apply A. The panel shows `bg-zinc-900 → bg-zinc-800`. The copied prompt names `[data-flux-sidebar]` and the swap.
- [ ] **Step 3:** Reload. The color re-applies, and the panel row is still there.
