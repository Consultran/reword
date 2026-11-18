// Change list, undo/redo history and persistence. commit() is the single path
// by which the change list and the page DOM are modified.
import {
  changeFingerprint,
  isStoredChange,
  mergeChanges,
  serialize,
  type Change,
  type ColorChange,
  type HistoryEntry,
  type PageRef,
  type Patch,
} from "./changes";
import { HOST_TAG, setOriginalTextLookup, textOf } from "./describe";
import * as engine from "./engine";
import type { ColorProperty } from "./palette";
import { elementOf, idOf } from "./registry";
import { store } from "./store";
import type { ChangeStore } from "./types";

const undoStack: HistoryEntry[] = [];
const redoStack: HistoryEntry[] = [];
let nextChangeId = 1;
/** Keeps ids from two tabs, or a page restored by Back, from colliding. */
const thisCopyTag = Math.random().toString(36).slice(2, 7);
let backend: ChangeStore | null = null;
let loaded: Promise<void> | null = null;
let lastSeenSaved = new Map<string, string>();
let saveQueue: Promise<void> = Promise.resolve();
let reapplyChanges: (() => void) | null = null;

export const currentPageKey = () => `${location.origin}${location.pathname}${location.search}`;

export function currentPage(): PageRef {
  return { key: currentPageKey(), url: location.href, title: document.title };
}

export const isOnCurrentPage = (c: Change) => c.page.key === currentPageKey();

export function newChangeId(): string {
  return `ch_${nextChangeId++}_${thisCopyTag}`;
}

setOriginalTextLookup((el) => {
  const c = changes().find((c) => c.type === "edit" && elementOf(c.elementId) === el);
  return c?.type === "edit" ? c.oldText : undefined;
});

export function changes(): Change[] {
  return store.get().changes;
}

export function findChange(elementId: string, type: Change["type"]): Change | undefined {
  return changes().find((c) => c.elementId === elementId && c.type === type);
}

/** An element can have one color change per property (background, text, border). */
export function findColorChange(elementId: string, property: ColorProperty): ColorChange | undefined {
  return changes().find((c): c is ColorChange => c.elementId === elementId && c.type === "color" && c.property === property);
}

function applyToList(list: Change[], patch: Patch, dir: "forward" | "back"): Change[] {
  const to = dir === "forward" ? patch.after : patch.before;
  const i = list.findIndex((c) => c.id === patch.id);
  if (!to) return i === -1 ? list : list.filter((c) => c.id !== patch.id);
  if (i !== -1) return list.map((c) => (c.id === patch.id ? to : c));
  const at = Math.min(Math.max(patch.index, 0), list.length);
  return [...list.slice(0, at), to, ...list.slice(at)];
}

function run(patches: Patch[], dir: "forward" | "back") {
  let list = changes();
  const ordered = dir === "forward" ? patches : [...patches].reverse();
  for (const p of ordered) {
    if (dir === "forward") engine.transition(p.before, p.after);
    else engine.transition(p.after, p.before);
    list = applyToList(list, p, dir);
  }
  return list;
}

