// The ⌘K palette's search: videos, folders and notes in one request, best match first. Every word of the query has to
// match somewhere (a video's name, folder or project; a note's text, replies, author or video), case and accents
// ignored, German spelling both ways ("Änderung", "anderung" and "aenderung" find each other). A match at the start
// beats one at the start of a word, which beats one inside a word; ties go to what changed last.
// Access: whoever may `view` the library sees all of it (server mode has one workspace); guests never reach this.
import path from 'node:path';
import { archivedIn } from './archived.ts';
import { archivedNow } from './folderIds.ts';
import { shownFolders } from './folders.ts';
import { slugify } from './paths.ts';
import { renderKey } from './renderKey.ts';
import { STAGE_LABELS } from './stage.ts';
import { stageForReview } from './stageContext.ts';
import { listReviews } from './store.ts';
import { compareTime, noteKind } from './time.ts';
import type { ArchivedProject, Comment, Review, SearchFolder, SearchNote, SearchResponse, SearchVideo } from './types.ts';

const MARKS = /\p{M}/gu;
/** Case and accents folded: "Änderung" → "anderung", "Straße" → "strasse". The query is folded this way. */
export const fold = (s: string): string => s.normalize('NFD').replace(MARKS, '').toLowerCase().replace(/ß/g, 'ss');
/** The same text spelled out the German way ("ä" → "ae"), so a query typed without umlauts finds it too. */
const spelled = (s: string): string =>
  s.normalize('NFC').toLowerCase().replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss').normalize('NFD').replace(MARKS, '');

const WORD = /[\p{L}\p{N}]/u;
type Field = { plain: string; spelled: string; weight: number };
const field = (s: string, weight: number): Field => ({ plain: fold(s), spelled: spelled(s), weight });

/** 3: the text starts with the word; 2: a word in it does; 1: it's inside a word; 0: not there. */
function rank(hay: string, word: string): number {
  let i = hay.indexOf(word);
  if (i < 0) return 0;
  if (i === 0) return 3;
  while (i > 0) {
    if (!WORD.test(hay[i - 1] as string)) return 2;
    i = hay.indexOf(word, i + 1);
  }
  return 1;
}

/** Per query word, the best weighted match over the fields; null when a word matches nowhere. */
function score(fields: Field[], words: string[]): { total: number; best: number[] } | null {
  const best: number[] = [];
  let total = 0;
  for (const w of words) {
    let top = 0;
    let at = -1;
    fields.forEach((f, i) => {
      const s = Math.max(rank(f.plain, w), rank(f.spelled, w)) * f.weight;
      if (s > top) [top, at] = [s, i];
    });
    if (!top) return null;
    total += top;
    best.push(at);
  }
  return { total, best };
}

// Times as instants, never as strings: stores mix offsets (a Mac's +02:00, a container's UTC) and DST.
const byScoreThenRecent = <T>(a: { s: number; t: string; x: T }, b: { s: number; t: string; x: T }) => b.s - a.s || compareTime(b.t, a.t);

const posterOf = (slug: string, hash: string) => `/api/poster/${encodeURIComponent(slug)}.jpg?h=${hash.slice(0, 10)}`;

function videoHit(r: Review): SearchVideo {
  const slug = slugify(r.video);
  const latest = r.versions.at(-1);
  const stage = stageForReview(r);
  return {
    slug,
    name: path.basename(r.video),
    folder: r.folder || null,
    v: latest?.v ?? 1,
    stage: stage.stage,
    stage_label: STAGE_LABELS[stage.stage],
    stage_detail: stage.detail,
    width: latest?.width ?? r.width,
    height: latest?.height ?? r.height,
    poster: posterOf(slug, latest ? renderKey(latest) : ''),
    updated: r.updated || null,
  };
}

const who = (by: string) => by.replace(/^guest:/, '').replace(/^agent:/, '');

