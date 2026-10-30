# Color picker: design

Date: 2026-10-30
Status: approved mockup, design for build
Mockup: https://claude.ai/artifact/5o1ESR7xZtYboMoWHdkzQn (private)

## Why

Ben is evaluating sidebar colors on kabob, a Laravel + Flux + Tailwind v4 app. Today the only way to ask for a color in Reword is a free-text note ("make this darker"). He wants to point at an element, try colors on the live page, compare two picks, and hand the agent an exact answer. On a Tailwind site the exact answer is a class swap (`bg-zinc-900` → `bg-zinc-800`), not a hex.

He wants both kinds of color: shades from the site's own palette and colors outside it.

## Goals

- A **Color** action on the selected element, beside Edit text, Remove and Note.
- Three properties: background (`background-color`), text (`color`) and border (`border-color`).
- Pick by swatch or by typing a hex.
- Swatches cover the site's own palette and the stock Tailwind palette, 50 to 950.
- Hovering a swatch previews it live on the page.
- A/B compare: two slots, flip the page between them, apply the one showing.
- The result is a normal Reword change: in the panel, undoable, saved across reloads, re-matched by selector, written into the prompt and the JSON block.
- A `set_color` command so an AI caller can do the same.

## Non-goals

- Gradients, shadows, opacity sliders, fill/stroke on SVG.
- Rewriting the site's theme tokens (`--color-zinc-900` itself). The change is to one element's class.
- A full HSV color wheel. Hex entry plus swatches covers it. The browser's native `<input type="color">` may sit beside the hex field if it's free to add.
- Saved favorites or more than two compare slots.
- Detecting non-Tailwind design tokens (CSS-in-JS themes, Bootstrap variables).

## Anti-goals

- The picker shows a color the page would not render for that class. On kabob, stock `zinc-900` (`#18181b`) is wrong; the site's `zinc-900` is a warm charcoal. Showing stock values for an overridden family is a failure even if everything else works.
- The prompt tells the agent to paste a hex onto an element that uses Tailwind classes when a class would do.
- Compare picks that weren't applied leak into the change list or undo history.

## Constraints found in the code and on kabob

- **Tailwind v4 emits only used theme variables.** Kabob's compiled CSS has 9 of 11 `blue` steps and only `slate-800`. So the page can't be the source of the full palette. Reword ships the stock v4 palette and treats page variables as overrides.
- **Kabob overrides more than zinc.** Its CSS redefines `zinc-*` (house palette) and `red-*` (rust scale), plus custom names `accent`, `accent-content`, `accent-foreground`, `focus`.
- **The compiled build on disk is stale** relative to `app.css` (accent differs). Reword reads the live page, so this doesn't matter, but don't test against `public/build`.
- **A class the site never used isn't compiled.** Live preview must use inline styles, never class swaps.
- **Text color on a container doesn't reach children that set their own.** Kabob's Flux sidebar items carry their own text color, so recoloring the `<div data-flux-sidebar>` text won't visibly change the nav labels. That's the cascade, not a bug. The Text tab says so in one line.
- Reword's UI lives in a shadow root (`src/core/ui/root.ts`) with its own tokens in `styles.ts`. The picker follows those tokens.

## How it behaves

### Opening

1. User selects an element. The action bar gains a **Color** button between Edit text and Remove. Its icon is a small swatch filled with the element's current background.
2. Click Color. A popover opens anchored under the action bar, like the note editor. It's positioned with the same clamp-to-viewport logic.
3. Esc or Cancel closes it with no change. Clicking outside also cancels.

### The popover, top to bottom

- **Header:** "Color", the element tag and short selector, close button.
- **Property tabs:** Background · Text · Border. Each tab shows a small swatch of that property's current (or pending) value. Default tab is Background unless the element is text-only (no background, has text), then Text.
- **Now / A / B cards.**
  - Now: current computed color, the matching class if one is found on the element, else "no class".
  - A and B: the picks. A is active when the popover opens. Clicking a card makes it active and paints its colors on the page. An empty B reads "Compare".
  - Hint line under the cards: "Pick a color for A. Click B to pick a second one to compare." Once both are filled: "Click A or B to flip the page between them. Apply keeps the one showing."
