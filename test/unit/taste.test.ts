// The taste file: what a reviewer asked for, loved, accepted and refused on a project, distilled from the notes so
// an agent can read it before rendering. Built from reviews in memory (buildTaste) and written next to the store
// (writeTaste); deterministic, so the same notes give the same markdown.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { Comment, Review, Shape } from '../../lib/types.ts';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { buildTaste, scopeOf, scopeSlug, writeTaste } = await import('../../lib/taste.ts');
const store = await import('../../lib/store.ts');

let seq = 0;
const at = (minute: number) => `2026-09-28T10:${String(minute).padStart(2, '0')}:00+02:00`;

function note(o: Partial<Comment> & { text: string }): Comment {
  seq++;
  return {
    id: `c_${String(seq).padStart(6, '0')}`,
    v: 1,
    frame: seq,
    timecode: `00:00:${String(seq).padStart(2, '0')}`,
    t: seq / 25,
    range: null,
    tags: [],
    severity: 'should',
    drawing: [],
    shots: null,
    voice: null,
    status: 'open',
    author: 'alex',
    created: at(seq),
    replies: [],
    ...o,
  };
}

function review(o: Partial<Review> & { video: string; comments: Comment[] }): Review {
  const version = (v: number) => ({
    v,
    hash: `h${v}`,
    mtime: at(0),
    size: 1,
    frames: 250,
    fps: 25,
    width: 1080,
    height: 1920,
    duration: 10,
    registered: at(0),
  });
  return {
    project: 'ACME/REELS',
    fps: 25,
    width: 1080,
    height: 1920,
    duration: 10,
    frames: 250,
    versions: [version(1), version(2)],
    session: null,
    folder: null,
    added: at(0),
    added_by: 'alex',
    ...o,
  };
}

const box = (y: number, h: number): Shape => ({ type: 'box', x: 100, y, w: 800, h, color: '#f00' }) as Shape;

const reel = review({
  video: '/work/acme/reels/spot.mp4',
  folder: 'Acme/Reels',
  comments: [
    note({ text: 'Love the opening move', tags: ['love-it'] }),
    note({ text: 'Logo too early', tags: ['timing'], severity: 'must', drawing: [box(1400, 200)] }),
    note({ text: 'Logo too early', tags: ['timing'], severity: 'must' }),
    note({ text: 'Music 2 dB quieter under the voice', tags: ['audio/music'] }),
    note({
      text: 'Title sits under the like button',
      tags: ['layout/overlap'],
      status: 'verified',
      replies: [{ by: 'agent:reel-edit', text: 'Moved the title up to y 1392', status: 'fixed', fixed_in_v: 2, at: at(40) }],
    }),
    note({
      text: 'Swap the end card colour',
      tags: ['color/grade'],
      status: 'wontfix',
      replies: [{ by: 'alex', text: 'Brand colour, it stays', status: 'wontfix', at: at(41) }],
    }),
    note({ text: 'Should the logo animate in?', author: 'agent:reel-edit', kind: 'question' }),
  ],
});
const unfiled = review({
  video: '/work/acme/teaser.mp4',
  project: 'acme/teaser',
  comments: [note({ text: 'Cut two frames earlier', tags: ['cut'], severity: 'nice' })],
});
const other = review({ video: '/work/globex/ad.mp4', folder: 'Globex', project: 'GLOBEX', comments: [note({ text: 'Not an Acme note', tags: ['timing'] })] });
const archived = review({ video: '/work/acme/old.mp4', folder: 'Acme', archived: at(50), comments: [note({ text: 'Archived note', tags: ['timing'] })] });
const all = [reel, unfiled, other, archived];

test('scopes: a top-level folder takes its sub-folders and its unfiled project; a sub-folder only itself', () => {
  assert.equal(buildTaste(all, { folder: 'Acme' }).stats.videos, 2, 'Acme/Reels + the unfiled acme project; not Globex, not archived');
  assert.equal(buildTaste(all, { folder: 'acme' }).stats.videos, 2, 'folder names match without case');
  assert.equal(buildTaste(all, { folder: 'Acme/Reels' }).stats.videos, 1);
  assert.equal(buildTaste(all, { project: 'acme' }).stats.videos, 2, 'project paths match by prefix');
  assert.equal(buildTaste(all).stats.videos, 3, 'everything that is not archived');
  assert.equal(buildTaste(all, { folder: 'Acme', title: 'Acme · all reels' }).scope, 'Acme · all reels');
});

