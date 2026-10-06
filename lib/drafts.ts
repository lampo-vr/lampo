// Notes not sent yet (Comment.draft): whoever writes a note may keep it to themselves and send it when they're ready,
// alone or with the others they saved. Drafts live beside the review, never in it. review.json, review.md,
// events.jsonl and INBOX.md are what agents read, and what every listing, count, inbox and review link is built from,
// so nothing there can show one:
//   data/<slug>/drafts/<account id>.json   {"drafts": Comment[]}: one person's drafts on the video, oldest first
//   data/<slug>/drafts/<note id>_clean.png, _marked.png, _range.jpg, <note id>.m4a: their screenshots and voice notes
// Every write happens under the video's lock. Sending moves drafts into the review in one write (store.mutate): their
// `comment` events land in events.jsonl together, so whoever waits for feedback gets the batch at once.
import fs from 'node:fs';
import path from 'node:path';
import { isoLocal, reviewDir } from './paths.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import type { Comment, NoteRef, Review, Severity, Version } from './types.ts';

/** How many drafts one person keeps on one video. */
export const DRAFTS_MAX = 200;

const OWNER = /^[A-Za-z0-9_-]{1,64}$/;
/** An account id that can name a drafts file. */
export const isDraftOwner = (owner: string | undefined | null): owner is string => !!owner && OWNER.test(owner);

export const draftsDir = (slug: string): string => path.join(reviewDir(slug), 'drafts');
const fileOf = (slug: string, owner: string): string => {
  if (!isDraftOwner(owner)) throw new Error('drafts need an account');
  return path.join(draftsDir(slug), `${owner}.json`);
};

/** One person's drafts on a video, oldest first (none when the video or the file doesn't exist). */
export function listDrafts(slug: string, owner: string): Comment[] {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(slug, owner), 'utf8')) as { drafts?: Comment[] };
    return Array.isArray(raw.drafts) ? raw.drafts : [];
  } catch {
    return [];
  }
}

function writeDrafts(slug: string, owner: string, drafts: Comment[]): void {
  const file = fileOf(slug, owner);
  if (!drafts.length) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  store.writeAtomic(file, `${JSON.stringify({ drafts }, null, 2)}\n`);
}

// The library asks for every video's count on each visit: a file is read again only when it changed.
const counted = new Map<string, { key: string; n: number }>();
/** How many drafts one person has on a video. */
export function countDrafts(slug: string, owner: string): number {
  const file = fileOf(slug, owner);
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    counted.delete(file);
    return 0;
  }
  const key = `${st.ino}:${st.size}:${st.mtimeMs}`;
  const hit = counted.get(file);
  if (hit?.key === key) return hit.n;
  const n = listDrafts(slug, owner).length;
  counted.set(file, { key, n });
  return n;
}

/** The files a draft keeps in data/<slug>/drafts/ (its screenshots and voice note; references live in storage). */
const filesOf = (d: Comment): string[] => [d.shots?.clean, d.shots?.marked, d.shots?.range, d.voice?.file].filter((f): f is string => !!f);

/** A file of one of this person's drafts, as a path to send, or null. */
export function draftFile(slug: string, owner: string, file: string): string | null {
  if (!/^c_[a-f0-9]+(_clean\.png|_marked\.png|_range\.jpg|\.m4a)$/.test(file)) return null;
  if (!listDrafts(slug, owner).some((d) => filesOf(d).includes(file))) return null;
  const full = path.join(draftsDir(slug), file);
  return fs.existsSync(full) ? full : null;
}

/** The references on this person's drafts (their files are served to them like a note's). */
export const draftRefs = (slug: string, owner: string): NoteRef[] => listDrafts(slug, owner).flatMap((d) => d.refs || []);

function own(slug: string, owner: string, id: string): { all: Comment[]; d: Comment } {
  const all = listDrafts(slug, owner);
  const d = all.find((x) => x.id === id);
  if (!d) throw Object.assign(new Error('no such draft'), { status: 404 });
  return { all, d };
}

