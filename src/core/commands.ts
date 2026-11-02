// The CommandRegistry: every action (UI, keyboard, future AI) runs through
// executeCommand(name, params). Handlers validate against the shared JSON
// Schemas, mutate via session.commit(), and return structured results.
import { COMMAND_DEFINITIONS, getDefinition, getToolDefinitions, type CommandName } from "./definitions";
import { validate } from "./validate";
import type { Change, ColorChange, ColorValue, EditChange, MoveChange, NoteChange, RemoveChange } from "./changes";
import { parseColor } from "./color";
import { detectClass, nearest, newClassName, paletteFor, parseToken, sameColor, type ClassMatch, type ColorProperty, type Palette } from "./palette";
import { contextHtml, sectionOf, segmentsOf, snippet, sourceHints, stableSelector, textOf } from "./describe";
import * as engine from "./engine";
import { buildPrompt } from "./prompt";
import { find, outline } from "./query";
import { elementOf, idOf } from "./registry";
import * as session from "./session";
import { store } from "./store";
import { copyText } from "./ui/root";

export interface CommandResult<T = unknown> {
  ok: boolean;
  data?: T;
  error?: string;
}

class CommandError extends Error {}

type Handler = (params: any) => unknown | Promise<unknown>;

function requireElement(elementId: string): Element {
  const el = elementOf(elementId);
  if (!el) throw new CommandError(`Unknown element "${elementId}". Use find_elements or get_page_outline to get element IDs.`);
  if (el === document.documentElement || el === document.body) throw new CommandError("Can't change <html> or <body>");
  return el;
}

function base(el: Element, elementId: string) {
  return {
    id: session.newChangeId(),
    page: session.currentPage(),
    elementId,
    selector: stableSelector(el),
    tag: el.localName,
    section: sectionOf(el),
    snippet: snippet(el, 80),
    contextHtml: contextHtml(el),
    segments: segmentsOf(el),
    sourceHints: sourceHints(el),
  };
}

/** The color an element paints for `property` right now. Unreadable values count as transparent. */
export function computedColor(el: Element, property: ColorProperty): { hex: string; alpha: number } {
  const cs = getComputedStyle(el);
  // A zero-width border still reports a color (currentColor under Tailwind's preflight): it isn't visible.
  if (property === "border-color" && ["top", "right", "bottom", "left"].every((side) => parseFloat(cs.getPropertyValue(`border-${side}-width`)) === 0))
    return { hex: "#000000", alpha: 0 };
  // The border-color shorthand can read as four values; the top edge stands for all of them.
  const raw = property === "border-color" ? cs.borderTopColor : cs.getPropertyValue(property);
  return parseColor(raw ?? "") ?? { hex: "#000000", alpha: 0 };
}

/** Turns "zinc-800", "zinc-800/50", "accent" or a hex into the new color value, or null if unreadable. */
function resolvePick(color: string, property: ColorProperty, palette: Palette, keep: ClassMatch | null): ColorChange["newValue"] | null {
  const token = parseToken(color);
  const swatch = token && palette.byToken.get(token.token);
  if (token && swatch?.defined) {
    const opacity = token.opacity ?? keep?.opacity ?? null;
    return {
      hex: swatch.hex,
      alpha: swatch.alpha * (opacity === null ? 1 : opacity / 100),
      className: newClassName(property, token.token, keep, token.opacity ?? undefined),
    };
  }
  const parsed = parseColor(color);
  if (!parsed) return null;
  const exact = [...palette.byToken.values()].find((s) => s.defined && sameColor(s, parsed));
  if (exact) return { ...parsed, className: newClassName(property, exact.token, keep, null) };
  const close = nearest(parsed.hex, palette);
  return { ...parsed, className: null, closest: { className: newClassName(property, close.token, keep, null), hex: close.hex } };
}

/** The public shape of a change for callers (list_changes). */
function view(c: Change, i: number) {
  const onThisPage = session.isOnCurrentPage(c);
  return { number: i + 1, ...c, onThisPage, found: onThisPage && !!elementOf(c.elementId) };
}

