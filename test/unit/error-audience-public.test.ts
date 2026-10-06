// An error about the server's state carries the sentence everyone but the machine's owner reads (`publicText`): a lost
// workspaces.json names the data folder, its backups and how to restore them, which only the operator may read. That
// sentence is decided by who asks before anything else — before a caller's 4xx turns a failure into "the caller's own
// business": an MCP tool reports every error as a 400, a route wraps a failure with `failFrom(4xx, e)`. And an error that
// says it is the server's fault (its own status ≥ 500) stays hidden whatever status the caller asked for (audit A12
// verification of E1: VE1-1).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_STT: 'off' } });
const { publicMessage } = await import('../../lib/publicError.ts');
const { WorkspacesLostError } = await import('../../lib/workspaces.ts');
const { createErrorHandler, failFrom } = await import('../../server/http.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { createReviewServer } = await import('../../mcp/core.ts');

const SECRET = '/srv/lampo/data';
const lost = () =>
  new WorkspacesLostError(
    `${SECRET}/workspaces.json is missing, but this store moved to workspaces (a backup from the move in ${SECRET}/backups): restore it from your backup of ${SECRET}.`,
  );
const PUBLIC_TEXT = 'the server can’t read its list of workspaces right now: try again later';

test('the rule: public text first, whatever the status; an error’s own 5xx stays hidden; our own words stay ours', () => {
  const e = lost();
  assert.equal(publicMessage(e, 'other', { status: 400 }), PUBLIC_TEXT, 'an MCP tool’s 400');
  assert.equal(publicMessage(failFrom(422, e), 'other', { status: 422 }), PUBLIC_TEXT, 'a route’s 4xx around it');
  assert.equal(publicMessage(e, 'owner', { status: 400 }), e.message, 'the owner at the machine reads it as it is');
  const fault = Object.assign(new Error(`the disk under ${SECRET} is full`), { status: 503 });
  const hidden = publicMessage(fault, 'other', { status: 400 });
  assert.match(hidden, /^something went wrong on the server \(ref [0-9a-f]{8}\)$/, hidden);
  assert.match(publicMessage(failFrom(400, fault), 'other', { status: 400 }), /\(ref [0-9a-f]{8}\)$/, 'through the cause too');
  assert.equal(publicMessage(new Error('no note c_123456'), 'other', { status: 400 }), 'no note c_123456', 'a sentence of our own about the request');
});

// A failure told again with which item failed (lib/askOptions.ts makeAsk) went out as a plain Error: an object store's
// XML and ffmpeg's output reached tokens as a 422 (A12 OPTM-1). `restated` keeps what it was.
test('a failure told again with words in front is still what it was: internal, its own sentence, its status', async () => {
  const { isInternal, restated, statusOf } = await import('../../lib/publicError.ts');
  const { QueueFullError } = await import('../../lib/jobs.ts');
  const bucket = Object.assign(new Error(`S3 upload asks/c_1a2b3c/r_0123456789.m4a: HTTP 403 <Error><BucketName>${SECRET}</BucketName></Error>`), {
    status: 403,
    internal: true,
  });
  const store = restated('voice/a: ', bucket);
  assert.equal(store.message, `voice/a: ${bucket.message}`);
  assert.equal(store.cause, bucket);
  assert.ok(isInternal(store));
  assert.equal(statusOf(store, 422), 500, 'the store’s refusal is the server’s fault');
  assert.match(publicMessage(store, 'other', { status: statusOf(store, 422) }), /^something went wrong on the server \(ref [0-9a-f]{8}\)$/, 'HTTP');
  const tool = publicMessage(store, 'other', { status: 400 });
  assert.match(tool, /\(ref [0-9a-f]{8}\)$/, 'an MCP tool’s 400');
  assert.doesNotMatch(tool, new RegExp(SECRET));
  assert.equal(publicMessage(store, 'owner', { status: 400 }), store.message, 'the owner at the machine reads which item and why');
  const busy = restated('voice/a: ', new QueueFullError(200));
  assert.equal(statusOf(busy, 422), 503);
  assert.equal((busy as Error & { retryAfter?: number }).retryAfter, 60);
  assert.match(publicMessage(busy, 'other', { status: 400 }), /^this workspace has 200 jobs waiting already/, 'its own sentence, no ref');
  const crash = restated('voice/a: ', Object.assign(new Error(`${SECRET}/ffmpeg exited null: …`), { stderr: '…', code: null }));
  assert.equal(statusOf(crash, 422), 422, 'a tool’s failure on the caller’s file keeps the route’s status');
  assert.doesNotMatch(publicMessage(crash, 'other', { status: 422 }), new RegExp(SECRET));
  const words = restated('voice/a: ', new Error('a sound may be at most 180 s long'));
  assert.equal(publicMessage(words, 'other', { status: 422 }), 'voice/a: a sound may be at most 180 s long', 'our own words stay');
});

test('HTTP: a 4xx made of the lost registry reads the public sentence for every audience but the owner at the machine', () => {
  const handle = createErrorHandler({ hosted: true });
  const answer = (via: string | null, path = '/api/review/x/refs') => {
    const res = {
      headersSent: false,
      code: 0,
      body: null as unknown,
      setHeader() {},
      status(c: number) {
        this.code = c;
        return this;
      },
      json(b: unknown) {
        this.body = b;
      },
    };
    handle(failFrom(422, lost()), { method: 'POST', path, auth: via ? { via } : undefined } as never, res as never, () => {});
    return { code: res.code, error: (res.body as { error: string }).error };
  };
  for (const via of ['token', 'cookie', 'lan', null]) assert.deepEqual(answer(via), { code: 422, error: PUBLIC_TEXT }, `via ${via}`);
  assert.deepEqual(answer('local', '/api/g/tok/comments'), { code: 422, error: PUBLIC_TEXT }, 'a review-link visitor at the machine');
  assert.match(answer('local').error, new RegExp(SECRET), 'the owner at the machine');
});

test('MCP: a tool’s error and a wait cut off by it read the public sentence; the machine’s own agent reads the error', async () => {
  const backend = createLocalBackend();
  const failing = {
    ...backend,
    listReviews: async () => {
      throw lost();
    },
  };
  const call = async (via: 'token' | 'oauth' | 'local', name: string, args: Record<string, unknown>) => {
    const server = createReviewServer({
      backend: failing as typeof backend,
      principal: { via, name: 'Max', id: 'u_000000000001', role: 'member' },
      stillAllowed: () => {
        throw lost();
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: 'agent', version: '1' });
    await c.connect(a);
    try {
      const r = (await c.callTool({ name, arguments: args })) as { content: { text?: string }[]; isError?: boolean };
      assert.equal(r.isError, true, `${name} fails`);
      return r.content.map((x) => x.text ?? '').join('\n');
    } finally {
      await c.close();
      await server.close();
    }
  };
  for (const via of ['token', 'oauth'] as const) {
    assert.equal(await call(via, 'list_videos', {}), `Error: ${PUBLIC_TEXT}`, `list_videos via ${via}`);
    assert.equal(await call(via, 'wait_for_feedback', { timeout_s: 0 }), `Error: ${PUBLIC_TEXT}`, `wait_for_feedback via ${via}`);
  }
  assert.match(await call('local', 'list_videos', {}), new RegExp(SECRET), 'the machine’s own agent');
});

// The inbox resource reads like the review resource: a failure reading it goes out by audience (A12 hardening).
test('MCP: a failure reading vr://inbox is a sentence for everyone but the machine’s own agent', async () => {
  const backend = createLocalBackend();
  const read = async (via: 'token' | 'oauth' | 'local') => {
    const server = createReviewServer({
      backend,
      principal: { via, name: 'Max', id: 'u_000000000001', role: 'member' },
      inboxMarkdown: async () => {
        throw Object.assign(new Error(`EACCES: permission denied, open '${SECRET}/INBOX.md'`), { code: 'EACCES', errno: -13, path: `${SECRET}/INBOX.md` });
      },
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await server.connect(b);
    const c = new Client({ name: 'agent', version: '1' });
    await c.connect(a);
    try {
      return await c.readResource({ uri: 'vr://inbox' }).then(
        () => 'read',
        (e: Error) => e.message,
      );
    } finally {
      await c.close();
      await server.close();
    }
  };
  for (const via of ['token', 'oauth'] as const) {
    const said = await read(via);
    assert.ok(!said.includes(SECRET), `via ${via}: ${said}`);
    assert.match(said, /\(ref [0-9a-f]{8}\)/, `via ${via}: ${said}`);
  }
  assert.match(await read('local'), new RegExp(SECRET), 'the machine’s own agent');
});
