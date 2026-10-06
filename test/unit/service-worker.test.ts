// The service worker (web/sw/sw.js) as the build writes it, run with a stand-in for the Cache API and fetch: a new
// version leaves no cache of an older one behind — the hashed chunks of every build used to pile up in one assets
// cache forever — and icons, whose names never change, are refreshed in the background instead of being served from
// the cache for good (A12 WEB-8).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const SOURCE = fs.readFileSync(path.join(import.meta.dirname, '../../web/sw/sw.js'), 'utf8');

/** A Cache API over Maps of URL → body text, and a fetch that answers `served` (counting the requests). */
function world(served: Record<string, string>) {
  const stores = new Map<string, Map<string, string>>();
  const open = (name: string) => {
    if (!stores.has(name)) stores.set(name, new Map());
    const m = stores.get(name) as Map<string, string>;
    return {
      put: async (req: { url: string } | string, res: { text: () => Promise<string> }) => void m.set(typeof req === 'string' ? req : req.url, await res.text()),
      match: async (req: { url: string } | string) => {
        const body = m.get(typeof req === 'string' ? req : req.url);
        return body === undefined ? undefined : response(body);
      },
      addAll: async (urls: string[]) => {
        for (const u of urls) m.set(`https://lampo.test${u}`, served[u] ?? '');
      },
    };
  };
  const response = (body: string) => ({ ok: true, status: 200, text: async () => body, clone: () => response(body) });
  const asked: string[] = [];
  const caches = {
    open: async (name: string) => open(name),
    keys: async () => [...stores.keys()],
    delete: async (name: string) => stores.delete(name),
    match: async (req: { url: string }, o?: { cacheName?: string }) => {
      for (const [name, m] of stores) if ((!o?.cacheName || o.cacheName === name) && m.has(req.url)) return response(m.get(req.url) as string);
      return undefined;
    },
  };
  const fetch = async (req: { url: string }) => {
    asked.push(req.url);
    return response(served[new URL(req.url).pathname] ?? 'fresh');
  };
  return { stores, caches, fetch, asked };
}

function worker(version: string, w: ReturnType<typeof world>, precache: string[] = ['/offline.html']) {
  const handlers: Record<string, (e: unknown) => void> = {};
  const self = {
    location: { origin: 'https://lampo.test' },
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      handlers[type] = fn;
    },
    clients: { claim: async () => {}, matchAll: async () => [] },
    registration: {},
    navigator: {},
    skipWaiting: () => {},
  };
  const code = SOURCE.replace("'__VERSION__'", JSON.stringify(version)).replace('__PRECACHE__', JSON.stringify(precache));
  vm.runInNewContext(code, { self, caches: w.caches, fetch: w.fetch, URL, Response: { error: () => ({ ok: false }) }, console });
  const wait = async (type: string, extra: object = {}) => {
    const pending: Promise<unknown>[] = [];
    let answer: Promise<unknown> | undefined;
    handlers[type]?.({ waitUntil: (p: Promise<unknown>) => pending.push(p), respondWith: (p: Promise<unknown>) => (answer = p), ...extra });
    const out = answer ? await answer : undefined;
    await Promise.all(pending);
    return out as { text: () => Promise<string> } | undefined;
  };
  return { wait };
}
const get = (url: string) => ({ request: { method: 'GET', url: `https://lampo.test${url}`, mode: 'no-cors' } });
const settle = () => new Promise((r) => setTimeout(r, 10));

test('a new version deletes the caches of older ones, the assets cache included', async () => {
  const w = world({ '/assets/index-aaa.js': 'v1 code' });
  const one = worker('v1', w);
  await one.wait('install');
  await one.wait('activate');
  await one.wait('fetch', get('/assets/index-aaa.js'));
  await settle();
  // an older worker's single assets cache, as the version before this fix kept it
  (await w.caches.open('vr-assets')).put('https://lampo.test/assets/old-zzz.js', { text: async () => 'stale' });
  const two = worker('v2', w);
  await two.wait('install');
  await two.wait('activate');
  const names = [...w.stores.keys()].sort();
  assert.ok(
    names.every((n) => n.endsWith('-v2')),
    `only the new version's caches stay: ${names.join(', ')}`,
  );
  assert.ok(names.includes('vr-shell-v2'));
});

test('hashed assets are served from the cache once fetched', async () => {
  const w = world({ '/assets/index-aaa.js': 'code' });
  const sw = worker('v1', w);
  await sw.wait('activate');
  assert.equal(await (await sw.wait('fetch', get('/assets/index-aaa.js')))?.text(), 'code');
  await settle();
  assert.equal(await (await sw.wait('fetch', get('/assets/index-aaa.js')))?.text(), 'code');
  assert.equal(w.asked.filter((u) => u.endsWith('/assets/index-aaa.js')).length, 1, 'fetched once');
});

test('icons answer from the cache and are fetched again behind it: a changed icon shows on the next load', async () => {
  const served: Record<string, string> = { '/icons/icon-192.png': 'old icon' };
  const w = world(served);
  const sw = worker('v1', w);
  await sw.wait('activate');
  assert.equal(await (await sw.wait('fetch', get('/icons/icon-192.png')))?.text(), 'old icon');
  await settle();
  served['/icons/icon-192.png'] = 'new icon';
  assert.equal(await (await sw.wait('fetch', get('/icons/icon-192.png')))?.text(), 'old icon', 'at once from the cache');
  await settle();
  assert.equal(await (await sw.wait('fetch', get('/icons/icon-192.png')))?.text(), 'new icon', 'the refreshed copy next time');
});

test('the start the install precached answers from the cache with the network gone', async () => {
  const w = world({ '/assets/index-aaa.js': 'entry', '/offline.html': 'offline' });
  const sw = worker('v1', w, ['/offline.html', '/assets/index-aaa.js']);
  await sw.wait('install');
  await sw.wait('activate');
  const offline = { ...w, fetch: async () => Promise.reject(new TypeError('offline')) };
  // the same caches, a fetch that fails: the worker as it runs on a plane
  const plane = worker('v1', offline as never, ['/offline.html', '/assets/index-aaa.js']);
  assert.equal(await (await plane.wait('fetch', get('/assets/index-aaa.js')))?.text(), 'entry');
});
