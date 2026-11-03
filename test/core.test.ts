import { beforeEach, describe, expect, it } from 'vitest';
import type { Change, ColorChange, EditChange } from '../src/core/changes';
import { executeCommand } from '../src/core/commands';
import { previewColor } from '../src/core/engine';
import { getToolDefinitions } from '../src/core/definitions';
import { segmentsOf, sourceHints, stableSelector, textOf } from '../src/core/describe';
import { describeDeployment } from '../src/core/deployment';
import { buildPrompt } from '../src/core/prompt';
import { store } from '../src/core/store';
import { extractText, normalize } from '../src/core/text';

describe('normalize', () => {
  it('collapses spaces but keeps intentional line breaks', () => {
    expect(normalize('  Hello    world \n\n\n\n  second   line  ')).toBe('Hello world\n\nsecond line');
  });
  it('strips zero-width characters', () => {
    expect(normalize('Book​ a demo')).toBe('Book a demo');
  });
});

describe('extractText', () => {
  beforeEach(() => {
    document.body.innerHTML = '';
  });

  it('reads source text, turning <br> into newlines and splitting segments', () => {
    document.body.innerHTML = '<h1 id="t">Ship <span>faster</span>\n    with Acme<br>today</h1>';
    const { text, segments } = extractText(document.getElementById('t')!);
    expect(text).toBe('Ship faster with Acme\ntoday');
    expect(segments).toEqual(['Ship', 'faster', 'with Acme', 'today']);
  });

  it('ignores script, svg and [hidden] content', () => {
    document.body.innerHTML = '<button id="b"><svg><text>icon</text></svg><span hidden>x</span>Book a demo<script>1</script></button>';
    expect(extractText(document.getElementById('b')!).text).toBe('Book a demo');
  });

  it('ignores text-transform', () => {
    document.body.innerHTML = '<span id="b" style="text-transform: uppercase">New feature</span>';
    expect(textOf(document.getElementById('b')!)).toBe('New feature');
  });
});

describe('describe helpers', () => {
  it('prefers stable ids and skips generated ones', () => {
    document.body.innerHTML = '<section id="pricing"><div id=":r3:"><p>Hi</p><p>There</p></div></section>';
    const p = document.querySelectorAll('p')[1]!;
    const sel = stableSelector(p, { cache: false });
    expect(sel.startsWith('#pricing')).toBe(true);
    expect(sel).not.toContain(':r3:');
    expect(document.querySelector(sel)).toBe(p);
  });

  it('collects source hints from ancestors and split segments', () => {
    document.body.innerHTML = '<div data-component="Hero"><h1 id="h" data-sentry-source-file="hero.tsx">Ship <span>faster</span></h1></div>';
    const h1 = document.getElementById('h')!;
    expect(sourceHints(h1)).toEqual(['data-sentry-source-file="hero.tsx"', 'data-component="Hero"']);
    expect(segmentsOf(h1)).toEqual(['Ship', 'faster']);
    expect(segmentsOf(h1.querySelector('span')!)).toEqual([]);
  });
});

