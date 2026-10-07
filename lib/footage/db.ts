// The footage index of a workspace: one SQLite file (node:sqlite, built into Node) in its cache, `footage/index.db` —
// isolation is the path, like everything else Lampo keeps per workspace, and deleting the cache only costs indexing
// again. Vectors are BLOBs scanned in JS (bench/footage/RESULTS.md: 8–17 ms over 10k keyframes, 80–95 ms over 100k).
// Everything here is derived from a render's bytes and keyed by its renderKey, so two videos holding the same render
// share it and a re-added file costs nothing.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { cacheDir } from '../paths.ts';

/** Bumped when what is stored changes meaning: an index of another version is dropped and made again. */
export const INDEX_VERSION = 1;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT);
CREATE TABLE IF NOT EXISTS renders (key TEXT PRIMARY KEY, width INT, height INT, fps REAL, frames INT,
  stage TEXT NOT NULL, error TEXT, tries INT DEFAULT 0, ocr TEXT, at TEXT);
CREATE TABLE IF NOT EXISTS shots (id INTEGER PRIMARY KEY AUTOINCREMENT, render TEXT NOT NULL, n INT, f_in INT, f_out INT,
  motion TEXT, speed TEXT, zoom REAL, dx REAL, dy REAL, path REAL, text TEXT NOT NULL DEFAULT '');
CREATE INDEX IF NOT EXISTS shots_render ON shots (render);
CREATE TABLE IF NOT EXISTS keyframes (id INTEGER PRIMARY KEY, shot_id INT NOT NULL, frame INT NOT NULL, ocr TEXT);
CREATE INDEX IF NOT EXISTS keyframes_shot ON keyframes (shot_id);
CREATE TABLE IF NOT EXISTS vectors (kf_id INT NOT NULL, model TEXT NOT NULL, vec BLOB NOT NULL, PRIMARY KEY (kf_id, model));
`;

type Sqlite = typeof import('node:sqlite');
let sqlite: Sqlite | null = null;
/** node:sqlite, without the "experimental" warning Node 22 prints on stderr (it would end up in `lampo`'s output). */
function sqliteModule(): Sqlite {
  if (sqlite) return sqlite;
  const emit = process.emitWarning;
  process.emitWarning = ((w: string | Error, ...rest: unknown[]) => {
    if (String(w instanceof Error ? w.message : w).includes('SQLite')) return;
    return (emit as (...a: unknown[]) => void).call(process, w, ...rest);
  }) as typeof process.emitWarning;
  try {
    sqlite = createRequire(import.meta.url)('node:sqlite') as Sqlite;
  } finally {
    process.emitWarning = emit;
  }
  return sqlite;
}

export const indexDir = (): string => path.join(cacheDir(), 'footage');
export const indexFile = (): string => path.join(indexDir(), 'index.db');
/** A keyframe's picture for contact sheets (360 px on its long side). */
export const thumbFile = (renderKey: string, frame: number): string => path.join(indexDir(), 'thumbs', renderKey, `${frame}.jpg`);

// One connection per index file in this process (a file per workspace: the path is the workspace's).
const open = new Map<string, DatabaseSync>();
const used = new Map<string, number>();
/** A workspace's index nobody has used for this long is closed (a hosted server holds many). */
const IDLE_MS = 10 * 60_000;

function closeIdle(now: number, keep: string): void {
  for (const [file, at] of used)
    if (file !== keep && now - at > IDLE_MS) {
      try {
        open.get(file)?.close();
      } catch {}
      open.delete(file);
      used.delete(file);
    }
}

/** The index of the workspace running now, opened (and made, or made again at a new INDEX_VERSION) on first use. */
export function openIndex(): DatabaseSync {
  const file = indexFile();
  const now = Date.now();
  if (!used.has(file) || now - (used.get(file) as number) > 60_000) closeIdle(now, file);
  used.set(file, now);
  const had = open.get(file);
  if (had && fs.existsSync(file)) return had;
  if (had) {
    // the cache was cleared under us: start a new file
    try {
      had.close();
    } catch {}
    open.delete(file);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const { DatabaseSync } = sqliteModule();
  const db = new DatabaseSync(file);
  // the server indexing and a `lampo` on the same machine may write at once: wait for the other, don't fail
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = NORMAL');
  db.exec('CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT)');
  const version = (db.prepare("SELECT v FROM meta WHERE k = 'version'").get() as { v: string } | undefined)?.v;
  if (version !== String(INDEX_VERSION)) {
    db.exec('DROP TABLE IF EXISTS vectors; DROP TABLE IF EXISTS keyframes; DROP TABLE IF EXISTS shots; DROP TABLE IF EXISTS renders; DELETE FROM meta;');
    fs.rmSync(path.join(path.dirname(file), 'thumbs'), { recursive: true, force: true });
  }
  const made = !db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'shots'").get();
  db.exec(SCHEMA);
  // A new index numbers its shots from a random start (s48213…, never s1): an id an agent kept from an index that was
  // made again (a cleared cache, a new INDEX_VERSION) or from another workspace names no shot here, instead of another one.
  if (made) db.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('shots', ?)").run(100000 + crypto.randomInt(800000));
  db.prepare("INSERT OR REPLACE INTO meta (k, v) VALUES ('version', ?)").run(String(INDEX_VERSION));
  open.set(file, db);
  return db;
}

/** Whether the workspace running now has an index file yet (a search before any indexing answers empty, makes nothing). */
export const hasIndex = (): boolean => fs.existsSync(indexFile());

/** A counter every write moves on: a search re-reads the index only when it changed (here or in another process). */
export function generation(db: DatabaseSync): number {
  return Number((db.prepare("SELECT v FROM meta WHERE k = 'gen'").get() as { v: string } | undefined)?.v ?? 0);
}
export function bump(db: DatabaseSync): void {
  db.prepare("INSERT INTO meta (k, v) VALUES ('gen', '1') ON CONFLICT(k) DO UPDATE SET v = CAST(v AS INTEGER) + 1").run();
}

/** Runs fn in one transaction (all of a stage's rows land, or none). */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = fn();
    bump(db);
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}

/** Closes every index this process opened (tests, a shutdown). */
export function closeIndexes(): void {
  for (const db of open.values())
    try {
      db.close();
    } catch {}
  open.clear();
  used.clear();
}

export interface RenderRow {
  key: string;
  width: number;
  height: number;
  fps: number;
  frames: number;
  /** analysed → shots and keyframes are in; done → pictures read and embedded; failed */
  stage: 'analysed' | 'done' | 'failed';
  error: string | null;
  tries: number;
  ocr: string | null;
  at: string | null;
}

export interface ShotRow {
  id: number;
  render: string;
  n: number;
  f_in: number;
  /** The shot's last frame (included). */
  f_out: number;
  motion: string;
  speed: string | null;
  zoom: number;
  dx: number;
  dy: number;
  path: number;
  text: string;
}

export interface KeyframeRow {
  id: number;
  shot_id: number;
  frame: number;
  ocr: string | null;
}
