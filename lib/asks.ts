// Questions with options asked before any render exists: an agent offers voices, music or a look on a project or
// folder (no video yet to pin them to), the person auditions and picks in the inbox or the folder, and the answer goes
// back like any answer — a `status` event, ANSWERED with the PICKED line (lib/options.ts). On a video the same
// question is a note (Comment.options); this file is for the folder's.
// Kept per workspace in data/asks.json (dataDir(): another team's are another file), under one lock; their pictures,
// clips and sounds go through the storage adapter at asks/<id>/ (locally data/asks/<id>/). Answered asks are kept a
// month, then dropped with their files — sooner, oldest first, when the file would pass its size (ASK_LIMITS: a
// reviewer's loop of ask + close grew it to 32 MB, A12 OPT-2). Every inbox read and every new note id reads it, so it
// is parsed once per change and held (like shares.json).
import fs from 'node:fs';
import path from 'node:path';
import { checkNotArchived } from './folderIds.ts';
import { answeredAlready, lastAnswer, OPTION_LIMITS, optionRefs, picksLine } from './options.ts';
import { dataDir, isoLocal } from './paths.ts';
import { storage } from './storage/index.ts';
import { alsoTaken, answerOf, logAskEvent, refFiles, reservedCommentId, withLock, writeAtomic } from './store.ts';
import { compareTime, instant } from './time.ts';
import type { FolderAsk, NoteRef, OptionAnswer, OptionGroup, Reply } from './types.ts';

const FILE = (): string => path.join(dataDir(), 'asks.json');
const LOCK = (): string => path.join(dataDir(), '.asks');
/** What one workspace's asks.json holds, whatever agents and people send (tests lower them). */
export const ASK_LIMITS = {
  /** Questions waiting at once. */
  open: 200,
  /** Questions kept, waiting and answered: past it the answered ones go, oldest first. */
  kept: 400,
  /** The file's size: answered ones go, oldest first, to stay under it; a new question that doesn't fit is refused. */
  bytes: 8 * 1024 * 1024,
  /** Answers one question keeps. */
  replies: OPTION_LIMITS.answers,
  /** A question's text (the API's limit, for every way in). */
  text: OPTION_LIMITS.text,
};
const KEEP_ANSWERED_MS = 30 * 24 * 3600 * 1000;

/** Where an ask's file lives in storage. */
export const askKey = (id: string, file: string): string => `asks/${id}/${file}`;
/** Where the browser gets it. */
export const askFileUrl = (id: string, file: string): string => `/api/asks/${encodeURIComponent(id)}/files/${encodeURIComponent(file)}`;

/**
 * asks.json can't be read, or isn't a list of questions: the server's state, not the request — everyone but the
 * machine's owner reads one sentence (`publicText`, lib/publicError.ts), the log says why (once).
 */
export class AsksUnreadableError extends Error {
  status = 500;
  publicText = 'the questions asked on folders can’t be read right now; try again later';
}

let warned = '';
function unreadable(e: unknown): never {
  const msg = (e as Error).message;
  if (warned !== msg) console.error(`asks: ${msg}; questions asked on folders are hidden and none can be asked until it is put right`);
  warned = msg;
  throw e;
}

const isAsk = (a: unknown): a is FolderAsk => {
  const x = a as Partial<FolderAsk> | null;
  return !!x && typeof x === 'object' && typeof x.id === 'string' && typeof x.folder === 'string' && Array.isArray(x.options) && Array.isArray(x.replies);
};

/**
 * The file as it is now. No file = none; one that can't be read or isn't a list of questions throws, and is never
 * written over (read as empty, the next write would drop every question waiting).
 */
function readFile(file: string): FolderAsk[] {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return [];
    return unreadable(e);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    return unreadable(new AsksUnreadableError(`${file} can't be read (${(e as Error).message})`));
  }
  const list = (parsed as { asks?: unknown } | null)?.asks;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || !Array.isArray(list) || !list.every(isAsk))
    return unreadable(new AsksUnreadableError(`${file} isn’t a list of questions: it is kept as it is until it is put right`));
  return list;
}

/** By file (one per workspace): the file as parsed, and which version of it (inode, size, mtime: every write renames). */
const held = new Map<string, { stat: string; asks: FolderAsk[] }>();
function statOf(file: string): string {
  try {
    const st = fs.statSync(file);
    return `${st.ino}:${st.size}:${st.mtimeMs}`;
  } catch {
    return 'none';
  }
}

/**
 * Every ask of this workspace, parsed once per change of the file. Shared: read it, never change it (writes read the
 * file afresh under the lock).
 */
