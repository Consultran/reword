// The change model. Changes are plain data (serializable to storage) plus a
// runtime elementId that is re-resolved from `selector` after a reload.
import type { ColorProperty } from "./palette";

/** The page a change was made on. Changes from every page of a site share one session. */
export interface PageRef {
  /** origin + pathname + search: the identity used for grouping. */
  key: string;
  url: string;
  title: string;
}

interface BaseChange {
  id: string;
  page: PageRef;
  /** Runtime element ID, or null when the element can't be found on the page. */
  elementId: string | null;
  /** Stable selector recorded when the change was first made (pre-change DOM). */
  selector: string;
  tag: string;
  section: string;
  /** Short visible text of the element when first changed, in source casing. */
  snippet: string;
  /** Truncated outerHTML of the element when first changed. */
  contextHtml: string;
  /** Individual text-node segments when the copy is split across elements (`Ship <span>faster</span>`). */
  segments: string[];
  /** Framework/tooling data attributes found on the element or its ancestors. */
  sourceHints: string[];
}

export interface EditChange extends BaseChange {
  type: "edit";
  oldText: string;
  newText: string;
}

export interface RemoveChange extends BaseChange {
  type: "remove";
}

export interface NoteChange extends BaseChange {
  type: "note";
  note: string;
}

export interface MoveChange extends BaseChange {
  type: "move";
  position: "before" | "after";
  targetId: string | null;
  targetSelector: string;
  targetSnippet: string;
  /** The container the element ends up in (the target's parent). */
  parentSelector: string;
  /** The container the element started in; equals parentSelector for a reorder among siblings. */
  fromParentSelector?: string;
}

export interface ColorValue {
  /** Opaque part, lowercase #rrggbb. */
  hex: string;
  /** 0 (transparent) to 1 (opaque). */
  alpha: number;
  /** The Tailwind class for this color ("dark:bg-zinc-800/50"), or null when none matches. */
  className: string | null;
}

export interface ColorChange extends BaseChange {
  type: "color";
  property: ColorProperty;
  oldValue: ColorValue;
  newValue: ColorValue & { closest?: { className: string; hex: string } };
  /** Other palette classes for the same property on the element (other variants). */
  alsoOnElement: string[];
}

export type Change = EditChange | RemoveChange | NoteChange | MoveChange | ColorChange;
export type ChangeType = Change["type"];

/** One reversible step: the change with this id goes from `before` to `after` (null = absent). */
export interface Patch {
  id: string;
  before: Change | null;
  after: Change | null;
  /** List position used when inserting. */
  index: number;
}

export interface HistoryEntry {
  label: string;
  patches: Patch[];
}

const RUNTIME_FIELDS = ["elementId", "targetId"] as const;
const TYPES: ChangeType[] = ["edit", "remove", "note", "move", "color"];

export function serialize(change: Change): Record<string, unknown> {
  const out: Record<string, unknown> = { ...change };
  for (const f of RUNTIME_FIELDS) delete out[f];
  return out;
}

/** Compares a change's saved content. Key order is ignored because browser storage can reorder keys. */
export function changeFingerprint(change: Change): string {
  return JSON.stringify(serialize(change), (_key, value: unknown) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : value,
  );
}

/**
 * Combines this tab's list with the saved one. `lastSeen` is the saved list this
 * tab last knew about, which tells "I removed it" apart from "someone else added it".
 */
export function mergeChanges(lastSeen: Map<string, string>, mine: Change[], saved: Change[]): Change[] {
  const mineById = new Map(mine.map((c) => [c.id, c]));
  const changedHere = (c: Change) => lastSeen.get(c.id) !== changeFingerprint(c);

  const merged = saved.flatMap((theirs) => {
    const own = mineById.get(theirs.id);
    // Gone here: honor that only if the saved copy is still the one this tab removed.
    if (!own) return lastSeen.get(theirs.id) === changeFingerprint(theirs) ? [] : [theirs];
    const changedElsewhere = changeFingerprint(own) !== changeFingerprint(theirs);
    return [changedElsewhere && !changedHere(own) ? theirs : own];
  });

  const savedIds = new Set(saved.map((c) => c.id));
  for (const c of mine) {
    if (savedIds.has(c.id) || !changedHere(c)) continue;
    const lastOnPage = merged.map((m) => m.page.key).lastIndexOf(c.page.key);
    merged.splice(lastOnPage === -1 ? merged.length : lastOnPage + 1, 0, c);
  }
  return merged;
}

/** Stored data from older versions (or another tool) is dropped rather than half-applied. */
export function isStoredChange(value: unknown): value is Change {
  const c = value as Partial<Change> | null;
  return !!c && typeof c.id === "string" && TYPES.includes(c.type as ChangeType) && typeof c.selector === "string" && !!c.page?.key;
}