test('stats: human notes only, agent questions apart, renders and round trips', () => {
  const { stats } = buildTaste(all, { folder: 'Acme' });
  assert.equal(stats.notes, 7, 'six from the reviewer on the reel + one on the teaser');
  assert.equal(stats.agent_questions, 1);
  assert.equal(stats.versions, 4);
  assert.equal(stats.round_trips, 2);
  assert.equal(stats.notes_per_version, 1.8);
  assert.equal(stats.open, 5, 'a love-it note stays open until someone closes it');
  assert.deepEqual(stats.by_tag, { timing: 2, 'audio/music': 1, 'layout/overlap': 1, 'color/grade': 1, cut: 1 });
  assert.deepEqual(stats.by_severity, { should: 3, must: 2, nice: 1 });
  assert.equal(stats.last_note, unfiled.comments[0]?.created);
});

test('the markdown: keep doing, recurring asks, decisions that stand, fixes that worked, numbers, open notes', () => {
  const md = buildTaste(all, { folder: 'Acme' }).markdown;
  assert.match(md, /^# Taste: Acme\n/);
  assert.match(md, /## Keep doing\n\n- “Love the opening move” — spot\.mp4/);
  assert.match(md, /### timing — 2 notes \(must 2\)/);
  assert.equal(md.match(/“Logo too early” — spot\.mp4/g)?.length, 1, 'the same ask is quoted once');
  assert.match(md, /“Swap the end card colour” → won't fix: “Brand colour, it stays” \(alex, spot\.mp4/);
  assert.match(md, /“Title sits under the like button” → “Moved the title up to y 1392” \(v2, verified/);
  assert.match(md, /- timing: 1 mark between y 1400–1600 \(73–83% of height\)/);
  assert.match(md, /accepted values in verified fixes: y 1392/);
  assert.match(md, /values the reviewer asked for: 2 dB/);
  assert.match(md, /## Open right now \(5\)\n\n- c_\d+ MUST/, 'must first');
  assert.doesNotMatch(md, /Not an Acme note|Archived note|Should the logo animate/);
});

test('an empty scope says so instead of leaving sections blank', () => {
  const md = buildTaste([], { folder: 'Nobody' }).markdown;
  for (const line of [
    '_No love-it notes yet._',
    '_No notes yet._',
    '_None yet._',
    '_No verified fixes yet._',
    '_Not enough marked frames yet._',
    '_Nothing open._',
  ])
    assert.ok(md.includes(line), line);
});

test('deterministic: the same notes give the same markdown', () => {
  assert.equal(buildTaste(all, { folder: 'Acme' }).markdown, buildTaste([...all].reverse(), { folder: 'Acme' }).markdown);
});

test('scopes of a video and file names', () => {
  assert.deepEqual(scopeOf({ folder: 'Acme/Reels', project: 'x' }), { folder: 'Acme' });
  assert.deepEqual(scopeOf({ folder: null, project: 'ACME/REELS' }), { folder: 'ACME' });
  assert.equal(scopeSlug('Acme · Reels / 2026'), 'acme-reels-2026');
  assert.equal(scopeSlug(''), 'all');
  assert.equal(scopeSlug(null), 'all');
});

test('writeTaste writes data/taste/<scope>.md and .json from the store', () => {
  const file = makeVideo(path.join(dir, 'Acme/export/spot.mp4'), { dur: 1 });
  const { review: r } = store.createOrGetReview(file, { by: 'tester' });
  store.addComment(store.resolveVideo(file).slug, { frame: 3, text: 'Logo later', tags: ['timing'], author: 'tester' });
  const out = writeTaste({ video: file });
  assert.equal(path.dirname(out), path.join(dir, 'data', 'taste'));
  assert.match(fs.readFileSync(out, 'utf8'), /“Logo later”/);
  const json = JSON.parse(fs.readFileSync(out.replace(/\.md$/, '.json'), 'utf8'));
  assert.equal(json.stats.notes, 1);
  assert.equal(json.scope, scopeOf(r).folder);
  assert.equal(writeTaste(json.scope), out, 'the same scope by name writes the same file');
});
