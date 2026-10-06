// Seeks that arrive while the decoder is still busy replace each other instead of piling up: the element finishes
// the seek it is on, then goes straight to the newest target. Dragging the playhead keeps showing frames and the
// last one always wins, like a native editor. Playback's own jumps go through seekNow, which ends the line.
const pending = new WeakMap<HTMLVideoElement, number>();
const wired = new WeakSet<HTMLVideoElement>();

export function seekVideo(vid: HTMLVideoElement, t: number) {
  if (!wired.has(vid)) {
    wired.add(vid);
    vid.addEventListener('seeked', () => {
      const next = pending.get(vid);
      if (next === undefined) return;
      pending.delete(vid);
      if (Math.abs(vid.currentTime - next) > 1e-6) vid.currentTime = next;
    });
    vid.addEventListener('emptied', () => pending.delete(vid));
  }
  if (vid.seeking) pending.set(vid, t);
  else {
    pending.delete(vid);
    if (Math.abs(vid.currentTime - t) > 1e-6) vid.currentTime = t;
  }
}

// Where playback starts or jumps to (a range, a loop's start) can't wait behind the seek in flight: it goes there now,
// and a seek still waiting in line is dropped, or it would land after this one and take playback elsewhere (a range
// played from wherever the playhead was being stepped to).
export function seekNow(vid: HTMLVideoElement, t: number) {
  pending.delete(vid);
  vid.currentTime = t;
}

// WebKit sometimes ends the first seek after a load with currentTime right and the old frame still presented (rVFC
// says so); seeking to the same frame again changes nothing, and a seek chained straight onto another presents only
// the first. Resting on the next-door frame for a moment and then seeking back does present the right one
// (test/e2e/webkit.mjs). `still()` says whether that frame is still wanted when the second seek is due.
export function reseekThroughNeighbour(vid: HTMLVideoElement, frame: number, fps: number, still: () => boolean) {
  seekVideo(vid, ((frame > 0 ? frame - 1 : frame + 1) + 0.5) / fps);
  setTimeout(() => {
    if (still() && vid.paused) seekVideo(vid, (frame + 0.5) / fps);
  }, 150);
}
