// Making a question with options (lib/options.ts): every item's picture, clip or sound stored first — where the
// question will live (a video's refs/<slug>/, or asks/<id>/ for a folder's) —, then the note on the video or the
// folder's ask (lib/asks.ts). One path for the API route, `vr ask` / the MCP tool on this machine, and the upload URL
// that brings an item's file later. Nothing half-made stays: a file that fails takes the others with it.
import { askFileUrl, createAsk, findAsk, setAskItemRef } from './asks.ts';
import { checkNotArchived, checkReviewOpen } from './folderIds.ts';
import { allFolders, createFolder, normFolder } from './folders.ts';
import { heavy, PRIORITY } from './jobs.ts';
import { answeredAlready, cleanOptions, cleanPrompt, OPTION_LIMITS, type OptionGroupInput, optionRefs } from './options.ts';
import { restated } from './publicError.ts';
import { type FrameTarget, frameRef, linkRef, type RefRequest, storeOptionFile } from './refs.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import type { AskView, Comment, FolderAsk, NoteRef, OptionGroup } from './types.ts';

/** Where an item's file comes from: a file on this disk (the caller decided it may name one), a link, a moment. */
export interface ItemSource {
  file?: string;
  url?: string;
  frame?: FrameTarget;
}

export interface MakeAsk {
  /** On a video (its slug): a note about the whole video. */
  slug?: string | null;
  /** Else on a project or folder, before any render. */
  folder?: string | null;
  /** May make the folder when it doesn't exist yet (the caller may organize). */
  makeFolder?: boolean;
  text: string;
  groups: OptionGroupInput[];
  /** "group/item" → where its file comes from; an item without one is its label alone (or gets a file later). */
  sources: Record<string, ItemSource>;
  answer_prompt?: string;
  author: string;
  author_id?: string;
  /**
   * Hands out the upload URLs of items whose file comes later, once the id is reserved and before anything is made,
   * stored, written or told: a refusal (429, too many open) leaves no question behind. Its caller takes the URLs back
   * when the question fails after all.
   */
  mint?: (id: string, groups: OptionGroup[]) => void;
}

export interface MadeAsk {
  id: string;
  slug: string | null;
  folder: string | null;
  comment?: Comment;
  ask?: FolderAsk;
}

/** What an upload URL for an item's file names: the question, the item, and who asked for it. */
export interface OptionTarget {
  ask: string;
  group: string;
  item: string;
  request: { by_id?: string };
}

const keyFor = (slug: string | null, id: string) => (file: string) => (slug ? store.refKey(slug, file) : `asks/${id}/${file}`);

/** The folder a question goes on: an existing project or folder, or a new one when the caller may make it. */
function placeFolder(raw: string | null | undefined, make: boolean): string {
  const f = normFolder(raw);
  if (!f) throw new Error('name the video, or the project or folder it is for');
  if (allFolders().includes(f)) return f;
  if (!make) throw new Error(`there is no project or folder "${f}"`);
  return createFolder(f);
}

// Files and moments are heavy work, done in the job queue one at a time (storeOptionFile queues itself; a moment is a
// frame grab or two, plus stills).
async function refFor(src: ItemSource, keyOf: (file: string) => string, req: RefRequest): Promise<NoteRef> {
  if (src.url) return linkRef(src.url, req);
  const frame = src.frame;
  if (frame) return heavy(() => frameRef('', frame, req, keyOf), PRIORITY.option);
  if (src.file) return storeOptionFile(src.file, keyOf, req);
  throw new Error('nothing to attach');
}

async function forget(refs: NoteRef[], keyOf: (file: string) => string): Promise<void> {
  for (const r of refs)
    for (const f of store.refFiles(r))
      await storage()
        .remove(keyOf(f))
        .catch(() => {});
}

/** The question made: its options cleaned, its files stored, the note or the folder's ask written (one event). */
export async function makeAsk(input: MakeAsk): Promise<MadeAsk> {
  const text = input.text.trim();
  if (!text) throw new Error('say what you are asking');
  if (text.length > OPTION_LIMITS.text) throw new Error(`a question is at most ${OPTION_LIMITS.text} characters long`);
  const groups: OptionGroup[] = cleanOptions(input.groups);
  for (const key of Object.keys(input.sources)) {
    const [g, i] = key.split('/');
    if (!groups.some((x) => x.id === g && x.items.some((it) => it.id === i))) throw new Error(`no item ${key} in the options`);
  }
  const moments = Object.values(input.sources).filter((s) => s.frame).length;
  if (moments > OPTION_LIMITS.moments) throw new Error(`a question shows at most ${OPTION_LIMITS.moments} moments of renders (this one ${moments})`);
  if (input.slug && !store.loadReview(input.slug)?.versions.length) throw new Error('no such video');
  // nothing new in an archived project: refused before any upload URL is handed out or any file is stored
  if (input.slug) checkReviewOpen(store.loadReview(input.slug));
  else checkNotArchived(normFolder(input.folder));
  const id = store.reservedCommentId();
  const slug = input.slug || null;
  input.mint?.(id, groups);
  const folder = slug ? null : placeFolder(input.folder, !!input.makeFolder);
  const keyOf = keyFor(slug, id);
  const req: RefRequest = { by: input.author, ...(input.author_id ? { by_id: input.author_id } : {}) };
  const made: NoteRef[] = [];
  try {
    for (const g of groups)
      for (const it of g.items) {
        const src = input.sources[`${g.id}/${it.id}`];
        if (!src) continue;
        try {
          it.ref = await refFor(src, keyOf, req);
        } catch (e) {
          // Which item, and still what failed: a store's or ffmpeg's words stay the server's (lib/publicError.ts).
          throw restated(`${g.id}/${it.id}: `, e);
        }
        made.push(it.ref);
      }
    const answer_prompt = cleanPrompt(input.answer_prompt);
    if (slug) {
      const comment = store.addComment(slug, {
        id,
        frame: 0,
        scope: 'video',
        kind: 'question',
        text,
        author: input.author,
        ...(input.author_id ? { author_id: input.author_id } : {}),
        options: groups,
        ...(answer_prompt ? { answer_prompt } : {}),
      });
      return { id, slug, folder: null, comment };
    }
    const ask = createAsk({ id, folder: folder as string, text, options: groups, answer_prompt, author: input.author, author_id: input.author_id });
    return { id, slug: null, folder: ask.folder, ask };
  } catch (e) {
    await forget(made, keyOf);
    throw e;
  }
}

