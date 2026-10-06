// The publish queue on a hosted server with several teams (A12 PUB-4): the owners of workspaces with posts due take
// turns, like the job queue's (lib/jobs.ts), so one workspace's backlog never holds another's post back by more than
// one send; and an encode a post needs is made before its turn to send, so a send that waits for ffmpeg (behind other
// teams' jobs) holds nobody's upload back.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, makeVideo, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const auth = await import('../../lib/auth.ts');
const wsl = await import('../../lib/workspaces.ts');
const { inWorkspace, currentWorkspace } = await import('../../lib/scope.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { heavy } = await import('../../lib/jobs.ts');
const { addConnection, changeConnection } = await import('../../lib/publish/connections.ts');
const posts = await import('../../lib/publish/posts.ts');
const { kitDir } = await import('../../lib/publish/kit.ts');
const { createPublisher } = await import('../../lib/publish/queue.ts');
type PublishTarget = import('../../lib/publish/adapter.ts').PublishTarget;

const sent: { ws: string; post: string }[] = [];
/** What happens while the next upload runs (once): the upload lasts until it is done. */
let during: (() => unknown) | null = null;
const adapter = {
  kind: 'zernio' as const,
  accounts: async () => [],
  async publish(t: PublishTarget) {
    sent.push({ ws: currentWorkspace(), post: t.post.id });
    const now = during;
    during = null;
    await now?.();
    return { state: 'posted' as const, remote_id: `r${sent.length}`, url: `https://x.example/${sent.length}` };
  },
  async status(p: { remote_id?: string; url?: string }) {
    return { state: 'posted' as const, remote_id: String(p.remote_id), url: p.url ?? null };
  },
};
const publisher = createPublisher({ adapters: { youtube: adapter as never, zernio: adapter as never }, log: () => {} });
const run = async () => {
  await publisher.tick();
  await publisher.idle();
};

const olivia = await auth.createUser({ email: 'o@example.com', name: 'Olivia', password: 'a long password 1', role: 'owner' });
const bob = await auth.createUser({ email: 'b@example.com', name: 'Bob', password: 'a long password 2', role: 'owner' });
void olivia;
const A = 'w1';
const B = wsl.createWorkspace({ name: 'Bravo', ownerId: bob.id }).id;
const conns: Record<string, string> = {};
for (const ws of [A, B])
  inWorkspace(ws, () => {
    const c = addConnection({ kind: 'zernio', label: ws, secret: { api_key: `sk_${ws}_secret_key_000` }, by: 't' });
    changeConnection(c.id, { state: 'ready', accounts: [{ id: 'ig1', platform: 'instagram', name: `${ws} IG` }] });
    conns[ws] = c.id;
  });

let n = 0;
/** A final video in the workspace with an Instagram post a person published; `fps` 120 needs the platform's encode. */
function due(ws: string, o: { fps?: number; cover?: number } = {}): string {
  return inWorkspace(ws, () => {
    const f = makeVideo(path.join(dir, `renders/${ws}-${++n}.mp4`), { w: 108, h: 192, fps: o.fps ?? 25, dur: 4, freq: 200 + n * 30 });
    store.createOrGetReview(f, { by: 'tester' });
    const slug = slugify(f);
    store.setApproval(slug, { status: 'approved' }, 'tester');
    store.setFinal(slug, {}, 'tester');
    const cover = o.cover === undefined ? {} : { cover_frame: o.cover };
    const fields = { connection: conns[ws], account: 'ig1', ai_generated: false, ...cover };
    const { post } = posts.draftPost({ slug, platform: 'instagram', fields, by: 'p' });
    posts.publishPost(post.id, { confirm: { platform: 'instagram', account: 'ig1', digest: posts.digestOf(post) }, by: 'p' });
    return post.id;
  });
}

test('PUB-4: two teams take turns: five posts due in one workspace hold the other’s back by one send at most', async () => {
  for (let i = 0; i < 5; i++) due(A);
  due(B);
  await run();
  const order = sent.map((s) => (s.ws === A ? 'A' : 'B'));
  assert.equal(order.length, 6);
  assert.ok(order.indexOf('B') <= 1, `B's post waits behind one of A's at most: ${order.join(' ')}`);
});

test('PUB-4: a post that needs an encode doesn’t hold the line while ffmpeg waits: another team’s post goes meanwhile', async () => {
  sent.length = 0;
  // the job queue is busy in A (another long job of A's): A's encode waits behind it
  let release: () => void = () => {};
  const blocker = inWorkspace(A, () => heavy(() => new Promise<void>((r) => (release = r)), 0));
  const slow = due(A, { fps: 120 }); // Instagram takes at most 60 fps: it needs the encode
  const quick = due(B);
  await publisher.tick();
  await until(() => sent.some((s) => s.post === quick), 'B’s post went while A’s encode waited', 20_000);
  assert.ok(!sent.some((s) => s.post === slow), 'A’s post waits for its encode, not in the send slot');
  release();
  await blocker;
  await run();
  assert.ok(
    sent.some((s) => s.post === slow),
    'and goes once its encode is made',
  );
  assert.equal(
    inWorkspace(A, () => posts.findPost(slow)?.file?.kind),
    'encode',
  );
});

test('PUB-4: a post published while another team’s uploads run waits behind one more of them at most, not the rest of that team’s backlog', async () => {
  sent.length = 0;
  for (let i = 0; i < 3; i++) due(A);
  let late = '';
  during = () => {
    late = due(B, { cover: 0 });
    // A's next upload lasts until B's file and cover are made (a real upload takes minutes, B's file seconds)
    during = () => until(() => inWorkspace(B, () => fs.existsSync(path.join(kitDir(late), 'cover.key'))), 'B’s cover was made', 10_000);
  };
  await run();
  const order = sent.map((s) => (s.ws === A ? 'A' : 'B'));
  assert.deepEqual(order, ['A', 'A', 'B', 'A'], 'B’s file was made during the second upload; B went next');
  assert.equal(sent[2]?.post, late);
});