export function listAsks(): FolderAsk[] {
  const file = FILE();
  const stat = statOf(file);
  const h = held.get(file);
  if (h?.stat === stat) return h.asks;
  const asks = readFile(file);
  held.set(file, { stat, asks });
  return asks;
}

/** The asks as lists show them (the inbox, the folder): a damaged file costs the list, never the page — logged once. */
export function shownAsks(): FolderAsk[] {
  try {
    return listAsks();
  } catch {
    return [];
  }
}

export const findAsk = (id: string): FolderAsk | null => shownAsks().find((a) => a.id === id) ?? null;

// A note and a folder's ask never share an id: get_note, the answer and the inbox name both the same way.
alsoTaken(() => shownAsks().map((a) => a.id));

// Written compact: every byte is parsed again after each write.
function save(asks: FolderAsk[]): void {
  fs.mkdirSync(dataDir(), { recursive: true });
  const file = FILE();
  writeAtomic(file, `${JSON.stringify({ asks })}\n`);
  held.set(file, { stat: statOf(file), asks });
}

const lastSeen = (a: FolderAsk): number => instant(lastAnswer(a)?.at ?? a.replies.at(-1)?.at ?? a.created);
const bytesOf = (asks: FolderAsk[]): number => asks.reduce((n, a) => n + Buffer.byteLength(JSON.stringify(a)) + 1, 12);

/**
 * What stays, and what goes with its files: answered asks a month old, then — oldest first — answered ones past the
 * count or the size (never `keep`, the one being changed). Questions waiting always stay: a new one that doesn't fit
 * is refused by its caller.
 */
function fitted(all: FolderAsk[], keep = '', now = Date.now()): { kept: FolderAsk[]; gone: FolderAsk[] } {
  const old = (a: FolderAsk) => a.status !== 'open' && now - lastSeen(a) > KEEP_ANSWERED_MS;
  const gone = all.filter(old);
  let kept = all.filter((a) => !old(a));
  const answered = kept.filter((a) => a.status !== 'open' && a.id !== keep).sort((a, b) => lastSeen(a) - lastSeen(b));
  const size = new Map(kept.map((a) => [a.id, Buffer.byteLength(JSON.stringify(a)) + 1]));
  let bytes = bytesOf(kept);
  const drop = new Set<string>();
  for (const a of answered) {
    if (kept.length - drop.size <= ASK_LIMITS.kept && bytes <= ASK_LIMITS.bytes) break;
    drop.add(a.id);
    bytes -= size.get(a.id) ?? 0;
  }
  if (drop.size) {
    gone.push(...kept.filter((a) => drop.has(a.id)));
    kept = kept.filter((a) => !drop.has(a.id));
  }
  return { kept, gone };
}

/** Changes one ask under the lock, on the file as it is now; throws when there is none with that id. */
function change<T>(id: string, fn: (ask: FolderAsk, all: FolderAsk[]) => T): T {
  let gone: FolderAsk[] = [];
  const out = withLock(LOCK(), () => {
    const all = readFile(FILE());
    const ask = all.find((a) => a.id === id);
    if (!ask) throw new Error(`no question ${id}`);
    // a question in an archived project waits as it is: no answer, no file, until the project is restored
    checkNotArchived(ask.folder);
    const out = fn(ask, all);
    const fit = fitted(all, id);
    gone = fit.gone;
    save(fit.kept);
    return out;
  });
  for (const a of gone) dropFiles(a);
  return out;
}

const refused = (message: string): Error => Object.assign(new Error(message), { status: 409 });

const dropFiles = (a: FolderAsk) =>
  storage()
    .remove(`asks/${a.id}/`)
    .catch((e: Error) => console.error(`removing the files of ${a.id}:`, e.message));

export interface AskInput {
  /** Reserved beforehand when files were stored under it (reservedCommentId). */
  id?: string;
  folder: string;
  text: string;
  /** Cleaned (lib/options.ts cleanOptions), their files stored at askKey(id, …). */
  options: OptionGroup[];
  answer_prompt?: string;
  author: string;
  author_id?: string;
}

