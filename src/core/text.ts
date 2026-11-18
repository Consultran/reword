/**
 * Collapse runs of whitespace inside each line, trim lines, drop runs of
 * blank lines beyond one, and trim the whole thing. Line breaks survive.
 */
export function normalize(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/[   ]/g, ' ')
    .replace(/[​‌‍﻿]/g, '')
    .split('\n')
    .map((line) => line.replace(/[ \t\f\v]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'SVG', 'svg', 'IFRAME', 'OBJECT', 'CANVAS', 'VIDEO', 'AUDIO']);
const BLOCK_DISPLAYS = new Set(['block', 'flex', 'grid', 'list-item', 'table', 'table-row', 'flow-root']);

export interface ExtractedText {
  text: string;
  /** Each non-empty text node, trimmed. More than one means the copy is split across elements. */
  segments: string[];
  /** The text nodes that make up `text`, in order. Hidden content isn't included. */
  textNodes: Text[];
}

function isVisuallyHidden(el: Element, style: CSSStyleDeclaration): boolean {
  if (style.display === 'none' || style.visibility === 'hidden') return true;
  // Tailwind/Bootstrap `sr-only`: 1px box that is clipped away.
  if (style.position === 'absolute' && (style.clip.startsWith('rect(0') || style.clipPath.includes('inset(50%'))) {
    const rect = el.getBoundingClientRect();
    if (rect.width <= 1 && rect.height <= 1) return true;
  }
  return false;
}

/**
 * Read the copy of an element the way it is written in source, not the way
 * CSS renders it. Unlike `innerText` this ignores `text-transform`, so an
 * `uppercase` button still reads "Book a demo".
 */
export function extractText(root: Element): ExtractedText {
  const segments: string[] = [];
  const textNodes: Text[] = [];
  let out = '';

  const walk = (node: Node, preserveNewlines: boolean) => {
    if (node.nodeType === Node.TEXT_NODE) {
      textNodes.push(node as Text);
      const raw = node.nodeValue ?? '';
      const text = preserveNewlines ? raw : raw.replace(/\s+/g, ' ');
      out += text;
      const seg = normalize(raw);
      if (seg) segments.push(seg);
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    const el = node as Element;
    if (SKIP_TAGS.has(el.tagName) || el.hasAttribute('hidden')) return;
    if (el.tagName === 'BR') {
      out += '\n';
      return;
    }
    const style = getComputedStyle(el);
    if (el !== root && isVisuallyHidden(el, style)) return;
    const pre = style.whiteSpace.startsWith('pre') || style.whiteSpace === 'break-spaces';
    const block = el !== root && BLOCK_DISPLAYS.has(style.display);
    if (block) out += '\n';
    for (const child of Array.from(el.childNodes)) walk(child, pre);
    if (block) out += '\n';
  };

  walk(root, false);
  return { text: normalize(out), segments, textNodes };
}

export function textMatches(el: Element, expected: string): boolean {
  return extractText(el).text === normalize(expected);
}
