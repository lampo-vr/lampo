// What each agent was told of each video, kept per workspace (mcp/feedback.ts Told): the place in the video's feedback
// right after the last thing a wait handed it or a read of its notes showed it. A wait hands over everything after that
// place, however old or new the cursor it brings: the cursor only keeps it from hearing a thing twice where nothing is
// remembered. Kept in the workspace's own folder (told.json, 0600), so a restart forgets nothing; bounded (TOLD_KEEP
// marks, the oldest go first: a forgotten mark means the cursor decides again, as before). The marks name an agent by
// its key (a hash of the connection and the client's name over HTTP, a session on the machine) and a video by its slug:
// nothing a person wrote.
import fs from 'node:fs';
import path from 'node:path';
import { withLock, writeAtomic } from './store.ts';

/** A place in one video's feedback: its second (ms) and how many of that video's events of that second came before. */
export interface ToldPlace {
  at: number;
  seen: number;
}

/** How many marks a workspace keeps: agents × videos they read. */
export const TOLD_KEEP = 4000;

/** On disk: `<agent>\0<slug>` → [second, seen, when written]. */
interface ToldFile {
  marks: Record<string, [number, number, number]>;
}

const fileIn = (dataDir: string) => path.join(dataDir, 'told.json');
const key = (agent: string, slug: string) => `${agent}\u0000${slug}`;

// The file as last read, per workspace folder: a wait asks for its marks on every look, and the file changes only when
// something is told.
const read = new Map<string, { mtime: number; data: ToldFile }>();

function load(dataDir: string): ToldFile {
  const file = fileIn(dataDir);
  let mtime = -1;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return { marks: {} };
  }
  const hit = read.get(file);
  if (hit && hit.mtime === mtime) return hit.data;
  let data: ToldFile = { marks: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<ToldFile>;
    if (parsed && typeof parsed.marks === 'object' && parsed.marks) data = { marks: parsed.marks };
  } catch {
    // unreadable: as if nothing was told (the cursor decides), and written anew with the next mark
  }
  read.set(file, { mtime, data });
  return data;
}

/** Where `agent` stands in `slug`'s feedback, or null when nothing of it was told. */
export function toldPlace(dataDir: string, agent: string, slug: string): ToldPlace | null {
  const m = load(dataDir).marks[key(agent, slug)];
  return Array.isArray(m) && Number.isFinite(m[0]) && Number.isFinite(m[1]) ? { at: m[0], seen: m[1] } : null;
}

/** Every video `agent` was told of, with its place. */
export function toldPlaces(dataDir: string, agent: string): Record<string, ToldPlace> {
  const out: Record<string, ToldPlace> = {};
  const head = `${agent}\u0000`;
  for (const [k, m] of Object.entries(load(dataDir).marks))
    if (k.startsWith(head) && Array.isArray(m) && Number.isFinite(m[0]) && Number.isFinite(m[1])) out[k.slice(head.length)] = { at: m[0], seen: m[1] };
  return out;
}

const later = (a: ToldPlace, b: ToldPlace) => a.at > b.at || (a.at === b.at && a.seen > b.seen);

/** `agent` was told of these videos up to these places (a mark never moves back). One write for all of them. */
export function markTold(dataDir: string, agent: string, places: Record<string, ToldPlace>, now = Date.now()): void {
  const slugs = Object.keys(places).filter((s) => Number.isFinite(places[s]?.at) && Number.isFinite(places[s]?.seen));
  if (!slugs.length) return;
  try {
    withLock(path.join(dataDir, '.told'), () => {
      read.delete(fileIn(dataDir));
      const data = load(dataDir);
      let changed = false;
      for (const s of slugs) {
        const k = key(agent, s);
        const had = data.marks[k];
        const place = places[s] as ToldPlace;
        if (had && !later(place, { at: had[0], seen: had[1] })) continue;
        delete data.marks[k];
        data.marks[k] = [place.at, place.seen, now];
        changed = true;
      }
      if (!changed) return;
      const entries = Object.entries(data.marks);
      if (entries.length > TOLD_KEEP) {
        entries.sort((a, b) => a[1][2] - b[1][2]);
        for (const [k] of entries.slice(0, entries.length - TOLD_KEEP)) delete data.marks[k];
      }
      fs.mkdirSync(dataDir, { recursive: true });
      writeAtomic(fileIn(dataDir), `${JSON.stringify(data)}\n`);
      fs.chmodSync(fileIn(dataDir), 0o600);
      read.delete(fileIn(dataDir));
    });
  } catch (e) {
    // a mark not written is told once more, never lost: the wait goes on
    console.error(`told: ${(e as Error).message}`);
  }
}