function update(list: Change[]) {
  store.set({ changes: list, canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
  const selected = elementOf(store.get().selectedId);
  if (selected && !(selected as HTMLElement).offsetParent && !selected.getClientRects().length) store.set({ selectedId: null });
  syncSavedChanges();
}

/** Applies patches, records them as one undoable step. */
export function commit(label: string, patches: Patch[]) {
  if (!patches.length) return;
  const list = run(patches, "forward");
  undoStack.push({ label, patches });
  redoStack.length = 0;
  update(list);
}

export function undo(): string | null {
  const entry = undoStack.pop();
  if (!entry) return null;
  const list = run(entry.patches, "back");
  redoStack.push(entry);
  update(list);
  return entry.label;
}

export function redo(): string | null {
  const entry = redoStack.pop();
  if (!entry) return null;
  const list = run(entry.patches, "forward");
  undoStack.push(entry);
  update(list);
  return entry.label;
}

/**
 * Patch that inserts a new change or replaces the existing one with the same id.
 * New changes go after the last change from the same page, so the list stays
 * grouped by page and numbers match the prompt.
 */
export function patchFor(before: Change | undefined, after: Change | null): Patch {
  const list = changes();
  const id = before?.id ?? after?.id ?? newChangeId();
  let index = list.length;
  if (before) index = list.findIndex((c) => c.id === before.id);
  else if (after) {
    const last = list.map((c) => c.page.key).lastIndexOf(after.page.key);
    if (last !== -1) index = last + 1;
  }
  return { id, before: before ?? null, after, index };
}

// ---- Persistence -----------------------------------------------------------

function fromStorage(stored: unknown): Change[] {
  return (Array.isArray(stored) ? stored : []).filter(isStoredChange).map((c) => ({
    ...c,
    segments: c.segments ?? [],
    sourceHints: c.sourceHints ?? [],
    elementId: null,
    ...(c.type === "move" ? { targetId: null } : {}),
  })) as Change[];
}

const fingerprintsOf = (list: Change[]) => new Map(list.map((c) => [c.id, changeFingerprint(c)]));

function isSameList(a: Change[], b: Change[]) {
  return a.length === b.length && a.every((c, i) => changeFingerprint(c) === changeFingerprint(b[i]!));
}

/** Undo steps for a change another tab altered would put back an outdated version. Other changes in the step stay undoable. */
function forgetHistoryOf(changeIds: Set<string>) {
  for (const stack of [undoStack, redoStack]) {
    const kept = stack
      .map((entry) => ({ ...entry, patches: entry.patches.filter((p) => !changeIds.has(p.id)) }))
      .filter((entry) => entry.patches.length);
    stack.splice(0, stack.length, ...kept);
  }
  store.set({ canUndo: undoStack.length > 0, canRedo: redoStack.length > 0 });
}

/** Brings this tab's list and page up to date. Edits made while saving are kept for the next save. */
function showMergedChanges(sentToStorage: Change[], merged: Change[]) {
  const current = changes();
  const next = mergeChanges(fingerprintsOf(sentToStorage), current, merged);
  if (next.length === current.length && next.every((c, i) => c === current[i])) return;

  const stillListed = new Set(next);
  const wasListed = new Set(current);
  const dropped = current.filter((c) => !stillListed.has(c));
  const arrived = next.filter((c) => !wasListed.has(c));
  // Changes of one kind on an element build on each other, so survivors come off and go back on with it.
  const survivors = new Set(
    next.filter((c) => wasListed.has(c) && c.elementId && dropped.some((d) => d.elementId === c.elementId && d.type === c.type)),
  );
  for (const c of [...current].reverse()) if (!stillListed.has(c) || survivors.has(c)) engine.unapply(c);
  for (const c of next) if (survivors.has(c)) engine.apply(c);
  store.set({ changes: next });
  forgetHistoryOf(new Set([...dropped, ...arrived].map((c) => c.id)));
  reapplyChanges?.();
}

async function mergeWithStorage() {
  if (!backend) return;
  const saved = fromStorage(await backend.load());
  const mine = changes();
  const merged = mergeChanges(lastSeenSaved, mine, saved);
  if (!isSameList(merged, saved)) await backend.save(merged.map(serialize));
  lastSeenSaved = fingerprintsOf(merged);
  showMergedChanges(mine, merged);
}

/**
 * Lets one tab of this site read, merge and write at a time. A tab waits its turn
 * for as long as it takes. Browsers offer this lock on https and localhost; where
 * it's missing or refused the save still runs, unprotected.
 */
async function oneTabAtATime(work: () => Promise<void>) {
  const locks = navigator.locks as LockManager | undefined;
  if (!locks) return work();
  let started = false;
  try {
    await locks.request("reword:changes", () => {
      started = true;
      return work();
    });
  } catch (err) {
    if (started) throw err;
    await work();
  }
}

/**
 * Saves by merging, one at a time, so a tab or restored page holding an older
 * list can't overwrite newer edits. If storage fails, nothing is treated as
 * saved and the edits stay in this tab for the next attempt.
 */
function syncSavedChanges() {
  saveQueue = saveQueue
    .then(() => oneTabAtATime(mergeWithStorage))
    .catch((err) => console.warn("Reword: could not save changes", err));
}

/** Loads the stored session once. Nothing on the page changes until `watch()` runs. */
export function load(changeStore: ChangeStore): Promise<void> {
  backend = changeStore;
  loaded ??= changeStore
    .load()
    .catch(() => [])
    .then((stored) => {
      const list = fromStorage(stored);
      lastSeenSaved = fingerprintsOf(list);
      store.set({ changes: list, pageKey: currentPageKey() });
    });
  return loaded;
}

function resolve(selector: string): Element | null {
  if (!selector) return null;
  try {
    const found = document.querySelectorAll(selector);
    return found.length === 1 ? found[0]! : null;
  } catch {
    return null;
  }
}

/**
 * Where an edit's element went when its selector no longer matches (ids churn,
 * a sibling was inserted): the one element of the same tag whose copy is still
 * the original or the edited text.
 */
function resolveByText(c: Change): Element | null {
  if (c.type !== "edit") return null;
  const texts = [c.oldText, c.newText];
  const probe = (c.oldText.split("\n")[0] ?? "").slice(0, 24);
  const hits = Array.from(document.getElementsByTagName(c.tag)).filter(
    (el) => !el.closest(HOST_TAG) && (el.textContent ?? "").replace(/\s+/g, " ").includes(probe) && texts.includes(textOf(el)),
  );
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Resolves elements for this page's changes that aren't on the page (not found
 * yet, or replaced by a client-side re-render) and applies them. Changes from
 * other pages are left alone. Returns how many are still missing.
 */
function applyMissing(): number {
  let missing = 0;
  let touched = false;
  const list = changes().map((c) => {
    if (!isOnCurrentPage(c)) return c;
    if (elementOf(c.elementId) && (c.type !== "move" || elementOf(c.targetId))) return c;
    const el = resolve(c.selector) ?? resolveByText(c);
    const elementId = el ? idOf(el) : null;
    const target = c.type === "move" ? resolve(c.targetSelector) : null;
    const resolved = c.type === "move" ? { ...c, elementId, targetId: target ? idOf(target) : null } : { ...c, elementId };
    if (!resolved.elementId || (resolved.type === "move" && !resolved.targetId)) {
      missing++;
      return c;
    }
    touched = true;
    engine.apply(resolved);
    return resolved;
  });
  if (touched) store.set({ changes: list });
  return missing;
}

/**
 * Applies this page's changes and keeps them applied while the editor is open:
 * late-rendering pages (SPAs) get a few retries, client-side navigation and
 * framework re-renders are followed. Returns a function that stops watching.
 */
export function watch(): () => void {
  let stopped = false;
  const timers = new Set<number>();
  const later = (fn: () => void, ms: number) => {
    const t = window.setTimeout(() => {
      timers.delete(t);
      if (!stopped) fn();
    }, ms);
    timers.add(t);
  };
  const applyWithRetries = () => {
    if (!applyMissing()) return;
    for (const delay of [300, 1300, 3800]) later(applyMissing, delay);
  };

  // Client-side navigation (pushState, popstate) keeps this script alive, so follow URL changes.
  const checkUrl = () => {
    const key = currentPageKey();
    if (key === store.get().pageKey) return;
    store.set({ pageKey: key, selectedId: null, noteEditingId: null });
    applyWithRetries();
  };

  // Re-renders replace elements; throttled (not debounced) so animating pages still catch up.
  let pending = false;
  const observer = new MutationObserver((records) => {
    if (pending || records.every((r) => r.target instanceof Element && r.target.localName === HOST_TAG)) return;
    pending = true;
    later(() => {
      pending = false;
      applyMissing();
    }, 300);
  });

  // Back/Forward can restore a frozen page, and another tab may have saved edits meanwhile.
  // Not while typing: an update could replace the draft. Finishing the edit syncs anyway.
  const syncUnlessEditing = () => {
    if (!store.get().editingId) syncSavedChanges();
  };
  const onPageShow = (e: PageTransitionEvent) => {
    if (e.persisted) syncUnlessEditing();
  };
  const onVisibilityChange = () => {
    if (document.visibilityState === "visible") syncUnlessEditing();
  };

  store.set({ pageKey: currentPageKey() });
  applyWithRetries();
  reapplyChanges = applyWithRetries;
  syncSavedChanges();
  const nav = (window as unknown as { navigation?: EventTarget }).navigation;
  const onNavigate = () => later(checkUrl, 0);
  addEventListener("popstate", checkUrl);
  addEventListener("pageshow", onPageShow);
  document.addEventListener("visibilitychange", onVisibilityChange);
  nav?.addEventListener("navigatesuccess", onNavigate);
  const interval = window.setInterval(checkUrl, 500);
  observer.observe(document.documentElement, { childList: true, subtree: true });

  return () => {
    stopped = true;
    reapplyChanges = null;
    for (const t of timers) clearTimeout(t);
    removeEventListener("popstate", checkUrl);
    removeEventListener("pageshow", onPageShow);
    document.removeEventListener("visibilitychange", onVisibilityChange);
    nav?.removeEventListener("navigatesuccess", onNavigate);
    clearInterval(interval);
    observer.disconnect();
  };
}

/** Puts this page back the way it was (the stored session is kept). Used when this instance is replaced. */
export function unapplyAll() {
  for (const c of [...changes()].reverse()) engine.unapply(c);
}
