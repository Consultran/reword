// Builds the readable summary people paste into an email or a Google Doc.
// The prompt in prompt.ts is the version written for coding agents.
import type { Change, ColorValue, PageRef, TextTarget } from "./changes";
import { textTargetFor } from "./describe";

export interface Summary {
  /** Formatted with inline styles, because email and Docs drop style sheets. */
  html: string;
  text: string;
}

interface SummaryLine {
  label?: string;
  text: string;
  struck?: boolean;
  color?: ColorValue;
}

interface SummaryItem {
  action: string;
  /** What the action applies to, shown in normal text. */
  subject?: string;
  /** Where it applies, shown in gray. */
  context?: string;
  lines: SummaryLine[];
  link: string | null;
}

const WORDS_FROM_SHORTENED_TEXT = 6;
/** Saved snippets are cut to 80 characters, so a shorter one ending in … really ends that way. */
const SHORTENED_SNIPPET_LENGTH = 78;
const PROPERTY_NAME = { "background-color": "background", color: "text", "border-color": "border" } as const;

const FONT = "font-family:Arial,sans-serif";
const BODY = `margin:0 0 4px;${FONT};font-size:11pt;line-height:1.45;color:#202124`;
const DETAIL = `margin:0 0 4px 22px;${FONT};font-size:11pt;line-height:1.45;color:#202124`;
const MUTED = "color:#5f6368";
const LINK = "color:#1a56b0";

const quoted = (s: string) => `“${s}”`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const wordsIn = (s: string) => s.split(/\s+/).filter(Boolean);
const escapeHtml = (s: string) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
const encodeForTextLink = (s: string) => encodeURIComponent(s).replace(/-/g, "%2D");

function webAddress(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
    // `#/pricing` and `#!/pricing` are app routes. A plain `#section` is only a scroll position.
    if (!/^#!?\//.test(parsed.hash)) parsed.hash = "";
    return parsed.href;
  } catch {
    return null;
  }
}

/** Best guess for changes saved before Reword recorded a text target. */
function targetFromSavedChange(c: Change, changes: Change[]): TextTarget | null {
  if (c.type === "edit") return textTargetFor(c.oldText);
  const editOfSameElement = changes.find((other) => other.type === "edit" && other.page.key === c.page.key && other.selector === c.selector);
  if (editOfSameElement?.type === "edit") return textTargetFor(editOfSameElement.oldText);
  if (c.segments.length > 1) return textTargetFor(c.segments.join("\n"));
  if (c.snippet.endsWith("…") && c.snippet.length >= SHORTENED_SNIPPET_LENGTH) {
    const start = wordsIn(c.snippet).slice(0, -1).slice(0, WORDS_FROM_SHORTENED_TEXT).join(" ");
    return start ? { start } : null;
  }
  return textTargetFor(c.snippet);
}

/**
 * A link that scrolls to this change and highlights it. It searches for the
 * original wording, and if that is gone the page still opens.
 */
function linkToChange(c: Change, changes: Change[]): string | null {
  const page = webAddress(c.page.url);
  if (!page) return null;
  const target = c.textTarget === undefined ? targetFromSavedChange(c, changes) : c.textTarget;
  if (!target) return page;
  const directive =
    (target.before ? `${encodeForTextLink(target.before)}-,` : "") +
    encodeForTextLink(target.start) +
    (target.end ? `,${encodeForTextLink(target.end)}` : "") +
    (target.after ? `,-${encodeForTextLink(target.after)}` : "");
  return `${page}${new URL(page).hash ? "" : "#"}:~:text=${directive}`;
}

const subjectOf = (c: Change) => (c.snippet ? quoted(c.snippet) : `the ${c.tag} element`);

function sectionOf(c: Change): string | undefined {
  return c.section && c.section !== "Page body" ? `in ${c.section.replace(" — ", ", ")}` : undefined;
}

function colorName(value: ColorValue): string {
  if (value.alpha === 0) return "transparent";
  const hex = value.hex.toUpperCase();
  return value.alpha < 1 ? `${hex} at ${Math.round(value.alpha * 100)}% opacity` : hex;
}