describe('commands', () => {
  beforeEach(async () => {
    await executeCommand('clear_all');
    document.body.innerHTML =
      '<section id="hero"><h1 id="h">Ship <span>faster</span></h1><button id="b"><svg></svg>Book a demo</button></section><ul id="l"><li>One</li><li>Two</li></ul>';
  });

  // happy-dom has no layout, so look elements up by selector (text search skips invisible elements).
  const idFor = async (selector: string) => {
    const r = await executeCommand('find_elements', { selector });
    return (r.data as { elementId: string }[])[0]!.elementId;
  };

  it('edits text live, keeps icons, and undoes', async () => {
    const id = await idFor('#b');
    const res = await executeCommand('edit_text', { elementId: id, newText: 'Get a demo' });
    expect(res).toMatchObject({ ok: true, data: { changed: true, oldText: 'Book a demo' } });
    expect(document.getElementById('b')!.innerHTML).toBe('<svg></svg>Get a demo');
    await executeCommand('undo');
    expect(document.getElementById('b')!.textContent).toBe('Book a demo');
    expect(store.get().changes).toHaveLength(0);
  });

  it('collapses repeated edits and drops edits back to the original', async () => {
    const id = await idFor('#b');
    await executeCommand('edit_text', { elementId: id, newText: 'A' });
    await executeCommand('edit_text', { elementId: id, newText: 'B' });
    expect(store.get().changes).toHaveLength(1);
    expect((store.get().changes[0] as EditChange).oldText).toBe('Book a demo');
    await executeCommand('edit_text', { elementId: id, newText: 'Book a demo' });
    expect(store.get().changes).toHaveLength(0);
  });

  it('records split-text segments on edits', async () => {
    const id = await idFor('#h');
    await executeCommand('edit_text', { elementId: id, newText: 'Ship it' });
    expect(store.get().changes[0]!.segments).toEqual(['Ship', 'faster']);
  });

  it('moves, removes and notes', async () => {
    const two = await idFor('li:nth-of-type(2)');
    const one = await idFor('li:nth-of-type(1)');
    await executeCommand('move_element', { elementId: two, targetId: one, position: 'before' });
    expect(document.getElementById('l')!.textContent).toBe('TwoOne');
    await executeCommand('remove_element', { elementId: one });
    expect((document.querySelectorAll('li')[1] as HTMLElement).style.display).toBe('none');
    const note = await executeCommand('add_note', { elementId: two, note: 'Make this bold' });
    expect(note.ok).toBe(true);
    expect(store.get().changes.map((c) => c.type)).toEqual(['move', 'remove', 'note']);
    await executeCommand('clear_all');
    expect(document.getElementById('l')!.textContent).toBe('OneTwo');
    expect((document.querySelectorAll('li')[1] as HTMLElement).getAttribute('style')).toBeNull();
  });

  it('selects the parent of a nested element', async () => {
    const span = await idFor('#h span');
    await executeCommand('select_element', { elementId: span });
    const res = await executeCommand('select_parent', {});
    expect(res.data).toMatchObject({ tag: 'h1' });
  });

  it('validates params and never throws', async () => {
    expect(await executeCommand('edit_text', { elementId: 'el_1' })).toMatchObject({ ok: false, error: 'params.newText is required' });
    expect(await executeCommand('nope')).toMatchObject({ ok: false });
    expect(await executeCommand('remove_element', { elementId: 'el_99999' })).toMatchObject({ ok: false });
  });

  it('exposes tool definitions in both formats', () => {
    const tools = getToolDefinitions();
    expect(tools.map((t) => t.name)).toContain('edit_text');
    expect(getToolDefinitions('openai')[0]).toHaveProperty('function.parameters');
  });
});

