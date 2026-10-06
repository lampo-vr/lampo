// The heavy-job queue is fair between workspaces (audit A12, WS-6): one team's batch of uploads must not hold every
// other team's posters, scrub copies and checks back until it drains — of any priority. The workspaces with work
// waiting take turns (the one served longest ago next), each turn running that workspace's most urgent job, its own
// jobs by priority and then in the order they came; with one workspace (the machine) the order is exactly what it
// always was.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

// A hosted store: the last tests make workspaces with owners (the rest use ids no registry knows: each its own turn).
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const { heavy, jobRoom, needJobRoom, PRIORITY, QUEUE_LIMITS, QueueFullError } = await import('../../lib/jobs.ts');
const { currentWorkspace, inWorkspace } = await import('../../lib/scope.ts');

const A = 'w_aaaaaaaaaaaa';
const B = 'w_bbbbbbbbbbbb';
const C = 'w_cccccccccccc';

/** Holds the one slot until released, so everything queued after it waits and is then taken in the queue's order. */
async function hold(): Promise<() => void> {
  let release = () => {};
  await new Promise<void>((started) =>
    heavy(
      () =>
        new Promise<void>((r) => {
          release = r;
          started();
        }),
      PRIORITY.scrub,
    ),
  );
  return release;
}

test('20 jobs of one workspace, then one of another at the same priority: the other runs second, not 21st', async () => {
  const release = await hold();
  const order: string[] = [];
  const all: Promise<unknown>[] = [];
  for (let i = 0; i < 20; i++) all.push(inWorkspace(A, () => heavy(() => order.push(`${currentWorkspace()}:${i}`), PRIORITY.poster)));
  all.push(inWorkspace(B, () => heavy(() => order.push(`${currentWorkspace()}:0`), PRIORITY.poster)));
  release();
  await Promise.all(all);
  assert.deepEqual(order.slice(0, 3), [`${A}:0`, `${B}:0`, `${A}:1`]);
  assert.deepEqual(
    order.filter((o) => o.startsWith(A)),
    Array.from({ length: 20 }, (_, i) => `${A}:${i}`),
    'each workspace’s own jobs keep their order',
  );
});

test('turns go round: three workspaces with work waiting take one job each in turn', async () => {
  const release = await hold();
  const order: string[] = [];
  const all: Promise<unknown>[] = [];
  for (const w of [A, A, A, B, B, C, C, C]) all.push(inWorkspace(w, () => heavy(() => order.push(currentWorkspace().slice(2, 3)), PRIORITY.analysis)));
  release();
  await Promise.all(all);
  assert.equal(order.join(''), 'abcabcac');
});

test('a turn runs the workspace’s most urgent job: a scrub copy before its poster, a poster before a sprite', async () => {
  const release = await hold();
  const order: string[] = [];
  const all = [
    inWorkspace(B, () => heavy(() => order.push('B sprite'), PRIORITY.sprite)),
    inWorkspace(A, () => heavy(() => order.push('A poster'), PRIORITY.poster)),
    inWorkspace(A, () => heavy(() => order.push('A scrub'), PRIORITY.scrub)),
    inWorkspace(B, () => heavy(() => order.push('B poster'), PRIORITY.poster)),
  ];
  release();
  await Promise.all(all);
  assert.deepEqual(order, ['A scrub', 'B poster', 'A poster', 'B sprite']);
});

test('across priorities too: one workspace’s 20 scrub copies hold another’s poster back by one job, not 21 (WS-6)', async () => {
  const release = await hold();
  const order: string[] = [];
  const all: Promise<unknown>[] = [];
  for (let i = 0; i < 20; i++) all.push(inWorkspace(A, () => heavy(() => order.push(`A scrub ${i}`), PRIORITY.scrub)));
  all.push(inWorkspace(B, () => heavy(() => order.push('B poster'), PRIORITY.poster)));
  all.push(inWorkspace(B, () => heavy(() => order.push('B scrub'), PRIORITY.scrub)));
  all.push(inWorkspace(C, () => heavy(() => order.push('C sprite'), PRIORITY.sprite)));
  release();
  await Promise.all(all);
  assert.deepEqual(order.slice(0, 7), ['A scrub 0', 'B scrub', 'C sprite', 'A scrub 1', 'B poster', 'A scrub 2', 'A scrub 3']);
  assert.deepEqual(
    order.filter((o) => o.startsWith('A')),
    Array.from({ length: 20 }, (_, i) => `A scrub ${i}`),
  );
});

test('of two workspaces nobody served yet the more urgent job goes first; after that they alternate', async () => {
  const release = await hold();
  const order: string[] = [];
  const all: Promise<unknown>[] = [];
  all.push(inWorkspace(A, () => heavy(() => order.push('A transcript'), PRIORITY.transcript)));
  for (let i = 0; i < 3; i++) all.push(inWorkspace(B, () => heavy(() => order.push(`B scrub ${i}`), PRIORITY.scrub)));
  release();
  await Promise.all(all);
  // B's scrub copy is more urgent than A's transcript, but B doesn't get a second turn while A waits
  assert.deepEqual(order, ['B scrub 0', 'A transcript', 'B scrub 1', 'B scrub 2']);
});

