// Applies a text edit by changing only the words that differ, inside the page's
// existing text nodes, so links and other inline elements around them survive.
import { extractText } from "./text";

const ZERO_WIDTH_CHARACTER = /[​-‍﻿]/;
const MAX_WORD_COMPARISONS = 1_000_000;
const MEDIA_IN_LINK = "img,svg,video,picture,canvas";

interface PageCharacter {
  run: Text;
  /** UTF-16 offsets in the text node. An emoji spans two. */
  start: number;
  end: number;
  ch: string;
}

interface Point {
  run: Text;
  offset: number;
}

interface Word {
  text: string;
  /** What separates this word from the previous one: a space or line breaks. */
  gapBefore: string;
}

interface PageWord extends Word {
  characters: PageCharacter[];
}

/** Replaces a stretch of existing text, or adds new text right beside a link. */
type TextChange = { from: Point; to: Point; text: string } | { besideLink: Element; afterLink: boolean; text: string };

/** Where new words go. `followsPrevious` says which side of them needs the word gap. */
type InsertionSpot = { point: Point; followsPrevious: boolean } | { besideLink: Element; afterLink: boolean; followsPrevious: boolean };

/** One character or word gap, used to narrow a replacement to what differs. */
interface Slot {
  ch: string;
  character?: PageCharacter;
}

const startOf = (c: PageCharacter): Point => ({ run: c.run, offset: c.start });
const endOf = (c: PageCharacter): Point => ({ run: c.run, offset: c.end });
const firstOf = (word: PageWord) => word.characters[0]!;
const lastOf = (word: PageWord) => word.characters[word.characters.length - 1]!;
const hasLineBreak = (gap: string) => gap.includes("\n");

function wordsIn(text: string): Word[] {
  return Array.from(text.matchAll(/(\s*)(\S+)/g), ([, space, word]) => {
    const lineBreaks = space!.split("\n").length - 1;
    return { text: word!, gapBefore: lineBreaks ? "\n".repeat(lineBreaks) : " " };
  });
}

/** Ties each word of the old text to its characters on the page, or null if they differ. */
function pageWordsFor(runs: Text[], oldText: string): PageWord[] | null {
  const characters: PageCharacter[] = [];
  for (const run of runs) {
    let start = 0;
    for (const ch of run.data) {
      const end = start + ch.length;
      if (!/\s/.test(ch) && !ZERO_WIDTH_CHARACTER.test(ch)) characters.push({ run, start, end, ch });
      start = end;
    }
  }
  let next = 0;
  const words: PageWord[] = [];
  for (const word of wordsIn(oldText.replace(new RegExp(ZERO_WIDTH_CHARACTER.source, "g"), ""))) {
    const wordCharacters: PageCharacter[] = [];
    for (const ch of word.text) {
      const character = characters[next++];
      if (character?.ch !== ch) return null;
      wordCharacters.push(character);
    }
    words.push({ ...word, characters: wordCharacters });
  }
  return words.length && next === characters.length ? words : null;
}

