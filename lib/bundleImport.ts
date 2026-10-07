// `vr admin import <bundle.tar> --workspace <id> --owner <email> [--dry-run] [--people "Name=email,…"]`: a bundle
// (lib/bundle.ts, made by `vr export` on another machine) into one workspace of this store, typically a hosted server
// (docs/moving.md). The bundle is a file from outside: it is read twice — once to check everything (the tar's shape,
// every file against the manifest's size and sha256, every record against a strict schema, every file named by the
// review it belongs to), once to place what is checked — and nothing is written before the first read is through.
// Everything goes in through the store and the storage adapter (local disk, Bunny or S3 alike). A video id this
// workspace holds already is skipped and said, never written over, so a second run brings nothing new. People: the
// bundle's owner (and the names they wrote under) become the `--owner` account, `--people` maps other names to
// accounts, agents keep their names, anyone else keeps a name and no account. The history goes into the event log
// marked as imported: no live follower (agents' feeds, webhooks, push) hears of it, and no mail goes out.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listAsks } from './asks.ts';
import { findUserByEmail, type User } from './auth.ts';
import {
  BUNDLE_CLOCK_SKEW_MS,
  BUNDLE_FORMAT,
  BUNDLE_LIMITS,
  BUNDLE_VERSION,
  BundleEvent,
  BundleFolders,
  BundleManifest,
  type BundlePart,
  BundlePlaybook,
  BundleReview,
  BundleViews,
  bundlePart,
  PERSON,
  partLimit,
  timesUpTo,
} from './bundle.ts';
import { loadConfig } from './config.ts';
import { createFolder, normFolder, shownFolders } from './folders.ts';
import { heavy, PRIORITY } from './jobs.ts';
import { analysis, poster, waveform } from './media.ts';
import { cleanAuthor, cleanDisplayName } from './names.ts';
import { optionRefs } from './options.ts';
import { dataDir, inWorkspace, reviewDir, slugify, validSlug, versionsDir } from './paths.ts';
import { readPlaybook } from './playbookFiles.ts';
import { importPlaybook, refFileKey, skillFileKey, withFreshIds } from './playbooks.ts';
import { checkIncoming, isVideoContainer, probe, quickHash, sampleHash } from './probe.ts';
import { linkTarget } from './refs.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import { readTar, TarError } from './tar.ts';
import { writeTaste } from './taste.ts';
import { compareTime, isAgent, oneLine } from './time.ts';
import type { Comment, NoteRef, Playbook, ProbeResult, Review, ReviewEvent, TeamWatch } from './types.ts';
import { importViews } from './views.ts';
import { getWorkspace, roleIn } from './workspaces.ts';

/** A bundle that can't be taken: what is wrong with it, said to the person running the import. */
export class BundleError extends Error {
  status = 400;
}

export interface ImportOptions {
  file: string;
  workspace: string;
  /** The account that becomes the bundle's owner (its address). */
  owner: string;
  /** Other people: "Name=email,…", each an account in the workspace. */
  people?: string;
  dryRun?: boolean;
  /** Queue posters, waveforms and loudness for the imported videos (default true). */
  derive?: boolean;
  log?: (line: string) => void;
}

export interface ReviewPlan {
  key: string;
  name: string;
  folder: string | null;
  slug: string;
  action: 'import' | 'resume' | 'skip';
  why?: string;
  versions: number;
  missing_versions: number;
  notes: number;
  replies: number;
  files: number;
  bytes: number;
  /** Note ids this workspace had already: given new ones. */
  renamed: Record<string, string>;
}

export interface ImportReport {
  bundle: { id: string; created: string; app: string };
  workspace: string;
  owner: { email: string; name: string };
  dry_run: boolean;
  reviews: ReviewPlan[];
  folders: { name: string; action: 'create' | 'there' | 'skip'; why?: string }[];
  playbooks: { scope: string; action: 'import' | 'skip'; why?: string }[];
  events: { append: number; there: number };
  people: { name: string; to: string }[];
  taste: string[];
  derive: number;
  bytes: number;
  warnings: string[];
}

interface Read {
  manifest: BundleManifest;
  reviews: Map<string, BundleReview>;
  views: Map<string, Record<string, TeamWatch>>;
  playbooks: Map<string, BundlePlaybook>;
  folders: string[];
  events: BundleEvent[];
  /** Files the bundle places (not its JSON), by tar name. */
  files: Map<string, { size: number; sha256: string; part: BundlePart }>;
  /** Bytes of its records together (review.json, views, playbooks, folders, events): what the import writes of them, at most. */
  records: number;
}

const JSON_KINDS = new Set(['review', 'views', 'playbook', 'folders', 'events']);
const CONTENT_TYPE: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.m4a': 'audio/mp4',
  '.mov': 'video/quicktime',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
};

// where a record is wrong, on one line: its keys are the bundle's own (a record key may hold anything)
const issue = (e: { issues: { path: PropertyKey[]; message: string }[] }): string => {
  const i = e.issues[0];
  return i ? oneLine(`${i.path.map((p) => String(p).slice(0, 80)).join('.') || '(top)'}: ${i.message}`) : 'invalid';
};

async function collect(chunks: AsyncIterable<Buffer>, hash: crypto.Hash, keep: boolean): Promise<Buffer | null> {
  const parts: Buffer[] = [];
  for await (const c of chunks) {
    hash.update(c);
    if (keep) parts.push(c);
  }
  return keep ? Buffer.concat(parts) : null;
}

/** The first bytes of a file say what it is: a picture, a sound or a video named so has to be one. */
function looksLike(file: string, ext: string): boolean {
  const head = Buffer.alloc(12);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, 12, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (ext === '.png') return head.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (ext === '.jpg') return head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff;
  if (ext === '.webp') return head.subarray(0, 4).toString('latin1') === 'RIFF' && head.subarray(8, 12).toString('latin1') === 'WEBP';
  if (ext === '.mp4' || ext === '.m4a') return head.subarray(4, 8).toString('latin1') === 'ftyp';
  return false;
}

