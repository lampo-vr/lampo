// What an agent is told when it hands work to the person, and while it waits for their notes (lib/handoff.ts): the
// hand-off answers (track_video, mark_fixed, wont_fix, a reply, a question, options to pick, a fix's preview; vr track,
// push, fix, wontfix, reply, add, ask) end with "wait now" — over MCP with a cursor from that moment, so a note written
// before the agent's next call is still heard — or with what is left to work (a note it answered waits for the person,
// so it isn't), a wait that ends with nothing new says why and to call again, and an agent that heard only that for 30
// minutes in a row (a chat app: 12 waits) is told to stop and say so (a clock of its own here: never a real half hour).
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { ReviewEvent } from '../../lib/types.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, slugOf, VR, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv({ config: { user: 'Sam Rivera' }, vars: { VR_STT: 'off' } });
const store = await import('../../lib/store.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { createReviewServer } = await import('../../mcp/core.ts');
const { ownQuiet, QUIET, quietIn } = await import('../../mcp/feedback.ts');
const { Recent } = await import('../../lib/rateLimit.ts');
const { CHAT_QUIET_WAITS, CHAT_STOP_LINE, CHAT_WAIT_WORDS, cursorAt, endsWaitNow, PENDING_LINE, STOP_LINE, stillOpenLine, WATCH_NOW_LINE, waitNowLine } =
  await import('../../lib/handoff.ts');
const { Client } = await import('@modelcontextprotocol/client');
const { InMemoryTransport } = await import('@modelcontextprotocol/server');

type Quiet = ReturnType<typeof ownQuiet>;
type Result = { content: { type: string; text?: string }[]; structuredContent?: Record<string, unknown>; isError?: boolean };
const said = (r: unknown) => ((r as Result).content ?? []).map((x) => x.text ?? '').join('\n');

/** An agent on this machine talking to the MCP server in this process (a clock of its own for `quiet`). */
async function mcp<T>(
  fn: (c: InstanceType<typeof Client>) => Promise<T>,
  o: { quiet?: Quiet; way?: 'machine' | 'coding' | 'chat'; onHandBack?: () => void } = {},
): Promise<T> {
  const server = createReviewServer({ backend: createLocalBackend(), principal: { via: 'local', name: 'Sam Rivera', role: 'owner' }, ...o });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(b);
  const c = new Client({ name: 'handoff-agent', version: '1' });
  await c.connect(a);
  try {
    return await fn(c);
  } finally {
    await c.close();
  }
}
const call = async (c: InstanceType<typeof Client>, name: string, args: Record<string, unknown>) => {
  const r = (await c.callTool({ name, arguments: args })) as Result;
  assert.ok(!r.isError, said(r));
  return r;
};
const lastLine = (s: string) => s.trimEnd().split('\n').at(-1);
const film = (name: string) => {
  const f = makeVideo(path.join(dir, 'Acme/export', name), { w: 160, h: 90, dur: 1 });
  age(f);
  return f;
};
const person = (slug: string, text: string, o: Record<string, unknown> = {}) =>
  store.addComment(slug, { frame: 3, text, severity: 'must', author: 'Mia Hartmann', ...o });
/** The agent's next render of the file, as V2: a fix marked now is in a version that has it (lib/store.ts). */
const rerender = (f: string) => {
  makeVideo(f, { w: 160, h: 90, dur: 1, freq: 990 });
  age(f);
  store.sync(slugOf(f));
};

test('cursorAt: this second, and the people’s events of it the log holds (every video’s: the wait it asks for hears them all)', () => {
  const at = '2026-10-05T10:00:07.000Z';
  const e = (o: Partial<ReviewEvent>) => ({ at, type: 'comment', by: 'Mia', slug: 'a', ...o }) as ReviewEvent;
  const events = [
    e({ at: '2026-10-05T10:00:06.000Z' }),
    e({}),
    e({ slug: 'b' }),
    e({ by: 'agent:cut' }), // an agent's own: never news to it
    e({ type: 'version' }), // not feedback
  ];
  const now = Date.parse('2026-10-05T10:00:07.640Z');
  assert.equal(cursorAt(events, now), `${at}#2`);
  assert.equal(cursorAt([], now), `${at}#0`);
});

test('track_video ends with "wait now" and a cursor from that moment: a note written before the next wait is heard', async () => {
  const f = film('spot.mp4');
  const slug = slugOf(f);
  await mcp(async (c) => {
    store.createOrGetReview(f, { by: 'Sam Rivera' });
    const before = person(slug, 'Written before the hand-off');
    const answer = said(await call(c, 'track_video', { path: f }));
    const cursor = /since "(\S+)"/.exec(answer)?.[1] as string;
    assert.ok(cursor, answer);
    assert.equal(lastLine(answer), waitNowLine(cursor), answer);
    assert.match(answer, /^already under review: .*spot\.mp4 \(v1\) · folder /);
    // the agent takes its time: the person writes meanwhile, and the wait with the hand-off's cursor hears it
    const meanwhile = person(slug, 'Written right after');
    const got = said(await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 5 }));
    assert.match(got, /^1 new:\n/, got);
    assert.ok(got.includes(meanwhile.id) && !got.includes(before.id), got);
  });
});

