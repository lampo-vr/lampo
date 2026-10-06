// A lock a crashed process left behind is taken over, even when the process that finds it has the same pid (a
// restarted container keeps its hostname and hands out the same small pids); a lock a live process holds is waited for.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');

let n = 0;
/** A folder with a lock someone left: its owner file (pid@host), maybe a run token, maybe an old time. */
function leftLock(owner: string, { run, minutesAgo = 0 }: { run?: string; minutesAgo?: number } = {}): string {
  const at = path.join(dir, `d${++n}`);
  const lock = path.join(at, '.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), owner);
  if (run) fs.writeFileSync(path.join(lock, 'run'), run);
  if (minutesAgo) {
    const t = new Date(Date.now() - minutesAgo * 60_000);
    fs.utimesSync(lock, t, t);
  }
  return at;
}
const host = os.hostname();
const quickly = (at: string) => {
  const t0 = Date.now();
  assert.equal(
    store.withLock(at, () => 'got it'),
    'got it',
  );
  // A live writer's lock is waited for 5 s, then refused: taken well before that = not waited for.
  assert.ok(Date.now() - t0 < 4000, `took ${Date.now() - t0} ms`);
};

test('our own pid on a lock we don’t hold: an earlier process of that number left it (a restart)', () => {
  quickly(leftLock(`${process.pid}@${host}`));
  quickly(leftLock(`${process.pid}@${host}`, { run: 'an earlier run' }));
});

test('a live process’s lock is waited for; one held for ten minutes is not held any more (its pid went to another)', () => {
  quickly(leftLock(`${process.ppid}@${host}`, { minutesAgo: 11 }));
  const busy = leftLock(`${process.ppid}@${host}`);
  assert.throws(
    () => store.withLock(busy, () => 'never'),
    (e: Error & { status?: number }) => e.status === 503,
  );
});
