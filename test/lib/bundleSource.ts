// A machine's store with everything a move to a server takes along and everything it leaves behind, made through the
// store's own functions (run as a process of its own: `node test/lib/bundleSource.ts <facts.json>`, in the env of a
// throwaway local store from isolatedEnv). Synthetic footage only; the "home" folder is a temp dir, so every path that
// must not travel starts with it. Writes what it made to <facts.json> for the test to check against.
import fs from 'node:fs';
import path from 'node:path';
import { makeVideo } from './helpers.ts';

const out = process.argv[2] as string;
const home = path.join(path.dirname(process.env.VR_DATA as string), 'home');

const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');
const refs = await import('../../lib/refs.ts');
const previews = await import('../../lib/previews.ts');
const views = await import('../../lib/views.ts');
const playbooks = await import('../../lib/playbooks.ts');
const drafts = await import('../../lib/drafts.ts');
const shares = await import('../../lib/shares.ts');
const shots = await import('../../lib/shots.ts');
const taste = await import('../../lib/taste.ts');
const { reviewDir, slugify } = await import('../../lib/paths.ts');
const { execFileSync } = await import('node:child_process');
const { FFMPEG } = await import('./helpers.ts');

// The machine's owner, as the app makes it on its first start; notes from the UI carry its id, `vr` writes as USER.
const owner = auth.ensureLocalOwner('Tester');
const settle = (file: string) => {
  const t = new Date(Date.now() - 60_000);
  fs.utimesSync(file, t, t);
};

// Two renders of the same name in one folder (the second becomes `~2/` on the server), one unfiled, one upload.
const clipA = makeVideo(path.join(home, 'Projects/Spot/export/clip.mp4'), { w: 320, h: 180, fps: 25, dur: 2 });
settle(clipA);
const clipB = makeVideo(path.join(home, 'Projects/Other/export/clip.mp4'), { w: 320, h: 180, fps: 25, dur: 1, freq: 660 });
settle(clipB);
const loose = makeVideo(path.join(home, 'Desktop/loose.mov'), { w: 160, h: 90, fps: 30, dur: 1, freq: 880 });
settle(loose);
const a = store.createOrGetReview(clipA, { by: 'tester', byId: owner.id }).review;
const slugA = slugify(a.video);
folders.moveVideo(slugA, 'Client A/Reels', 'tester');
const b = store.createOrGetReview(clipB, { by: 'tester' }).review;
const slugB = slugify(b.video);
folders.moveVideo(slugB, 'Client A/Reels', 'tester');
const c = store.createOrGetReview(loose, {
  by: 'agent:cutter',
  session: { name: 'cutter', sessionId: 'sess-123', cwd: path.join(home, 'Projects/Spot') },
}).review;
const slugC = slugify(c.video);
folders.createFolder('Client A/Empty');

// A second version of A: the file on disk re-rendered (registered from the disk, as the watcher does).
makeVideo(clipA, { w: 320, h: 180, fps: 25, dur: 2, pattern: 'testsrc2' });
settle(clipA);
store.sync(slugA);

// An upload, as `vr push` / the browser make one.
const pushed = makeVideo(path.join(home, 'tmp/teaser.mp4'), { w: 160, h: 90, fps: 25, dur: 1, freq: 550 });
const up = await store.ingestUpload(pushed, { name: 'teaser.mp4', folder: 'Client A', by: 'tester', byId: owner.id, keep: true });
const slugU = slugify(up.review.video);

// Notes: the owner's (with its account and without), an agent's question, a client's, someone with no account here.
const verA = store.loadReview(slugA)?.versions.at(-1);
const fileA = store.versionFile(store.loadReview(slugA) as never, 2) as string;
const drawn = store.addComment(slugA, {
  v: 2,
  frame: 10,
  text: 'Logo comes in too early',
  severity: 'must',
  tags: ['timing'],
  author: 'tester',
  author_id: owner.id,
  drawing: [
    { type: 'box', x: 10, y: 10, w: 50, h: 30 },
    { type: 'arrow', x1: 0, y1: 0, x2: 40, y2: 40 },
    {
      type: 'freehand',
      points: [
        [1, 1],
        [5, 5],
        [9, 2],
      ],
    },
  ],
});
const madeShots = await shots.makeShots({
  file: fileA,
  frame: 10,
  meta: { fps: 25, width: 320, height: 180 },
  drawing: drawn.drawing,
  dir: reviewDir(slugA),
  id: drawn.id,
});
store.mutate(slugA, (r) => {
  const n = r.comments.find((x) => x.id === drawn.id);
  if (n) n.shots = madeShots;
});
const ranged = store.addComment(slugA, { v: 2, frame: 20, range: { in: 20, out: 30 }, text: 'Music too loud here', author: 'tester', severity: 'should' });
const overall = store.addComment(slugA, { v: 1, frame: 0, scope: 'video', text: 'Overall: tighter cut please', author: 'Rita' });
const question = store.addComment(slugA, {
  v: 2,
  frame: 5,
  text: 'Keep the blue or go warmer?',
  author: 'agent:cutter',
  kind: 'question',
  choices: ['Blue', 'Warmer'],
});
const client = store.addComment(slugA, { v: 2, frame: 40, text: 'Can the price be bigger?', author: 'guest:Mia', share: 's_abcdef123456' });
// a voice clip next to review.json, as the composer leaves one
const voiceFile = `${ranged.id}.m4a`;
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'sine=frequency=300:duration=0.5', '-c:a', 'aac', '-y', path.join(reviewDir(slugA), voiceFile)]);
store.mutate(slugA, (r) => {
  const n = r.comments.find((x) => x.id === ranged.id);
  if (n) n.voice = { file: voiceFile, transcript: 'music too loud here' };
});

