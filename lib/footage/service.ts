// Footage search for the workspace running now, as `vr`, the MCP tools and the API use it: find, a contact sheet of
// shots by id, how far the index is, and the workspace's switch.
import fs from 'node:fs';
import path from 'node:path';
import { cacheDir } from '../paths.ts';
import { hasIndex, openIndex } from './db.ts';
import { embedder } from './embedder.ts';
import { SIGLIP } from './models.ts';
import { indexState, shotsById } from './search.ts';
import { footageState, writeSetting } from './settings.ts';
import { contactSheet } from './sheet.ts';
import type { FootageShot, FootageStatus } from './types.ts';

export { find } from './search.ts';

export function status(): FootageStatus {
  const e = embedder();
  const state = indexState(undefined, e.key);
  const shots = hasIndex() ? Number((openIndex().prepare('SELECT count(*) AS n FROM shots').get() as { n: number }).n) : 0;
  const progress = e.progress();
  return {
    ...state,
    shots,
    model: e.kind === 'fake' ? 'fake (tests)' : SIGLIP.id,
    model_ready: e.ready(),
    ...(progress !== null ? { download: Math.round(progress * 100) / 100 } : {}),
  };
}

/** Turns footage search on or off for the workspace running now (the caller decides who may). */
export function setOn(on: boolean, by: string): FootageStatus {
  writeSetting(on, by);
  return status();
}

export const isOn = (): boolean => footageState().on;

/**
 * The contact sheet of shots by id (`s412`, as a list named them), at `out` or in the cache: unknown ids are left out,
 * none known is an error. Nine tiles at most (3 × 3) keep it one picture an agent reads at a glance.
 */
export const SHEET_MAX = 9;
export async function sheet(ids: readonly string[], out?: string): Promise<{ file: string; shots: FootageShot[]; width: number; height: number }> {
  const items = shotsById([...new Set(ids)].slice(0, SHEET_MAX), embedder().key);
  if (!items.length) throw new Error(`no shot ${ids.slice(0, 3).join(', ')} in this workspace's footage (ids come from vr footage find)`);
  const file =
    out ??
    path.join(
      cacheDir(),
      'footage',
      'sheets',
      `${items
        .map((x) => x.shot.id)
        .join('-')
        .slice(0, 120)}.jpg`,
    );
  const size = await contactSheet(items, file);
  // sheets made for callers are a cache: the newest 50 are kept
  if (!out) prune(path.dirname(file), 50);
  return { file, shots: items.map((x) => x.shot), ...size };
}

function prune(dir: string, keep: number): void {
  try {
    const files = fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.jpg'))
      .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
      .sort((a, b) => b.t - a.t);
    for (const x of files.slice(keep)) fs.rmSync(path.join(dir, x.f), { force: true });
  } catch {}
}
