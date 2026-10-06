// A review link's signed URLs live minutes (A12 GUEST-11), and a browser keeps asking the URL a redirect gave it: once
// that runs out, the <video> errors on its next range request. The player loads its source again — the server checks
// the link and hands out a fresh URL — and plays on where it was. A source that never loaded is not retried, and one
// that keeps failing (the link was revoked) is given up after a few tries: its media stops.
import assert from 'node:assert/strict';
import test from 'node:test';

// recover.ts is browser code: imported by URL, so the backend typecheck doesn't take it in.
type Media = EventTarget & { paused: boolean; readyState: number; load(): void; play(): Promise<void> };
const { recoverOnError, RELOADS } = (await import(new URL('../../web/src/player/recover.ts', import.meta.url).href)) as {
  recoverOnError: (el: Media, now?: () => number) => () => void;
  RELOADS: number;
};

/** A stand-in <video> that behaves like Chrome's on a failed range request: counts loads and plays. */
function video(readyState = 0) {
  const el = Object.assign(new EventTarget(), {
    paused: true,
    readyState,
    loads: 0,
    plays: 0,
    load() {
      el.loads++;
      el.paused = true;
      el.readyState = 0;
    },
    play() {
      el.plays++;
      el.paused = false;
      el.dispatchEvent(new Event('play'));
      return Promise.resolve();
    },
    pause() {
      el.paused = true;
      el.dispatchEvent(new Event('pause'));
    },
  });
  const fire = (type: string) => {
    if (type === 'loadedmetadata') el.readyState = 1;
    // Chrome sets `paused` when a request fails, without a pause event
    if (type === 'error') el.paused = true;
    el.dispatchEvent(new Event(type));
  };
  return { el, fire };
}

test('a source that ran out while playing is loaded again and plays on', () => {
  const { el, fire } = video();
  recoverOnError(el);
  fire('loadedmetadata');
  el.play();
  el.plays = 0;
  fire('error');
  assert.equal(el.loads, 1, 'loaded again');
  assert.equal(el.plays, 0, 'plays once it knows the file again (and is back on its frame)');
  fire('loadedmetadata');
  assert.equal(el.plays, 1);
  assert.equal(el.paused, false);
});

test('paused, it is loaded again and stays paused', () => {
  const { el, fire } = video(1);
  recoverOnError(el);
  el.play();
  el.pause();
  el.plays = 0;
  fire('error');
  assert.equal(el.loads, 1);
  fire('loadedmetadata');
  assert.equal(el.plays, 0);
});

test('a source that never loaded is not retried', () => {
  const { el, fire } = video();
  recoverOnError(el);
  fire('error');
  assert.equal(el.loads, 0);
});

test('a revoked link: a few tries a minute, then the error stands; the watch ends with its source', () => {
  let t = 0;
  const { el, fire } = video(1);
  const stop = recoverOnError(el, () => t);
  for (let i = 0; i < 10; i++) {
    fire('error');
    t += 1000;
  }
  assert.equal(el.loads, RELOADS);
  assert.ok(RELOADS <= 3);
  t += 61_000;
  fire('error');
  assert.equal(el.loads, RELOADS + 1, 'a minute later it may try again (a long play past another window)');
  stop();
  t += 61_000;
  fire('error');
  assert.equal(el.loads, RELOADS + 1, 'not after the player moved on to another source');
});