/** What `/@uploads/<folder>/(~<n>/)<name>` names, or null for any other shape (paths of a machine never come in). */
function uploadShape(r: BundleReview): string | null {
  let name: string;
  let folder: string | null;
  try {
    name = store.uploadName(r.source.name);
    folder = store.uploadFolder(r.folder);
  } catch {
    return null;
  }
  if (name !== r.source.name || folder !== r.folder) return null;
  const base = store.uploadVideoPath(folder, '');
  if (!r.video.startsWith(base)) return null;
  const rest = r.video.slice(base.length);
  if (rest !== name && !new RegExp(`^~[2-9]\\d{0,3}/${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`).test(rest)) return null;
  const slug = slugify(r.video);
  return validSlug(slug) && store.isUploadSlug(slug) ? slug : null;
}

// ------------------------------------------------------------------------------------------------ the first read

/** Reads a bundle and checks all of it; throws a BundleError (or TarError) on the first thing that isn't right. */
export async function readBundle(file: string, versionBytes: number): Promise<Read> {
  let manifest: BundleManifest | null = null;
  const expected = new Map<string, { size: number; sha256: string; part: BundlePart }>();
  const seen = new Set<string>();
  const texts = new Map<string, Buffer>();
  let held = 0;
  try {
    fs.accessSync(file, fs.constants.R_OK);
  } catch {
    throw new BundleError(`can't read ${file}`);
  }
  const st = fs.lstatSync(file);
  if (!st.isFile()) throw new BundleError(`${file} is not a plain file`);
  await readTar(file, { entries: BUNDLE_LIMITS.files + 4, maxSize: (n) => partLimit(bundlePart(n), versionBytes) }, async (entry, chunks) => {
    const part = bundlePart(entry.name);
    if (!part) throw new BundleError(`${entry.name}: not a file a bundle holds`);
    if (!manifest) {
      if (part.kind !== 'manifest') throw new BundleError('not a bundle: its first file must be manifest.json');
      const buf = (await collect(chunks, crypto.createHash('sha256'), true)) as Buffer;
      let raw: unknown;
      try {
        raw = JSON.parse(buf.toString('utf8'));
      } catch {
        throw new BundleError('manifest.json is not JSON');
      }
      const head = raw as { format?: unknown; version?: unknown } | null;
      if (head?.format !== BUNDLE_FORMAT) throw new BundleError('not a Lampo bundle (made by vr export)');
      if (head.version !== BUNDLE_VERSION)
        throw new BundleError(`a bundle of format ${String(head.version)}: this Lampo reads format ${BUNDLE_VERSION} (update it)`);
      // made no later than now (and a little drift)
      const m = timesUpTo(Date.now() + BUNDLE_CLOCK_SKEW_MS, () => BundleManifest.safeParse(raw));
      if (!m.success) throw new BundleError(`manifest.json: ${issue(m.error)}`);
      manifest = m.data;
      for (const f of manifest.files) {
        const p = bundlePart(f.path);
        if (!p || p.kind === 'manifest') throw new BundleError(`the manifest lists ${f.path}, not a file a bundle holds`);
        if (expected.has(f.path)) throw new BundleError(`the manifest lists ${f.path} twice`);
        if (f.size > partLimit(p, versionBytes)) throw new BundleError(`${f.path} is ${f.size} bytes, more than such a file may be`);
        expected.set(f.path, { size: f.size, sha256: f.sha256, part: p });
      }
      return;
    }
    const want = expected.get(entry.name);
    if (!want) throw new BundleError(`${entry.name} is in the archive but not in its manifest`);
    if (want.size !== entry.size) throw new BundleError(`${entry.name} is ${entry.size} bytes, its manifest says ${want.size}`);
    // the records are kept to be parsed once every file is checked: together no more than BUNDLE_LIMITS.records
    if (JSON_KINDS.has(part.kind)) held += entry.size;
    if (held > BUNDLE_LIMITS.records) throw new BundleError(`the bundle's records are more than ${BUNDLE_LIMITS.records / 1024 / 1024} MB together`);
    const h = crypto.createHash('sha256');
    const buf = await collect(chunks, h, JSON_KINDS.has(part.kind));
    if (h.digest('hex') !== want.sha256) throw new BundleError(`${entry.name} doesn't match its checksum: the bundle is damaged or was changed`);
    if (buf) texts.set(entry.name, buf);
    seen.add(entry.name);
  });
  if (!manifest) throw new BundleError('an empty archive');
  const m = manifest as BundleManifest;
  for (const name of expected.keys()) if (!seen.has(name)) throw new BundleError(`the manifest lists ${name}, the archive doesn't hold it`);

  const parseJson = (name: string): unknown => {
    try {
      return JSON.parse((texts.get(name) as Buffer).toString('utf8'));
    } catch {
      throw new BundleError(`${name} is not JSON`);
    }
  };
  const out: Read = { manifest: m, reviews: new Map(), views: new Map(), playbooks: new Map(), folders: [], events: [], files: new Map(), records: held };
  // Every time a record or an event holds happened before the bundle was made (and before now): sweep 2 SW-1.
  const made = Date.parse(m.created);
  const ceiling = Math.min(Number.isNaN(made) ? Date.now() : made, Date.now()) + BUNDLE_CLOCK_SKEW_MS;
  timesUpTo(ceiling, () => {
    for (const [name, f] of expected) {
      const part = f.part;
      if (part.kind === 'review') {
        const r = BundleReview.safeParse(parseJson(name));
        if (!r.success) throw new BundleError(`${name}: ${issue(r.error)}`);
        out.reviews.set(part.key, r.data);
      } else if (part.kind === 'views') {
        const v = BundleViews.safeParse(parseJson(name));
        if (!v.success) throw new BundleError(`${name}: ${issue(v.error)}`);
        out.views.set(part.key, v.data.viewers as Record<string, TeamWatch>);
      } else if (part.kind === 'playbook') {
        const p = BundlePlaybook.safeParse(parseJson(name));
        if (!p.success) throw new BundleError(`${name}: ${issue(p.error)}`);
        out.playbooks.set(part.key, p.data);
      } else if (part.kind === 'folders') {
        const p = BundleFolders.safeParse(parseJson(name));
        if (!p.success) throw new BundleError(`${name}: ${issue(p.error)}`);
        out.folders = p.data.folders;
      } else if (part.kind === 'events') {
        const lines = (texts.get(name) as Buffer).toString('utf8').split('\n');
        if (lines.length > BUNDLE_LIMITS.eventLines + 1) throw new BundleError(`events.jsonl holds more than ${BUNDLE_LIMITS.eventLines} events`);
        lines.forEach((line, i) => {
          if (!line.trim()) return;
          let raw: unknown;
          try {
            raw = JSON.parse(line);
          } catch {
            throw new BundleError(`events.jsonl line ${i + 1} is not JSON`);
          }
          const e = BundleEvent.safeParse(raw);
          if (!e.success) throw new BundleError(`events.jsonl line ${i + 1}: ${issue(e.error)}`);
          out.events.push(e.data);
        });
      } else out.files.set(name, f);
    }
  });
  if (out.reviews.size > BUNDLE_LIMITS.reviews) throw new BundleError(`more than ${BUNDLE_LIMITS.reviews} videos`);
  if (m.counts.reviews !== out.reviews.size) throw new BundleError(`the manifest counts ${m.counts.reviews} videos, the bundle holds ${out.reviews.size}`);

  // Every file belongs to a review (or playbook) that names it, every review to a video id of its own.
  const people = new Set(['owner', ...m.people.map((p) => p.key)]);
  const slugs = new Map<string, string>();
  for (const [key, r] of out.reviews) {
    const slug = uploadShape(r);
    if (!slug) throw new BundleError(`reviews/${key}: its video ${JSON.stringify(r.video).slice(0, 120)} is not an upload's (a path of another machine?)`);
    if ([...slugs.values()].includes(slug)) throw new BundleError(`reviews/${key}: two videos with the id ${slug}`);
    slugs.set(key, slug);
    for (const id of personIds(r)) if (!people.has(id)) throw new BundleError(`reviews/${key}: names ${id}, whom the manifest doesn't`);
    const ids = new Set<string>();
    for (const c of r.comments) {
      if (ids.has(c.id)) throw new BundleError(`reviews/${key}: the note ${c.id} twice`);
      ids.add(c.id);
    }
  }
  for (const key of out.views.keys()) if (!out.reviews.has(key)) throw new BundleError(`reviews/${key}/views.json without its review`);
  for (const [name, f] of out.files) {
    const p = f.part;
    if (p.kind === 'skillFile' || p.kind === 'playbookRef') {
      const book = out.playbooks.get(p.key);
      const named =
        p.kind === 'skillFile'
          ? book?.skills.some((s) => s.id === p.skill && s.files.some((x) => x.name === p.name))
          : book?.refs.some((r) => store.refFiles(r as NoteRef).includes(p.name));
      if (!named) throw new BundleError(`${name}: a file its playbook doesn't name`);
      continue;
    }
    if (!('key' in p)) continue;
    const r = out.reviews.get(p.key);
    if (!r) throw new BundleError(`${name}: a file of a review the bundle doesn't hold`);
    const named =
      p.kind === 'file'
        ? r.comments.some((c) => [c.shots?.clean, c.shots?.marked, c.shots?.range, c.voice?.file].includes(p.name))
        : p.kind === 'ref'
          ? r.comments.some((c) =>
              [...(c.refs || []), ...optionRefs(c.options as Comment['options'])].some((x) => store.refFiles(x as NoteRef).includes(p.name)),
            )
          : p.kind === 'preview'
            ? r.comments.some((c) => c.previews?.some((x) => x.file === p.name))
            : p.kind === 'version'
              ? r.versions.some((v) => v.v === p.v) &&
                path.extname(p.name).toLowerCase() === path.extname(r.video).toLowerCase() &&
                p.name === `v${p.v}${path.extname(r.video)}`
              : false;
    if (!named) throw new BundleError(`${name}: a file its review doesn't name`);
  }
  const videoOf = new Map([...out.reviews].map(([key, r]) => [slugs.get(key) as string, r.video]));
  for (const [i, e] of out.events.entries()) {
    if (videoOf.get(e.slug) !== e.video) throw new BundleError(`events.jsonl line ${i + 1}: about a video the bundle doesn't hold`);
  }
  // A link reference is kept as the app keeps one it makes (lib/refs.ts linkTarget): http(s), no credentials.
  const links = (where: string, refs: { id?: string; kind: string; url?: string; site?: string }[]) => {
    for (const x of refs) {
      if (x.kind !== 'link') continue;
      try {
        Object.assign(x, linkTarget(x.url ?? ''));
      } catch (e) {
        throw new BundleError(`${where}: the link reference ${x.id ?? ''}: ${(e as Error).message}`);
      }
    }
  };
  for (const [key, r] of out.reviews) for (const c of r.comments) links(`reviews/${key}`, [...(c.refs || []), ...optionRefs(c.options as Comment['options'])]);
  for (const [key, p] of out.playbooks) links(`playbooks/${key}`, p.refs);
  for (const [i, e] of out.events.entries()) if (e.ref) links(`events.jsonl line ${i + 1}`, [e.ref]);
  for (const [key, p] of out.playbooks) {
    for (const id of p.refs.map((x) => x.by_id).filter(Boolean))
      if (!people.has(id as string)) throw new BundleError(`playbooks/${key}: names ${id}, whom the manifest doesn't`);
    if (new Set(p.skills.map((s) => s.id)).size !== p.skills.length) throw new BundleError(`playbooks/${key}: two skills with one id`);
  }
  return out;
}