/** Where an item is: on a note of a video, or on a folder's ask; and whether the question still waits for its answer. */
function locate(id: string): { slug: string | null; options: OptionGroup[]; open: boolean } | null {
  const hit = store.findComment(id);
  if (hit) return hit.comment.options?.length ? { slug: hit.slug, options: hit.comment.options, open: hit.comment.status === 'open' } : null;
  const ask = findAsk(id);
  return ask ? { slug: null, options: ask.options, open: ask.status === 'open' } : null;
}

/** Whether a question offers this item (an upload URL is only handed out for one it does). */
export function hasItem(id: string, group: string, item: string): boolean {
  return !!locate(id)
    ?.options.find((g) => g.id === group)
    ?.items.some((it) => it.id === item);
}

/** What an item's upload URL answers: the file as stored, and the video the question is on (null: a folder's). */
export interface OptionAttached {
  ref: NoteRef;
  slug: string | null;
}

/** An item's file arriving after the question (an upload URL): stored where the question lives, then set on the item. */
export async function attachOptionFile(target: OptionTarget, file: string, by: string): Promise<OptionAttached> {
  const at = locate(target.ask);
  if (!at) throw new Error(`no question ${target.ask}`);
  // Answered or closed: the person picked from what was there (checked again under the lock as the file is set).
  if (!at.open) throw answeredAlready();
  const keyOf = keyFor(at.slug, target.ask);
  const ref = await storeOptionFile(file, keyOf, { by, ...(target.request.by_id ? { by_id: target.request.by_id } : {}) });
  try {
    if (at.slug) store.setOptionRef(target.ask, target.group, target.item, ref);
    else setAskItemRef(target.ask, target.group, target.item, ref);
  } catch (e) {
    await forget([ref], keyOf);
    throw e;
  }
  // A file the item had before is replaced.
  const old = at.options.find((g) => g.id === target.group)?.items.find((it) => it.id === target.item)?.ref;
  if (old) await forget([old], keyOf);
  return { ref, slug: at.slug };
}

/**
 * A question with options as the audition reads it — a note on a video or a folder's ask — with where each item's
 * files are served; null when the id is neither (or the note offers no options).
 */
export function askView(id: string): AskView | null {
  const fileUrl = (file: string) => askFileUrl(id, file);
  // Files a bucket serves come from its URLs (another origin): Web Audio may not read them there.
  const level: AskView['level'] = storage().url(keyFor(null, id)('r_0000000000.m4a')) ? 'volume' : 'gain';
  const files = (groups: OptionGroup[]): AskView['files'] =>
    Object.fromEntries(
      optionRefs(groups).map((r) => [
        r.id,
        { src: r.file ? fileUrl(r.file) : null, still: r.still ? fileUrl(r.still) : r.kind === 'image' && r.file ? fileUrl(r.file) : null },
      ]),
    );
  const hit = store.findComment(id);
  if (hit) {
    const c = hit.comment;
    if (!c.options?.length) return null;
    return {
      id,
      slug: hit.slug,
      name: hit.review.video.split('/').pop() || hit.review.video,
      folder: hit.review.folder ?? null,
      v: c.v,
      text: c.text,
      options: c.options,
      answer_prompt: c.answer_prompt ?? null,
      status: c.status,
      author: c.author,
      created: c.created,
      replies: c.replies,
      files: files(c.options),
      level,
    };
  }
  const ask = findAsk(id);
  if (!ask) return null;
  return {
    id,
    slug: null,
    name: ask.folder.split('/').pop() || ask.folder,
    folder: ask.folder,
    v: null,
    text: ask.text,
    options: ask.options,
    answer_prompt: ask.answer_prompt ?? null,
    status: ask.status,
    author: ask.author,
    created: ask.created,
    replies: ask.replies,
    files: files(ask.options),
    level,
  };
}

/** The storage key of a file an ask's item carries (null when no item of it has that file): what may be served. */
export function askFileKey(id: string, file: string): string | null {
  const at = locate(id);
  if (!at) return null;
  const owns = optionRefs(at.options).some((r) => store.refFiles(r).includes(file));
  return owns ? keyFor(at.slug, id)(file) : null;
}
