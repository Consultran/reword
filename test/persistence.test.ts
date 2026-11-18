import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EditChange } from '../src/core/changes';
import type { ChangeStore } from '../src/core/types';
import { sessionStore } from '../src/standalone/boot';

/** Behaves like chrome.storage: values are copied, and object keys come back sorted. */
function fakeBrowserStorage() {
  const sortKeys = (_key: string, value: unknown) =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)))
      : value;
  let saved = '[]';
  const storage: ChangeStore & {
    count(): number;
    texts(): string[];
    all(): Record<string, unknown>[];
    replaceAll(changes: unknown[]): void;
    failReads: boolean;
    saves: number;
  } = {
    failReads: false,
    saves: 0,
    async load() {
      if (storage.failReads) throw new Error('storage unavailable');
      return JSON.parse(saved);
    },
    async save(changes) {
      storage.saves++;
      saved = JSON.stringify(changes, sortKeys);
    },
    all: () => JSON.parse(saved),
    replaceAll(changes) {
      saved = JSON.stringify(changes, sortKeys);
    },
    count: () => JSON.parse(saved).length,
    texts: () => JSON.parse(saved).map((c: { newText: string }) => c.newText),
  };
  return storage;
}

/** Each call is a separate copy of Reword, like a second tab or a page restored by Back. */
async function openTab(storage: ChangeStore) {
  vi.resetModules();
  const session = await import('../src/core/session');
  const { executeCommand } = await import('../src/core/commands');
  const { store } = await import('../src/core/store');
  await session.load(storage);
  const idFor = async (selector: string) => {
    const found = await executeCommand('find_elements', { selector });
    return (found.data as { elementId: string }[])[0]!.elementId;
  };
  const edit = async (selector: string, newText: string) => {
    await executeCommand('edit_text', { elementId: await idFor(selector), newText });
  };
  const moveAfter = async (selector: string, targetSelector: string) => {
    await executeCommand('move_element', { elementId: await idFor(selector), targetId: await idFor(targetSelector), position: 'after' });
  };
  return { session, executeCommand, store, edit, moveAfter };
}

