// Signing out leaves nothing of the account in the browser's storage (A12 WEB-7): folder paths (the sidebar's open
// folders), collapsed project names, the player's last video and zoom per slug, the machine's last folder, Insights'
// remembered shape, the tab's last library view. What stays belongs to the device or to a review link's visitor, not to
// the account: theme, language, a visitor's id and typed name. A key that isn't listed as staying goes — so a new key
// is the account's until someone says otherwise.
import assert from 'node:assert/strict';
import test from 'node:test';
import { DEVICE_KEYS, forgetAccountStorage, LEFT_TO_FORGET_PERSISTED } from '../../web/src/lib/signedOut.ts';

/** The part of Web Storage the function uses, over a Map. */
function storage(entries: Record<string, string>) {
  const m = new Map(Object.entries(entries));
  return {
    map: m,
    get length() {
      return m.size;
    },
    key: (i: number) => [...m.keys()][i] ?? null,
    removeItem: (k: string) => void m.delete(k),
  };
}

test('sign-out removes every vr. key but the device’s own and the review-link visitor’s', () => {
  const local = storage({
    'vr.expanded': '["Acme","Acme/Launch"]',
    'vr.library': '{"collapsed":["Acme"]}',
    'vr.player': '{"panel":"__Users__someone__Acme__spot.mp4"}',
    'vr.lastDir': '/Users/someone/Acme',
    'vr.insights': '{"shape":{}}',
    'vr.grid': '{}',
    'vr.chrome': '{"role":"owner"}',
    'vr.autocheck': '{}',
    'vr.some-key-added-later': 'x',
    'vr.cache.who': 'u_1',
    'vr.theme': 'dark',
    'vr.lang': 'de',
    'vr.g.visitor': 'abcdefghijklmnop',
    'vr.guestName': 'Mia',
    'other-site-key': 'kept',
  });
  const tab = storage({ 'vr.lastLibrary': '#/folder/Acme', 'vr.library': '{"q":"Acme"}' });
  forgetAccountStorage(local);
  forgetAccountStorage(tab);
  // whose kept data IndexedDB holds stays for forgetPersisted, which reads it to delete that data, then removes it
  assert.deepEqual([...local.map.keys()].sort(), ['other-site-key', 'vr.cache.who', 'vr.g.visitor', 'vr.guestName', 'vr.lang', 'vr.theme']);
  assert.deepEqual([...tab.map.keys()], []);
  assert.deepEqual([...DEVICE_KEYS].sort(), ['vr.g.visitor', 'vr.guestName', 'vr.lang', 'vr.theme']);
});

test('a storage that throws (private mode, blocked site data) changes nothing and throws nothing', () => {
  const broken = {
    get length(): number {
      throw new Error('denied');
    },
    key: () => null,
    removeItem: () => {},
  };
  assert.doesNotThrow(() => forgetAccountStorage(broken));
});

test('afterSignOut clears both storages; the kept data’s owner key is persist.ts’s', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const persist = fs.readFileSync(path.join(import.meta.dirname, '../../web/src/api/persist.ts'), 'utf8');
  assert.ok(persist.includes(`export const WHO = '${LEFT_TO_FORGET_PERSISTED}';`), 'the same key forgetPersisted reads');
  const src = fs.readFileSync(path.join(import.meta.dirname, '../../web/src/api/auth.ts'), 'utf8');
  const body = src.slice(src.indexOf('export function afterSignOut'), src.indexOf('\n}\n', src.indexOf('export function afterSignOut')));
  assert.match(body, /forgetAccountStorage\(localStorage\)/);
  assert.match(body, /forgetAccountStorage\(sessionStorage\)/);
});
