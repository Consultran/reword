// The color popover: property tabs, Now / A / B cards, hex entry and a swatch
// grid of the site's palette plus stock Tailwind. Everything it shows on the
// page before Apply is a temporary inline preview; Apply runs set_color.
import type { ColorValue } from "../changes";
import { parseColor } from "../color";
import { computedColor, executeCommand } from "../commands";
import { colorCss, previewColor } from "../engine";
import { STEPS } from "../palette-data";
import { detectClass, nearest, newClassName, paletteFor, sameColor, type ClassMatch, type ColorProperty, type Palette, type Swatch } from "../palette";
import { elementOf } from "../registry";
import * as session from "../session";
import { store } from "../store";
import { h, icon } from "./root";
import { swatch } from "./panel";

type Pick = { token: string | null; hex: string; alpha: number };
type SlotName = "A" | "B";
type Preview = ReturnType<typeof previewColor>;

const PROPERTIES: ColorProperty[] = ["background-color", "color", "border-color"];
const TAB_LABEL: Record<ColorProperty, string> = { "background-color": "Background", color: "Text", "border-color": "Border" };

interface Session {
  id: string;
  el: Element;
  palette: Palette;
  now: Record<ColorProperty, { value: ColorValue; match: ClassMatch | null }>;
  previews: Record<ColorProperty, Preview>;
}

export interface ColorPicker {
  el: HTMLElement;
  /** Positions the popover next to the element; called every animation frame. */
  frame(): void;
}