// Replies and statuses: the agent fixes (naming a path on this machine), the owner checks, a reply, a won't-fix.
store.updateComment(drawn.id, { status: 'fixed', note: `Moved it, rendered to ${clipA}`, fixed_in_v: 2, by: 'agent:cutter' });
store.updateComment(drawn.id, { status: 'verified', note: 'Looks right', by: 'tester', by_id: owner.id });
store.updateComment(question.id, { note: 'Warmer', by: 'tester' });
store.updateComment(overall.id, { status: 'wontfix', note: 'Length is fixed by the client', by: 'agent:cutter' });

// References: a link, a picture, a moment of another video (B); a fix preview on the range note.
const png = path.join(home, 'tmp/ref.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=red:s=64x48', '-frames:v', '1', '-y', png]);
await refs.attachRefFile(drawn.id, png, { by: 'tester', by_id: owner.id, caption: 'like this' });
await refs.saveRefs(drawn.id, slugA, [refs.linkRef('https://example.com/look', { by: 'tester' })], { by: 'tester' });
const frameRef = await refs.frameRef(slugA, { video: slugB, frame: 3 }, { by: 'tester' });
await refs.saveRefs(ranged.id, slugA, [frameRef], { by: 'tester' });
const still = path.join(home, 'tmp/fix.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'color=c=blue:s=320x180', '-frames:v', '1', '-y', still]);
const preview = await previews.attachPreview(ranged.id, still, {
  kind: 'still',
  by: 'agent:cutter',
  fixed: true,
  note: 'Lowered the music',
  source: { app: 'After Effects', project: path.join(home, 'Projects/Spot/spot.aep') },
});

// Sign-off: the team approves v2, a client asks for changes, the video goes final.
store.setApproval(slugA, { status: 'changes', v: 1, note: 'not yet' }, 'tester');
store.setApproval(slugA, { status: 'approved', v: 2 }, 'tester');
store.setApproval(slugA, { status: 'changes', v: 2, note: 'one more' }, 'guest:Mia', { party: 'client', share: 's_abcdef123456' });
store.setFinal(slugA, { v: 2, note: 'ships' }, 'tester');
store.setVersionSource(slugA, 2, { app: 'After Effects', project: path.join(home, 'Projects/Spot/spot.aep'), comp: 'Main' }, 'agent:cutter');
store.addRequest(slugA, 'pre-review v2 before I watch it', 'tester');
store.addComment(slugB, { v: 1, frame: 2, text: 'Grade looks off', author: 'tester' });
store.addComment(slugU, { v: 1, frame: 1, text: 'Nice teaser', author: 'tester', author_id: owner.id });

// The team's watching (Insights) and a taste file.
views.recordTeamWatch(slugA, { id: owner.id, name: 'Tester' }, { v: 2, seen: 'f'.repeat(25), secs: 4 });
taste.writeTaste('Client A');

// A playbook with a skill, its file and a moment of a video.
playbooks.writeText('Client A', 'brief', 'Warm, fast cuts. Exports live in ~/Projects.', { by: 'tester' });
playbooks.putSkill('Client A', { name: 'export-preset', description: 'How to export', body: 'Use the preset.' }, { by: 'tester' });
const preset = path.join(home, 'tmp/preset.json');
fs.writeFileSync(preset, '{"crf":18}');
await playbooks.addSkillFile('Client A', 'export-preset', 'preset.json', preset, 'tester');
await playbooks.addRef('Client A', { kind: 'frame', video: slugB, frame: 1 }, 'tester');

// What stays on this machine: a draft, a review link, a download through it, devices, and the keys.
drafts.addDraft(slugA, owner.id, { v: 2, frame: 3, text: 'draft only' });
const link = shares.createShare(slugA, { label: 'For Mia', by: 'tester' });
store.logFolderEvent({ type: 'download', by: 'guest:Mia', folder: 'Client A', text: 'downloaded 1 video', share: link.id, files: 1, bytes: 10 });
fs.writeFileSync(path.join(path.dirname(store.EVENTS_FILE), 'devices.json'), '{"devices":[]}');
auth.secret();

fs.writeFileSync(
  out,
  JSON.stringify({
    home,
    owner: owner.id,
    slugs: { a: slugA, b: slugB, c: slugC, u: slugU },
    notes: { drawn: drawn.id, ranged: ranged.id, overall: overall.id, question: question.id, client: client.id },
    preview: preview.preview.id,
    hashA2: verA?.hash,
    versionsA: store.loadReview(slugA)?.versions.length,
  }),
);
