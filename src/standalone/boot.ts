import { createReword, type Reword } from '../core/reword';
import type { ChangeStore, PrefStore } from '../core/types';

const CHANGES_KEY = 'reword:changes';
const OPEN_KEY = 'reword:open';

/** Per-tab, per-origin storage. Survives reloads and page-to-page navigation in the same tab. */
export function sessionStore(): ChangeStore {
  return {
    async load() {
      const saved = sessionStorage.getItem(CHANGES_KEY);
      try {
        return JSON.parse(saved ?? '[]');
      } catch {
        return []; // Unreadable leftovers, not a storage failure.
      }
    },
    // Blocked or full storage rejects, and the editor keeps the edits in memory.
    async save(changes) {
      if (changes.length) sessionStorage.setItem(CHANGES_KEY, JSON.stringify(changes));
      else sessionStorage.removeItem(CHANGES_KEY);
    },
  };
}

/** UI preferences (panel position) per origin. */
const localPrefs: PrefStore = {
  async get(key) {
    try {
      return JSON.parse(localStorage.getItem(key) ?? 'null') ?? undefined;
    } catch {
      return undefined;
    }
  },
  async set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* ignore */
    }
  },
};

export function rememberOpen(open: boolean) {
  try {
    if (open) sessionStorage.setItem(OPEN_KEY, '1');
    else sessionStorage.removeItem(OPEN_KEY);
  } catch {
    /* ignore */
  }
}

export function wasOpen(): boolean {
  try {
    return sessionStorage.getItem(OPEN_KEY) === '1';
  } catch {
    return false;
  }
}

export interface RewordApi extends Reword {
  flavor: string;
}

declare global {
  interface Window {
    Reword?: RewordApi;
  }
}

/** Create (once) the page-wide editor and expose it as `window.Reword`. */
export function boot(flavor: string): RewordApi {
  if (window.Reword) return window.Reword;
  const reword = createReword({ store: sessionStore(), prefs: localPrefs, onClose: () => rememberOpen(false) });
  const api: RewordApi = Object.assign(Object.create(reword) as Reword, {
    flavor,
    open: async () => {
      rememberOpen(true);
      await reword.open();
    },
    toggle: () => (reword.opened ? reword.close() : void api.open()),
  });
  window.Reword = api;
  return api;
}

/** Alt+Shift+E toggles the editor (used by the userscript and the drop-in). */
export function bindHotkey(api: RewordApi) {
  window.addEventListener('keydown', (e) => {
    if (e.altKey && e.shiftKey && !e.metaKey && !e.ctrlKey && e.code === 'KeyE') {
      e.preventDefault();
      api.toggle();
    }
  });
}
