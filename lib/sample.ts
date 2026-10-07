// The first run's sample: a new account sees the whole loop at once on Lampo's own brand film — two versions of the
// same five seconds, frame for frame, the title "EVERY MILE, ON THE RECORD." over the car in V1 and on the hill in V2;
// a teammate's note on V1 that the agent fixed in V2 (waiting to be checked), an idea with the agent's answer, and the
// agent's question with answers to pick. The two versions are committed in lib/sample-film/ (made from the site's
// film by scripts/sample-film.ts; its README says where the footage comes from), so making the sample needs no
// browser, font or generator: each version is copied and uploaded through the storage adapter like any other (local
// disk, Bunny or S3), marked `Review.onboarding_sample` from its first write — so none of its events is logged (no
// agent feed, INBOX.md, webhook or push hears of it), Insights leave it out, billing and plan limits must not count it
// — and removed for good in one click.
import fs from 'node:fs';
import path from 'node:path';
import { CACHE, isoLocal, reviewDir, slugify } from './paths.ts';
import { wsKey } from './scope.ts';
import { makeShots } from './shots.ts';
import * as store from './store.ts';
import type { Comment, FrameMeta, Rect, Review, SampleMark, Shape, Version } from './types.ts';

export type SampleLang = 'en' | 'de';

/** Where the two versions live (committed; the Docker image copies lib/). */
export const SAMPLE_FILM_DIR = path.join(import.meta.dirname, 'sample-film');
export const SAMPLE_FILES: Record<1 | 2, string> = { 1: path.join(SAMPLE_FILM_DIR, 'v1.mp4'), 2: path.join(SAMPLE_FILM_DIR, 'v2.mp4') };

/** The picture: the brand film's 121 frames at 24 fps, 960 wide (scripts/sample-film.ts). */
export const SAMPLE_VIDEO = { width: 960, height: 412, fps: 24, frames: 121 } as const;
export const SAMPLE_FRAMES = SAMPLE_VIDEO.frames;

/**
 * Where the title sits in each version, in frame pixels (scripts/sample-film.ts prints them): `letters`, its glyphs;
 * `touched`, every pixel the title changes (its soft shadow too). Outside V1's and V2's `touched` the versions are
 * the same picture.
 */
export const SAMPLE_TITLE: Record<1 | 2, { letters: Rect; touched: Rect }> = {
  1: { letters: { x: 165, y: 254, w: 467, h: 27 }, touched: { x: 153, y: 244, w: 488, h: 46 } },
  2: { letters: { x: 637, y: 306, w: 260, h: 58 }, touched: { x: 626, y: 296, w: 281, h: 80 } },
};

/** The frame where the car drives under V1's title (the prototype's frame 0295, the film's note). */
export const SAMPLE_CAR_FRAME = 35;

/** What the sample says, in the language the person uses Lampo in. */
export interface SampleScript {
  name: string;
  folder: string;
  /** Who left the notes (a made-up teammate: the person's own notes are theirs to write). */
  reviewer: string;
  /** The agent's name; the app shows the agent the person picked in the setup in its place. */
  agent: string;
  title: { text: string; fix: string };
  idea: { text: string; reply: string };
  question: { text: string; choices: string[] };
}

export const SAMPLE_SCRIPTS: Record<SampleLang, SampleScript> = {
  en: {
    name: 'Lampo sample.mp4',
    folder: 'Sample',
    reviewer: 'Alex',
    agent: 'agent:Sample agent',
    title: {
      text: 'The title covers the car. Move it off the road, onto the hill.',
      fix: 'Moved the title to the lower right, on the hill.',
    },
    idea: {
      text: 'Try a slower push-in on the opening shot.',
      reply: 'Noted for V3: a fifth slower. Your call.',
    },
    question: {
      text: 'Should the title fade out before the bend, or hold to the end card?',
      choices: ['Fade it out', 'Hold it'],
    },
  },
  de: {
    name: 'Lampo-Beispiel.mp4',
    folder: 'Beispiel',
    reviewer: 'Alex',
    agent: 'agent:Beispiel-Agent',
    title: {
      text: 'Der Titel verdeckt das Auto. Setz ihn von der Straße weg, auf den Hügel.',
      fix: 'Den Titel nach rechts unten verschoben, auf den Hügel.',
    },
    idea: {
      text: 'Probier in der ersten Einstellung eine langsamere Ranfahrt.',
      reply: 'Für V3 notiert: ein Fünftel langsamer. Du entscheidest.',
    },
    question: {
      text: 'Soll der Titel vor der Kurve ausblenden oder bis zur Endkarte stehen bleiben?',
      choices: ['Ausblenden', 'Stehen lassen'],
    },
  },
};

/** The notes, where they sit (frames of the 121) and what they look like: the plan createSample follows. */
export function samplePlan(lang: SampleLang) {
  const s = SAMPLE_SCRIPTS[lang];
  const { letters } = SAMPLE_TITLE[1];
  const pad = 14;
  return {
    script: s,
    // on V1, a box around the title and the car under it: fixed in V2, waiting for a check
    title: {
      v: 1,
      frame: SAMPLE_CAR_FRAME,
      severity: 'must' as const,
      tags: ['layout/overlap'],
      drawing: [{ type: 'box', x: letters.x - pad, y: letters.y - pad, w: letters.w + 2 * pad, h: 72 }] as Shape[],
    },
    // on the opening frames: an idea (never holds the video back) with the agent's answer
    idea: { v: 1, frame: 12, severity: 'idea' as const, tags: ['timing'], drawing: [] as Shape[] },
    // late in V2, before the bend: the agent asks, with two answers to pick
    question: { v: 2, frame: 96 },
  };
}