- **Hex field.** Accepts `#rgb`, `#rrggbb`, with or without `#`. Exact match to a palette color → that class. No exact match → shows "No class matches. Closest: `bg-slate-800` ■" with **Use it**.
- **Swatch grid.** Column headers 50 … 950. Two sections:
  - **This site:** every family the page overrides (value differs from stock), in the site's values, then a chip row of custom names (`accent`, `focus`, …). Steps an overridden family doesn't emit show as empty, disabled cells.
  - **Tailwind:** every stock family the site doesn't override, in stock v4 values.
  - A dot marks the element's current color. A white ring marks the active slot's pick.
  - Hover = live preview in the active slot. Click = set the active slot.
- **Footer:** "Hover a swatch to preview" · Cancel · Apply (reads "Apply A" / "Apply B" when both are filled).

### Applying

- Apply commits one change per property that differs from the original, using the active slot. Other slot is discarded.
- Popover closes, the panel lists the change: swatch-old ~~`bg-zinc-900`~~ → swatch-new `bg-zinc-800`.
- Re-opening Color on an element with a color change starts from the applied value. Picking the original value again removes the change (same rule as edit_text).

### Keyboard

- Arrow keys move through the grid, Enter picks, Esc cancels. Tab order: tabs → cards → hex → grid → footer.
- No global shortcuts beyond what Reword already has.

## Data model

New change type in `src/core/changes.ts`:

```ts
type ColorProperty = "background-color" | "color" | "border-color";

interface ColorValue {
  hex: string;            // "#2b2723", lowercase, opaque part only
  alpha: number;          // 0..1; 1 for opaque, 0 for transparent
  className: string | null; // "dark:bg-zinc-800/50", or null when no palette color matches
}

interface ColorChange extends BaseChange {
  type: "color";
  property: ColorProperty;
  oldValue: ColorValue;   // what the element rendered, plus the class found on it
  newValue: ColorValue & { closest?: { className: string; hex: string } };
}
```

- Alpha *(my call)*: a kept `/NN` suffix carries its alpha into the live preview, so the preview shows what the class will produce. Typed hex is opaque. Transparent current values (most backgrounds, borders with zero width) show as a checkerboard swatch labelled "transparent". The prompt reads `Old: transparent (no background set)`, or `(no border)` for a border with zero width. Picking a border color on an element with no border width only previews if a width exists, and the Border tab says "No border on this element" when the width is zero.
- One color change per element per property. `session.findChange` takes the property into account for `type: "color"` (a small helper, or match on `property` at the call site).
- Add `"color"` to `TYPES` so stored changes load.

## Engine

`apply` sets the inline property with `!important`, saving the previous inline value in a WeakMap, like `remove` does for `display`. `unapply` restores it and drops an empty `style` attribute. Preview inside the open picker uses the same two calls on a temporary value so hover never touches the session.

## Palette

New module `src/core/palette.ts`, no DOM imports except the one reader:

- `STOCK_PALETTE`: Tailwind v4 families × steps as OKLCH strings, converted to hex once at load. Include the v4.2 neutrals (`taupe`, `mauve`, `olive`, `mist`) because Flux references them.
- **Names** come from the stylesheets: walk `document.styleSheets` (including `@layer` and `@media` blocks) and collect every `--color-*` custom property name declared anywhere. Cross-origin sheets that throw are skipped. Stock names are always included.
- **Values** come from the selected element *(my call, from the anti-goal)*: each name resolves through `getComputedStyle(selectedEl).getPropertyValue(name)`. Kabob redefines `--color-accent` inside `.dark`, and its sidebar carries `class="dark"` itself, so `accent` is khaki inside the sidebar and rust outside it. Only the element's own scope gives the value that class would render there. The palette is rebuilt each time the picker opens, never cached per page.
- Merge rule: a family is a site family if any of its steps, resolved on the element, differs from stock. Custom names that aren't `<family>-<step>` are site singles.
- `nearest(hex)`: closest palette color by OKLCH distance (ΔE OK), so "closest" matches what the eye sees.
- `classFor(property, token)`: `bg-` / `text-` / `border-` + token.

## Reading the current class

*(My call, from the anti-goal: Now and the swap follow the class that is rendering.)*

