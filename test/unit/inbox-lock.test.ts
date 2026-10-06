// INBOX.md is rewritten by every process that writes an event (the server, `vr`, an MCP server). Two of them at once
// must not leave the older rendering last: the rendering is read and written under one lock. The test plays the slow
// process: it holds that lock while it writes a rendering from before another process's event, and the other process
// must write after it, from the events as they are then.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, ROOT, sleep } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { DATA, slugify } = await import('../../lib/paths.ts');

const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { dur: 1, audio: false });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(video);
const inbox = () => fs.readFileSync(store.INBOX_FILE, 'utf8');

async function until(what: () => boolean, ms: number): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (what()) return true;
    await sleep(10);
  }
  return what();
}

test('a rendering from before another process’s event never lands last', async () => {
  store.addRequest(slug, 'first request', 'tester');
  assert.match(inbox(), /first request/);
  // The slow process read the events before the other one wrote its own, and holds the inbox's lock while it renders.
  const older = store.renderInbox(store.inboxEvents());
  const lock = path.join(DATA, '.inbox', '.lock');
  fs.mkdirSync(lock, { recursive: true });
  fs.writeFileSync(path.join(lock, 'owner'), `${process.pid}@${os.hostname()}`);

  const script = `const s = await import(${JSON.stringify(path.join(ROOT, 'lib/store.ts'))}); s.addRequest(${JSON.stringify(slug)}, 'second request', 'tester');`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => {
    err += d;
  });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));

  assert.ok(await until(() => store.readEvents().some((e) => e.text === 'second request'), 5000), 'the other process wrote its event');
  // Without the lock the other process has rewritten INBOX.md by now; with it, it waits for the slow one.
  await until(() => inbox().includes('second request'), 1000);
  store.writeAtomic(store.INBOX_FILE, older);
  fs.rmSync(lock, { recursive: true, force: true });

  assert.equal(await exited, 0, err);
  assert.match(inbox(), /second request/, 'the newest rendering is the one that stays');
  assert.match(inbox(), /first request/);
});