/** A question on a folder, told like a note (a `comment` event: the inbox, push, webhooks and `vr watch` hear it). */
export function createAsk(input: AskInput): FolderAsk {
  const text = input.text.trim();
  if (text.length > ASK_LIMITS.text) throw new Error(`a question is at most ${ASK_LIMITS.text} characters long`);
  checkNotArchived(input.folder);
  const ask: FolderAsk = {
    id: input.id ?? reservedCommentId(),
    folder: input.folder,
    text,
    kind: 'question',
    options: input.options,
    ...(input.answer_prompt ? { answer_prompt: input.answer_prompt } : {}),
    status: 'open',
    author: input.author,
    ...(input.author_id ? { author_id: input.author_id } : {}),
    created: isoLocal(),
    replies: [],
  };
  const gone = withLock(LOCK(), () => {
    const all = readFile(FILE());
    if (all.filter((a) => a.status === 'open').length >= ASK_LIMITS.open)
      throw refused(`${ASK_LIMITS.open} questions are waiting already: wait for answers first`);
    if (all.some((a) => a.id === ask.id)) throw new Error(`there is a question ${ask.id} already`);
    const { kept, gone } = fitted([...all, ask], ask.id);
    if (bytesOf(kept) > ASK_LIMITS.bytes) throw refused('the questions waiting here take all the room there is: wait for answers first');
    save(kept);
    logAskEvent('comment', ask.author, ask);
    return gone;
  });
  for (const a of gone) dropFiles(a);
  return ask;
}

/** An item's file, stored after the question was asked (an upload URL's PUT). */
export function setAskItemRef(id: string, group: string, item: string, ref: NoteRef): FolderAsk {
  return change(id, (ask) => {
    if (ask.status !== 'open') throw answeredAlready();
    const it = ask.options.find((g) => g.id === group)?.items.find((x) => x.id === item);
    if (!it) throw new Error(`${id} has no item ${group}/${item}`);
    it.ref = ref;
    return ask;
  });
}

/**
 * The person's picks: the question is answered (a `status` event, ANSWERED with the PICKED line) — or, answered
 * already, a reply with the new picks. Checked against what it offers.
 */
export function answerAsk(id: string, a: OptionAnswer, by: string): FolderAsk {
  return change(id, (ask) => {
    const answer = answerOf(ask, a);
    if (ask.replies.filter((r) => r.answer).length >= ASK_LIMITS.replies)
      throw refused(`this question was answered ${ASK_LIMITS.replies} times already: ask a new one`);
    const reply: Reply = { by, text: picksLine(ask.options, answer), at: isoLocal(), answer };
    if (ask.status === 'open') {
      reply.status = 'verified';
      ask.status = 'verified';
      ask.replies.push(reply);
      logAskEvent('status', by, ask, reply);
    } else {
      ask.replies.push(reply);
      logAskEvent('reply', by, ask, reply);
    }
    return ask;
  });
}

/** Closed without an answer ("Done" in the inbox): the asker hears VERIFIED, no picks. */
export function closeAsk(id: string, by: string): FolderAsk {
  return change(id, (ask) => {
    if (ask.status !== 'open') return ask;
    const reply: Reply = { by, text: '', status: 'verified', at: isoLocal() };
    ask.status = 'verified';
    ask.replies.push(reply);
    logAskEvent('status', by, ask, reply);
    return ask;
  });
}

/** Gone for good, with its files. */
export function removeAsk(id: string, by: string): FolderAsk {
  const ask = withLock(LOCK(), () => {
    const all = readFile(FILE());
    const hit = all.find((a) => a.id === id);
    if (!hit) throw new Error(`no question ${id}`);
    checkNotArchived(hit.folder);
    save(all.filter((a) => a.id !== id));
    logAskEvent('delete', by, hit);
    return hit;
  });
  dropFiles(ask);
  return ask;
}

/** Asks follow their folder when it is renamed or moved, and up a level when it is deleted (lib/folders.ts). */
export function moveAskFolders(map: (folder: string) => string | null): void {
  withLock(LOCK(), () => {
    let all: FolderAsk[];
    try {
      all = readFile(FILE());
    } catch (e) {
      // The folder moves anyway; its questions keep the old name until the file is put right and the folder is moved again.
      console.error(`asks: questions on folders weren’t moved with their folder (${(e as Error).message})`);
      return;
    }
    let moved = false;
    for (const a of all) {
      const to = map(a.folder);
      if (to !== null && to !== a.folder) {
        a.folder = to;
        moved = true;
      }
    }
    if (moved) save(all);
  });
}

/** The asks of a folder and the folders inside it (the library's strip), waiting ones first, newest first. */
export function asksIn(folder: string | null, asks = shownAsks()): FolderAsk[] {
  const inside = (f: string) => !folder || f === folder || f.startsWith(`${folder}/`);
  return asks.filter((a) => inside(a.folder)).sort((a, b) => Number(b.status === 'open') - Number(a.status === 'open') || compareTime(b.created, a.created));
}

/** Every file an ask's items carry. */
export const askFiles = (a: Pick<FolderAsk, 'options'>): string[] => optionRefs(a.options).flatMap(refFiles);