/** The people (`owner`, `person:<n>`) a review names by account. */
function personIds(r: BundleReview): string[] {
  const out: (string | undefined)[] = [r.added_by_id];
  for (const c of r.comments) {
    out.push(c.author_id);
    for (const rp of c.replies) out.push(rp.by_id);
    for (const ref of [...(c.refs || []), ...optionRefs(c.options as Comment['options'])]) out.push(ref.by_id);
  }
  return out.filter((x): x is string => !!x);
}

// ------------------------------------------------------------------------------------------------ people

const norm = (name: string): string => cleanDisplayName(name).toLowerCase();

interface People {
  /** A name and the account it was written with, as this workspace keeps them. */
  map(name: string, id?: string): { name: string; id?: string };
  lines: { name: string; to: string }[];
}

function peopleFor(read: Read, owner: User, ws: string, given: string | undefined): People {
  const byName = new Map<string, User>();
  for (const pair of (given ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)) {
    const at = pair.lastIndexOf('=');
    const name = pair.slice(0, at).trim();
    const email = pair.slice(at + 1).trim();
    if (at < 1 || !name || !email) throw new BundleError(`--people takes "Name=email,…": not ${JSON.stringify(pair).slice(0, 80)}`);
    const u = findUserByEmail(email);
    if (!u || !roleIn(ws, u.id)) throw new BundleError(`--people: ${email} is not a member of workspace ${ws}`);
    byName.set(norm(name), u);
  }
  const ownerNames = new Set(read.manifest.owner.names.map(norm));
  const byKey = new Map<string, User>();
  for (const p of read.manifest.people) {
    const u = byName.get(norm(p.name)) ?? (ownerNames.has(norm(p.name)) ? owner : undefined);
    if (u) byKey.set(p.key, u);
  }
  const lines = new Map<string, string>();
  const as = (u: User) => `${u.name} <${u.email}>${u.id === owner.id ? ' (the owner)' : ''}`;
  return {
    map(name, id) {
      const shown = cleanAuthor(name) || 'unnamed';
      // the store's own doing (a render registered from the disk): nobody's
      if (shown === 'system' && !id) return { name: shown };
      const account = id === 'owner' ? owner : id ? byKey.get(id) : undefined;
      if (isAgent(shown) || shown.startsWith('guest:')) {
        lines.set(shown, isAgent(shown) ? 'stays an agent' : 'stays a client of a review link (a name, no account)');
        return { name: shown };
      }
      // an account of the other store that --people didn't name stays a name, whatever name it shares with someone here
      const u = id ? account : ownerNames.has(norm(shown)) ? owner : byName.get(norm(shown));
      if (u) {
        lines.set(shown, `→ ${as(u)}`);
        return { name: u.name, id: u.id };
      }
      lines.set(shown, 'stays a name (no account here: --people "Name=email" gives it one)');
      return { name: shown };
    },
    get lines() {
      return [...lines].map(([name, to]) => ({ name, to })).sort((a, b) => a.name.localeCompare(b.name));
    },
  };
}