function itemFor(c: Change, changes: Change[]): SummaryItem {
  const link = linkToChange(c, changes);
  switch (c.type) {
    case "edit":
      return {
        action: "Change text",
        context: sectionOf(c),
        lines: [
          { label: "Was", text: c.oldText || "(no text)", struck: true },
          { label: "Now", text: c.newText || "(no text)" },
        ],
        link,
      };
    case "note":
      return { action: "Note", context: c.snippet ? `on ${quoted(c.snippet)}` : sectionOf(c), lines: [{ text: c.note }], link };
    case "remove":
      return { action: "Remove", subject: subjectOf(c), lines: [], link };
    case "move": {
      const target = c.targetSnippet ? quoted(c.targetSnippet) : "the neighboring element";
      return { action: "Move", subject: `${subjectOf(c)} ${c.position} ${target}`, lines: [], link };
    }
    case "color":
      return {
        action: "Change color",
        context: `${PROPERTY_NAME[c.property]} of ${subjectOf(c)}`,
        lines: [
          { label: "Was", text: colorName(c.oldValue), color: c.oldValue },
          { label: "Now", text: colorName(c.newValue), color: c.newValue },
        ],
        link,
      };
  }
}

function plainLine(line: SummaryLine, isColor: boolean): string {
  const value = line.label && !isColor ? quoted(line.text) : line.text;
  return `   ${line.label ? `${line.label}: ` : ""}${value}`.replace(/\n/g, "\n   ");
}

function plainItem(item: SummaryItem, number: number): string[] {
  const heading = [`${number}. ${item.action}`, item.context, item.subject].filter(Boolean).join(" ");
  return [
    heading,
    ...item.lines.map((line) => plainLine(line, !!line.color)),
    ...(item.link ? [`   View on page: ${item.link}`] : []),
  ];
}

function htmlLine(line: SummaryLine): string {
  const content = escapeHtml(line.text).replace(/\n/g, "<br>");
  const chip = line.color && line.color.alpha > 0 ? `<span style="color:${escapeHtml(line.color.hex)}">■</span> ` : "";
  const label = line.label ? `<span style="${MUTED}">${line.label}:</span> ` : "";
  return `<p style="${DETAIL}">${label}${chip}${line.struck ? `<s>${content}</s>` : content}</p>`;
}

function htmlItem(item: SummaryItem, number: number): string {
  const context = item.context ? ` <span style="${MUTED}">${escapeHtml(item.context)}</span>` : "";
  const subject = item.subject ? ` ${escapeHtml(item.subject)}` : "";
  const link = item.link ? ` &nbsp;<a href="${escapeHtml(item.link)}" style="${LINK};font-size:10pt">View on page</a>` : "";
  return `<p style="${BODY}"><b>${number}. ${escapeHtml(item.action)}</b>${context}${subject}${link}</p>${item.lines.map(htmlLine).join("")}<p style="margin:0 0 6px;font-size:4pt">&nbsp;</p>`;
}

function htmlPageHeading(page: PageRef): string {
  const title = escapeHtml(page.title || page.url);
  const address = webAddress(page.url);
  const heading = address ? `<a href="${escapeHtml(address)}" style="${LINK}">${title}</a>` : title;
  return `<p style="margin:16px 0 6px;${FONT};font-size:13pt;font-weight:bold">${heading}</p>`;
}

/** Numbers match the panel: changes keep list order, grouped by page like the prompt. */
export function buildSummary(changes: Change[]): Summary {
  const pages = new Map<string, PageRef>();
  for (const c of changes) if (!pages.has(c.page.key)) pages.set(c.page.key, c.page);

  const firstAddress = changes[0] ? webAddress(changes[0].page.url) : null;
  const site = firstAddress ? new URL(firstAddress).hostname : "this site";
  const title = `Website edits for ${site}`;
  const counts = `${plural(changes.length, "change")} on ${plural(pages.size, "page")}`;
  const text = [title, counts, ""];
  let html =
    `<p style="margin:0 0 2px;${FONT};font-size:16pt;font-weight:bold;color:#202124">${escapeHtml(title)}</p>` +
    `<p style="margin:0 0 14px;${FONT};font-size:11pt;${MUTED}">${counts}</p>`;

  let number = 0;
  for (const page of pages.values()) {
    const address = webAddress(page.url);
    text.push(page.title || page.url, ...(address ? [address] : []));
    html += htmlPageHeading(page);
    for (const c of changes.filter((change) => change.page.key === page.key)) {
      const item = itemFor(c, changes);
      number++;
      text.push(...plainItem(item, number));
      html += htmlItem(item, number);
    }
    text.push("");
  }
  return { html, text: text.join("\n").trim() };
}
