import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Change, PageRef } from '../src/core/changes';
import { executeCommand } from '../src/core/commands';
import { buildSummary } from '../src/core/summary';
import { copyRichText } from '../src/core/ui/root';

const home: PageRef = { key: 'https://acme.test/', url: 'https://acme.test/#pricing', title: 'Acme: Ship faster' };
const about: PageRef = { key: 'https://acme.test/about', url: 'https://acme.test/about', title: 'About Acme' };
const base = {
  page: home,
  elementId: null,
  selector: 'p',
  tag: 'p',
  section: 'Hero — "Ship faster"',
  snippet: 'Short text',
  contextHtml: '<p>Short text</p>',
  segments: [],
  sourceHints: [],
};
const edit = (extra: Partial<Change> = {}) =>
  ({ ...base, id: 'ch_1', type: 'edit', oldText: 'Old words', newText: 'New words', ...extra }) as Change;

describe('buildSummary', () => {
  it('describes every kind of change in order, numbered across pages', () => {
    const { text } = buildSummary([
      edit(),
      { ...base, id: 'ch_2', type: 'note', note: 'Is this still true?' },
      { ...base, id: 'ch_3', type: 'remove' },
      { ...base, id: 'ch_4', page: about, type: 'move', position: 'after', targetId: null, targetSelector: 'h2', targetSnippet: 'Team', parentSelector: 'main' },
      {
        ...base, id: 'ch_5', page: about, type: 'color', property: 'background-color', alsoOnElement: [],
        oldValue: { hex: '#112233', alpha: 1, className: 'bg-a' }, newValue: { hex: '#aabbcc', alpha: 0.5, className: null },
      },
    ]);
    expect(text).toContain('Website edits for acme.test\n5 changes on 2 pages');
    expect(text).toContain('Acme: Ship faster\nhttps://acme.test/\n1. Change text in Hero, "Ship faster"\n   Was: “Old words”\n   Now: “New words”');
    expect(text).toContain('2. Note on “Short text”\n   Is this still true?');
    expect(text).toContain('3. Remove “Short text”');
    expect(text).toContain('About Acme\nhttps://acme.test/about\n4. Move “Short text” after “Team”');
    expect(text).toContain('5. Change color background of “Short text”\n   Was: #112233\n   Now: #AABBCC at 50% opacity');
    expect(text).not.toMatch(/selector|contextHtml|bg-a/);
  });

  it('uses singular wording for one change on one page', () => {
    expect(buildSummary([edit()]).text).toContain('1 change on 1 page');
  });

  it('links to the old wording, because that is what the page still shows', () => {
    const { html, text } = buildSummary([edit({ oldText: 'Save 10% - now, & more' } as Partial<Change>)]);
    const link = 'https://acme.test/#:~:text=Save%2010%25%20%2D%20now%2C%20%26%20more';
    expect(text).toContain(`View on page: ${link}`);
    expect(html).toContain(`href="${link}"`);
  });

  it('matches long text by its first and last words', () => {
    const oldText = 'one two three four five six seven eight nine ten eleven twelve';
    expect(buildSummary([edit({ oldText } as Partial<Change>)]).text).toContain('#:~:text=one%20two%20three%20four%20five,eight%20nine%20ten%20eleven%20twelve');
  });

  it('matches text on separate lines by its first and last lines', () => {
    const { text } = buildSummary([edit({ oldText: 'First part\nLast part' } as Partial<Change>)]);
    expect(text).toContain('#:~:text=First%20part,Last%20part');
  });

  it('matches a short edit whole even when a link splits it', () => {
    const { text } = buildSummary([edit({ oldText: 'Go to our site.', segments: ['Go to', 'our site', '.'] } as Partial<Change>)]);
    expect(text).toMatch(/#:~:text=Go%20to%20our%20site\.$/m);
  });

  it('matches a note on a section by its first and last pieces, skipping lone punctuation', () => {
    const { text } = buildSummary([{ ...base, id: 'ch_1', type: 'note', note: 'Check this', snippet: 'Heading Body te…', segments: ['Heading', 'Body text', '.'] }]);
    expect(text).toMatch(/#:~:text=Heading,Body%20text$/m);
  });

  it('keeps every word of an edit that really ends in an ellipsis', () => {
    const { text } = buildSummary([edit({ oldText: 'Wait for it…' } as Partial<Change>)]);
    expect(text).toContain('#:~:text=Wait%20for%20it%E2%80%A6');
  });

  it('ignores the cut-off last word of shortened text', () => {
    const { text } = buildSummary([{ ...base, id: 'ch_1', type: 'remove', snippet: 'One two three four five six seven eight nine ten eleven twelve thirteen fourte…' }]);
    expect(text).toMatch(/#:~:text=One%20two%20three%20four%20five%20six$/m);
  });

  it('links to the page when the change has no text to find', () => {
    const { text } = buildSummary([{ ...base, id: 'ch_1', type: 'remove', tag: 'img', snippet: '' }]);
    expect(text).toContain('Remove the img element\n   View on page: https://acme.test/');
  });

  it('escapes page text and leaves out links that are not web addresses', () => {
    const bad = { key: 'x', url: 'javascript:alert(1)', title: '<img src=x onerror=alert(1)>' };
    const { html } = buildSummary([{ ...base, id: 'ch_1', page: bad, type: 'note', snippet: '<b>x</b>', note: '"quoted" & <script>' }]);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script');
    expect(html).not.toContain('javascript:');
    expect(html).toContain('&quot;quoted&quot; &amp; &lt;script&gt;');
  });

  it('keeps line breaks and marks the old wording in the formatted version', () => {
    const { html } = buildSummary([edit({ oldText: 'Old', newText: 'Line one\nLine two' } as Partial<Change>)]);
    expect(html).toContain('<s>Old</s>');
    expect(html).toContain('Line one<br>Line two');
  });
});

describe('summary links from real changes', () => {
  const idFor = async (selector: string) => ((await executeCommand('find_elements', { selector })).data as { elementId: string }[])[0]!.elementId;
  const summaryText = async () => (await executeCommand('get_summary')).data as { text: string };
  const setPage = (html: string, url = 'https://acme.test/') => {
    (window as unknown as { happyDOM: { setURL(address: string): void } }).happyDOM.setURL(url);
    document.body.innerHTML = html;
  };

  beforeEach(async () => {
    await executeCommand('clear_all');
  });

  it('tells repeated text apart with the words around it', async () => {
    setPage('<nav><span>Acme</span><button id="top">Book a demo</button></nav><main><p>Ready to start?</p><button id="low">Book a demo</button><p>No card needed.</p></main>');
    await executeCommand('add_note', { elementId: await idFor('#low'), note: 'Make this bigger' });
    expect((await summaryText()).text).toContain('#:~:text=Ready%20to%20start%3F-,Book%20a%20demo,-No%20card%20needed.');
  });

  it('leaves out nearby words when the text appears once', async () => {
    setPage('<p>Before</p><button id="only">Book a demo</button><p>After</p>');
    await executeCommand('add_note', { elementId: await idFor('#only'), note: 'Check' });
    expect((await summaryText()).text).toMatch(/#:~:text=Book%20a%20demo$/m);
  });

  it('links a note made after an edit to the original wording', async () => {
    setPage('<h1 id="h">Original headline</h1>');
    const elementId = await idFor('#h');
    await executeCommand('edit_text', { elementId, newText: 'Replacement headline' });
    await executeCommand('add_note', { elementId, note: 'Is this better?' });
    const links = (await summaryText()).text.match(/:~:text=\S+/g);
    expect(links).toEqual([':~:text=Original%20headline', ':~:text=Original%20headline']);
  });

  it('opens the page without searching for text that is not visible', async () => {
    setPage('<img id="logo" alt="Acme logo" src="x.png"><button id="close" aria-label="Close"></button>');
    await executeCommand('remove_element', { elementId: await idFor('#logo') });
    await executeCommand('add_note', { elementId: await idFor('#close'), note: 'Keep this?' });
    const { text } = await summaryText();
    expect(text).not.toContain(':~:text=');
    expect(text).toContain('View on page: https://acme.test/');
  });

  it('keeps an app route in the link', async () => {
    setPage('<p id="p">Plans and prices</p>', 'https://acme.test/#/pricing');
    await executeCommand('add_note', { elementId: await idFor('#p'), note: 'Update' });
    expect((await summaryText()).text).toContain('https://acme.test/#/pricing:~:text=Plans%20and%20prices');
  });

  it('keeps technical link details out of the prompt', async () => {
    setPage('<p id="p">Plans and prices</p>');
    await executeCommand('add_note', { elementId: await idFor('#p'), note: 'Update' });
    expect(((await executeCommand('get_prompt')).data as { prompt: string }).prompt).not.toContain('textTarget');
  });
});

describe('links for changes saved by earlier versions', () => {
  it('keeps a word that really ends in an ellipsis', () => {
    const { text } = buildSummary([{ ...base, id: 'ch_1', type: 'remove', snippet: 'Loading…' }]);
    expect(text).toContain('#:~:text=Loading%E2%80%A6');
  });

  it('uses the original wording for a note on an edited element', () => {
    const { text } = buildSummary([edit({ oldText: 'Original', newText: 'Replacement', snippet: 'Original' } as Partial<Change>), { ...base, id: 'ch_2', type: 'note', note: 'Check', snippet: 'Replacement' }]);
    expect(text).not.toContain(':~:text=Replacement');
  });
});

describe('copy_summary', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('refuses when there is nothing to copy', async () => {
    await executeCommand('clear_all');
    expect(await executeCommand('copy_summary')).toMatchObject({ ok: false });
  });

  it('copies the summary of the current changes', async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, Blob>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });
    await executeCommand('clear_all');
    document.body.innerHTML = '<p id="p">Old words</p>';
    const found = await executeCommand('find_elements', { selector: '#p' });
    await executeCommand('edit_text', { elementId: (found.data as { elementId: string }[])[0]!.elementId, newText: 'New words' });

    const result = await executeCommand('copy_summary');

    expect(result).toMatchObject({ ok: true, data: { count: 1 } });
    expect(write).toHaveBeenCalledTimes(1);
    expect((result.data as { text: string }).text).toContain('Now: “New words”');
  });

  it('puts formatted and plain versions on the clipboard', async () => {
    const write = vi.fn(async () => {});
    vi.stubGlobal('ClipboardItem', class { constructor(public items: Record<string, Blob>) {} });
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { write } });

    await copyRichText('<b>Hi</b>', 'Hi');

    const [[item]] = write.mock.calls as unknown as [[{ items: Record<string, Blob> }[]]];
    expect(Object.keys(item![0]!.items).sort()).toEqual(['text/html', 'text/plain']);
  });
});