/** A review from the bundle as this workspace will hold it: people mapped, note ids renamed, the storage kind set. */
function toStored(b: BundleReview, people: People, renamed: Record<string, string>, placed: Set<number>, kind: string): Review {
  const r = structuredClone(b) as unknown as Review;
  const who = (name: string, id?: string) => people.map(name, id);
  const added = who(r.added_by, r.added_by_id);
  r.added_by = added.name;
  if (added.id) r.added_by_id = added.id;
  else delete r.added_by_id;
  if (r.session) r.session = { ...r.session, by: who(r.session.by).name, name: cleanAuthor(r.session.name) || 'agent' };
  for (const v of r.versions) {
    if (v.by) v.by = who(v.by).name;
    // kept in a bucket only when this import put its bytes there (a version without bytes is in none)
    if (placed.has(v.v) && kind !== 'local') v.stored = kind as 'bunny' | 's3';
    else delete v.stored;
  }
  const ref = (x: NoteRef) => {
    const m = who(x.by, x.by_id);
    x.by = m.name;
    if (m.id) x.by_id = m.id;
    else delete x.by_id;
  };
  const rename = (f: string) => f.replace(/^c_[a-f0-9]+/, (id) => renamed[id] ?? id);
  for (const c of r.comments) {
    const a = who(c.author, c.author_id);
    c.author = a.name;
    if (a.id) c.author_id = a.id;
    else delete c.author_id;
    if (renamed[c.id]) {
      c.id = renamed[c.id] as string;
      if (c.shots) c.shots = { clean: rename(c.shots.clean), marked: rename(c.shots.marked), ...(c.shots.range ? { range: rename(c.shots.range) } : {}) };
      if (c.voice) c.voice = { ...c.voice, file: rename(c.voice.file) };
    }
    for (const rp of c.replies) {
      const m = who(rp.by, rp.by_id);
      rp.by = m.name;
      if (m.id) rp.by_id = m.id;
      else delete rp.by_id;
    }
    for (const x of c.refs || []) ref(x);
    for (const x of optionRefs(c.options)) ref(x);
    for (const p of c.previews || []) p.by = who(p.by).name;
  }
  for (const a of r.approvals || []) a.by = who(a.by).name;
  if (r.approval) r.approval = { ...r.approval, by: who(r.approval.by).name };
  if (r.final) r.final = { ...r.final, by: who(r.final.by).name };
  for (const f of r.finals || []) f.by = who(f.by).name;
  return r;
}

// ------------------------------------------------------------------------------------------------ the import

export async function importBundle(o: ImportOptions): Promise<ImportReport> {
  const log = o.log ?? (() => {});
  const cfg = loadConfig();
  if (!getWorkspace(o.workspace)) throw new BundleError(`no workspace ${o.workspace} (vr admin workspaces lists them)`);
  const owner = findUserByEmail(o.owner);
  if (!owner || !roleIn(o.workspace, owner.id)) throw new BundleError(`${o.owner} is not a member of workspace ${o.workspace}`);
  log(`checking ${path.basename(o.file)} …`);
  let read: Read;
  try {
    read = await readBundle(o.file, cfg.upload_max_bytes);
  } catch (e) {
    if (e instanceof TarError) throw new BundleError(e.message);
    throw e;
  }
  return inWorkspace(o.workspace, async () => {
    // one import into a workspace at a time: then a video id another bundle marked is what a killed run left (SW-7)
    const release = o.dryRun ? null : store.holdImport();
    try {
      return await run(o, read, owner, log);
    } finally {
      release?.();
    }
  });
}

