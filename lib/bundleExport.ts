// `lampo export <out.tar> [--folder <name>]…`: this store's reviews as a bundle (lib/bundle.ts) for another store,
// typically a hosted server (docs/moving.md). It reads the store the way the app does (listReviews, the storage
// adapter, the event log) and writes nothing into it. What the bundle carries is the history people and agents made;
// what belongs to this machine stays: paths (a video tracked from a file becomes an upload, `__Users__…` →
// `__@uploads__<folder>__<name>`, everywhere it is named), the Claude Code sessions' ids and folders, review links,
// devices, push, accounts and their keys, drafts and unsent recordings, and every derived file (the server makes its
// own posters, proxies, waveforms and analysis).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { getUser, localOwner } from './auth.ts';
import {
  BUNDLE_EVENT_TYPES,
  BUNDLE_FORMAT,
  BUNDLE_VERSION,
  BundleEvent,
  BundleManifest,
  BundlePlaybook,
  BundleReview,
  BundleViews,
  bundlePath,
  MANIFEST,
  VERSION_FILE,
} from './bundle.ts';
import { loadConfig } from './config.ts';
import { folderName, shownFolders } from './folders.ts';
import { optionRefs } from './options.ts';
import { CACHE, DATA, DEV, dataDir, HOME, projectDirOf, ROOT, reviewDir, slugify, USER, VERSIONS } from './paths.ts';
import { listPlaybooks } from './playbookFiles.ts';
import { refFileKey, skillFileKey } from './playbooks.ts';
import { quickHash } from './probe.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import { openTarWriter } from './tar.ts';
import type { Comment, NoteRef, Playbook, Review, ReviewEvent } from './types.ts';
import { readViews } from './views.ts';

export interface ExportOptions {
  /** The archive to write (written over). */
  out: string;
  /** Only these folders and what is inside them (none: everything). */
  folders?: string[];
  /** Progress lines. */
  log?: (line: string) => void;
}

export interface ExportResult {
  file: string;
  bytes: number;
  manifest: BundleManifest;
  /** What a person should know: files that were gone, reviews that couldn't come along. */
  warnings: string[];
}

interface FileEntry {
  name: string;
  src: string;
}

const sha256 = (data: Buffer | string): string => crypto.createHash('sha256').update(data).digest('hex');

async function hashFile(file: string): Promise<{ sha256: string; size: number }> {
  const h = crypto.createHash('sha256');
  let size = 0;
  for await (const chunk of fs.createReadStream(file, { highWaterMark: 1 << 20 })) {
    h.update(chunk as Buffer);
    size += (chunk as Buffer).length;
  }
  return { sha256: h.digest('hex'), size };
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Absolute paths of this machine inside text (an agent's reply naming the file it rendered, an older render-source
 * line) become the file's name: the server has no business with this disk's folders. Best effort, by the roots this
 * store knows (the home folder, the store, the app, the folders videos were tracked in).
 */
function pathScrubber(roots: string[]): { scrub: (s: string) => string; count: () => number } {
  const sorted = [...new Set(roots.filter((r) => r && r !== '/' && path.isAbsolute(r)).map((r) => r.replace(/\/+$/, '')))].sort((a, b) => b.length - a.length);
  // a root where a path begins (not inside a URL or another word), then its folders and the file
  const re = sorted.length ? new RegExp(`(?<![\\w.:/-])(?:${sorted.map(escapeRe).join('|')})(?:/[^/\\n"]*)*`, 'g') : null;
  let n = 0;
  return {
    scrub: (s) =>
      re && s.includes('/')
        ? s.replace(re, (m) => {
            n++;
            return path.basename(m) || '~';
          })
        : s,
    count: () => n,
  };
}

/** Every string inside `value`, through `fn` (a deep copy; the store's object is never touched). */
function mapStrings<T>(value: T, fn: (s: string) => string): T {
  if (typeof value === 'string') return fn(value) as T;
  if (Array.isArray(value)) return value.map((x) => mapStrings(x, fn)) as T;
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, mapStrings(v, fn)])) as T;
  return value;
}

const appVersion = (): string => {
  try {
    return String(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version || '');
  } catch {
    return '';
  }
};