/** The sample in this store, if there is one (archived ones included: a sample is never archived, only removed). */
export const findSample = (): Review | undefined => store.listReviews().find((r) => !!r.onboarding_sample);

const metaOf = (review: Review, ver: Version): FrameMeta => ({
  ...(review.meta || {}),
  fps: ver.fps,
  width: ver.width,
  height: ver.height,
  frames: ver.frames,
});

/** A note's screenshots, made like the composer's (lib/shots.ts) from the version's own bytes. */
async function shotsFor(slug: string, v: number, frame: number, drawing: Shape[]) {
  const review = store.loadReview(slug) as Review;
  const ver = review.versions.find((x) => x.v === v) as Version;
  const file = await store.ensureVersionFile(review, v);
  if (!file) throw new Error(`the sample's V${v} is gone`);
  const id = store.reservedCommentId();
  const shots = await makeShots({ file, frame, meta: metaOf(review, ver), drawing, dir: reviewDir(slug), id });
  return { id, shots };
}

// The sample being made, per workspace (wsKey): another workspace asking meanwhile makes its own (A12 WS-8).
const making = new Map<string, Promise<Review>>();

/**
 * Makes the sample (or hands back the one there is): uploads both versions through the storage adapter, then writes
 * the notes as the plan says. One at a time per workspace: a second click waits for the first.
 */
export function createSample({ by, byId, lang = 'en' }: { by: string; byId?: string; lang?: SampleLang }): Promise<Review> {
  const there = findSample();
  if (there) return Promise.resolve(there);
  const key = wsKey('sample');
  let p = making.get(key);
  if (!p) {
    p = make({ by, byId, lang }).finally(() => making.delete(key));
    making.set(key, p);
  }
  return p;
}

/** Whether the sample is being made in the workspace running now. */
export const sampleInMaking = (): boolean => making.has(wsKey('sample'));

/**
 * createSample, saying whether this call made it: asks while one is being made share it, and only the one that started
 * the making made it (sweep 3 ONB-4) — so only that one warms the sample up and tells the library.
 */
export function createSampleOnce(o: { by: string; byId?: string; lang?: SampleLang }): Promise<{ review: Review; made: boolean }> {
  const p = making.get(wsKey('sample'));
  if (p) return p.then((review) => ({ review, made: false }));
  const there = findSample();
  if (there) return Promise.resolve({ review: there, made: false });
  return createSample(o).then((review) => ({ review, made: true }));
}

async function make({ by, byId, lang }: { by: string; byId?: string; lang: SampleLang }): Promise<Review> {
  const plan = samplePlan(lang);
  const s = plan.script;
  const mark: SampleMark = { made: isoLocal(), by, ...(byId ? { by_id: byId } : {}) };
  fs.mkdirSync(CACHE, { recursive: true });
  const work = fs.mkdtempSync(path.join(CACHE, 'sample-'));
  try {
    // working copies: an upload is moved into the store, and the committed versions must stay where they are
    const [v1, v2] = ([1, 2] as const).map((v) => {
      const copy = path.join(work, `v${v}.mp4`);
      fs.copyFileSync(SAMPLE_FILES[v], copy);
      return copy;
    });
    const first = await store.ingestUpload(v1 as string, { name: s.name, folder: s.folder, by, byId, sample: mark });
    const slug = slugify(first.review.video);
    try {
      return await notes(slug, plan, v2 as string, mark);
    } catch (e) {
      // half a sample is no sample: take it away again
      store.removeSample(slug);
      throw e;
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function notes(slug: string, plan: ReturnType<typeof samplePlan>, v2: string, mark: SampleMark): Promise<Review> {
  const s = plan.script;
  // V1: the reviewer's note on the title and an idea
  const titleShots = await shotsFor(slug, 1, plan.title.frame, plan.title.drawing);
  const ideaShots = await shotsFor(slug, 1, plan.idea.frame, plan.idea.drawing);
  const [title, idea] = store.addComments(slug, [
    {
      ...titleShots,
      v: 1,
      frame: plan.title.frame,
      text: s.title.text,
      tags: plan.title.tags,
      severity: plan.title.severity,
      drawing: plan.title.drawing,
      author: s.reviewer,
    },
    {
      ...ideaShots,
      v: 1,
      frame: plan.idea.frame,
      text: s.idea.text,
      tags: plan.idea.tags,
      severity: plan.idea.severity,
      author: s.reviewer,
    },
  ]) as [Comment, Comment];
  // V2 from the agent, with the title moved onto the hill; the idea answered (nothing to recheck on V2)
  // (the sample's own making: anyone else's upload onto the sample is refused)
  await store.ingestUpload(v2, { name: s.name, slug, by: s.agent, sample: mark });
  store.updateComment(title.id, { status: 'fixed', note: s.title.fix, fixed_in_v: 2, by: s.agent });
  store.updateComment(idea.id, { note: s.idea.reply, ack: true, by: s.agent });
  // and its question on V2, with two answers to pick
  const q = await shotsFor(slug, 2, plan.question.frame, []);
  store.addComment(slug, { ...q, v: 2, frame: plan.question.frame, text: s.question.text, kind: 'question', choices: s.question.choices, author: s.agent });
  return store.loadReview(slug) as Review;
}
