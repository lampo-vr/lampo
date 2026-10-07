// covers: web/src/files/uploadStore.ts web/src/lib/signedOut.ts
// The Files tab's uploads without a browser, against a stand-in API and tus: a big drop asks for its ways in a few files
// ahead of what is being sent (a way in lives 15 minutes), so none runs out waiting its turn, and a thousand and one
// files go without ever looking like "no more versions today"; a way in that ran out as its file started is asked for
// once more; a 429 for too many open ways in waits and asks again, while a file's day of versions waits in the tray;
// and signing out empties the store.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DetailedError } from 'tus-js-client';
import { until } from '../lib/helpers.ts';

// browser code: imported by URL, so the backend typecheck doesn't take it in
type Upload = { key: string; path: string; state: string; mode?: string; reasked?: boolean };
type Store = {
  fileIo: { api: unknown; Upload: unknown };
  AHEAD: number;
  sendFiles: (area: string, dir: string, items: { file: File; path: string; base: number | null; rel: string }[]) => string;
  fileUploadsNow: () => { batches: unknown[]; uploads: Upload[] };
  resetFileUploads: () => void;
};
const store = (await import(new URL('../../web/src/files/uploadStore.ts', import.meta.url).href)) as Store;
const { ApiError } = (await import(new URL('../../web/src/api/client.ts', import.meta.url).href)) as {
  ApiError: new (message: string, status: number, retryAfter?: number | null, details?: Record<string, unknown>) => Error;
};
const { forgetInMemory } = (await import(new URL('../../web/src/lib/signedOut.ts', import.meta.url).href)) as { forgetInMemory: () => void };

const AT_ONCE = 3;
/** What the store hands tus that the stand-in uses. */
type Options = { onSuccess: (x: unknown) => void; onError: (e: unknown) => void };
const response = (status: number, body: unknown) => ({
  getStatus: () => status,
  getBody: () => JSON.stringify(body),
  getHeader: () => undefined,
  getUnderlyingObject: () => null,
});

/** The stand-in server: ways in on request, what each upload does when it starts, and what was asked. */
function fakes() {
  const asks: string[][] = [];
  const started: string[] = [];
  let open = 0;
  let mostOpen = 0;
  /** Paths whose way in has run out by the time they start, and how often. */
  const expired = new Map<string, number>();
  /** Answers to give before the ways in (one per ask). */
  const refusals: Error[] = [];
  const hanging = new Set<string>();
  store.fileIo.api = async (url: string, init: { body: { files: { path: string }[] } }) => {
    if (url !== '/api/files/uploads') throw new Error(`not expected: ${url}`);
    const refusal = refusals.shift();
    if (refusal) throw refusal;
    const paths = init.body.files.map((f) => f.path);
    asks.push(paths);
    open += paths.length;
    mostOpen = Math.max(mostOpen, open);
    return { folder: 'Acme', tus: 'http://media.test/api/uploads', uploads: paths.map((path) => ({ path, ticket: `t-${path}`, expires: '' })) };
  };
  store.fileIo.Upload = class {
    file: File;
    options: Options;
    constructor(file: File, options: Options) {
      this.file = file;
      this.options = options;
    }
    async findPreviousUploads() {
      return [];
    }
    resumeFromPreviousUpload() {}
    async abort() {}
    start() {
      const path = this.file.name;
      open--;
      started.push(path);
      if (hanging.has(path)) return;
      setTimeout(() => {
        const left = expired.get(path) ?? 0;
        if (left > 0) {
          expired.set(path, left - 1);
          // tus's error with the server's answer on it, as tus makes it
          const gone = Object.assign(new DetailedError('gone'), { originalResponse: response(410, { error: 'this upload URL has expired' }) });
          return this.options.onError(gone);
        }
        this.options.onSuccess({ lastResponse: response(204, { commit: { files: [{ path, state: 'added' }] } }) });
      }, 0);
    }
  };
  return { asks, started, expired, refusals, hanging, mostOpen: () => mostOpen };
}

const drop = (names: string[], base: number | null = null) =>
  store.sendFiles(
    'Acme',
    '',
    names.map((n) => ({ file: new File([new Uint8Array(8)], n), path: n, base, rel: n })),
  );
const uploads = () => store.fileUploadsNow().uploads;
const settled = () => uploads().every((u) => u.state !== 'waiting' && u.state !== 'uploading');

test('a thousand and one files: ways in asked a few ahead of what is sent, none in “later”, all arrive', async () => {
  store.resetFileUploads();
  const f = fakes();
  const names = Array.from({ length: 1001 }, (_, i) => `take-${String(i).padStart(4, '0')}.mov`);
  drop(names);
  await until(
    settled,
    () =>
      JSON.stringify(
        uploads()
          .filter((u) => u.state !== 'done')
          .slice(0, 3),
      ),
    60_000,
  );
  assert.equal(uploads().filter((u) => u.state === 'done').length, 1001);
  assert.equal(uploads().filter((u) => u.state === 'later').length, 0, 'never “no more versions today”');
  assert.ok(
    f.asks.every((a) => a.length <= AT_ONCE + store.AHEAD),
    `asked in windows: ${Math.max(...f.asks.map((a) => a.length))}`,
  );
  assert.ok(f.mostOpen() <= AT_ONCE + store.AHEAD, `ways in open at most a window's: ${f.mostOpen()}`);
  assert.equal(f.asks.flat().length, 1001, 'each asked for once');
});

test('a way in that ran out as its file started is asked for once more; a second time, the file says it failed', async () => {
  store.resetFileUploads();
  const f = fakes();
  f.expired.set('b.mov', 1);
  f.expired.set('c.mov', 2);
  drop(['a.mov', 'b.mov', 'c.mov']);
  await until(settled, () => JSON.stringify(uploads()));
  const state = Object.fromEntries(uploads().map((u) => [u.path, u.state]));
  assert.deepEqual(state, { 'a.mov': 'done', 'b.mov': 'done', 'c.mov': 'failed' });
  const asked = (p: string) => f.asks.filter((a) => a.includes(p)).length;
  assert.equal(asked('a.mov'), 1);
  assert.equal(asked('b.mov'), 2, 'asked for again, once');
  assert.equal(asked('c.mov'), 2, 'and only once');
});

test('too many ways in open (429 tickets): nothing waits in “later”, they are asked for again and arrive', async () => {
  store.resetFileUploads();
  const f = fakes();
  f.refusals.push(new ApiError('too many upload URLs are open here right now', 429, 1, { reason: 'tickets', retry_after: 1 }));
  drop(['a.mov', 'b.mov']);
  await until(
    () => uploads().every((u) => u.state === 'done'),
    () => JSON.stringify(uploads()),
    10_000,
  );
  assert.equal(f.asks.length, 1, 'asked again after the wait');
});

test('a file’s day of versions (429 versions) waits in the tray as “later”', async () => {
  store.resetFileUploads();
  const f = fakes();
  f.refusals.push(new ApiError('you made 24 versions of a.mov today', 429, 3600, { reason: 'versions', retry_after: 3600 }));
  drop(['a.mov'], 3);
  await until(settled, () => JSON.stringify(uploads()));
  assert.equal(uploads()[0]?.state, 'later');
  assert.equal(f.started.length, 0);
});

test('signing out empties the store: no batch, no file, nothing to try again', async () => {
  store.resetFileUploads();
  const f = fakes();
  f.hanging.add('a.mov');
  drop(['a.mov', 'b.mov']);
  await until(() => f.started.includes('a.mov'), 'a.mov on its way');
  forgetInMemory();
  assert.deepEqual(store.fileUploadsNow(), { batches: [], uploads: [] });
});