const problemOf = (e: { issues: { path: PropertyKey[]; message: string }[] }): string => {
  const i = e.issues[0];
  return i ? `${i.path.map(String).join('.') || '(top)'}: ${i.message}` : 'invalid';
};

export async function exportBundle(o: ExportOptions): Promise<ExportResult> {
  const log = o.log ?? (() => {});
  const warnings: string[] = [];
  const out = path.resolve(o.out);

  // ------------------------------------------------------------------ what goes
  const known = shownFolders().folders;
  const wanted = (o.folders ?? []).map((f) => folderName(f)).filter((f): f is string => !!f);
  for (const w of wanted) if (!known.includes(w)) throw new Error(`there is no folder "${w}" (lampo folders lists them)`);
  const inside = (f: string | null | undefined) => !wanted.length || (!!f && wanted.some((w) => f === w || f.startsWith(`${w}/`)));
  const above = (f: string) => wanted.some((w) => w.startsWith(`${f}/`));

  const all = store.listReviews();
  const samples = all.filter((r) => r.onboarding_sample).length;
  const reviews = all
    .filter((r) => !r.onboarding_sample && inside(r.folder))
    .map((r) => structuredClone(r) as Review)
    .sort((a, b) => slugify(a.video).localeCompare(slugify(b.video)));

  // ------------------------------------------------------------------ people
  // The machine's owner (and the names `lampo` and the app wrote under) becomes the --owner account on the server. A hosted
  // store has no such one: every account there travels as a person of its own.
  const owner = loadConfig().mode === 'server' ? null : localOwner();
  const ownerNames = new Set<string>();
  if (owner) {
    ownerNames.add(owner.name);
    ownerNames.add(USER);
  }
  const people = new Map<string, { key: string; name: string }>();
  const personOf = (id: string | undefined, name: string): string | undefined => {
    if (!id) return undefined;
    if (owner && id === owner.id) {
      if (name && !name.startsWith('agent') && !name.startsWith('guest:')) ownerNames.add(name);
      return 'owner';
    }
    let p = people.get(id);
    if (!p) {
      p = { key: `person:${people.size + 1}`, name: getUser(id)?.name || name };
      people.set(id, p);
    }
    return p.key;
  };

  // ------------------------------------------------------------------ new names: every video becomes an upload
  const moved = new Map<string, { slug: string; video: string; name: string; key: string }>();
  const taken = new Set<string>();
  const keyOf = (i: number) => `r${String(i + 1).padStart(4, '0')}`;
  const kept: Review[] = [];
  for (const r of reviews.filter((x) => store.isUpload(x))) {
    taken.add(slugify(r.video));
    kept.push(r);
  }
  for (const r of reviews.filter((x) => !store.isUpload(x))) {
    let name: string;
    let folder: string | null;
    try {
      name = store.uploadName(path.basename(r.video));
      folder = store.uploadFolder(r.folder);
    } catch (e) {
      warnings.push(`left out ${path.basename(r.video)}: ${(e as Error).message}`);
      continue;
    }
    if (folder !== (r.folder || null)) {
      warnings.push(`left out ${path.basename(r.video)}: its folder's name can't be a server's (${r.folder})`);
      continue;
    }
    for (let n = 1; ; n++) {
      const video = store.uploadVideoPath(folder, n === 1 ? name : `~${n}/${name}`);
      if (!taken.has(slugify(video))) {
        taken.add(slugify(video));
        moved.set(slugify(r.video), { slug: slugify(video), video, name, key: '' });
        break;
      }
    }
    kept.push(r);
  }
  kept.sort((a, b) => slugify(a.video).localeCompare(slugify(b.video)));
  kept.forEach((r, i) => {
    const from = slugify(r.video);
    const hit = moved.get(from);
    if (hit) hit.key = keyOf(i);
    else moved.set(from, { slug: from, video: r.video, name: r.source?.name || path.basename(r.video), key: keyOf(i) });
  });
  const newSlug = (slug: string | undefined): string | undefined => (slug ? moved.get(slug)?.slug : undefined);

  // where this machine's paths begin: its home, the store, the app, each tracked video's project, and the folder all
  // tracked videos share (unless that is a top-level one like /Users)
  const tracked = reviews.filter((r) => !store.isUpload(r)).map((r) => r.video);
  const roots = [HOME, DATA, VERSIONS, CACHE, DEV, ROOT, ...tracked.map((v) => path.dirname(v)), ...tracked.map(projectDirOf)];
  for (const v of tracked) if (v.startsWith('/Volumes/')) roots.push(v.split('/').slice(0, 3).join('/'));
  const shared = tracked.reduce<string | null>((acc, v) => {
    let d = acc ?? path.dirname(v);
    while (d !== '/' && !`${path.dirname(v)}/`.startsWith(`${d}/`)) d = path.dirname(d);
    return d;
  }, null);
  if (shared && shared.split('/').filter(Boolean).length >= 2) roots.push(shared);
  const paths = pathScrubber(roots);

  // ------------------------------------------------------------------ references, people, links: as the server holds them
  const refOut = (ref: NoteRef): NoteRef => {
    const { share: _share, by_id, ...rest } = ref;
    const x: NoteRef = { ...rest };
    const who = personOf(by_id, ref.by);
    if (who) x.by_id = who;
    if (x.kind === 'frame' && x.video) {
      const to = newSlug(x.video);
      if (to) x.video = to;
      else delete x.video;
    }
    if (x.name) x.name = store.fileName(x.name);
    return x;
  };
  const commentOut = (c: Comment): Comment => {
    const { share: _share, draft: _draft, author_id, ...rest } = c;
    const x: Comment = { ...rest };
    const who = personOf(author_id, c.author);
    if (who) x.author_id = who;
    if (!c.author.startsWith('agent') && !c.author.startsWith('guest:') && who === 'owner') ownerNames.add(c.author);
    x.replies = c.replies.map((rp) => {
      const { by_id, ...r } = rp;
      const y = { ...r };
      const w = personOf(by_id, rp.by);
      return w ? { ...y, by_id: w } : y;
    });
    if (x.refs) x.refs = x.refs.map(refOut);
    if (x.options) x.options = x.options.map((g) => ({ ...g, items: g.items.map((it) => (it.ref ? { ...it, ref: refOut(it.ref) } : it)) }));
    if (x.previews) x.previews = x.previews.map((p) => (p.source?.project ? { ...p, source: { ...p.source, project: store.fileName(p.source.project) } } : p));
    return x;
  };

  const entries: FileEntry[] = [];
  const json = new Map<string, Buffer>();
  const missingVersions: { key: string; v: number }[] = [];
  let missingFiles = 0;
  let versionBytes = 0;
  let views = 0;
  const counts = { notes: 0, replies: 0, drawings: 0, approvals: 0, versions: 0 };

  for (const r of kept) {
    const from = slugify(r.video);
    const to = moved.get(from) as { slug: string; video: string; name: string; key: string };
    const { key } = to;
    const ext = path.extname(r.video);
    const b = {
      ...r,
      id: r.id || `r_${sha256(`${from}\0${r.added}`).slice(0, 12)}`,
      video: to.video,
      source: { kind: 'upload' as const, name: to.name },
      project: store.isUpload(r) ? r.project : r.folder || 'Uploads',
      session: r.session
        ? { name: r.session.name, id: null, cwd: null, assigned: r.session.assigned, by: r.session.by, ...(r.session.agent ? { agent: r.session.agent } : {}) }
        : null,
      versions: r.versions.map((v) => {
        const { stored: _stored, ...rest } = v;
        return rest.source?.project ? { ...rest, source: { ...rest.source, project: store.fileName(rest.source.project) } } : rest;
      }),
      comments: r.comments.map(commentOut),
      ...(r.approvals ? { approvals: r.approvals.map(({ share: _share, ...a }) => a) } : {}),
    } as Review & Record<string, unknown>;
    delete b.missing;
    delete b.agent_status;
    delete b.onboarding_sample;
    if (r.added_by_id) {
      const who = personOf(r.added_by_id, r.added_by);
      if (who) b.added_by_id = who;
      else delete b.added_by_id;
    }
    const parsed = BundleReview.safeParse(mapStrings(b, paths.scrub));
    if (!parsed.success) throw new Error(`${path.basename(r.video)} doesn't fit a bundle (${problemOf(parsed.error)}): nothing was written`);
    json.set(bundlePath.review(key), Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`));
    counts.notes += r.comments.length;
    counts.replies += r.comments.reduce((n, c) => n + c.replies.length, 0);
    counts.drawings += r.comments.reduce((n, c) => n + (c.drawing?.length || 0), 0);
    counts.approvals += (r.approvals?.length ?? (r.approval ? 1 : 0)) + (r.finals?.length || 0);

    // the notes' own files, next to review.json
    const dir = reviewDir(from);
    for (const c of r.comments)
      for (const f of [c.shots?.clean, c.shots?.marked, c.shots?.range, c.voice?.file]) {
        if (!f) continue;
        const src = path.join(dir, f);
        if (store.NOTE_FILE.test(f) && fs.existsSync(src)) entries.push({ name: bundlePath.file(key, f), src });
        else missingFiles++;
      }
    // references (and options' files) and fix previews, through the storage adapter
    const seen = new Set<string>();
    for (const c of r.comments) {
      for (const ref of [...(c.refs || []), ...optionRefs(c.options)])
        for (const f of store.refFiles(ref)) {
          if (seen.has(`r/${f}`)) continue;
          seen.add(`r/${f}`);
          const src = await storage().ensureLocal(store.refKey(from, f));
          if (src) entries.push({ name: bundlePath.ref(key, f), src });
          else missingFiles++;
        }
      for (const p of c.previews || []) {
        if (seen.has(`p/${p.file}`)) continue;
        seen.add(`p/${p.file}`);
        const src = await storage().ensureLocal(store.previewKey(from, p.file));
        if (src) entries.push({ name: bundlePath.preview(key, p.file), src });
        else missingFiles++;
      }
    }
    // each version's own bytes: its copy in versions/ (or the bucket), else the file it was tracked from while it matches
    for (const ver of r.versions) {
      const name = `v${ver.v}${ext}`;
      let src: string | null = null;
      try {
        src = VERSION_FILE.test(name) ? await store.ensureOwnFile(r, ver.v) : null;
        if (src && quickHash(src) !== ver.hash) src = null;
      } catch {
        src = null;
      }
      if (!src) {
        missingVersions.push({ key, v: ver.v });
        continue;
      }
      entries.push({ name: bundlePath.version(key, name), src });
      counts.versions++;
      versionBytes += fs.statSync(src).size;
    }
    // the team's watching (Insights), by person
    const watched = readViews(from).viewers;
    if (Object.keys(watched).length) {
      let unnamed = 0;
      const viewers: Record<string, unknown> = {};
      for (const [id, w] of Object.entries(watched)) {
        const k = id === 'owner' ? 'owner' : id.startsWith('u_') ? (personOf(id, w.name) as string) : `viewer:${++unnamed}`;
        viewers[k] = w;
      }
      const v = BundleViews.safeParse(mapStrings({ viewers }, paths.scrub));
      if (v.success) {
        json.set(bundlePath.views(key), Buffer.from(`${JSON.stringify(v.data)}\n`));
        views++;
      } else warnings.push(`the watching of ${path.basename(r.video)} stays behind (${problemOf(v.error)})`);
    }
  }

  // ------------------------------------------------------------------ playbooks, folders, taste
  const books = listPlaybooks().filter((p) => p.scope === '' || inside(p.scope) || above(p.scope));
  let bookN = 0;
  for (const p of books) {
    const key = `p${String(++bookN).padStart(3, '0')}`;
    const b: Playbook = {
      ...p,
      refs: p.refs.map(refOut),
    };
    const parsed = BundlePlaybook.safeParse(mapStrings(b, paths.scrub));
    if (!parsed.success) {
      warnings.push(`the playbook of ${p.scope || 'the House'} stays behind (${problemOf(parsed.error)})`);
      continue;
    }
    json.set(bundlePath.playbook(key), Buffer.from(`${JSON.stringify(parsed.data, null, 2)}\n`));
    for (const s of p.skills)
      for (const f of s.files) {
        const src = await storage().ensureLocal(skillFileKey(p, s, f.name));
        if (src) entries.push({ name: bundlePath.skillFile(key, s.id, f.name), src });
        else missingFiles++;
      }
    for (const ref of p.refs)
      for (const f of store.refFiles(ref)) {
        const src = await storage().ensureLocal(refFileKey(p, f));
        if (src) entries.push({ name: bundlePath.playbookRef(key, f), src });
        else missingFiles++;
      }
  }
  const folders = known.filter((f) => inside(f) || above(f));
  json.set('folders.json', Buffer.from(`${JSON.stringify({ folders }, null, 2)}\n`));

  const taste: string[] = [];
  try {
    for (const f of fs.readdirSync(path.join(dataDir(), 'taste')).filter((x) => x.endsWith('.json'))) {
      try {
        const scope = JSON.parse(fs.readFileSync(path.join(dataDir(), 'taste', f), 'utf8')).scope;
        if (typeof scope === 'string' && (!wanted.length || inside(scope))) taste.push(paths.scrub(scope));
      } catch {}
    }
  } catch {}

  // ------------------------------------------------------------------ history: the event log, line by line
  // (a store that was moved itself carries its imported history on: what happened to its videos before)
  const lines: string[] = [];
  let droppedEvents = 0;
  for (const logFile of store.historyFiles()) {
    if (!fs.existsSync(logFile)) continue;
    const rl = readline.createInterface({ input: fs.createReadStream(logFile, { encoding: 'utf8' }), crlfDelay: Number.POSITIVE_INFINITY });
    for await (const line of rl) {
      if (!line.trim()) continue;
      let e: ReviewEvent;
      try {
        e = store.shownEvent(JSON.parse(line));
      } catch {
        droppedEvents++;
        continue;
      }
      const to = e.slug ? moved.get(e.slug) : undefined;
      if (!to || !BUNDLE_EVENT_TYPES.includes(e.type)) {
        droppedEvents++;
        continue;
      }
      const {
        session_id: _sid,
        imported: _imp,
        share: _share,
        files: _files,
        bytes: _bytes,
        run: _run,
        phase: _phase,
        exit: _exit,
        post: _post,
        folder: _folder,
        ...rest
      } = e;
      const x: ReviewEvent = { ...rest, slug: to.slug, video: to.video };
      const base = (f: string | null | undefined) => {
        const b = f ? path.basename(f) : null;
        return b && store.NOTE_FILE.test(b) ? b : null;
      };
      if (e.shots) x.shots = { clean: base(e.shots.clean), marked: base(e.shots.marked), ...(e.shots.range ? { range: base(e.shots.range) } : {}) };
      if (e.reply) {
        const { by_id: _by, ...reply } = e.reply;
        x.reply = reply;
      }
      if (e.ref) {
        const { by_id: _by, ...ref } = refOut(e.ref);
        x.ref = ref;
      }
      const parsed = BundleEvent.safeParse(mapStrings(x, paths.scrub));
      if (!parsed.success) {
        droppedEvents++;
        continue;
      }
      lines.push(JSON.stringify(parsed.data));
    }
  }
  json.set('events.jsonl', Buffer.from(lines.length ? `${lines.join('\n')}\n` : ''));
  if (paths.count()) warnings.push(`${paths.count()} path${paths.count() === 1 ? '' : 's'} of this machine in text became file names`);

  // ------------------------------------------------------------------ what stays behind
  const countIn = (dir: string, test: (f: string) => boolean): number => {
    try {
      return fs.readdirSync(dir).filter(test).length;
    } catch {
      return 0;
    }
  };
  let drafts = 0;
  let recordings = 0;
  for (const r of kept) {
    const dir = reviewDir(slugify(r.video));
    for (const f of fs.existsSync(path.join(dir, 'drafts')) ? fs.readdirSync(path.join(dir, 'drafts')).filter((x) => x.endsWith('.json')) : [])
      try {
        drafts += (JSON.parse(fs.readFileSync(path.join(dir, 'drafts', f), 'utf8')) as { drafts?: unknown[] }).drafts?.length || 0;
      } catch {}
    recordings += countIn(path.join(dir, 'recordings'), (f) => f.endsWith('.json'));
  }
  let links = 0;
  let asks = 0;
  try {
    links = Object.keys(JSON.parse(fs.readFileSync(path.join(dataDir(), 'shares.json'), 'utf8')).shares || {}).length;
  } catch {}
  try {
    asks = (JSON.parse(fs.readFileSync(path.join(dataDir(), 'asks.json'), 'utf8')).asks || []).length;
  } catch {}
  if (missingVersions.length)
    warnings.push(
      `${missingVersions.length} version${missingVersions.length === 1 ? '' : 's'} had no bytes left on this machine: their notes come along, the video doesn't`,
    );
  if (missingFiles)
    warnings.push(
      `${missingFiles} screenshot${missingFiles === 1 ? '' : 's'}, voice clip${missingFiles === 1 ? '' : 's'} or reference${missingFiles === 1 ? '' : 's'} were gone already`,
    );

  // ------------------------------------------------------------------ the manifest: every file, its size and checksum
  log(`reading ${entries.length} files (${(versionBytes / 1e9).toFixed(2)} GB of versions) …`);
  const files: { path: string; size: number; sha256: string }[] = [];
  for (const [name, data] of json) files.push({ path: name, size: data.length, sha256: sha256(data) });
  const hashes = new Map<string, string>();
  for (const e of entries) {
    const h = await hashFile(e.src);
    hashes.set(e.name, h.sha256);
    files.push({ path: e.name, size: h.size, sha256: h.sha256 });
  }
  const manifest: BundleManifest = BundleManifest.parse({
    format: BUNDLE_FORMAT,
    version: BUNDLE_VERSION,
    id: `b_${crypto.randomBytes(8).toString('hex')}`,
    created: new Date().toISOString(),
    app: { version: appVersion() },
    owner: { names: [...ownerNames].filter(Boolean).sort() },
    people: [...people.values()],
    counts: {
      reviews: kept.length,
      versions: counts.versions,
      version_bytes: versionBytes,
      notes: counts.notes,
      replies: counts.replies,
      drawings: counts.drawings,
      approvals: counts.approvals,
      files: entries.length,
      events: lines.length,
      folders: folders.length,
      playbooks: bookN,
      views,
    },
    files,
    taste: [...new Set(taste)].sort(),
    left_out: { missing_versions: missingVersions, samples, drafts, recordings, links, asks, events: droppedEvents, missing_files: missingFiles },
  });

  // ------------------------------------------------------------------ the archive
  const need = files.reduce((n, f) => n + 512 + Math.ceil(f.size / 512) * 512, 1 << 20);
  const free = (() => {
    try {
      const s = fs.statfsSync(path.dirname(out));
      return s.bavail * s.bsize;
    } catch {
      return Number.POSITIVE_INFINITY;
    }
  })();
  if (need > free) throw new Error(`the bundle needs ${(need / 1e9).toFixed(2)} GB and ${path.dirname(out)} has ${(free / 1e9).toFixed(2)} GB free`);
  log(`writing ${out} (${(need / 1e9).toFixed(2)} GB) …`);
  const tmp = `${out}.${process.pid}.part`;
  const tar = await openTarWriter(tmp);
  try {
    await tar.buffer(MANIFEST, Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`));
    const order = [...json.keys()].filter((n) => n.startsWith('reviews/') || n.startsWith('playbooks/'));
    const byOwner = (n: string) => n.split('/').slice(0, 2).join('/');
    const groups = new Map<string, string[]>();
    for (const n of [...order, ...entries.map((e) => e.name)]) groups.set(byOwner(n), [...(groups.get(byOwner(n)) ?? []), n]);
    const src = new Map(entries.map((e) => [e.name, e.src]));
    for (const names of groups.values())
      for (const n of names) {
        const data = json.get(n);
        if (data) {
          await tar.buffer(n, data);
          continue;
        }
        const wrote = await tar.file(n, src.get(n) as string);
        if (wrote.sha256 !== hashes.get(n)) throw new Error(`${n} changed while the bundle was written: run lampo export again`);
      }
    await tar.buffer('folders.json', json.get('folders.json') as Buffer);
    await tar.buffer('events.jsonl', json.get('events.jsonl') as Buffer);
    await tar.close();
    fs.renameSync(tmp, out);
  } catch (e) {
    await tar.close().catch(() => {});
    fs.rmSync(tmp, { force: true });
    throw e;
  }
  return { file: out, bytes: fs.statSync(out).size, manifest, warnings };
}
