// asks.json (lib/asks.ts) stays bounded and is read once per change (audit A12, options: OPT-2, OPT-5). A reviewer's
// loop of ask + close grew it to 32 MB, re-parsed on every inbox read and every new note; re-answering appended without
// end; a file of the wrong shape read as empty and the next question wrote over it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { OptionGroup } from '../../lib/types.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const asks = await import('../../lib/asks.ts');
const { dataDir } = await import('../../lib/paths.ts');
const { cleanOptions } = await import('../../lib/options.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { publicMessage } = await import('../../lib/publicError.ts');

const FILE = path.join(dataDir(), 'asks.json');
const options = (): OptionGroup[] => cleanOptions([{ id: 'voice', items: [{ id: 'a' }, { id: 'b' }] }]);
const ask = (text = 'Which voice?', folder = 'Demo') => asks.createAsk({ folder, text, options: options(), author: 'agent:sound' });

test('a question’s text is at most 5000 characters, whoever makes it', () => {
  assert.throws(() => ask('x'.repeat(5001)), /at most 5000 characters/);
  assert.equal(ask('x'.repeat(5000)).text.length, 5000);
});

test('answers to one question are capped: past the cap a new pick is refused, the thread kept', () => {
  const a = ask();
  for (let i = 0; i < asks.ASK_LIMITS.replies; i++) asks.answerAsk(a.id, { picks: { voice: [i % 2 ? 'a' : 'b'] } }, 'Rita');
  assert.throws(
    () => asks.answerAsk(a.id, { picks: { voice: ['a'] } }, 'Rita'),
    (e: Error & { status?: number }) => e.status === 409 && /answered 50 times already/.test(e.message),
  );
  assert.equal(asks.findAsk(a.id)?.replies.length, asks.ASK_LIMITS.replies);
});

test('a question on a video is capped the same way (review.json)', () => {
  const video = makeVideo(path.join(dir, 'renders', 'spot.mp4'), { dur: 1 });
  store.createOrGetReview(video, { by: 'tester' });
  const q = store.addComment(slugify(video), { frame: 0, scope: 'video', kind: 'question', text: 'Which voice?', author: 'agent:sound', options: options() });
  for (let i = 0; i < 50; i++) store.updateComment(q.id, { answer: { picks: { voice: ['a'] } }, by: 'Rita' });
  assert.throws(
    () => store.updateComment(q.id, { answer: { picks: { voice: ['b'] } }, by: 'Rita' }),
    (e: Error & { status?: number }) => e.status === 409 && /answered 50 times already/.test(e.message),
  );
});

test('the file has a size: answered questions go, oldest first, to make room; questions waiting are refused past it', () => {
  const saved = { ...asks.ASK_LIMITS };
  Object.assign(asks.ASK_LIMITS, { kept: 12, bytes: 40_000 });
  try {
    for (let i = 0; i < 30; i++) asks.closeAsk(ask(`Closed ${i}`).id, 'Rita');
    let all = asks.listAsks();
    assert.ok(all.length <= 12, `kept ${all.length}`);
    assert.ok(
      all.some((a) => a.text === 'Closed 29'),
      'the newest stay',
    );
    assert.ok(!all.some((a) => a.text === 'Closed 0'), 'the oldest answered went');
    // Big questions waiting fill the room: answered ones make way, oldest first, then a new one is refused.
    const answeredBefore = all.filter((a) => a.status !== 'open');
    const big = 'B'.repeat(4000);
    let refused: Error | null = null;
    for (let i = 0; i < 30 && !refused; i++) {
      try {
        ask(`${big} ${i}`);
      } catch (e) {
        refused = e as Error;
      }
    }
    assert.match(refused?.message ?? '', /questions waiting here take all the room/);
    assert.equal((refused as Error & { status?: number }).status, 409);
    all = asks.listAsks();
    assert.ok(fs.statSync(FILE).size <= 40_000, `${fs.statSync(FILE).size} bytes`);
    const answeredAfter = all.filter((a) => a.status !== 'open');
    assert.ok(answeredAfter.length < answeredBefore.length, 'answered ones made way');
    const newest = answeredBefore.slice(answeredBefore.length - answeredAfter.length);
    assert.deepEqual(
      answeredAfter.map((a) => a.id),
      newest.map((a) => a.id),
      'the newest answered stay',
    );
  } finally {
    Object.assign(asks.ASK_LIMITS, saved);
    fs.rmSync(FILE, { force: true });
  }
});

test('read once per change: lists, the inbox and new note ids share one parse until the file changes', () => {
  ask('Held?');
  const first = asks.shownAsks();
  assert.equal(asks.shownAsks(), first, 'the same parse, no second read');
  store.reservedCommentId();
  assert.equal(asks.shownAsks(), first, 'a new note id reads the held copy');
  // Another process writes the file (an atomic rename: a new inode).
  const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  parsed.asks[0].text = 'Changed elsewhere';
  fs.writeFileSync(`${FILE}.tmp`, JSON.stringify(parsed));
  fs.renameSync(`${FILE}.tmp`, FILE);
  assert.equal(asks.shownAsks()[0]?.text, 'Changed elsewhere');
  // A write here is held at once.
  const made = ask('After');
  assert.ok(asks.shownAsks().some((a) => a.id === made.id));
  fs.rmSync(FILE, { force: true });
});

test('a file of the wrong shape is never read as empty, nor written over (OPT-5)', () => {
  for (const wrong of ['{"items": []}', '[]', '{"asks": {}}', '{"asks": [{"id": 7}]}', '{"asks": [null]}']) {
    fs.writeFileSync(FILE, wrong);
    assert.throws(() => asks.listAsks(), /isn’t a list of questions/, wrong);
    assert.throws(
      () => ask(),
      (e: Error) => {
        // The server's state, said without the path to everyone but the machine's owner.
        assert.match(e.message, /isn’t a list of questions/);
        assert.equal(publicMessage(e, 'other', { status: 422 }), 'the questions asked on folders can’t be read right now; try again later');
        return true;
      },
    );
    assert.equal(fs.readFileSync(FILE, 'utf8'), wrong, 'kept as it was');
    assert.deepEqual(asks.shownAsks(), [], 'lists show none meanwhile');
  }
  // A folder renamed meanwhile says so in the log instead of passing in silence.
  const logged: string[] = [];
  const ce = console.error;
  console.error = (...a: unknown[]) => logged.push(a.join(' '));
  try {
    asks.moveAskFolders((f) => f);
  } finally {
    console.error = ce;
  }
  assert.ok(
    logged.some((l) => /questions on folders weren’t moved/.test(l)),
    logged.join('\n'),
  );
  fs.rmSync(FILE, { force: true });
});