/** Pairs of [old index, new index] for words kept by the edit (longest common subsequence). */
function matchingWords(oldWords: string[], newWords: string[]): [number, number][] {
  const shorter = Math.min(oldWords.length, newWords.length);
  let start = 0;
  while (start < shorter && oldWords[start] === newWords[start]) start++;
  let tail = 0;
  while (tail < shorter - start && oldWords[oldWords.length - 1 - tail] === newWords[newWords.length - 1 - tail]) tail++;

  const pairs: [number, number][] = [];
  for (let i = 0; i < start; i++) pairs.push([i, i]);
  const oldCount = oldWords.length - start - tail;
  const newCount = newWords.length - start - tail;
  if (oldCount && newCount && oldCount * newCount <= MAX_WORD_COMPARISONS) {
    const width = newCount + 1;
    const longest = new Uint32Array((oldCount + 1) * width);
    const at = (i: number, j: number) => i * width + j;
    for (let i = oldCount - 1; i >= 0; i--) {
      for (let j = newCount - 1; j >= 0; j--) {
        longest[at(i, j)] =
          oldWords[start + i] === newWords[start + j]
            ? longest[at(i + 1, j + 1)]! + 1
            : Math.max(longest[at(i + 1, j)]!, longest[at(i, j + 1)]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < oldCount && j < newCount) {
      if (oldWords[start + i] === newWords[start + j]) pairs.push([start + i++, start + j++]);
      else if (longest[at(i + 1, j)]! >= longest[at(i, j + 1)]!) i++;
      else j++;
    }
  }
  for (let i = tail; i > 0; i--) pairs.push([oldWords.length - i, newWords.length - i]);
  return pairs;
}

function depthInside(el: Element, node: Node): number {
  let depth = 0;
  for (let parent = node.parentNode; parent && parent !== el; parent = parent.parentNode) depth++;
  return depth;
}

/** The link holding this text, when the link sits inside the element being edited. */
function linkAround(el: Element, run: Text): Element | null {
  const link = run.parentElement?.closest("a");
  return link && link !== el && el.contains(link) ? link : null;
}

function lineBreaksBetween(el: Element, from: Text, to: Text): Element[] {
  if (from === to) return [];
  return Array.from(el.querySelectorAll("br")).filter(
    (br) => from.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_FOLLOWING && to.compareDocumentPosition(br) & Node.DOCUMENT_POSITION_PRECEDING,
  );
}

function planChanges(el: Element, oldWords: PageWord[], newWords: Word[]): TextChange[] {
  const changes: TextChange[] = [];
  const replaceRange = (from: Point, to: Point, text: string) => changes.push({ from, to, text });

  /** A line break between block elements comes from the layout, so text edits can't change it. */
  const isLayoutBreak = (previous: PageCharacter, next: PageCharacter) =>
    previous.run !== next.run && !lineBreaksBetween(el, previous.run, next.run).length;

  /** New words stay out of a link unless they land between two of its words. */
  const insertionSpot = (previous: PageCharacter | undefined, next: PageCharacter | undefined): InsertionSpot => {
    const afterPrevious = () => ({ point: endOf(previous!), followsPrevious: true });
    const beforeNext = () => ({ point: startOf(next!), followsPrevious: false });
    const previousLink = previous ? linkAround(el, previous.run) : null;
    const nextLink = next ? linkAround(el, next.run) : null;
    if (previous && next && previous.run === next.run) return afterPrevious();
    if (previousLink !== nextLink) {
      if (previous && !previousLink) return afterPrevious();
      if (next && !nextLink) return beforeNext();
      return previousLink
        ? { besideLink: previousLink, afterLink: true, followsPrevious: true }
        : { besideLink: nextLink!, afterLink: false, followsPrevious: false };
    }
    const nextIsOuter = previous && next && depthInside(el, next.run) < depthInside(el, previous.run);
    return next && (!previous || nextIsOuter) ? beforeNext() : afterPrevious();
  };

  const insertAt = (spot: InsertionSpot, text: string) => {
    if ("point" in spot) replaceRange(spot.point, spot.point, text);
    else changes.push({ besideLink: spot.besideLink, afterLink: spot.afterLink, text });
  };

  const setGap = (oldIndex: number, newGap: string) => {
    const oldGap = oldWords[oldIndex]!.gapBefore;
    if (oldGap === newGap) return;
    const previous = lastOf(oldWords[oldIndex - 1]!);
    const next = firstOf(oldWords[oldIndex]!);
    if (hasLineBreak(oldGap) && isLayoutBreak(previous, next)) return;
    replaceRange(endOf(previous), startOf(next), newGap);
  };

  const insertWords = (oldIndex: number, added: Word[], wordAfter: Word | undefined) => {
    const previous = oldWords[oldIndex - 1] && lastOf(oldWords[oldIndex - 1]!);
    const next = oldWords[oldIndex] && firstOf(oldWords[oldIndex]!);
    const withLeadingGaps = added.map((w) => w.gapBefore + w.text).join("");
    const gapAfter = wordAfter?.gapBefore ?? " ";
    const oldGap = oldWords[oldIndex]?.gapBefore ?? " ";
    const touchesLineBreak = [oldGap, added[0]!.gapBefore, gapAfter].some(hasLineBreak);
    if (previous && next && touchesLineBreak && !(hasLineBreak(oldGap) && isLayoutBreak(previous, next))) {
      replaceRange(endOf(previous), startOf(next), withLeadingGaps + gapAfter);
      return;
    }
    const spot = insertionSpot(previous, next);
    insertAt(spot, spot.followsPrevious ? withLeadingGaps : withLeadingGaps.slice(added[0]!.gapBefore.length) + gapAfter);
  };

  /** Removes the words and the space on one side, so no double space is left behind. */
  const deleteWords = (start: number, end: number, wordAfter: Word | undefined) => {
    const first = firstOf(oldWords[start]!);
    const last = lastOf(oldWords[end - 1]!);
    const next = oldWords[end] && firstOf(oldWords[end]!);
    const previous = oldWords[start - 1] && lastOf(oldWords[start - 1]!);
    const touchesLineBreak =
      oldWords.slice(start, end + 1).some((w) => hasLineBreak(w.gapBefore)) || (wordAfter && hasLineBreak(wordAfter.gapBefore));

    if (touchesLineBreak) {
      if (previous && next && !isLayoutBreak(previous, next)) return replaceRange(endOf(previous), startOf(next), wordAfter!.gapBefore);
      if (!previous && next) return replaceRange(startOf(first), startOf(next), "");
      if (previous && !next) return replaceRange(endOf(previous), endOf(last), "");
    } else {
      if (next?.run === last.run) return replaceRange(startOf(first), startOf(next), "");
      if (previous?.run === first.run) return replaceRange(endOf(previous), endOf(last), "");
    }
    return replaceRange(startOf(first), endOf(last), "");
  };

  const replaceWords = (oldPart: PageWord[], newPart: Word[]) => {
    const before: Slot[] = oldPart.flatMap((word, i) => [
      ...(i ? [{ ch: word.gapBefore }] : []),
      ...word.characters.map((character) => ({ ch: character.ch, character })),
    ]);
    const after: Slot[] = newPart.flatMap((word, i) => [...(i ? [{ ch: word.gapBefore }] : []), ...Array.from(word.text, (ch) => ({ ch }))]);
    const shorter = Math.min(before.length, after.length);
    let start = 0;
    while (start < shorter && before[start]!.ch === after[start]!.ch) start++;
    let tail = 0;
    while (tail < shorter - start && before[before.length - 1 - tail]!.ch === after[after.length - 1 - tail]!.ch) tail++;
    const end = before.length - tail;
    const text = after.slice(start, after.length - tail).map((slot) => slot.ch).join("");
    const left = before[start - 1]?.character;
    const right = before[start]?.character;

    if (start === end) {
      if (text) insertAt(insertionSpot(left, right), text);
      return;
    }
    const last = before[end - 1]!.character;
    replaceRange(right ? startOf(right) : endOf(left!), last ? endOf(last) : startOf(before[end]!.character!), text);
  };

  /** Words that start in the same text node stay together, so each node keeps its share. */
  const replaceAcrossNodes = (oldStart: number, oldEnd: number, newStart: number, newEnd: number) => {
    const groups: [number, number][] = [];
    for (let i = oldStart; i < oldEnd; i++) {
      const group = groups[groups.length - 1];
      if (group && firstOf(oldWords[i]!).run === firstOf(oldWords[group[0]]!).run) group[1] = i + 1;
      else groups.push([i, i + 1]);
    }
    let nextNew = newStart;
    for (const [index, [start, end]] of groups.entries()) {
      const remaining = newEnd - nextNew;
      if (!remaining) {
        // The new words ran out: everything left in this stretch goes.
        replaceRange(endOf(lastOf(oldWords[start - 1]!)), endOf(lastOf(oldWords[oldEnd - 1]!)), "");
        return;
      }
      const take = index === groups.length - 1 ? remaining : Math.min(end - start, remaining);
      replaceWords(oldWords.slice(start, end), newWords.slice(nextNew, nextNew + take));
      nextNew += take;
    }
  };

  const pairs = matchingWords(oldWords.map((w) => w.text), newWords.map((w) => w.text));
  let oldAt = 0;
  let newAt = 0;
  for (const [oldIndex, newIndex] of [...pairs, [oldWords.length, newWords.length] as [number, number]]) {
    const wordAfter = newWords[newIndex];
    const hasOldWordAfter = oldIndex < oldWords.length;
    if (oldAt === oldIndex && newAt === newIndex) {
      if (oldIndex > 0 && hasOldWordAfter) setGap(oldIndex, wordAfter!.gapBefore);
    } else if (oldAt === oldIndex) {
      insertWords(oldIndex, newWords.slice(newAt, newIndex), wordAfter);
    } else if (newAt === newIndex) {
      deleteWords(oldAt, oldIndex, wordAfter);
    } else {
      if (oldAt > 0) setGap(oldAt, newWords[newAt]!.gapBefore);
      replaceAcrossNodes(oldAt, oldIndex, newAt, newIndex);
      if (hasOldWordAfter) setGap(oldIndex, wordAfter!.gapBefore);
    }
    oldAt = oldIndex + 1;
    newAt = newIndex + 1;
  }
  return changes;
}

/**
 * Changes only the words that differ. Returns a function that restores the
 * original, or null when the page text doesn't match `oldText`.
 */
export function editChangedWords(el: Element, oldText: string, newText: string): (() => void) | null {
  const runs = extractText(el).textNodes;
  const oldWords = pageWordsFor(runs, oldText);
  if (!oldWords) return null;

  const originalText = runs.map((run) => ({ run, data: run.data }));
  const addedNodes: ChildNode[] = [];
  const removedNodes: { node: ChildNode; parent: ParentNode; next: ChildNode | null }[] = [];
  const remove = (node: ChildNode) => {
    removedNodes.push({ node, parent: node.parentNode!, next: node.nextSibling });
    node.remove();
  };
  const add = (node: ChildNode, parent: ParentNode, before: ChildNode | null) => {
    parent.insertBefore(node, before);
    addedNodes.push(node);
  };
  /** Adds extra lines (each after a <br>) in front of `before`. */
  const addLines = (lines: string[], parent: ParentNode, before: ChildNode | null) => {
    lines.forEach((line, i) => {
      if (i) add(document.createElement("br"), parent, before);
      if (line) add(document.createTextNode(line), parent, before);
    });
  };

  const write = (change: TextChange) => {
    const lines = change.text.split("\n");
    if ("besideLink" in change) {
      const { besideLink, afterLink } = change;
      addLines(lines, besideLink.parentNode!, afterLink ? besideLink.nextSibling : besideLink);
      return;
    }
    const { from, to } = change;
    const sameRun = from.run === to.run;
    const head = from.run.data.slice(0, from.offset);
    const remainder = to.run.data.slice(to.offset);
    lineBreaksBetween(el, from.run, to.run).forEach(remove);
    for (let i = runs.indexOf(from.run) + 1; i < runs.indexOf(to.run); i++) runs[i]!.data = "";
    if (!sameRun) to.run.data = remainder;
    from.run.data = head + lines[0] + (sameRun && lines.length === 1 ? remainder : "");
    if (lines.length > 1) {
      const rest = ["", ...lines.slice(1)];
      if (sameRun) rest[rest.length - 1] += remainder;
      addLines(rest, from.run.parentNode!, from.run.nextSibling);
    }
  };

  const linksWithOldWords = new Set(oldWords.flatMap((word) => word.characters.map((c) => linkAround(el, c.run))));
  // Last to first, so offsets for earlier changes stay valid.
  for (const change of planChanges(el, oldWords, wordsIn(newText)).reverse()) write(change);
  for (const link of linksWithOldWords) {
    if (link && !link.textContent?.trim() && !link.querySelector(MEDIA_IN_LINK)) remove(link);
  }

  return () => {
    for (const { node, parent, next } of [...removedNodes].reverse()) parent.insertBefore(node, next);
    for (const node of addedNodes) node.remove();
    for (const { run, data } of originalText) run.data = data;
  };
}