const handlers: Record<CommandName, Handler> = {
  select_element({ elementId, scrollIntoView, flash }: { elementId: string | null; scrollIntoView?: boolean; flash?: boolean }) {
    if (elementId === null) {
      store.set({ selectedId: null, noteEditingId: null });
      return { selectedId: null };
    }
    const el = requireElement(elementId);
    if (scrollIntoView) el.scrollIntoView({ block: "center", behavior: "smooth" });
    store.set({ selectedId: elementId, noteEditingId: null, ...(flash ? { flash: { elementId, at: Date.now() } } : {}) });
    return { selectedId: elementId, tag: el.localName, text: snippet(el), selector: stableSelector(el) };
  },

  edit_text({ elementId, newText }: { elementId: string; newText: string }) {
    const el = requireElement(elementId);
    const before = session.findChange(elementId, "edit") as EditChange | undefined;
    const oldText = before?.oldText ?? textOf(el);
    const text = newText.replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    if (!before && text === oldText) return { changed: false };
    if (before && text === before.newText) return { changed: false, changeId: before.id };
    // Editing back to the original text removes the change.
    const after: EditChange | null =
      text === oldText ? null : { ...(before ?? base(el, elementId)), type: "edit", oldText, newText: text };
    const patch = session.patchFor(before, after);
    session.commit("Edit text", [patch]);
    return { changed: true, changeId: patch.id, oldText, newText: text };
  },

  remove_element({ elementId }: { elementId: string }) {
    const el = requireElement(elementId);
    if (session.findChange(elementId, "remove")) throw new CommandError("Element is already removed");
    const after: RemoveChange = { ...base(el, elementId), type: "remove" };
    session.commit("Remove", [session.patchFor(undefined, after)]);
    if (store.get().selectedId === elementId) store.set({ selectedId: null });
    return { changeId: after.id };
  },

  add_note({ elementId, note }: { elementId: string; note: string }) {
    const el = requireElement(elementId);
    const before = session.findChange(elementId, "note") as NoteChange | undefined;
    const text = note.trim();
    if (!before && !text) return { changed: false };
    if (before && before.note === text) return { changed: false, changeId: before.id };
    const after: NoteChange | null = text ? { ...(before ?? base(el, elementId)), type: "note", note: text } : null;
    const patch = session.patchFor(before, after);
    session.commit(text ? "Note" : "Delete note", [patch]);
    return { changed: true, changeId: patch.id };
  },

  move_element({ elementId, targetId, position }: { elementId: string; targetId: string; position: "before" | "after" }) {
    const el = requireElement(elementId);
    const target = requireElement(targetId);
    if (el === target) throw new CommandError("An element can't be moved relative to itself");
    if (el.contains(target)) throw new CommandError("An element can't be moved inside itself");
    if (!el.parentElement || !target.parentElement || target.parentElement === document.documentElement)
      throw new CommandError("That target can't hold a moved element");
    const already = position === "before" ? el.nextElementSibling === target : el.previousElementSibling === target;
    if (already) return { changed: false };

    const before = session.findChange(elementId, "move") as MoveChange | undefined;
    // Check against the original position: moving back there drops the change.
    if (before) engine.unapply(before);
    const backHome = position === "before" ? el.nextElementSibling === target : el.previousElementSibling === target;
    const fresh = before ? null : base(el, elementId);
    // Selectors are taken with the element in its original place.
    const fromParentSelector = stableSelector(el.parentElement!);
    const parentSelector = stableSelector(target.parentElement);
    const targetSelector = stableSelector(target);
    if (before) engine.apply(before);

    const after: MoveChange | null = backHome
      ? null
      : {
          ...(before ?? fresh!),
          type: "move",
          position,
          targetId,
          targetSelector,
          targetSnippet: snippet(target, 60),
          parentSelector,
          fromParentSelector,
        };
    const patch = session.patchFor(before, after);
    session.commit("Move", [patch]);
    return { changed: true, changeId: patch.id };
  },

  set_color({ elementId, property, color }: { elementId: string; property: ColorProperty; color: string }) {
    const el = requireElement(elementId);
    const palette = paletteFor(el);
    const before = session.findColorChange(elementId, property);
    const original = before?.oldValue ?? computedColor(el, property);
    const detected = detectClass(el.classList, property, original, palette);
    const oldValue: ColorValue = before?.oldValue ?? { hex: original.hex, alpha: original.alpha, className: detected.match?.className ?? null };
    const newValue = resolvePick(color, property, palette, detected.match);
    if (!newValue) throw new CommandError("Color must be a hex like #2b2723 or a palette token like zinc-800");
    const result = { className: newValue.className, hex: newValue.hex };
    if (before ? sameColor(before.newValue, newValue) : sameColor(oldValue, newValue)) return { changed: false, changeId: before?.id, ...result };
    // Picking the original color again removes the change.
    const after: ColorChange | null = sameColor(oldValue, newValue)
      ? null
      : { ...(before ?? base(el, elementId)), type: "color", property, oldValue, newValue, alsoOnElement: before?.alsoOnElement ?? detected.others };
    const patch = session.patchFor(before, after);
    session.commit("Color", [patch]);
    return { changed: true, changeId: patch.id, ...result };
  },

  revert_change({ changeId }: { changeId: string }) {
    const before = session.changes().find((c) => c.id === changeId);
    if (!before) throw new CommandError(`Unknown change "${changeId}"`);
    session.commit("Revert", [session.patchFor(before, null)]);
    return { reverted: changeId };
  },

  undo() {
    const label = session.undo();
    return { undone: label, canUndo: store.get().canUndo, canRedo: store.get().canRedo };
  },

  redo() {
    const label = session.redo();
    return { redone: label, canUndo: store.get().canUndo, canRedo: store.get().canRedo };
  },

  clear_all() {
    const list = session.changes();
    session.commit(
      "Clear all",
      list.map((c) => session.patchFor(c, null)).reverse(),
    );
    return { cleared: list.length };
  },

  list_changes() {
    return session.changes().map(view);
  },

  get_prompt() {
    return { prompt: buildPrompt(session.changes()), count: session.changes().length };
  },

  async copy_prompt() {
    const prompt = buildPrompt(session.changes());
    await copyText(prompt);
    store.set({ toast: { text: "Copied", at: Date.now() } });
    return { prompt, count: session.changes().length };
  },

  find_elements(params: { query?: string; text?: string; selector?: string; limit?: number }) {
    if (!params.query && !params.text && !params.selector) throw new CommandError("Provide query, text or selector");
    return find(params);
  },

  get_page_outline({ limit, includeSelectors }: { limit?: number; includeSelectors?: boolean }) {
    return outline(limit ?? 200, includeSelectors ?? false);
  },

  select_parent({ elementId }: { elementId?: string }) {
    const id = elementId ?? store.get().selectedId;
    if (!id) throw new CommandError("Nothing is selected");
    const parent = requireElement(id).parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) throw new CommandError("The element has no selectable parent");
    const parentId = idOf(parent);
    store.set({ selectedId: parentId, noteEditingId: null });
    return { selectedId: parentId, tag: parent.localName, text: snippet(parent), selector: stableSelector(parent) };
  },

  set_enabled({ enabled }: { enabled: boolean }) {
    store.set({ enabled, ...(enabled ? {} : { selectedId: null, editingId: null, noteEditingId: null, colorEditingId: null }) });
    return { enabled };
  },
};

export type CommandListener = (name: string, params: unknown, result: CommandResult) => void;
const listeners = new Set<CommandListener>();

/** Run a command by name. Validates params and never throws. */
export async function executeCommand(name: string, params: unknown = {}): Promise<CommandResult> {
  const def = getDefinition(name);
  if (!def) return { ok: false, error: `Unknown command "${name}". Available: ${COMMAND_DEFINITIONS.map((d) => d.name).join(", ")}` };
  const p = params ?? {};
  const invalid = validate(p, def.parameters);
  if (invalid) return { ok: false, error: invalid };
  let result: CommandResult;
  try {
    const data = await handlers[def.name](p);
    result = { ok: true, data };
  } catch (err) {
    result = { ok: false, error: err instanceof Error ? err.message : String(err) };
    if (!(err instanceof CommandError)) console.error(`Reword: ${name} failed`, err);
  }
  for (const l of listeners) l(name, p, result);
  return result;
}

/** Observe every executed command (e.g. to log or mirror actions to an agent). */
export function onCommand(listener: CommandListener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export const CommandRegistry = { executeCommand, getToolDefinitions, onCommand, definitions: COMMAND_DEFINITIONS };
