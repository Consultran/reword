// Applies and un-applies changes on the live DOM. Every DOM mutation Reword
// makes to the page goes through here, driven by the command layer.
import type { Change, ColorValue, MoveChange } from "./changes";
import type { ColorProperty } from "./palette";
import { elementOf } from "./registry";

/** What an edit replaced, restored when the edit is reverted. */
const originalContent = new WeakMap<Element, { children: Node[] } | { text: Text; data: string }>();
/** Inline display value before an element was hidden. */
const originalDisplay = new WeakMap<Element, { value: string; priority: string }>();
/** Where a moved element sat before the move was applied. */
const originalPlace = new WeakMap<MoveChange, { parent: Element; next: Node | null }>();
/** Inline color values before a color change was applied, per property. */
const originalColor = new WeakMap<Element, Map<ColorProperty, { value: string; priority: string }>>();

/** CSS text for a picked color: rgb(r g b / a). */
export function colorCss(v: Pick<ColorValue, "hex" | "alpha">): string {
  const n = parseInt(v.hex.slice(1), 16);
  return `rgb(${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255} / ${v.alpha})`;
}

function restoreInline(style: CSSStyleDeclaration, property: string, prev: { value: string; priority: string } | undefined) {
  if (prev?.value) style.setProperty(property, prev.value, prev.priority);
  else style.removeProperty(property);
}

function dropEmptyStyle(el: Element) {
  if (!el.getAttribute("style")) el.removeAttribute("style");
}

/**
 * Temporary inline color for the picker's hover and A/B preview. Never touches
 * the session; `end()` puts back whatever inline value was there at the start.
 */
export function previewColor(el: Element, property: ColorProperty): { set(css: string | null): void; end(): void } {
  const style = (el as HTMLElement).style;
  const start = style ? { value: style.getPropertyValue(property), priority: style.getPropertyPriority(property) } : undefined;
  let ended = false;
  return {
    set(css) {
      if (ended || !style) return;
      if (css === null) restoreInline(style, property, start);
      else style.setProperty(property, css, "important");
      dropEmptyStyle(el);
    },
    end() {
      if (ended || !style) return;
      ended = true;
      restoreInline(style, property, start);
      dropEmptyStyle(el);
    },
  };
}

export function apply(change: Change) {
  const el = elementOf(change.elementId);
  if (!el) return;
  switch (change.type) {
    case "edit": {
      if (originalContent.has(el)) unapply({ ...change, type: "edit" });
      // A single text run next to icons (<button><svg/>Book a demo</button>) is edited in place.
      const runs = textRuns(el);
      if (runs.length === 1 && !change.newText.includes("\n")) {
        const run = runs[0]!;
        originalContent.set(el, { text: run, data: run.data });
        const [, lead, , trail] = run.data.match(/^(\s*)([\s\S]*?)(\s*)$/)!;
        run.data = lead + change.newText + trail;
      } else {
        originalContent.set(el, { children: Array.from(el.childNodes) });
        setPlainText(el, change.newText);
      }
      break;
    }
    case "remove": {
      const style = (el as HTMLElement).style;
      if (!style) return;
      if (!originalDisplay.has(el))
        originalDisplay.set(el, { value: style.getPropertyValue("display"), priority: style.getPropertyPriority("display") });
      style.setProperty("display", "none", "important");
      break;
    }
    case "note":
      break; // Notes are drawn as pins by the overlay; nothing changes on the page.
    case "move": {
      const target = elementOf(change.targetId);
      if (!target || !el.parentElement || !target.parentElement || el.contains(target)) return;
      originalPlace.set(change, { parent: el.parentElement, next: el.nextSibling });
      target.parentElement.insertBefore(el, change.position === "before" ? target : target.nextSibling);
      break;
    }
    case "color": {
      const style = (el as HTMLElement).style;
      if (!style) return;
      let saved = originalColor.get(el);
      if (!saved) originalColor.set(el, (saved = new Map()));
      if (!saved.has(change.property))
        saved.set(change.property, { value: style.getPropertyValue(change.property), priority: style.getPropertyPriority(change.property) });
      style.setProperty(change.property, colorCss(change.newValue), "important");
      break;
    }
  }
}

export function unapply(change: Change) {
  const el = elementOf(change.elementId);
  if (!el) return;
  switch (change.type) {
    case "edit": {
      const orig = originalContent.get(el);
      if (!orig) break;
      if ("children" in orig) el.replaceChildren(...orig.children);
      else orig.text.data = orig.data;
      originalContent.delete(el);
      break;
    }
    case "remove": {
      const prev = originalDisplay.get(el);
      const style = (el as HTMLElement).style;
      if (!style) return;
      if (prev?.value) style.setProperty("display", prev.value, prev.priority);
      else style.removeProperty("display");
      if (!el.getAttribute("style")) el.removeAttribute("style");
      originalDisplay.delete(el);
      break;
    }
    case "note":
      break;
    case "move": {
      const place = originalPlace.get(change);
      if (!place) return;
      const next = place.next && place.next.parentNode === place.parent ? place.next : null;
      place.parent.insertBefore(el, next);
      originalPlace.delete(change);
      break;
    }
    case "color": {
      const style = (el as HTMLElement).style;
      const saved = originalColor.get(el);
      if (!style || !saved?.has(change.property)) return;
      restoreInline(style, change.property, saved.get(change.property));
      saved.delete(change.property);
      dropEmptyStyle(el);
      break;
    }
  }
}

/** Moves the DOM from `before` to `after` for one change slot. */
export function transition(before: Change | null, after: Change | null) {
  if (before) unapply(before);
  if (after) apply(after);
}

/** Sets text like innerText does (newlines become <br>), without HTML parsing. */
export function setPlainText(el: Element, text: string) {
  const nodes: Node[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) nodes.push(document.createElement("br"));
    if (line) nodes.push(document.createTextNode(line));
  });
  el.replaceChildren(...nodes);
}

/** Non-whitespace text nodes inside `el`, ignoring <svg>, <style> and <script> content. */
function textRuns(el: Element): Text[] {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) =>
      n.parentElement?.closest("svg,style,script,noscript,template") || !n.nodeValue?.trim() ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT,
  });
  const out: Text[] = [];
  while (walker.nextNode()) out.push(walker.currentNode as Text);
  return out;
}