function loaded(slug: string): Review {
  const review = store.loadReview(slug);
  if (!review) throw Object.assign(new Error('unknown video'), { status: 404 });
  return review;
}

/**
 * Saves a note as a draft: built like any note (store.buildComment), kept in the author's drafts file, no event. Its
 * screenshots and voice note are expected in draftsDir (the route makes them there).
 */
export function addDraft(slug: string, owner: string, input: store.CommentInput): Comment {
  return store.withLock(reviewDir(slug), () => {
    const all = listDrafts(slug, owner);
    if (all.length >= DRAFTS_MAX) throw Object.assign(new Error(`at most ${DRAFTS_MAX} drafts per video: send some first`), { status: 409 });
    const c = store.buildComment(loaded(slug), input);
    // Whether it lands on an older version is decided when it is sent.
    delete c.check_again;
    delete c.carried_to;
    if (all.some((x) => x.id === c.id)) throw new Error('a draft with this id exists');
    c.draft = true;
    writeDrafts(slug, owner, [...all, c]);
    return c;
  });
}

export interface DraftPatch {
  text?: string;
  tags?: string[];
  severity?: Severity;
  /** A text edit's new words (what was heard stays). */
  text_edit_to?: string;
}

/** Changes a draft's words, tags or severity (no event: nobody else knows it exists). */
export function editDraft(slug: string, owner: string, id: string, patch: DraftPatch): Comment {
  return store.withLock(reviewDir(slug), () => {
    const { all, d } = own(slug, owner, id);
    if (patch.text !== undefined) d.text = patch.text.trim();
    if (patch.tags !== undefined)
      d.tags = patch.tags
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
    if (patch.severity !== undefined && (d.kind ?? 'feedback') === 'feedback') d.severity = patch.severity;
    if (patch.text_edit_to !== undefined && d.text_edit) d.text_edit = { from: d.text_edit.from, to: patch.text_edit_to.trim() };
    writeDrafts(slug, owner, all);
    return d;
  });
}

const removeStored = (slug: string, refs: NoteRef[]) => {
  for (const r of refs)
    for (const f of store.refFiles(r))
      storage()
        .remove(store.refKey(slug, f))
        .catch((e: Error) => console.error(`removing reference ${r.id}:`, e.message));
};

/** Deletes a draft with its files. */
export function deleteDraft(slug: string, owner: string, id: string): Comment {
  return store.withLock(reviewDir(slug), () => {
    const { all, d } = own(slug, owner, id);
    writeDrafts(
      slug,
      owner,
      all.filter((x) => x !== d),
    );
    for (const f of filesOf(d)) fs.rmSync(path.join(draftsDir(slug), f), { force: true });
    removeStored(slug, d.refs || []);
    return d;
  });
}

/**
 * Every draft one person keeps on a video, with their files and references: they left the workspace, or their account
 * went (lib/erasure.ts). By the account's own file only (`drafts/<id>.json`), never anyone else's. How many went.
 */
export function discardDraftsOf(slug: string, owner: string): number {
  if (!isDraftOwner(owner) || !fs.existsSync(fileOf(slug, owner))) return 0;
  return store.withLock(reviewDir(slug), () => {
    const all = listDrafts(slug, owner);
    for (const d of all) {
      for (const f of filesOf(d)) fs.rmSync(path.join(draftsDir(slug), f), { force: true });
      removeStored(slug, d.refs || []);
    }
    fs.rmSync(fileOf(slug, owner), { force: true });
    counted.delete(fileOf(slug, owner));
    return all.length;
  });
}

/** Adds references to a draft (its own: drafts have no replies). Throws past REFS_PER_NOTE. */
export function addDraftRefs(slug: string, owner: string, id: string, refs: NoteRef[]): Comment {
  return store.withLock(reviewDir(slug), () => {
    const { all, d } = own(slug, owner, id);
    if ((d.refs?.length || 0) + refs.length > store.REFS_PER_NOTE) throw new Error(`a note carries at most ${store.REFS_PER_NOTE} references`);
    d.refs = [...(d.refs || []), ...refs];
    writeDrafts(slug, owner, all);
    return d;
  });
}