test('one workspace (the machine): priority, then arrival, as always', async () => {
  const release = await hold();
  const order: number[] = [];
  const all = [5, 1, 5, 0, 1, 8].map((p, i) => heavy(() => order.push(i), p));
  release();
  await Promise.all(all);
  assert.deepEqual(order, [3, 1, 4, 0, 2, 5]);
  // and any mix of every kind of job: sorted by priority, then arrival
  const again = await hold();
  const kinds = Object.values(PRIORITY);
  let seed = 7;
  const next = (): number => {
    seed = (seed * 48271) % 2147483647;
    return seed;
  };
  const mix = Array.from({ length: 60 }, () => kinds[next() % kinds.length] as number);
  const ran: number[] = [];
  const jobs = mix.map((p, i) => heavy(() => ran.push(i), p));
  again();
  await Promise.all(jobs);
  assert.deepEqual(
    ran,
    mix
      .map((p, i) => ({ p, i }))
      .sort((x, y) => x.p - y.p || x.i - y.i)
      .map((x) => x.i),
  );
});

test('a workspace may have so many jobs waiting: past that a job is refused with a clear answer, said once; owed work still queues, and other teams are never held (D2)', async () => {
  QUEUE_LIMITS.perWorkspace = 3;
  const logged: string[] = [];
  const { error } = console;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    const release = await hold();
    const ran: string[] = [];
    const queuedA = [0, 1, 2].map((i) => inWorkspace(A, () => heavy(() => ran.push(`A${i}`), PRIORITY.analysis)));
    assert.equal(
      inWorkspace(A, () => jobRoom()),
      false,
    );
    for (let i = 0; i < 2; i++)
      await assert.rejects(
        inWorkspace(A, () => heavy(() => ran.push('A refused'), PRIORITY.analysis)),
        (e: Error) => e instanceof QueueFullError && e.status === 503 && /^this workspace has 3 jobs waiting already/.test(e.message),
      );
    assert.throws(() => inWorkspace(A, () => needJobRoom()), QueueFullError);
    assert.equal(logged.filter((l) => l.startsWith(`jobs: workspace ${A} has 3 jobs waiting`)).length, 1, `said once:\n${logged.join('\n')}`);
    // a fix check the server owes is queued past the cap; another team queues as ever
    const owed = inWorkspace(A, () => heavy(() => ran.push('A owed'), PRIORITY.preview, { mustRun: true }));
    const other = inWorkspace(B, () => heavy(() => ran.push('B'), PRIORITY.analysis));
    release();
    await Promise.all([...queuedA, owed, other]);
    assert.deepEqual(ran.sort(), ['A owed', 'A0', 'A1', 'A2', 'B']);
    assert.equal(
      inWorkspace(A, () => jobRoom()),
      true,
      'room again once they ran',
    );
  } finally {
    QUEUE_LIMITS.perWorkspace = Number.POSITIVE_INFINITY;
    console.error = error;
  }
});

test('turns go by who runs a workspace first: one account’s ten workspaces hold another team’s poster back by one job, not ten (D2)', async () => {
  const auth = await import('../../lib/auth.ts');
  const ws = await import('../../lib/workspaces.ts');
  const una = await auth.createUser({ email: 'una@example.com', name: 'Una', password: 'unas password 1', role: 'owner' });
  const ben = await auth.createUser({ email: 'ben@example.com', name: 'Ben', password: 'bens password 1', role: 'reviewer' });
  const hers = Array.from({ length: 10 }, (_, i) => ws.createWorkspace({ name: `Una ${i}`, ownerId: una.id }).id);
  const his = ws.createWorkspace({ name: 'Ben’s', ownerId: ben.id }).id;
  const release = await hold();
  const order: string[] = [];
  const all: Promise<unknown>[] = [];
  for (const w of hers) for (let i = 0; i < 5; i++) all.push(inWorkspace(w, () => heavy(() => order.push(`una ${w}`), PRIORITY.scrub)));
  for (const n of [1, 2]) all.push(inWorkspace(his, () => heavy(() => order.push(`ben poster ${n}`), PRIORITY.poster)));
  release();
  await Promise.all(all);
  assert.equal(order.indexOf('ben poster 1'), 1, 'second, behind one of Una’s scrub copies (was 11th of 52)');
  assert.equal(order.indexOf('ben poster 2'), 3);
  const unas = order.filter((o) => o.startsWith('una'));
  assert.equal(new Set(unas.slice(0, 10)).size, 10, 'within Una’s turns her ten workspaces take turns');
});