test('a wait for one video hears a note made in the same second as one on another video the cursor counted', async () => {
  const [fa, fb] = [film('same-a.mp4'), film('same-b.mp4')];
  const [a, b] = [slugOf(fa), slugOf(fb)];
  store.createOrGetReview(fa, { by: 'Sam Rivera' });
  store.createOrGetReview(fb, { by: 'Sam Rivera' });
  const onB = person(b, 'On B first');
  const onA = person(a, 'On A, the same second');
  // both notes in one second, B's first: the cursor a hand-off gave between them counted B's (cursorAt counts every video)
  const T = Math.floor(Date.now() / 1000) * 1000 - 5000;
  const file = store.eventsFile();
  const lines = fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((l) => (l.includes(onA.id) || l.includes(onB.id) ? JSON.stringify({ ...JSON.parse(l), at: new Date(T).toISOString() }) : l));
  fs.writeFileSync(file, lines.join('\n'));
  const cursor = `${new Date(T).toISOString()}#1`;
  await mcp(async (c) => {
    const got = said(await call(c, 'wait_for_feedback', { video: fa, since: cursor, timeout_s: 1 }));
    assert.ok(got.includes(onA.id), `A’s note is heard: ${got}`);
    assert.ok(!got.includes(onB.id), 'B’s is not this wait’s');
  });
});

test('mark_fixed and wont_fix say how many notes are still open, then (none left) "wait now"; ideas and questions are no work', async () => {
  const f = film('cut.mp4');
  const slug = slugOf(f);
  store.createOrGetReview(f, { by: 'Sam Rivera' });
  const a = person(slug, 'Logo too early');
  const b = person(slug, 'Title too small', { severity: 'should' });
  const w = person(slug, 'Music too loud', { severity: 'nice' });
  person(slug, 'Maybe a warmer grade', { severity: 'idea' });
  store.addComment(slug, { frame: 5, text: 'Is the logo final?', kind: 'question', author: 'agent:handoff-agent' });
  rerender(f);
  await mcp(async (c) => {
    let answer = said(await call(c, 'mark_fixed', { id: a.id, note: 'Logo 4 frames later' }));
    assert.equal(answer, `${a.id}: fixed in v2\n${stillOpenLine(2)}`);
    answer = said(await call(c, 'wont_fix', { id: w.id, reason: 'The client wants it loud' }));
    assert.equal(answer, `${w.id}: wontfix\n${stillOpenLine(1)}`);
    answer = said(await call(c, 'mark_fixed', { id: b.id, note: 'Title 20 % bigger' }));
    const cursor = /since "(\S+)"/.exec(answer)?.[1] as string;
    assert.equal(answer, `${b.id}: fixed in v2\n${waitNowLine(cursor)}`);
  });
  assert.equal(stillOpenLine(1), '1 note still open on this video.');
});