/** Takes a reference off a draft, with its files. */
export function removeDraftRef(slug: string, owner: string, id: string, refId: string): Comment {
  return store.withLock(reviewDir(slug), () => {
    const { all, d } = own(slug, owner, id);
    const ref = d.refs?.find((r) => r.id === refId);
    if (!ref) throw Object.assign(new Error('no such reference'), { status: 404 });
    d.refs = (d.refs || []).filter((r) => r !== ref);
    if (!d.refs.length) delete d.refs;
    writeDrafts(slug, owner, all);
    removeStored(slug, [ref]);
    return d;
  });
}

/** Hard link where the disk allows (the same volume), else a copy: the draft's file stays until the review is saved. */
function place(from: string, to: string): boolean {
  try {
    fs.linkSync(from, to);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false;
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') fs.rmSync(to, { force: true });
  }
  try {
    fs.copyFileSync(from, to);
    return true;
  } catch {
    return false;
  }
}

/**
 * A draft as the note it becomes: written now (created = when it was sent, which is what `since` compares), files
 * beside the review under its id (a new one when another note took the draft's meanwhile), carried to the newest
 * version when one arrived after it was written.
 */
function promote(slug: string, d: Comment, id: string, latest: number): Comment {
  const named = (f: string) => (f.startsWith(d.id) ? `${id}${f.slice(d.id.length)}` : f);
  const moved = (f: string) => place(path.join(draftsDir(slug), f), path.join(reviewDir(slug), named(f)));
  const c: Comment = { ...d, id, created: isoLocal(), replies: [] };
  delete c.draft;
  delete c.edited;
  delete c.check_again;
  delete c.carried_to;
  if (d.shots) {
    const all = [d.shots.clean, d.shots.marked, ...(d.shots.range ? [d.shots.range] : [])];
    c.shots = all.every(moved)
      ? { clean: named(d.shots.clean), marked: named(d.shots.marked), ...(d.shots.range ? { range: named(d.shots.range) } : {}) }
      : null;
  }
  if (d.voice?.file) c.voice = moved(d.voice.file) ? { ...d.voice, file: named(d.voice.file) } : null;
  if (c.v < latest) {
    c.check_again = true;
    c.carried_to = latest;
  }
  return c;
}

/**
 * Sends drafts: the ones named (all of them without `ids`), then `also` (notes made at the same moment — what a
 * recording said), in one write: one batch of `comment` events, in that order. The drafts sent are let go of only once
 * the review is saved. Returns the notes.
 */
export function sendDrafts(slug: string, owner: string, o: { ids?: string[] | null; also?: store.CommentInput[] } = {}): Comment[] {
  let keep: Comment[] = [];
  let sent: Comment[] = [];
  return store.mutate(
    slug,
    (review) => {
      const mine = listDrafts(slug, owner);
      const pick = o.ids ? new Set(o.ids) : null;
      sent = mine.filter((d) => !pick || pick.has(d.id));
      keep = mine.filter((d) => !sent.includes(d));
      const taken = new Set([...store.listReviews().flatMap((r) => r.comments.map((c) => c.id)), ...review.comments.map((c) => c.id)]);
      const latest = (review.versions.at(-1) as Version).v;
      const notes: Comment[] = [];
      for (const d of sent) {
        let id = d.id;
        while (taken.has(id)) id = store.reservedCommentId();
        taken.add(id);
        notes.push(promote(slug, d, id, latest));
      }
      for (const input of o.also || []) notes.push(store.buildComment(review, input));
      for (const c of notes) {
        review.comments.push(c);
        store.logEvent({ type: 'comment', by: c.author, review, comment: c });
      }
      return notes;
    },
    () => {
      writeDrafts(slug, owner, keep);
      for (const d of sent) for (const f of filesOf(d)) fs.rmSync(path.join(draftsDir(slug), f), { force: true });
    },
  );
}