1. Collect every class on the element with the right prefix and a known palette token, with or without variants: `bg-zinc-50`, `dark:bg-zinc-900`, `lg:bg-zinc-800`, `bg-zinc-900/50`.
2. Resolve each candidate's color on the element (palette value, with any `/NN` alpha applied).
3. **Now** is the candidate whose color equals the computed color. Ties go to the one with variants, since the variant is the one that won. Kabob's mobile header (`bg-zinc-50 dark:bg-zinc-900` under a dark `<html>`) resolves to `dark:bg-zinc-900`.
4. The new class keeps the winning candidate's variant prefix and opacity suffix: `dark:bg-zinc-900/50` → `dark:bg-zinc-800/50`.
5. Other candidates go on the prompt's "Also on the element" line.
6. No candidate matches the computed color → `className: null`, and the Now card says "no class (set elsewhere)". If candidates exist but none match, the prompt lists them so the agent can see them.

Hover-only variants (`hover:`, `focus:`) never match at rest. That's correct: they aren't what's rendering.

## Prompt

New block in `src/core/prompt.ts`:

```
3. CHANGE COLOR
   Element: <div> — selector: `[data-flux-sidebar]`
   Section: …
   Property: background-color
   Old: bg-zinc-900 (#1f1c19)
   New: bg-zinc-800 (#2b2723)
   Swap the class `bg-zinc-900` for `bg-zinc-800`.
   Also on the element: dark:bg-zinc-950
   Context HTML: `…`
```

Variants:
- Old has no class: `Old: #b9b3a3 (no Tailwind class on this element; the color comes from a component, a parent or CSS)`.
- New has no class: `New: #2a3b4c (no matching Tailwind class; closest is bg-slate-800 #1e293b)`.

Rule added to `RULES`: "CHANGE COLOR: swap the named Tailwind class. Use the class, not the hex, because the site may redefine palette colors. If Old has no class, set the color where it's defined (component prop, parent class or stylesheet)."

## Command

`set_color` in `definitions.ts` and `commands.ts`:

```
set_color({ elementId, property: "background-color" | "color" | "border-color", color: string })
```

`color` is a hex or a palette token (`zinc-800`, `accent`). Tokens resolve through the merged palette. Same collapse and drop-back rules as `edit_text`. Returns `{ changed, changeId, className, hex }`.

## Files touched

| File | Change |
|---|---|
| `src/core/changes.ts` | `ColorChange`, add to `Change` union and `TYPES` |
| `src/core/palette.ts` | new: stock palette, site reader, nearest, class helpers |
| `src/core/engine.ts` | apply/unapply for `color`, preview helpers |
| `src/core/commands.ts` | `set_color` handler |
| `src/core/definitions.ts` | `set_color` definition |
| `src/core/prompt.ts` | CHANGE COLOR block and rule |
| `src/core/session.ts` | color-aware `findChange` (property) |
| `src/core/store.ts` | `colorEditingId` UI state |
| `src/core/ui/overlay.ts` | Color button, popover |
| `src/core/ui/panel.ts` | color row rendering |
| `src/core/ui/styles.ts` | popover, grid, cards |
| `test/core.test.ts` | palette, set_color, prompt |
| `test/fixture.html`, `test/e2e.mjs` | an element with `bg-*` classes and a theme override; open picker, hover, A/B, apply |
| `README.md` | Color in the Use section and the prompt example |

## Testing

- Unit (vitest + happy-dom): stock-vs-override merge, hex parsing, nearest by OKLCH, class detection with variants and opacity, `set_color` collapse and drop-back, prompt text for all three Old/New variants.
- E2E (Playwright, existing harness): open Color on the fixture, hover previews, fill A and B, flip, Apply B, check panel row, undo, reload re-applies, copied prompt has the class swap.
- Manual on kabob through the extension: sidebar shows house zinc under "This site", A/B flip works, prompt names `bg-zinc-900`.

## Calls made without asking

These came up in review and follow from the anti-goal. Each is easy to change.

- Palette values resolve on the selected element, not the page root.
- Now and the swap follow the class that's rendering, including its variant and opacity suffix.
- Alpha is carried for opacity suffixes. Transparent current colors are shown and written as "transparent".
- Compare is a pair of slots inside the picker, not a saved list.

## Left to the builder

- Exact popover width and grid cell size (mockup: 384px, 18px cells).
- Whether native `<input type="color">` sits beside the hex field.
- How the grid scrolls when a site overrides many families.
- Panel row layout details, following existing rows.