test('a reply, a question, options to pick and a fix’s preview hand the next step to the person: what is left, else "wait now" with a cursor', async () => {
  const f = film('asked.mp4');
  const slug = slugOf(f);
  store.createOrGetReview(f, { by: 'Sam Rivera' });
  // two Auto-check-like notes to work, and a third that comes later
  const dark = person(slug, 'Too dark in the first second');
  const logo = person(slug, 'Logo too early');
  let handedBack = 0;
  await mcp(
    async (c) => {
      // a reply that asks: one note is still the agent's to work
      let answer = said(await call(c, 'reply', { id: dark.id, note: 'Leave it or brighten it?' }));
      assert.equal(answer, `${dark.id}: reply added\n${stillOpenLine(1)}`);
      assert.equal(handedBack, 0, 'work is left: no hand-back yet');
      // a question pinned to the frame: the same, the answered note is no work left
      answer = said(await call(c, 'add_note', { video: f, frame: 2, text: 'Should the logo come in on the beat?', choices: ['On the beat', 'As it is'] }));
      assert.match(answer, /\nkind: question\n/);
      assert.equal(lastLine(answer), stillOpenLine(1), answer);
      // its last answer: nothing is left to work, so it waits now, from this moment
      answer = said(await call(c, 'reply', { id: logo.id, note: 'Is 4 frames later right?' }));
      let cursor = /since "(\S+)"/.exec(answer)?.[1] as string;
      assert.equal(answer, `${logo.id}: reply added\n${waitNowLine(cursor)}`);
      assert.equal(handedBack, 1, 'the app is told the next step is the person’s (server/agents.ts)');
      // the person answers meanwhile: the wait with that cursor hears it
      store.updateComment(dark.id, { note: 'Brighten it a little', by: 'Mia Hartmann' });
      const got = said(await call(c, 'wait_for_feedback', { since: cursor, timeout_s: 5 }));
      assert.match(got, /^1 new:\n/, got);
      assert.ok(got.includes(dark.id), got);
      // a note it fixed (in the version it rendered since) or left closes like before; one it answered isn't open work
      rerender(f);
      answer = said(await call(c, 'mark_fixed', { id: dark.id, note: 'Brightened by 10 %' }));
      assert.ok(endsWaitNow(answer), answer);
      // options to pick, on a folder before any render: the pick is the person's, so it waits
      answer = said(
        await call(c, 'ask_options', {
          folder: 'Acme/Reels',
          text: 'Which music?',
          groups: [
            {
              id: 'music',
              label: 'Music',
              items: [
                { id: 'a', label: 'Calm' },
                { id: 'b', label: 'Driving' },
              ],
            },
          ],
        }),
      );
      cursor = /since "(\S+)"/.exec(answer)?.[1] as string;
      assert.equal(lastLine(answer), waitNowLine(cursor), answer);
      assert.match(answer, /PICKED <group>=<item>/, 'the line agents parse stays');
      // a fix shown on a preview: the person checks it, so (nothing else left) it waits
      const next = person(slug, 'Cut the end 6 frames sooner');
      // the render's own frame shape (a preview of another shape is another picture)
      const png = path.join(dir, 'fix.png');
      execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=gray:s=160x90', '-frames:v', '1', '-y', png]);
      answer = said(await call(c, 'attach_preview', { id: next.id, path: png }));
      assert.ok(endsWaitNow(answer), answer);
    },
    { onHandBack: () => handedBack++ },
  );
  // a person's own reply through MCP hands nothing over: no line after it
  const own = person(slug, 'One more');
  await mcp(async (c) => assert.equal(said(await call(c, 'reply', { id: own.id, note: 'Noted for myself', by: 'Mia Hartmann' })), `${own.id}: reply added`));
});

test('a chat app stops after 12 waits with nothing new and ends its turn with one line that sends the person to Lampo and back', async () => {
  let clock = Date.parse('2026-10-05T10:00:00Z');
  const quiet = ownQuiet(() => clock, { waits: CHAT_QUIET_WAITS });
  await mcp(
    async (c) => {
      const wait = async () => (await call(c, 'wait_for_feedback', { timeout_s: 0 })) as Result;
      for (let i = 1; i < CHAT_QUIET_WAITS; i++, clock += 50_000) assert.equal(lastLine(said(await wait())), PENDING_LINE, `wait ${i}`);
      const stop = await wait();
      assert.equal(lastLine(said(stop)), CHAT_STOP_LINE, said(stop));
      assert.equal(stop.structuredContent?.stop, true);
    },
    { quiet, way: 'chat' },
  );
  assert.equal(CHAT_QUIET_WAITS, 12);
  assert.ok(CHAT_STOP_LINE.endsWith(CHAT_WAIT_WORDS));
  assert.equal(CHAT_WAIT_WORDS, `"I'm waiting for your answer in Lampo — answer there, then tell me 'go on' here."`);
});