async function run(o: ImportOptions, read: Read, owner: User, log: (line: string) => void): Promise<ImportReport> {
  const { manifest } = read;
  const bundle = manifest.id;
  const warnings: string[] = [];
  const people = peopleFor(read, owner, o.workspace, o.people);
  const kind = storage().kind;

  // ---------------------------------------------------------------- what a killed run of another bundle left
  // Its marked folders, with renders nothing lists, are taken back (this bundle's are carried on: `resume`).
  const left = store.unfinishedImports().filter((x) => x.bundle !== bundle);
  if (left.length) {
    if (!o.dryRun) for (const x of left) await store.dropUnfinishedImport(x.slug, x.bundle);
    const from = [...new Set(left.map((x) => x.bundle))].join(', ');
    warnings.push(
      `${left.length} video id${left.length === 1 ? '' : 's'} held what an unfinished import left (${from}): ${o.dryRun ? 'the import takes it back' : 'taken back'}`,
    );
  }
  const leftover = new Set(o.dryRun ? left.map((x) => x.slug) : []);

  // ---------------------------------------------------------------- the plan
  const here = store.listReviews();
  const ids = new Set([...here.flatMap((r) => r.comments.map((c) => c.id)), ...listAsks().map((a) => a.id)]);
  const plans: ReviewPlan[] = [];
  const stored = new Map<string, Review>();
  // A video this bundle put in before: its notes' ids as they were stored (an id taken in the workspace got a new one),
  // matched by place and text, for history a run that was killed before writing it still owes (below).
  const putInBefore = new Map<string, Record<string, string>>();
  for (const [key, b] of [...read.reviews].sort(([a], [b2]) => a.localeCompare(b2))) {
    const slug = uploadShape(b) as string;
    const files = [...read.files].filter(([, f]) => 'key' in f.part && f.part.key === key && f.part.kind !== 'skillFile' && f.part.kind !== 'playbookRef');
    const versions = files.filter(([, f]) => f.part.kind === 'version');
    const plan: ReviewPlan = {
      key,
      name: b.source.name,
      folder: b.folder,
      slug,
      action: 'import',
      versions: versions.length,
      missing_versions: b.versions.length - versions.length,
      notes: b.comments.length,
      replies: b.comments.reduce((n, c) => n + c.replies.length, 0),
      files: files.length - versions.length,
      bytes: files.reduce((n, [, f]) => n + f.size, 0),
      renamed: {},
    };
    const has = here.find((r) => slugify(r.video) === slug);
    const mark = store.importingFrom(slug);
    if (has) {
      plan.action = 'skip';
      plan.why = has.id && has.id === b.id ? 'this workspace has it already (imported before)' : 'this workspace has another video with this id';
      if (has.id && has.id === b.id) {
        const renamed: Record<string, string> = {};
        b.comments.forEach((c, i) => {
          const now = has.comments[i];
          if (now && now.id !== c.id && now.text === c.text) renamed[c.id] = now.id;
        });
        putInBefore.set(slug, renamed);
      }
    } else if (mark === bundle) plan.action = 'resume';
    else if (!leftover.has(slug) && (fs.existsSync(reviewDir(slug)) || fs.existsSync(path.join(versionsDir(), slug)))) {
      plan.action = 'skip';
      plan.why = mark ? 'another import is filling this video id' : 'this workspace has files under this video id';
    }
    if (plan.action !== 'skip') {
      for (const c of b.comments) {
        if (!ids.has(c.id)) {
          ids.add(c.id);
          continue;
        }
        let id = store.reservedCommentId();
        while (ids.has(id)) id = store.reservedCommentId();
        ids.add(id);
        plan.renamed[c.id] = id;
      }
      const placed = new Set(versions.map(([, f]) => (f.part as { v: number }).v));
      stored.set(key, toStored(b, people, plan.renamed, placed, kind));
    }
    plans.push(plan);
  }
  const going = plans.filter((p) => p.action !== 'skip');
  const goingKeys = new Set(going.map((p) => p.key));

  const folders: ImportReport['folders'] = [];
  const known = new Set(shownFolders().folders);
  const wantFolders = [...new Set([...read.folders, ...going.map((p) => p.folder).filter((f): f is string => !!f)])].sort();
  for (const f of wantFolders) {
    let name: string | null = null;
    try {
      name = normFolder(f);
    } catch (e) {
      folders.push({ name: f, action: 'skip', why: (e as Error).message });
      continue;
    }
    if (!name || name !== f) folders.push({ name: f, action: 'skip', why: 'not a folder name this server takes' });
    else folders.push({ name: f, action: known.has(f) ? 'there' : 'create' });
  }

  const books: ImportReport['playbooks'] = [];
  // What comes in gets ids of this workspace (its files land under them, never under an id it holds: SW-2).
  const booksIn = new Map<string, { book: BundlePlaybook; fresh: BundlePlaybook; skills: Map<string, string> }>();
  for (const [key, p] of [...read.playbooks].sort(([a], [b2]) => a.localeCompare(b2))) {
    const scope = p.scope;
    // the House, or a folder name as the app makes one (normFolder: cleaned, within the limits on folders)
    let named: string | null = null;
    try {
      named = scope === '' ? '' : normFolder(scope);
    } catch {}
    if (named !== scope) books.push({ scope, action: 'skip', why: 'not a folder name this server takes' });
    else if (readPlaybook(scope)) books.push({ scope, action: 'skip', why: 'this workspace has a playbook there already' });
    else if ([...booksIn.values()].some((x) => x.book.scope === scope)) books.push({ scope, action: 'skip', why: 'the bundle has another playbook there' });
    else {
      books.push({ scope, action: 'import' });
      const { playbook, skills } = withFreshIds(p);
      booksIn.set(key, { book: p, fresh: playbook, skills });
    }
  }

  const already = store.historyFrom(bundle);
  const slugOfKey = new Map(plans.map((p) => [p.key, p.slug]));
  const goingSlugs = new Set(going.map((p) => p.slug));
  // A video's history is appended once the video is in: a run killed in between left a video without it, and the next
  // run (which skips the video) appends it. Never for a video any import brought history for already.
  const anyHistory = store.historyFrom();
  const owed = new Map([...putInBefore].filter(([slug]) => !anyHistory.has(slug)));
  const events = read.events.filter((e) => (goingSlugs.has(e.slug) && !already.has(e.slug)) || owed.has(e.slug));
  const there = read.events.filter((e) => goingSlugs.has(e.slug) && already.has(e.slug)).length;
  // the files, and the records written as reviews, views, playbooks and history (SW-8: they were left out)
  const bytes =
    going.reduce((n, p) => n + p.bytes, 0) +
    [...read.files.values()].filter((f) => f.part.kind === 'skillFile' || f.part.kind === 'playbookRef').reduce((n, f) => n + f.size, 0) +
    read.records;
  if (manifest.left_out.missing_versions.length)
    warnings.push(
      `${manifest.left_out.missing_versions.length} version(s) came without their bytes (gone on the machine they came from): their notes come along, the video can't play`,
    );

  const report: ImportReport = {
    bundle: { id: bundle, created: manifest.created, app: manifest.app.version },
    workspace: o.workspace,
    owner: { email: owner.email, name: owner.name },
    dry_run: !!o.dryRun,
    reviews: plans,
    folders,
    playbooks: books,
    events: { append: events.length, there },
    people: [],
    taste: manifest.taste,
    derive: o.derive === false ? 0 : going.length,
    bytes,
    warnings,
  };
  // every name the bundle holds, mapped once so the plan can say what becomes of it
  for (const e of read.events) people.map(e.by);
  for (const p of read.playbooks.values()) for (const n of [p.by, ...p.history.map((h) => h.by)]) if (n) people.map(n);
  report.people = people.lines;

  // ---------------------------------------------------------------- room on the disk (VR_MIN_FREE stays free)
  // renders go to versions/ (a bucket's through the working folder), records to data/: the fuller disk decides
  const keepFree = loadConfig().min_free_bytes ?? 2e9;
  const free = Math.min(freeBytes(kind === 'local' ? versionsDir() : os.tmpdir()), freeBytes(dataDir()));
  const room =
    bytes + keepFree > free
      ? `the import writes ${(bytes / 1e9).toFixed(2)} GB and keeps ${(keepFree / 1e9).toFixed(1)} GB free: the disk has ${(free / 1e9).toFixed(2)} GB`
      : null;
  if (o.dryRun) {
    if (room) warnings.push(`it won't fit: ${room}`);
    return report;
  }
  if (room) throw new BundleError(room);

  // ---------------------------------------------------------------- the second read: placing what was checked
  // Each video id is marked under its upload hold, checked free again then (claimForImport); one taken meanwhile stops
  // the import before a byte is written, and what it marked is taken back.
  const claimed: string[] = [];
  for (const p of going) {
    const why = store.claimForImport(p.slug, bundle);
    if (why) {
      for (const s of claimed) await store.dropUnfinishedImport(s, bundle).catch(() => {});
      throw new BundleError(`${p.slug}: ${why}; nothing was imported: run the import again`);
    }
    claimed.push(p.slug);
  }
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-import-'));
  const placedFiles = new Set<string>();
  // What ffprobe read of each placed version, and its bytes' sample (review key → version number): what its record
  // says, as for an upload.
  const probes = new Map<string, Map<number, Placed>>();
  // A playbook's files wait here, checked, until the reviews are in: a refused import leaves none behind.
  const staged: Staged[] = [];
  try {
    try {
      let done = 0;
      await readTar(
        o.file,
        { entries: BUNDLE_LIMITS.files + 4, maxSize: (n) => partLimit(bundlePart(n), loadConfig().upload_max_bytes) },
        async (entry, chunks) => {
          const want = read.files.get(entry.name);
          if (!want) return;
          const p = want.part;
          const forReview = 'key' in p && (p.kind === 'file' || p.kind === 'ref' || p.kind === 'preview' || p.kind === 'version') && goingKeys.has(p.key);
          const forBook = (p.kind === 'skillFile' || p.kind === 'playbookRef') && booksIn.has(p.key);
          if (!forReview && !forBook) return;
          if (entry.size !== want.size) throw new BundleError(`${entry.name} changed since it was checked`);
          const tmp = path.join(work, `f${done++}${path.extname(entry.name)}`);
          const h = crypto.createHash('sha256');
          const fh = await fs.promises.open(tmp, 'w', 0o600);
          try {
            for await (const c of chunks) {
              h.update(c);
              await fh.write(c);
            }
          } finally {
            await fh.close();
          }
          if (h.digest('hex') !== want.sha256) throw new BundleError(`${entry.name} changed since it was checked`);
          if (p.kind === 'skillFile' || p.kind === 'playbookRef') staged.push(stage(p, tmp, entry.name, booksIn));
          else await place(p, tmp, entry.name, stored, slugOfKey, plans, probes);
          placedFiles.add(entry.name);
          if (p.kind === 'version') log(`  ${entry.name} (${(entry.size / 1e6).toFixed(1)} MB)`);
        },
      );
      for (const [name, f] of read.files) {
        const p = f.part;
        const needed =
          ('key' in p && goingKeys.has(p.key) && p.kind !== 'skillFile' && p.kind !== 'playbookRef') ||
          ((p.kind === 'skillFile' || p.kind === 'playbookRef') && booksIn.has(p.key));
        if (needed && !placedFiles.has(name)) throw new BundleError(`${name} wasn't in the archive the second time it was read`);
      }
      for (const [key, r] of stored) settle(r, probes.get(key) ?? new Map());

      // ---------------------------------------------------------------- the reviews, then their history
      const renamedOf = new Map([...owed, ...going.map((p) => [p.slug, p.renamed] as const)]);
      const history: ReviewEvent[] = events
        .map((e) => {
          const x = structuredClone(e) as ReviewEvent;
          const renamed = renamedOf.get(e.slug) ?? {};
          if (x.id && renamed[x.id]) x.id = renamed[x.id];
          x.by = people.map(x.by).name;
          if (x.session) x.session = cleanAuthor(x.session) || null;
          if (x.reply) x.reply = { ...x.reply, by: people.map(x.reply.by).name };
          if (x.ref) x.ref = { ...x.ref, by: people.map(x.ref.by).name };
          const abs = (f: string | null | undefined) =>
            f
              ? path.join(
                  reviewDir(e.slug),
                  f.replace(/^c_[a-f0-9]+/, (id) => renamed[id] ?? id),
                )
              : null;
          if (x.shots) x.shots = { clean: abs(x.shots.clean), marked: abs(x.shots.marked), ...(x.shots.range ? { range: abs(x.shots.range) } : {}) };
          return x;
        })
        .sort((a, b) => compareTime(a.at, b.at));
      // A video's history goes into the log once the video is in, never before: a video that doesn't come in leaves
      // none behind for whatever takes its id later (SW-7).
      const committed = new Set<string>(owed.keys());
      try {
        for (const p of going) {
          const r = stored.get(p.key) as Review;
          const views = read.views.get(p.key);
          if (views) {
            const viewers: Record<string, TeamWatch> = {};
            for (const [k, w] of Object.entries(views)) {
              const m = k === 'owner' || PERSON.test(k) ? people.map(w.name, k) : { name: w.name };
              viewers[m.id ?? `imported:${k}`] = { ...w, name: m.name };
            }
            importViews(p.slug, viewers);
          }
          store.importReview(r);
          committed.add(p.slug);
        }
      } finally {
        store.appendHistory(
          history.filter((e) => committed.has(e.slug)),
          bundle,
        );
      }
    } catch (e) {
      for (const p of going) await store.dropUnfinishedImport(p.slug, bundle).catch(() => {});
      throw e;
    }

    // ---------------------------------------------------------------- folders, playbooks, taste
    for (const f of folders)
      if (f.action === 'create')
        try {
          createFolder(f.name);
        } catch (e) {
          warnings.push(`folder ${f.name}: ${(e as Error).message}`);
        }
    // A playbook's files go in now the reviews have, each under a key nothing holds; a playbook that can't be written
    // takes its files back.
    for (const [key, { book: p, fresh }] of booksIn) {
      const b: Playbook = structuredClone(fresh) as unknown as Playbook;
      b.by = b.by ? people.map(b.by).name : null;
      for (const s of b.skills) {
        s.by = people.map(s.by).name;
        for (const f of s.files) f.by = people.map(f.by).name;
      }
      for (const r of b.refs) {
        const m = people.map(r.by, r.by_id);
        r.by = m.name;
        if (m.id) r.by_id = m.id;
        else delete r.by_id;
      }
      for (const h of b.history) {
        h.by = people.map(h.by).name;
        if (h.accepted_by) h.accepted_by = people.map(h.accepted_by).name;
      }
      const renamed = Object.assign({}, ...going.map((x) => x.renamed)) as Record<string, string>;
      for (const x of b.proposals) {
        x.by = people.map(x.by).name;
        if (x.decided_by) x.decided_by = people.map(x.decided_by).name;
        x.evidence = x.evidence.map((id) => renamed[id] ?? id);
      }
      const placed: string[] = [];
      try {
        for (const f of staged.filter((x) => x.book === key)) {
          if (storage().has(f.key)) throw new BundleError(`a file is kept under ${f.key} already: nothing is written over`);
          await storage().put(f.key, f.tmp, { contentType: f.contentType });
          placed.push(f.key);
        }
        importPlaybook(b);
      } catch (e) {
        for (const k of placed)
          await storage()
            .remove(k)
            .catch(() => {});
        warnings.push(`playbook ${p.scope || 'House'}: ${(e as Error).message}`);
      }
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // A taste file is written from the notes (lib/taste.ts): again here for the whole library and for each folder the
  // bundle had one for. One for a project path of the other machine is made when an agent asks (`vr taste`).
  const folderNow = new Set(shownFolders().folders);
  for (const scope of manifest.taste)
    try {
      if (scope === 'all videos') writeTaste({});
      else if (folderNow.has(scope)) writeTaste({ folder: scope });
    } catch (e) {
      warnings.push(`taste for ${scope}: ${(e as Error).message}`);
    }

  // ---------------------------------------------------------------- what the server derives itself, as normal jobs
  if (o.derive !== false) {
    const jobs: Promise<unknown>[] = [];
    for (const p of going) {
      const review = store.loadReview(p.slug);
      const ver = review?.versions.filter((v) => store.versionAvailable(review, v.v)).at(-1);
      if (!review || !ver) continue;
      const file = () => store.ensureVersionFile(review, ver.v).then((f) => f ?? Promise.reject(new Error('gone')));
      jobs.push(heavy(() => poster(file, ver, review.meta), PRIORITY.poster, { mustRun: true }));
      jobs.push(heavy(() => waveform(file, ver), PRIORITY.analysis, { mustRun: true }));
      jobs.push(heavy(async () => analysis(await file(), ver), PRIORITY.analysis, { mustRun: true }));
    }
    if (jobs.length) log(`making posters, waveforms and loudness for ${going.length} video(s) …`);
    const results = await Promise.allSettled(jobs);
    const failed = results.filter((x) => x.status === 'rejected').length;
    if (failed) warnings.push(`${failed} of ${jobs.length} background job(s) failed: the server makes them when someone opens the video`);
  }
  return report;
}

/** Free bytes where `dir` (or the nearest folder above it that exists) lives. */
function freeBytes(dir: string): number {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    try {
      const s = fs.statfsSync(d);
      return s.bavail * s.bsize;
    } catch {
      if (path.dirname(d) === d) return Number.POSITIVE_INFINITY;
    }
  }
}

/**
 * What the store records of the versions this import placed, as registerVersion records an upload's (lib/store.ts): a
 * part shows the frames, rate and picture of the version it patches; the review describes its newest version, and its
 * stream properties are its newest full render's.
 */
function settle(r: Review, probed: Map<number, Placed>): void {
  if (!probed.size) return;
  for (const ver of r.versions) {
    const own = probed.get(ver.v);
    if (!own) continue;
    if (!ver.part) {
      // checked against the bytes when the bundle named one (place), made from them when it didn't
      ver.sample = own.sample;
      continue;
    }
    // A part's sample is made from its bytes, the version it patches and where, as ingestPart makes it (lib/store.ts
    // partSample): never the bundle's, which could name another video's renderKey and so its derived files (SW-4).
    const base = r.versions.find((x) => x.v === ver.part?.of);
    if (!base) throw new BundleError(`a part of v${ver.part.of}, which the review doesn't have`);
    ver.sample = store.partSample(own.sample, base, ver.part);
    Object.assign(ver, { fps: base.fps, width: base.width, height: base.height, duration: base.duration, frames: base.frames });
  }
  const last = r.versions.at(-1);
  if (last && probed.has(last.v)) Object.assign(r, { fps: last.fps, width: last.width, height: last.height, duration: last.duration, frames: last.frames });
  const whole = r.versions.findLast((v) => !v.part);
  const m = whole && probed.get(whole.v)?.meta;
  if (m) r.meta = { codec: m.codec, pix_fmt: m.pix_fmt, color_space: m.color_space, color_range: m.color_range, audio: m.audio };
}

/** What a placed version's bytes are: ffprobe's reading, and their sample (lib/probe.ts sampleHash). */
interface Placed {
  meta: ProbeResult;
  sample: string;
}

/** A playbook's file, checked and waiting in the import's folder: where it goes (under the playbook's new ids). */
interface Staged {
  book: string;
  key: string;
  tmp: string;
  contentType: string;
}

function stage(
  p: Extract<BundlePart, { kind: 'skillFile' | 'playbookRef' }>,
  tmp: string,
  name: string,
  booksIn: Map<string, { fresh: BundlePlaybook; skills: Map<string, string> }>,
): Staged {
  const b = booksIn.get(p.key) as { fresh: BundlePlaybook; skills: Map<string, string> };
  if (p.kind === 'skillFile')
    // served as a download only, like every skill file (lib/playbooks.ts addSkillFile)
    return { book: p.key, key: skillFileKey(b.fresh, { id: b.skills.get(p.skill) as string }, p.name), tmp, contentType: 'application/octet-stream' };
  const ext = path.extname(tmp).toLowerCase();
  if (!looksLike(tmp, ext)) throw new BundleError(`${name}: not the picture, sound or clip its name says`);
  return { book: p.key, key: refFileKey(b.fresh, p.name), tmp, contentType: CONTENT_TYPE[ext] || 'application/octet-stream' };
}

/** Puts one checked file of a review where it belongs, through the store or the storage adapter. */
async function place(
  p: BundlePart,
  tmp: string,
  name: string,
  stored: Map<string, Review>,
  slugOfKey: Map<string, string>,
  plans: ReviewPlan[],
  probes: Map<string, Map<number, Placed>>,
): Promise<void> {
  const ext = path.extname(tmp).toLowerCase();
  const type = { contentType: CONTENT_TYPE[ext] || 'application/octet-stream' };
  const picture = () => {
    if (!looksLike(tmp, ext)) throw new BundleError(`${name}: not the picture, sound or clip its name says`);
  };
  if (!('key' in p)) return;
  const slug = slugOfKey.get(p.key) as string;
  if (p.kind === 'file') {
    picture();
    const renamed = plans.find((x) => x.key === p.key)?.renamed ?? {};
    store.placeNoteFile(
      slug,
      p.name.replace(/^c_[a-f0-9]+/, (id) => renamed[id] ?? id),
      tmp,
    );
  } else if (p.kind === 'ref') {
    picture();
    await storage().put(store.refKey(slug, p.name), tmp, type);
  } else if (p.kind === 'preview') {
    picture();
    await storage().put(store.previewKey(slug, p.name), tmp, type);
  } else if (p.kind === 'version') {
    const r = stored.get(p.key) as Review;
    const ver = r.versions.find((v) => v.v === p.v);
    if (!ver) throw new BundleError(`${name}: a version its review doesn't have`);
    // the bytes are the version's: its hash (and sample) say so, as for every render the store registers
    const sample = sampleHash(tmp);
    if (quickHash(tmp) !== ver.hash || (!ver.part && ver.sample && sample !== ver.sample))
      throw new BundleError(`${name}: its bytes are not the version its review describes`);
    let meta: Awaited<ReturnType<typeof probe>>;
    try {
      meta = await probe(tmp, { incoming: true });
    } catch {
      throw new BundleError(`${name}: not a video ffmpeg can read`);
    }
    if (!isVideoContainer(meta.format)) throw new BundleError(`${name}: not a video container (${meta.format || 'unknown'})`);
    try {
      checkIncoming(meta);
    } catch (e) {
      throw new BundleError(`${name}: ${(e as Error).message}`);
    }
    // its size, frames, rate and picture as this server reads the bytes, never as the bundle says (settle, for a part)
    ver.size = fs.statSync(tmp).size;
    if (!ver.part) Object.assign(ver, { fps: meta.fps, width: meta.width, height: meta.height, duration: meta.duration, frames: meta.frames });
    const byV = probes.get(p.key) ?? new Map<number, Placed>();
    byV.set(ver.v, { meta, sample });
    probes.set(p.key, byV);
    await storage().put(store.versionKey(slug, ver.v, path.extname(r.video)), tmp, type);
  }
}
