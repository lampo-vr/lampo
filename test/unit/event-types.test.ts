// Which events wake an agent and which the inbox lists, defined once (lib/eventLine.ts): INBOX.md, `vr inbox` and
// GET /api/inbox show the same events; wait_for_feedback wakes on the same minus new videos.
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { test } from 'node:test';
import type { ReviewEvent } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { age, isolatedEnv, makeVideo, vr } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
const store = await import('../../lib/store.ts');
const lines = await import('../../lib/eventLine.ts');
const { slugify } = await import('../../lib/paths.ts');

const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { dur: 1, audio: false });
age(video);
store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(video);
const note = store.addComment(slug, { frame: 5, text: 'logo too early', author: 'tester' });
store.addRefs(note.id, [{ id: 'r_0123456789', kind: 'link', url: 'https://example.com/look', site: 'example.com', by: 'tester', at: '2026-09-30T10:00:00' }], {
  by: 'tester',
});

const { port } = await startApp({ token: 'test-token', loadSessions: async () => [] });

const types = (evs: { type: string }[]) => [...new Set(evs.map((e) => e.type))].sort();

test('feedback wakes agents; the inbox is feedback plus new videos', () => {
  assert.deepEqual([...lines.FEEDBACK_TYPES].sort(), ['approval', 'assigned', 'comment', 'edit', 'ref', 'reply', 'request', 'status']);
  assert.deepEqual([...lines.INBOX_TYPES].sort(), [...lines.FEEDBACK_TYPES, 'added'].sort());
  const ev = (type: ReviewEvent['type'], by = 'tester') => ({ type, by }) as ReviewEvent;
  assert.equal(lines.isFeedback(ev('ref')), true, 'a reference someone adds to a note wakes the agent');
  assert.equal(lines.isFeedback(ev('added')), false, 'a new video is not feedback');
  assert.equal(lines.isFeedback(ev('comment', 'agent:edit')), false);
});

test('INBOX.md, `vr inbox` and GET /api/inbox list the same kinds of events', async () => {
  assert.deepEqual(types(store.inboxEvents()), ['added', 'comment', 'ref']);
  const md = store.renderInbox(store.inboxEvents());
  assert.match(md, /· REFERENCE · c_[0-9a-f]{6}/);
  assert.match(md, /- reference: r_0123456789 link https:\/\/example\.com\/look \(by tester\)/);

  const cli = vr(['inbox', '--json'], env);
  assert.equal(cli.code, 0, cli.err);
  assert.deepEqual(types(JSON.parse(cli.out)), ['added', 'comment', 'ref']);

  const api = await new Promise<{ events: ReviewEvent[] }>((resolve, reject) =>
    http
      .get({ host: '127.0.0.1', port, path: '/api/inbox' }, (res) => {
        let text = '';
        res.on('data', (d) => {
          text += d;
        });
        res.on('end', () => resolve(JSON.parse(text)));
      })
      .on('error', reject),
  );
  assert.deepEqual(types(api.events), ['added', 'comment', 'ref']);
});