test('every way of telling the loop says it: questions go to Lampo and the agent then waits, never asks in the chat or ends its turn', async () => {
  const { instructionsFor } = await import('../../mcp/loop.ts');
  for (const way of ['machine', 'coding', 'chat'] as const) {
    const told = instructionsFor(way);
    assert.match(
      told,
      /in Lampo \(reply, or add_note kind question with choices; ask_options to pick before a render\), then wait_for_feedback: never (also here|in your chat), never by ending your turn\./,
      way,
    );
  }
  // the chat app's last line when it must stop waiting
  assert.ok(instructionsFor('chat').includes(`When you must stop waiting, say only: ${CHAT_WAIT_WORDS}`));
});

test('a wait that ends with nothing new says what is going on, after the two lines agents parse', async () => {
  await mcp(async (c) => {
    const r = await call(c, 'wait_for_feedback', { timeout_s: 0 });
    const cursor = /cursor: (\S+)/.exec(said(r))?.[1];
    assert.equal(said(r), `No new feedback in 0 s.\ncursor: ${cursor}\n${PENDING_LINE}`);
    assert.equal(r.structuredContent?.stop, undefined);
  });
  assert.match(PENDING_LINE, /^The person's notes arrive together when they press Send: call wait_for_feedback again now/);
});

test('30 minutes of only "no new feedback" in a row: the answer says to stop and how to start again; a note starts the count over', async () => {
  let clock = Date.parse('2026-10-05T10:00:00Z');
  const quiet = ownQuiet(() => clock);
  await mcp(
    async (c) => {
      const wait = async () => (await call(c, 'wait_for_feedback', { video: 'quiet.mp4', timeout_s: 0 })) as Result;
      const f = film('quiet.mp4');
      store.createOrGetReview(f, { by: 'Sam Rivera' });
      // a wait every 100 s (the agent's turn between them well inside the 2 minutes a run allows)
      for (let i = 0; i < 18; i++, clock += 100_000) assert.equal(lastLine(said(await wait())), PENDING_LINE, `wait ${i}`);
      // 30 min after the first began
      const stop = await wait();
      assert.equal(lastLine(said(stop)), STOP_LINE, said(stop));
      assert.match(said(stop), /^No new feedback in 0 s\.\ncursor: \S+\n/, 'the lines agents parse stay first');
      assert.equal(stop.structuredContent?.stop, true);
      // told once: an agent started again begins a new run
      clock += 100_000;
      assert.equal(lastLine(said(await wait())), PENDING_LINE);
      // nothing for 29 min, then a note: a real answer, and the count starts over
      for (let i = 0; i < 17; i++, clock += 100_000) await wait();
      const cursor = /cursor: (\S+)/.exec(said(await wait()))?.[1];
      person(slugOf(f), 'At last');
      assert.match(said(await call(c, 'wait_for_feedback', { video: 'quiet.mp4', since: cursor, timeout_s: 5 })), /^1 new:/);
      for (let i = 0; i < 10; i++, clock += 100_000) assert.equal(lastLine(said(await wait())), PENDING_LINE, `after the note: wait ${i}`);
    },
    { quiet },
  );
  assert.match(STOP_LINE, /^30 min with nothing new: stop waiting now\. Tell the person you stopped listening; .*\/lampo:watch/);
});

test('the run of nothing: a pause longer than gapMs between two waits begins it again; agents are counted apart, in a bounded map', () => {
  let t = 0;
  const map = new Recent<{ since: number; last: number }>(2);
  const a = quietIn(map, 'a', () => t);
  const b = quietIn(map, 'b', () => t);
  // a: waits of 50 s back to back
  const waitA = () => {
    const from = t;
    t += 50_000;
    return a.nothing(from);
  };
  while (t + 50_000 < QUIET.stopMs) assert.equal(waitA(), false);
  // b waits too: its own run, from now
  assert.equal(b.nothing(t), false);
  // a pause longer than gapMs (it worked on something else): a's run begins again
  t += QUIET.gapMs + 1;
  assert.equal(waitA(), false);
  const restart = t - 50_000;
  while (t + 50_000 - restart < QUIET.stopMs) assert.equal(waitA(), false);
  assert.equal(waitA(), true, 'stopMs after the run began again');
  // a run that something interrupted ends at once
  assert.equal(waitA(), false);
  a.something();
  assert.equal(map.get('a'), undefined);
  // bounded: a third agent pushes the oldest out (forgetting only starts its count again)
  quietIn(map, 'c', () => t).nothing(t);
  quietIn(map, 'd', () => t).nothing(t);
  assert.ok(map.size <= 2);
});

test('vr track, push, fix and wontfix end with how to hear the person’s notes: vr watch (no cursor of its own); the JSON says it too', () => {
  const f = film('cli.mp4');
  const tracked = vr(['track', f, '--by', 'agent:cli'], env);
  assert.equal(tracked.code, 0, tracked.err);
  assert.equal(lastLine(tracked.out), WATCH_NOW_LINE, tracked.out);
  assert.match(WATCH_NOW_LINE, /^Now listen with lampo watch \(keep it running\): the person's notes arrive together when they press Send\.$/);
  const slug = slugOf(f);
  const a = person(slug, 'Cut later');
  const b = person(slug, 'Fade out');
  rerender(f);
  const fix = vr(['fix', a.id, '--note', 'Cut 3 frames later', '--by', 'agent:cli'], env);
  assert.equal(fix.out, `${a.id}: fixed in v2\n${stillOpenLine(1)}\n`, fix.err);
  const last = vr(['wontfix', b.id, '--note', 'It is meant to stop dead', '--by', 'agent:cli'], env);
  assert.equal(last.out, `${b.id}: wontfix\n${WATCH_NOW_LINE}\n`, last.err);
  // a person's own verdicts hand nothing over
  assert.equal(vr(['reopen', b.id, '--note', 'Please fade'], env).out, `${b.id}: open\n`);
  const pushed = JSON.parse(vr(['push', film('pushed.mp4'), '--folder', 'Acme/Reels', '--json', '--by', 'agent:cli'], env).out);
  assert.equal(pushed.next, WATCH_NOW_LINE);
  const again = vr(['push', path.join(dir, 'Acme/export/pushed.mp4'), '--folder', 'Acme/Reels', '--by', 'agent:cli'], env);
  assert.match(again.out, /^unchanged: .*\nNow listen with lampo watch/, again.err);
});

test('lampo reply, a question with lampo add and lampo ask end with what is left, else how to hear the answer; --json keeps stdout one document', () => {
  const f = film('cli-asked.mp4');
  assert.equal(vr(['track', f, '--by', 'agent:cli'], env).code, 0);
  const slug = slugOf(f);
  const a = person(slug, 'Too dark');
  const b = person(slug, 'Logo late');
  const asked = vr(['reply', a.id, '--note', 'Leave it or brighten it?', '--by', 'agent:cli'], env);
  assert.equal(asked.out, `${a.id}: reply added\n${stillOpenLine(1)}\n`, asked.err);
  const last = vr(['reply', b.id, '--note', 'Is 4 frames later right?', '--by', 'agent:cli'], env);
  assert.equal(last.out, `${b.id}: reply added\n${WATCH_NOW_LINE}\n`, last.err);
  // a question pinned to a frame (an agent's note is a question unless it says otherwise)
  const q = vr(['add', f, '--frame', '2', '--text', 'On the beat?', '--by', 'agent:cli'], env);
  assert.equal(q.code, 0, q.err);
  assert.equal(lastLine(q.out), WATCH_NOW_LINE, q.out);
  // (vr() keeps stderr only for a failure: this one reads both)
  const json = spawnSync(process.execPath, [VR, 'add', f, '--frame', '3', '--text', 'Warmer?', '--json', '--by', 'agent:cli'], { env, encoding: 'utf8' });
  assert.equal(JSON.parse(json.stdout).kind, 'question');
  assert.equal(json.stderr.trim(), WATCH_NOW_LINE);
  // options to pick: the pick is the person's
  const groups = path.join(dir, 'music.json');
  fs.writeFileSync(
    groups,
    JSON.stringify([
      {
        id: 'music',
        items: [
          { id: 'a', label: 'Calm' },
          { id: 'b', label: 'Driving' },
        ],
      },
    ]),
  );
  const ask = vr(['ask', f, '--text', 'Which music?', '--options', groups, '--by', 'agent:cli'], env);
  assert.equal(ask.code, 0, ask.err);
  assert.equal(lastLine(ask.out), WATCH_NOW_LINE, ask.out);
  // a person's reply, and a person's note (`lampo` writes as an agent unless --by names someone), hand nothing over
  assert.equal(vr(['reply', a.id, '--note', 'Brighten it', '--by', 'Mia Hartmann'], env).out, `${a.id}: reply added\n`);
  assert.doesNotMatch(vr(['add', f, '--frame', '4', '--text', 'Cut sooner', '--by', 'Mia Hartmann'], env).out, /lampo watch/);
});