describe('set_color', () => {
  // happy-dom doesn't inherit custom properties from :root, so the vars sit on the element too.
  const css = ':root,#side{--color-zinc-900:#1f1c19;--color-zinc-800:#2b2723} .bg-zinc-900{background-color:var(--color-zinc-900)}';
  beforeEach(async () => {
    await executeCommand('clear_all');
    document.head.innerHTML = `<style>${css}</style>`;
    document.body.innerHTML = '<div id="side" class="bg-zinc-900">x</div>';
  });

  const idFor = async (selector: string) => {
    const r = await executeCommand('find_elements', { selector });
    return (r.data as { elementId: string }[])[0]!.elementId;
  };

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
    const c = store.get().changes[0] as ColorChange;
    expect(c.newValue).toMatchObject({ hex: '#123456', className: null });
    expect(c.newValue.closest).toBeDefined();
    await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-900' });
    expect(store.get().changes).toHaveLength(0);
  });

  it('keeps one change per property', async () => {
    const id = await idFor('#side');
    await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-800' });
    await executeCommand('set_color', { elementId: id, property: 'color', color: '#ffffff' });
    expect(store.get().changes.map((c) => (c as ColorChange).property)).toEqual(['background-color', 'color']);
  });

  it('ends a live preview before applying or undoing, so no stale color comes back', async () => {
    const id = await idFor('#side');
    const el = document.getElementById('side')!;
    const preview = previewColor(el, 'background-color');
    preview.set('rgb(1 2 3 / 1)');
    await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'zinc-800' });
    preview.end(); // the picker closing afterwards must not undo the applied color
    expect(el.style.getPropertyValue('background-color')).toContain('43');
    const again = previewColor(el, 'background-color');
    again.set('rgb(1 2 3 / 1)');
    await executeCommand('undo');
    again.end();
    expect(el.getAttribute('style')).toBeNull();
  });

  it('records a borderless element as having no border', async () => {
    document.body.innerHTML = '<div id="side" class="bg-zinc-900" style="border-width: 0; border-style: solid; border-top-color: rgb(200, 0, 0); border-top-width: 0px">x</div>';
    const id = await idFor('#side');
    await executeCommand('set_color', { elementId: id, property: 'border-color', color: 'zinc-800' });
    expect((store.get().changes[0] as ColorChange).oldValue).toMatchObject({ alpha: 0, className: null });
  });

  it('rejects colors it cannot read', async () => {
    const id = await idFor('#side');
    expect(await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'not-a-color' })).toMatchObject({ ok: false });
    expect(await executeCommand('set_color', { elementId: id, property: 'background-color', color: 'lab(50% 0 0)' })).toMatchObject({ ok: false });
  });
});

describe('buildPrompt', () => {
  const page = { key: 'https://example.com/', url: 'https://example.com/', title: 'Example' };
  const base = {
    page, elementId: null, selector: 'h1', tag: 'h1', section: 'Hero', snippet: 'Old', contextHtml: '<h1>Old</h1>', segments: [], sourceHints: [],
  };

  it('renders every change type with rules and JSON', () => {
    const changes: Change[] = [
      { ...base, id: 'ch_1', type: 'edit', oldText: 'Old', newText: 'New', segments: ['Ol', 'd'], sourceHints: ['data-component="Hero"'] },
      { ...base, id: 'ch_2', type: 'note', note: 'Shorter' },
      { ...base, id: 'ch_3', type: 'remove' },
      {
        ...base, id: 'ch_4', type: 'move', position: 'after', targetId: null, targetSelector: 'li:nth-of-type(2)', targetSnippet: 'Two', parentSelector: 'ul', fromParentSelector: 'ul',
      },
    ];
    const prompt = buildPrompt(changes);
    expect(prompt).toContain('Page: https://example.com/  |  Title: Example');
    expect(prompt).toContain('1. EDIT TEXT\n   Element: <h1> — selector: `h1`');
    expect(prompt).toContain('   Old: "Old"\n   New: "New"');
    expect(prompt).toContain('Search terms (text is split across elements): "Ol", "d"');
    expect(prompt).toContain('Source hints: data-component="Hero"');
    expect(prompt).toContain('2. NOTE');
    expect(prompt).toContain('Instruction: "Shorter"');
    expect(prompt).toContain('3. REMOVE');
    expect(prompt).toContain('Move `h1` ("Old") to be after `li:nth-of-type(2)` ("Two") within `ul`.');
    expect(prompt).toContain('Rules for the coding agent:');
    const json = JSON.parse(prompt.split('```json')[1]!.split('```')[0]!);
    expect(json).toHaveLength(4);
    expect(json[0]).not.toHaveProperty('elementId');
    expect(json[1]).toMatchObject({ number: 2, note: 'Shorter' });
  });

  it('renders color changes as a class swap', () => {
    const color = (o: Partial<ColorChange>): ColorChange => ({
      ...base, id: 'ch_9', type: 'color', property: 'background-color',
      oldValue: { hex: '#1f1c19', alpha: 1, className: 'dark:bg-zinc-900' },
      newValue: { hex: '#2b2723', alpha: 1, className: 'dark:bg-zinc-800' },
      alsoOnElement: ['bg-zinc-50'], ...o,
    });
    const p1 = buildPrompt([color({})]);
    expect(p1).toContain('CHANGE COLOR');
    expect(p1).toContain('Property: background-color');
    expect(p1).toContain('Old: dark:bg-zinc-900 (#1f1c19)');
    expect(p1).toContain('New: dark:bg-zinc-800 (#2b2723)');
    expect(p1).toContain('Swap the class `dark:bg-zinc-900` for `dark:bg-zinc-800`.');
    expect(p1).toContain('Also on the element: bg-zinc-50');
    expect(p1).toContain('CHANGE COLOR: swap the named Tailwind class');

    const p2 = buildPrompt([color({
      oldValue: { hex: '#000000', alpha: 0, className: null },
      newValue: { hex: '#2a3b4c', alpha: 1, className: null, closest: { className: 'bg-slate-800', hex: '#1e293b' } },
      alsoOnElement: [],
    })]);
    expect(p2).toContain('Old: transparent (no background set)');
    expect(p2).toContain('New: #2a3b4c (no matching Tailwind class; closest is bg-slate-800 #1e293b)');
    expect(p2).not.toContain('Swap the class');
    expect(p2).not.toContain('Also on the element');

    const p3 = buildPrompt([color({ property: 'color', oldValue: { hex: '#b9b3a3', alpha: 1, className: null }, alsoOnElement: [] })]);
    expect(p3).toContain('Old: #b9b3a3 (no Tailwind class on this element; the color comes from a component, a parent or CSS)');
  });

  it('groups by page and keeps numbering across pages', () => {
    const other = { key: 'https://example.com/pricing', url: 'https://example.com/pricing', title: 'Pricing' };
    const prompt = buildPrompt([
      { ...base, id: 'ch_1', type: 'edit', oldText: 'A', newText: 'A2' },
      { ...base, id: 'ch_2', type: 'edit', oldText: 'C', newText: 'C2' },
      { ...base, id: 'ch_3', page: other, type: 'edit', oldText: 'B', newText: 'B2' },
    ]);
    expect(prompt).toContain('I reviewed 2 pages');
    expect(prompt.indexOf('2. EDIT TEXT')).toBeLessThan(prompt.indexOf('## Page: https://example.com/pricing'));
    expect(prompt.indexOf('3. EDIT TEXT')).toBeGreaterThan(prompt.indexOf('## Page: https://example.com/pricing'));
  });

  it('names the deployment in the header', () => {
    const prompt = buildPrompt([{ ...base, id: 'ch_1', type: 'edit', oldText: 'A', newText: 'A2' }]);
    expect(prompt).toContain('Deployment: Custom domain (example.com).');
    expect(prompt).toContain('check out the branch named in the Deployment line');
  });
});

