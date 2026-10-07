// A synthetic store for performance work: N videos (hard links of one small generated clip, so nothing is big on
// disk) in 20 project folders, M notes spread over them with statuses, replies, ranges and drawings, and the events
// a real store would have logged for them. Never point it at a real store: it refuses a LAMPO_DATA that exists.
//
//   node bench/perf/synth.ts <dir> [videos=1000] [notes=20000]
//
// Writes <dir>/data, <dir>/cache, <dir>/config.json; start a server on it with LAMPO_DATA/LAMPO_CACHE/LAMPO_CONFIG set there.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { settings } from '../../lib/env.ts';

const [dirArg, videosArg = '1000', notesArg = '20000'] = process.argv.slice(2);
if (!dirArg) {
  console.error('usage: node bench/perf/synth.ts <dir> [videos] [notes]');
  process.exit(2);
}
const dir = path.resolve(dirArg);
const VIDEOS = Number(videosArg);
const NOTES = Number(notesArg);
const DATA = path.join(dir, 'data');
if (fs.existsSync(DATA)) {
  console.error(`${DATA} exists: synth.ts only writes a fresh store`);
  process.exit(1);
}
fs.mkdirSync(dir, { recursive: true });
Object.assign(process.env, { LAMPO_DATA: DATA, LAMPO_CACHE: path.join(dir, 'cache'), LAMPO_CONFIG: path.join(dir, 'config.json'), LAMPO_STT: 'off' });
fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ browse_root: dir }));

const { slugify, isoLocal, reviewDir, reviewFile } = await import('../../lib/paths.ts');
const store = await import('../../lib/store.ts');
const { timecode, frameToTime } = await import('../../lib/time.ts');
type Review = import('../../lib/types.ts').Review;
type Comment = import('../../lib/types.ts').Comment;

// One 4 s clip, aged so the store doesn't take it for a render in progress.
const base = path.join(dir, 'src', 'base.mp4');
fs.mkdirSync(path.dirname(base), { recursive: true });
execFileSync(settings.LAMPO_FFMPEG || 'ffmpeg', [
  ...['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=25:duration=4', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=4'],
  ...['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', '-y', base],
]);
const old = (Date.now() - 3600_000) / 1000;
fs.utimesSync(base, old, old);

// A tiny deterministic random, so two runs build the same store.
let seed = 42;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(list: readonly T[]): T => list[Math.floor(rnd() * list.length)] as T;

const WORDS = 'logo title grade colour timing cut transition music level text kerning safe area flicker wipe fade lower third subtitle'.split(' ');
const PEOPLE = ['Sam', 'Alex', 'Robin', 'Kim', 'agent:edit', 'guest:Jordan'];
const STATUSES = ['open', 'open', 'open', 'fixed', 'verified', 'wontfix'] as const;
const SEVERITIES = ['must', 'should', 'nice', 'idea'] as const;
const day = 86400_000;

const file = (i: number) => path.join(dir, 'Studio', `project-${i % 20}`, 'export', `film-${String(i).padStart(4, '0')}.mp4`);
fs.mkdirSync(path.dirname(file(0)), { recursive: true });
fs.linkSync(base, file(0));
const template = store.createOrGetReview(file(0), { by: 'Sam' }).review;
const templateSlug = slugify(file(0));
const snapshot = store.snapshotPath(templateSlug, 1, '.mp4');

const perVideo = Math.floor(NOTES / VIDEOS);
let extra = NOTES - perVideo * VIDEOS;
const t0 = Date.now();
for (let i = 0; i < VIDEOS; i++) {
  const video = file(i);
  const slug = slugify(video);
  if (i > 0) {
    fs.mkdirSync(path.dirname(video), { recursive: true });
    fs.linkSync(base, video);
    fs.mkdirSync(path.dirname(store.snapshotPath(slug, 1, '.mp4')), { recursive: true });
    fs.linkSync(snapshot, store.snapshotPath(slug, 1, '.mp4'));
  }
  const added = new Date(Date.now() - rnd() * 90 * day);
  const review: Review = {
    ...structuredClone(template),
    video,
    project: path.join(dir, 'Studio', `project-${i % 20}`),
    folder: `Project ${i % 20}`,
    added: isoLocal(added),
    comments: [],
  };
  const count = perVideo + (extra-- > 0 ? 1 : 0);
  const ver = review.versions[0];
  store.withLock(reviewDir(slug), () => {
    for (let n = 0; n < count; n++) {
      const frame = Math.floor(rnd() * ver.frames);
      const status = pick(STATUSES);
      const author = pick(PEOPLE);
      const created = isoLocal(new Date(added.getTime() + rnd() * (Date.now() - added.getTime())));
      const c: Comment = {
        id: `c_${(i * 1000 + n).toString(16).padStart(6, '0')}`,
        v: 1,
        frame,
        timecode: timecode(frame, ver.fps),
        t: frameToTime(frame, ver.fps),
        range: rnd() < 0.15 ? { in: frame, out: Math.min(ver.frames - 1, frame + 12) } : null,
        text: `${pick(WORDS)} ${pick(WORDS)}: ${Array.from({ length: 4 + Math.floor(rnd() * 14) }, () => pick(WORDS)).join(' ')}`,
        tags: rnd() < 0.4 ? [pick(WORDS)] : [],
        severity: pick(SEVERITIES),
        drawing: rnd() < 0.3 ? [{ type: 'box', x: 20, y: 20, w: 80, h: 40 }] : [],
        shots: null,
        voice: null,
        status,
        author,
        created,
        replies:
          status === 'open'
            ? []
            : [
                { by: 'agent:edit', text: 'Changed it in the project', status: 'fixed', at: created },
                ...(status === 'verified' ? [{ by: 'Sam', text: 'Looks right', status: 'verified' as const, at: created }] : []),
              ],
      };
      review.comments.push(c);
      store.logEvent({ type: 'comment', by: author, review, comment: c });
    }
    store.writeAtomic(reviewFile(slug), `${JSON.stringify(review, null, 2)}\n`);
  });
  if (i % 100 === 99) console.log(`${i + 1} videos (${((Date.now() - t0) / 1000).toFixed(1)} s)`);
}
console.log(`store at ${dir}: ${VIDEOS} videos, ${NOTES} notes`);
