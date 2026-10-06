// What an agent writes on a client's note (a reply, the fix note of `mark_fixed` / `vr fix`) reaches the client as
// written, through every review link that shows the note (docs/sharing.md). Agents are told so where they read the
// note — the MCP note lines and `vr open` / `vr show` — so a path, a tool or a remark for the team stays out of it
// (A12 GUEST-7). A team note has no such flag.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');
const { createLocalBackend } = await import('../../lib/backend/local.ts');
const { noteLines } = await import('../../mcp/format.ts');

const video = makeVideo(path.join(dir, 'acme/export/spot.mp4'), { w: 160, h: 90, dur: 1 });
age(video);
const slug = slugify(video);
store.createOrGetReview(video, { by: 'olivia' });
const client = store.addComment(slug, { frame: 3, text: 'Logo bitte kleiner', severity: 'should', author: 'guest:Mia' });
const team = store.addComment(slug, { frame: 5, text: 'Grade warmer', severity: 'should', author: 'olivia' });
const FLAG = /CLIENT: they read your replies and fix note as written/;

test('MCP: a client’s note says the client reads what the agent writes on it; a team note doesn’t', () => {
  const review = store.loadReview(slug);
  assert.ok(review);
  const b = createLocalBackend();
  const head = (id: string) => noteLines(b, review, review.comments.find((c) => c.id === id) as never).split('\n')[0];
  assert.match(head(client.id), FLAG);
  assert.doesNotMatch(head(team.id), FLAG);
  assert.doesNotMatch(head(client.id), /guest:|Mia/, 'the flag names nobody: the note’s words are its own line');
});

test('vr open and vr show: the same flag on the client’s note only', () => {
  const open = vr(['open', video], env);
  assert.equal(open.code, 0, open.err);
  const lines = open.out.split('\n');
  assert.match(lines.find((l) => l.startsWith(client.id)) ?? '', FLAG);
  assert.doesNotMatch(lines.find((l) => l.startsWith(team.id)) ?? '', FLAG);
  const show = vr(['show', client.id], env);
  assert.equal(show.code, 0, show.err);
  assert.match(show.out, FLAG);
});