function noteHit(r: Review, c: Comment, reply: string | null): SearchNote {
  return {
    id: c.id,
    slug: slugify(r.video),
    video: path.basename(r.video),
    v: c.v,
    frame: c.frame,
    timecode: c.timecode,
    text: c.text.length > 300 ? `${c.text.slice(0, 299)}…` : c.text,
    author: c.author,
    status: c.status,
    kind: noteKind(c),
    severity: c.severity,
    created: c.created,
    reply,
  };
}

export function search(
  q: string,
  {
    limit = 8,
    reviews = listReviews(),
    archived = archivedNow(),
  }: { limit?: number; reviews?: Review[]; archived?: Readonly<Record<string, ArchivedProject>> } = {},
): SearchResponse {
  const listed = reviews.filter((r) => !r.archived && r.versions.length);
  // Archived projects (lib/archived.ts) are put away: what matches in them comes apart (`archived`), and only for a query.
  const away = (folder: string | null | undefined) => !!archivedIn(folder, archived);
  const live = listed.filter((r) => !away(r.folder));
  const words = [...new Set(fold(q).split(/\s+/).filter(Boolean))].slice(0, 6).map((w) => w.slice(0, 64));
  if (!words.length) {
    const recent = [...live].sort((a, b) => compareTime(b.updated, a.updated)).slice(0, limit);
    return { q, videos: recent.map(videoHit), folders: [], notes: [] };
  }

  const videosIn = (pool: Review[]) =>
    pool
      .map((r) => {
        const name = path.basename(r.video);
        // The project is matched (it names the job) but never returned: locally it can be a path on this disk.
        const project = r.project && !r.project.startsWith('/') ? r.project : '';
        const m = score([field(name, 3), field(r.folder || '', 1), field(project, 1)], words);
        return m && { s: m.total, t: r.updated || '', x: r };
      })
      .filter((m) => !!m)
      .sort(byScoreThenRecent)
      .slice(0, limit)
      .map((m) => videoHit(m.x));
  const videos = videosIn(live);

  // Folders: ties go to the fuller one.
  const known = shownFolders(reviews).folders;
  const foldersIn = (list: string[], pool: Review[]): SearchFolder[] =>
    list
      .map((f) => {
        const name = f.split('/').at(-1) as string;
        const m = score([field(name, 3), field(f, 1)], words);
        return m && { s: m.total, x: { folder: f, name, videos: pool.filter((r) => r.folder === f || r.folder?.startsWith(`${f}/`)).length } };
      })
      .filter((m) => !!m)
      .sort((a, b) => b.s - a.s || b.x.videos - a.x.videos || a.x.folder.localeCompare(b.x.folder, 'de'))
      .slice(0, limit)
      .map((m) => m.x);
  const folders = foldersIn(
    known.filter((f) => !away(f)),
    live,
  );
  const shut = { folders: foldersIn(known.filter(away), listed), videos: videosIn(listed.filter((r) => away(r.folder))) };

  // Notes: at least one word must be in the note itself (its text, a reply or who wrote it), or "spot" would list
  // every note of spot.mp4.
  const notes: { s: number; t: string; x: SearchNote }[] = [];
  for (const r of live) {
    const video = field(path.basename(r.video), 1);
    for (const c of r.comments) {
      const replies = (c.replies || []).filter((x) => x.text);
      const own = [field(c.text, 3), field(who(c.author), 1), ...replies.map((x) => field(x.text, 2))];
      const m = score([...own, video], words);
      if (!m?.best.some((i) => i < own.length)) continue;
      // Found through a reply (and not the note's own text): show that reply.
      const viaReply = m.best.find((i) => i >= 2 && i < own.length);
      const reply = viaReply !== undefined && !m.best.includes(0) ? (replies[viaReply - 2]?.text ?? null) : null;
      notes.push({ s: m.total, t: c.created, x: noteHit(r, c, reply) });
    }
  }
  notes.sort(byScoreThenRecent);

  return { q, videos, folders, notes: notes.slice(0, limit).map((m) => m.x), ...(shut.folders.length || shut.videos.length ? { archived: shut } : {}) };
}