describe('saved edits with several copies of Reword open', () => {
  beforeEach(() => {
    document.body.innerHTML = '<h1 id="a">Headline</h1><p id="b">First</p><p id="c">Second</p>';
  });

  it('keeps edits saved by another tab', async () => {
    const storage = fakeBrowserStorage();
    const first = await openTab(storage);
    const second = await openTab(storage);
    await first.edit('#a', 'From first tab');
    await first.edit('#b', 'Also from first tab');
    await vi.waitFor(() => expect(storage.count()).toBe(2));

    await second.edit('#c', 'From second tab');

    await vi.waitFor(() => expect(storage.count()).toBe(3));
    expect(storage.texts()).toEqual(expect.arrayContaining(['From first tab', 'Also from first tab', 'From second tab']));
  });

  it('shows the other tab\'s edits after saving', async () => {
    const storage = fakeBrowserStorage();
    const first = await openTab(storage);
    const second = await openTab(storage);
    await first.edit('#a', 'From first tab');
    await vi.waitFor(() => expect(storage.count()).toBe(1));

    await second.edit('#c', 'From second tab');

    await vi.waitFor(() => expect(second.session.changes()).toHaveLength(2));
  });

  it('does not bring back an edit another tab reverted', async () => {
    const storage = fakeBrowserStorage();
    const first = await openTab(storage);
    await first.edit('#a', 'Reverted soon');
    await vi.waitFor(() => expect(storage.count()).toBe(1));
    const second = await openTab(storage);

    await first.executeCommand('undo');
    await vi.waitFor(() => expect(storage.count()).toBe(0));
    await second.edit('#c', 'Kept');

    await vi.waitFor(() => expect(storage.texts()).toEqual(['Kept']));
  });

  it('lets this tab revert an edit without another tab\'s edits being lost', async () => {
    const storage = fakeBrowserStorage();
    const first = await openTab(storage);
    const second = await openTab(storage);
    await first.edit('#a', 'Mine');
    await vi.waitFor(() => expect(storage.count()).toBe(1));
    await second.edit('#c', 'Theirs');
    await vi.waitFor(() => expect(storage.count()).toBe(2));

    await first.executeCommand('undo');

    await vi.waitFor(() => expect(storage.texts()).toEqual(['Theirs']));
  });

  it('gives the first edit in each of two tabs its own identity', async () => {
    const storage = fakeBrowserStorage();
    const first = await openTab(storage);
    const second = await openTab(storage);

    await first.edit('#a', 'Edit from first tab');
    await vi.waitFor(() => expect(storage.count()).toBe(1));
    await second.edit('#c', 'Edit from second tab');

    await vi.waitFor(() => expect(storage.count()).toBe(2));
    expect(storage.texts()).toEqual(expect.arrayContaining(['Edit from first tab', 'Edit from second tab']));
  });

  it('does not overwrite saved edits when they cannot be read', async () => {
    const storage = fakeBrowserStorage();
    const first = await openTab(storage);
    await first.edit('#a', 'Saved earlier');
    await vi.waitFor(() => expect(storage.count()).toBe(1));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const savesBefore = storage.saves;
    storage.failReads = true;

    await first.edit('#c', 'Made while storage is failing');

    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
    expect(storage.saves).toBe(savesBefore);
    warn.mockRestore();
  });

  describe('when tabs overlap or storage misbehaves', () => {
    const settle = (ms = 40) => new Promise((resolve) => setTimeout(resolve, ms));
    const tabComesBack = async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await settle();
    };
    const watchedTab = async (storage: ChangeStore) => {
      const tab = await openTab(storage);
      const stopWatching = tab.session.watch();
      await settle(20);
      return { ...tab, stopWatching };
    };
    const editOf = (storage: ReturnType<typeof fakeBrowserStorage>) => storage.all()[0]!;

    /** Hands the lock to one caller at a time, like navigator.locks does across tabs. */
    function useFakeTabLock() {
      let queue: Promise<unknown> = Promise.resolve();
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: {
          request(_name: string, work: () => Promise<void>) {
            const result = queue.then(work);
            queue = result.catch(() => {});
            return result;
          },
        },
      });
    }

    afterEach(() => {
      Reflect.deleteProperty(navigator, 'locks');
      vi.unstubAllGlobals();
    });

    it('keeps both edits when two tabs save at the same moment', async () => {
      useFakeTabLock();
      const storage = fakeBrowserStorage();
      const first = await openTab(storage);
      const second = await openTab(storage);

      await Promise.all([first.edit('#a', 'Edit from first tab'), second.edit('#c', 'Edit from second tab')]);

      await vi.waitFor(() => expect(storage.count()).toBe(2));
      expect(storage.texts()).toEqual(expect.arrayContaining(['Edit from first tab', 'Edit from second tab']));
    });

    it('still saves when the browser refuses the lock', async () => {
      Object.defineProperty(navigator, 'locks', {
        configurable: true,
        value: { request: () => Promise.reject(new DOMException('denied', 'SecurityError')) },
      });
      const storage = fakeBrowserStorage();
      const tab = await openTab(storage);

      await tab.edit('#a', 'Saved anyway');

      await vi.waitFor(() => expect(storage.texts()).toEqual(['Saved anyway']));
    });

    it('keeps earlier edits in memory when session storage is blocked', async () => {
      const blocked = () => {
        throw new DOMException('blocked', 'SecurityError');
      };
      vi.stubGlobal('sessionStorage', { getItem: blocked, setItem: blocked, removeItem: blocked });
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const tab = await openTab(sessionStore());

      await tab.edit('#a', 'Edit one');
      await settle();
      await tab.edit('#c', 'Edit two');
      await settle();

      expect(tab.session.changes().map((c) => (c as EditChange).newText)).toEqual(['Edit one', 'Edit two']);
      warn.mockRestore();
    });

    it('does not let undo delete an update adopted from another tab', async () => {
      const storage = fakeBrowserStorage();
      const tab = await watchedTab(storage);
      await tab.edit('#a', 'One');
      await vi.waitFor(() => expect(storage.count()).toBe(1));
      storage.replaceAll([{ ...editOf(storage), newText: 'Two' }]);
      await tabComesBack();
      expect((tab.session.changes()[0] as EditChange).newText).toBe('Two');

      await tab.executeCommand('undo');
      await settle();

      expect(storage.texts()).toEqual(['Two']);
    });

    it('does not let a stale revert delete a newer saved version', async () => {
      const storage = fakeBrowserStorage();
      const tab = await openTab(storage);
      await tab.edit('#a', 'One');
      await vi.waitFor(() => expect(storage.count()).toBe(1));
      storage.replaceAll([{ ...editOf(storage), newText: 'Two' }]);

      await tab.executeCommand('undo');
      await settle();

      expect(storage.texts()).toEqual(['Two']);
    });

    it('keeps the surviving edit on the page when another edit on that element is dropped', async () => {
      const storage = fakeBrowserStorage();
      const tab = await watchedTab(storage);
      await tab.edit('#a', 'Mine');
      await vi.waitFor(() => expect(storage.count()).toBe(1));
      const mine = editOf(storage);
      storage.replaceAll([mine, { ...mine, id: 'from_other_tab', newText: 'Theirs' }]);
      await tabComesBack();
      await settle(60);

      storage.replaceAll([mine]);
      await tabComesBack();

      expect(tab.session.changes().map((c) => (c as EditChange).newText)).toEqual(['Mine']);
      expect(document.getElementById('a')!.textContent).toBe('Mine');
    });

    it('puts the surviving edit back even if the editor closed during the save', async () => {
      const storage = fakeBrowserStorage();
      const tab = await watchedTab(storage);
      await tab.edit('#a', 'Mine');
      await vi.waitFor(() => expect(storage.count()).toBe(1));
      const mine = editOf(storage);
      storage.replaceAll([mine, { ...mine, id: 'from_other_tab', newText: 'Theirs' }]);
      await tabComesBack();
      await settle(60);

      tab.stopWatching();
      storage.replaceAll([mine]);
      await tab.edit('#c', 'Another edit');
      await settle();

      expect(document.getElementById('a')!.textContent).toBe('Mine');
    });

    it('keeps the surviving move when another move of that element is dropped', async () => {
      const storage = fakeBrowserStorage();
      const tab = await watchedTab(storage);
      await tab.moveAfter('#a', '#b');
      await vi.waitFor(() => expect(storage.count()).toBe(1));
      const first = editOf(storage);
      const second = { ...first, id: 'from_other_tab', targetSelector: '#c' };
      storage.replaceAll([first, second]);
      await tabComesBack();
      await settle(60);
      const order = () => Array.from(document.body.children, (el) => el.id).join('');
      expect(order()).toBe('bca');

      storage.replaceAll([second]);
      await tabComesBack();

      expect(order()).toBe('bca');
    });

    it('leaves an in-progress draft alone when the tab comes back', async () => {
      const storage = fakeBrowserStorage();
      const tab = await watchedTab(storage);
      await tab.edit('#a', 'One');
      await vi.waitFor(() => expect(storage.count()).toBe(1));
      tab.store.set({ editingId: tab.session.changes()[0]!.elementId });
      const draft = document.getElementById('a')!;
      draft.textContent = 'Unsaved draft';
      storage.replaceAll([{ ...editOf(storage), newText: 'Update from other tab' }]);

      await tabComesBack();

      expect(draft.textContent).toBe('Unsaved draft');
    });

    it('can still undo Clear all for edits no other tab touched', async () => {
      const storage = fakeBrowserStorage();
      const tab = await openTab(storage);
      await tab.edit('#a', 'Changed elsewhere');
      await tab.edit('#b', 'Only here');
      await vi.waitFor(() => expect(storage.count()).toBe(2));
      storage.replaceAll(storage.all().map((c) => (c.newText === 'Changed elsewhere' ? { ...c, newText: 'Newer version' } : c)));

      await tab.executeCommand('clear_all');
      await settle();
      expect(storage.texts()).toEqual(['Newer version']);
      await tab.executeCommand('undo');
      await settle();

      expect(storage.texts()).toEqual(expect.arrayContaining(['Newer version', 'Only here']));
    });
  });
});