export function createColorPicker(): ColorPicker {
  let open: Session | null = null;
  let property: ColorProperty = "background-color";
  let slots: Record<SlotName, Partial<Record<ColorProperty, Pick>>> = { A: {}, B: {} };
  let active: SlotName = "A";
  let hover: Pick | null = null;

  // ---- Static frame ----
  const target = h("span", { class: "target" });
  const tabs = h("div", { class: "tabs", role: "tablist", "aria-label": "Which color" });
  const cards = h("div", { class: "cards" });
  const hint = h("p", { class: "hint-line" });
  const note = h("p", { class: "prop-note" });
  const hexInput = h("input", { type: "text", class: "hex", spellcheck: "false", placeholder: "#2b2723", "aria-label": "Hex color" });
  const closest = h("div", { class: "closest" });
  const grid = h("div", { class: "grid" });
  const applyBtn = h("button", { class: "btn primary apply", onclick: () => apply() }, "Apply");
  const el = h(
    "div",
    { class: "color-picker", role: "dialog", "aria-label": "Color" },
    h(
      "div",
      { class: "title" },
      "Color",
      target,
      h("button", { class: "icon-btn close", title: "Cancel (Esc)", "aria-label": "Cancel", onclick: () => close() }, icon("close")),
    ),
    tabs,
    cards,
    hint,
    note,
    h("div", { class: "hex-row" }, h("label", {}, "Hex", hexInput), closest),
    grid,
    h(
      "div",
      { class: "row" },
      h("span", { class: "spacer" }, "Hover a swatch to preview"),
      h("button", { class: "btn", onclick: () => close() }, "Cancel"),
      applyBtn,
    ),
  );

  // ---- State helpers ----
  const keptMatch = () => open?.now[property].match ?? null;
  const pickFromSwatch = (s: Swatch): Pick => {
    // A swatch picked over a class with /50 keeps that opacity, as set_color will.
    const opacity = keptMatch()?.opacity ?? null;
    return { token: s.token, hex: s.hex, alpha: s.alpha * (opacity === null ? 1 : opacity / 100) };
  };
  const labelOf = (p: Pick | ColorValue | null, prop = property): string => {
    if (!p) return "";
    if ("className" in p) return p.alpha === 0 ? "transparent" : (p.className ?? "no class");
    return p.token ? newClassName(prop, p.token, open?.now[prop].match ?? null) : "custom";
  };
  const filled = (slot: SlotName) => Object.keys(slots[slot]).length > 0;

  /** Paints the page: the hovered swatch on the open tab, else the active slot's picks, else nothing. */
  function paint() {
    if (!open) return;
    for (const prop of PROPERTIES) {
      const v = prop === property && hover ? hover : slots[active][prop];
      open.previews[prop].set(v ? colorCss(v) : null);
    }
  }

  function setPick(p: Pick | null) {
    if (p) slots[active][property] = p;
    else delete slots[active][property];
    hover = null;
    hexInput.value = p ? p.hex : "";
    render();
  }

  // ---- Open / close ----
  function start(id: string) {
    const target = elementOf(id);
    if (!target) return;
    const palette = paletteFor(target);
    const now = {} as Session["now"];
    for (const prop of PROPERTIES) {
      const applied = session.findColorChange(id, prop);
      if (applied) {
        now[prop] = { value: applied.newValue, match: detectClass(target.classList, prop, applied.oldValue, palette).match };
      } else {
        const c = computedColor(target, prop);
        const match = detectClass(target.classList, prop, c, palette).match;
        now[prop] = { value: { ...c, className: match?.className ?? null }, match };
      }
    }
    const previews = Object.fromEntries(PROPERTIES.map((p) => [p, previewColor(target, p)])) as Session["previews"];
    open = { id, el: target, palette, now, previews };
    slots = { A: {}, B: {} };
    active = "A";
    hover = null;
    const hasText = Array.from(target.childNodes).some((n) => n.nodeType === Node.TEXT_NODE && n.textContent?.trim());
    property = now["background-color"].value.alpha === 0 && hasText ? "color" : "background-color";
    hexInput.value = "";
    buildGrid();
    render();
    el.classList.add("show");
    // Focus the hex field: focusing a swatch would preview it before the user chose anything.
    hexInput.focus({ preventScroll: true });
  }

  function end() {
    if (!open) return;
    for (const p of PROPERTIES) open.previews[p].end();
    open = null;
    hover = null;
    el.classList.remove("show");
  }

  function close() {
    store.set({ colorEditingId: null }); // the subscription below ends the preview
  }

  async function apply() {
    if (!open) return;
    const id = open.id;
    const chosen = slots[active];
    // End the preview now, not via the store listener: set_color reads the
    // element's current color as the "old" value, so the preview must be gone.
    end();
    close();
    for (const prop of PROPERTIES) {
      const p = chosen[prop];
      if (p) await executeCommand("set_color", { elementId: id, property: prop, color: p.token ?? p.hex });
    }
  }

  store.subscribe((s, prev) => {
    if (s.colorEditingId !== prev.colorEditingId) {
      end();
      if (s.colorEditingId) start(s.colorEditingId);
    } else if (open && (s.selectedId !== open.id || s.changes !== prev.changes)) {
      // Undo, redo, revert or an API call changed the page under the preview:
      // end now so the preview's saved "before" value can't be put back stale.
      end();
      store.set({ colorEditingId: null });
    }
  });

  // ---- Grid ----
  let rows: HTMLButtonElement[][] = [];

  function cell(s: Swatch, label?: string): HTMLButtonElement {
    const b = h(
      "button",
      {
        class: label ? "chip" : "cell",
        "data-token": s.token,
        tabindex: "-1",
        title: `${s.token} ${s.hex}`,
        "aria-label": s.defined ? s.token : `${s.token} (not defined on this site)`,
        disabled: !s.defined,
      },
      ...(label ? [swatch(s), label] : []),
    );
    if (!label && s.defined) b.style.setProperty("--swatch", colorCss(s));
    b.addEventListener("mouseenter", () => {
      if (!s.defined) return;
      hover = pickFromSwatch(s);
      render();
    });
    b.addEventListener("click", () => setPick(pickFromSwatch(s)));
    return b;
  }

  function familyRow(name: string, swatches: Swatch[]) {
    const buttons = swatches.map((s) => cell(s));
    rows.push(buttons);
    return h("div", { class: "fam" }, h("span", { class: "fam-name" }, name), ...buttons);
  }

  function buildGrid() {
    if (!open) return;
    rows = [];
    const { siteFamilies, siteSingles, stockFamilies, stockSingles } = open.palette;
    const head = h("div", { class: "fam steps", "aria-hidden": "true" }, h("span"), ...STEPS.map((s) => h("span", {}, s)));
    const site = [
      ...siteFamilies.map((f) => familyRow(f.name, f.swatches)),
      ...(siteSingles.length
        ? [
            (() => {
              const chips = siteSingles.map((s) => cell(s, s.token));
              rows.push(chips);
              return h("div", { class: "singles" }, ...chips);
            })(),
          ]
        : []),
    ];
    const stockRows = stockFamilies.map((f) => familyRow(f.name, f.swatches));
    const stockChips = stockSingles.map((s) => cell(s, s.token));
    rows.push(stockChips);
    grid.replaceChildren(
      head,
      ...(site.length ? [h("div", { class: "section site" }, "This site"), ...site] : []),
      h("div", { class: "section" }, "Tailwind"),
      ...stockRows,
      h("div", { class: "singles" }, ...stockChips),
    );
    const first = rows.flat().find((b) => !b.disabled);
    if (first) first.tabIndex = 0;
  }

  grid.addEventListener("mouseleave", () => {
    if (!hover) return;
    hover = null;
    render();
  });

  // Arrow keys move a roving focus through the grid.
  grid.addEventListener("keydown", (e) => {
    const moves: Record<string, [number, number]> = { ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0] };
    const move = moves[e.key];
    if (!move) return;
    const current = e.target as HTMLButtonElement;
    const r = rows.findIndex((row) => row.includes(current));
    if (r === -1) return;
    e.preventDefault();
    let [row, col] = [r, rows[r]!.indexOf(current)];
    for (let i = 0; i < 40; i++) {
      row += move[0];
      col += move[1];
      if (row < 0 || row >= rows.length) return;
      col = Math.max(0, Math.min(col, rows[row]!.length - 1));
      const next = rows[row]![col];
      if (next && !next.disabled) {
        current.tabIndex = -1;
        next.tabIndex = 0;
        next.focus();
        next.scrollIntoView({ block: "nearest" });
        // Arrowing through the grid previews like hovering does.
        const s = open?.palette.byToken.get(next.dataset.token!);
        if (s) {
          hover = pickFromSwatch(s);
          render();
        }
        return;
      }
      if (move[0] === 0 && (col === 0 || col === rows[row]!.length - 1)) return;
    }
  });

  // ---- Hex entry ----
  hexInput.addEventListener("input", () => {
    if (!open) return;
    const raw = hexInput.value.trim();
    const parsed = parseColor(raw.startsWith("#") ? raw : `#${raw}`);
    if (!parsed || !/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.test(raw)) return;
    const exact = [...open.palette.byToken.values()].find((s) => s.defined && sameColor(s, parsed));
    slots[active][property] = { token: exact?.token ?? null, hex: parsed.hex, alpha: 1 };
    hover = null;
    render();
  });

  el.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      close();
    } else if (e.key === "Enter" && e.target === hexInput) {
      e.preventDefault();
      void apply();
    }
  });

  // ---- Render ----
  function render() {
    if (!open) return;
    paint();
    const now = open.now[property].value;
    const pick = slots[active][property] ?? null;
    target.textContent = `<${open.el.localName}>`;

    tabs.replaceChildren(
      ...PROPERTIES.map((p) => {
        const shown = (p === property && hover) || slots[active][p] || open!.now[p].value;
        return h(
          "button",
          {
            class: `tab${p === property ? " on" : ""}`,
            role: "tab",
            "aria-selected": String(p === property),
            onclick: () => {
              property = p;
              hover = null;
              hexInput.value = slots[active][p]?.hex ?? "";
              render();
            },
          },
          swatch(shown),
          TAB_LABEL[p],
        );
      }),
    );

    const card = (cls: string, caption: string, value: Pick | ColorValue | null, onclick?: () => void, emptyLabel = "") => {
      const body = [
        value ? swatch(value) : h("span", { class: "swatch empty", "aria-hidden": "true" }),
        h("span", { class: "cap" }, caption),
        h("span", { class: "cls" }, value ? labelOf(value) : emptyLabel),
        h("span", { class: "hexv" }, value ? (value.alpha === 0 ? "" : value.hex) : ""),
      ];
      return onclick
        ? h("button", { class: `card ${cls}`, onclick, "aria-pressed": String(cls.includes("on")) }, ...body)
        : h("div", { class: `card ${cls}` }, ...body);
    };
    const slotCard = (name: SlotName) => {
      const on = active === name;
      const v = on && hover ? hover : (slots[name][property] ?? null);
      const caption = name + (on && hover ? " · previewing" : on && filled(name) && filled(other(name)) ? " · on page" : "");
      return card(`slot-${name.toLowerCase()}${on ? " on" : ""}`, caption, v, () => {
        active = name;
        hover = null;
        hexInput.value = slots[name][property]?.hex ?? "";
        render();
      }, name === "B" && !filled("B") ? "Compare" : "Pick a color");
    };
    cards.replaceChildren(card("now", "Now", now), slotCard("A"), slotCard("B"));

    hint.textContent =
      filled("A") && filled("B")
        ? "Click A or B to flip the page between them. Apply keeps the one showing."
        : "Pick a color for A. Click B to pick a second one to compare.";

    note.textContent =
      property === "color" && open.el.children.length
        ? "Children with their own color won't change. Select one of them to recolor it."
        : property === "border-color" && noBorder(open.el)
          ? "No border on this element"
          : "";
    note.hidden = !note.textContent;

    if (pick && !pick.token) {
      const c = nearest(pick.hex, open.palette);
      closest.replaceChildren(
        "No class matches. Closest: ",
        swatch(c),
        h("code", {}, newClassName(property, c.token, keptMatch(), null)),
        h("button", { class: "btn quiet use", onclick: () => setPick({ token: c.token, hex: c.hex, alpha: c.alpha }) }, "Use it"),
      );
      closest.hidden = false;
    } else {
      closest.replaceChildren();
      closest.hidden = true;
    }

    // Grid marks: ring on the open slot's pick, dot on the current color.
    for (const b of rows.flat()) {
      const s = open.palette.byToken.get(b.dataset.token!)!;
      b.classList.toggle("picked", !!pick?.token && pick.token === s.token);
      b.classList.toggle("current", s.defined && now.alpha > 0 && sameColor(s, now));
    }

    applyBtn.textContent = filled("A") && filled("B") ? `Apply ${active}` : "Apply";
    applyBtn.disabled = !filled(active);
  }

  const other = (n: SlotName): SlotName => (n === "A" ? "B" : "A");

  // ---- Position ----
  function frame() {
    const s = store.get();
    const t = elementOf(s.colorEditingId);
    if (open && (!t || !t.isConnected)) {
      // The element went away (re-render): drop the preview and close.
      store.set({ colorEditingId: null });
      return;
    }
    if (!open || !t) return;
    const r = t.getBoundingClientRect();
    const w = el.offsetWidth || 392;
    const hh = el.offsetHeight || 520;
    let y = r.bottom + 8;
    if (y + hh > innerHeight - 8) y = Math.max(8, r.top - hh - 48);
    el.style.translate = `${Math.round(Math.max(8, Math.min(r.left, innerWidth - w - 8)))}px ${Math.round(Math.min(y, innerHeight - hh - 8))}px`;
  }

  return { el, frame };
}

function noBorder(el: Element): boolean {
  const cs = getComputedStyle(el);
  return ["Top", "Right", "Bottom", "Left"].every((side) => parseFloat(cs.getPropertyValue(`border-${side.toLowerCase()}-width`)) === 0);
}
