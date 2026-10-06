// A change that fails writes no event: events.jsonl (and INBOX.md, `vr watch`, wait_for_feedback, webhooks) only
// hear about what was saved.
import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { age, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { dur: 1, audio: false });
age(video);
const { review } = store.createOrGetReview(video, { by: 'tester' });
const slug = slugify(review.video);
const note = store.addComment(slug, { frame: 5, text: 'logo too early', author: 'tester' });
const events = (type: string) => store.readEvents().filter((e) => e.type === type && e.id === note.id);

test('an edit with a preview the note does not have throws and writes no edit event', () => {
  assert.throws(() => store.updateComment(note.id, { text: 'logo much too early', preview: 'p_nope', by: 'tester' }), /has no preview p_nope/);
  assert.equal(events('edit').length, 0, 'no edit event for an edit that never happened');
  assert.equal(must(store.loadReview(slug)).comments[0].text, 'logo too early');
  store.updateComment(note.id, { text: 'logo much too early', by: 'tester' });
  assert.equal(events('edit').length, 1);
});

test('events queued inside a lock whose work throws are dropped; a finished inner lock keeps its own', () => {
  const r = must(store.loadReview(slug));
  const before = store.readEvents().length;
  assert.throws(() =>
    store.withLock(path.join(dir, 'a'), () => {
      store.logEvent({ type: 'request', by: 'tester', review: r, text: 'dropped' });
      throw new Error('boom');
    }),
  );
  assert.equal(store.readEvents().length, before);

  assert.throws(() =>
    store.withLock(path.join(dir, 'a'), () => {
      store.logEvent({ type: 'request', by: 'tester', review: r, text: 'outer, dropped' });
      store.withLock(path.join(dir, 'b'), () => store.logEvent({ type: 'request', by: 'tester', review: r, text: 'inner, saved' }));
      assert.throws(() =>
        store.withLock(path.join(dir, 'c'), () => {
          store.logEvent({ type: 'request', by: 'tester', review: r, text: 'inner that failed' });
          throw new Error('inner boom');
        }),
      );
      store.logEvent({ type: 'request', by: 'tester', review: r, text: 'outer again, dropped' });
      throw new Error('boom');
    }),
  );
  assert.deepEqual(
    store
      .readEvents()
      .slice(before)
      .map((e) => e.text),
    ['inner, saved'],
  );

  store.withLock(path.join(dir, 'a'), () => {
    store.logEvent({ type: 'request', by: 'tester', review: r, text: 'kept' });
    assert.throws(() =>
      store.withLock(path.join(dir, 'b'), () => {
        store.logEvent({ type: 'request', by: 'tester', review: r, text: 'failed inside' });
        throw new Error('inner boom');
      }),
    );
  });
  assert.deepEqual(
    store
      .readEvents()
      .slice(before)
      .map((e) => e.text),
    ['inner, saved', 'kept'],
  );
});