describe('describeDeployment', () => {
  it('reads the branch alias from a Workers branch preview', () => {
    const line = describeDeployment('https://codex-storybrand-copy-review-consultran-website-2026.developer-e11.workers.dev/ifta');
    expect(line).toContain('Cloudflare Workers preview "codex-storybrand-copy-review-consultran-website-2026"');
    expect(line).toContain('Remove the Worker name');
  });

  it('flags a Workers commit preview as not naming the branch', () => {
    const line = describeDeployment('https://b9876cbe-consultran-website-2026.developer-e11.workers.dev/');
    expect(line).toContain('commit preview (version b9876cbe)');
    expect(line).toContain('does not name the branch');
  });

  it('handles Pages branch, deployment and production URLs', () => {
    expect(describeDeployment('https://new-hero.dna-site.pages.dev/')).toContain('Pages branch preview "new-hero"');
    expect(describeDeployment('https://1a2b3c4d.dna-site.pages.dev/')).toContain('does not name the branch');
    expect(describeDeployment('https://dna-site.pages.dev/')).toContain('production deploy');
  });

  it('asks before switching branches on custom domains, and uses the checked-out branch on localhost', () => {
    const line = describeDeployment('https://new.donnormanassociates.com/');
    expect(line).toContain('Custom domain (new.donnormanassociates.com)');
    expect(line).toContain('confirm with the user before switching');
    expect(describeDeployment('http://localhost:4321/')).toContain('branch currently checked out');
  });
});
