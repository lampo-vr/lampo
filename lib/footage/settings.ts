// Whether footage search indexes a workspace's videos. On a person's own machine it is on unless they turn it off; on a
// hosted server a workspace's owner or admin turns it on (it costs the server's CPU: ~10–40 CPU-minutes per hour of
// footage, bench/footage/RESULTS.md). `footage: "off"` in config.json (or LAMPO_FOOTAGE=off) turns it off everywhere:
// nothing is indexed and no model is downloaded.
import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from '../config.ts';
import { settings } from '../env.ts';
import { dataDir, readConfigFile } from '../paths.ts';
import { writeAtomic } from '../store.ts';

/** What a workspace said, kept with its data: `footage.json`. */
export interface FootageSetting {
  on: boolean;
  by?: string;
  at?: string;
}

const file = () => path.join(dataDir(), 'footage.json');

/** Off for the whole machine or server (config.json `footage: "off"`, LAMPO_FOOTAGE=off). */
export function footageOffEverywhere(): boolean {
  const v = (settings.LAMPO_FOOTAGE || readConfigFile().footage || 'auto').trim().toLowerCase();
  return v === 'off' || v === '0' || v === 'false';
}

let hosted: boolean | null = null;
const isHosted = (): boolean => {
  hosted ??= loadConfig().mode === 'server';
  return hosted;
};

/**
 * What the workspace said: null when it said nothing (no file), `unreadable` when its file is there and can't be read —
 * never taken for nothing said, which on a person's machine means on: someone may have turned it off.
 */
export function readSetting(): FootageSetting | null | 'unreadable' {
  let text: string;
  try {
    text = fs.readFileSync(file(), 'utf8');
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'unreadable';
  }
  try {
    const s = JSON.parse(text) as FootageSetting;
    return s && typeof s.on === 'boolean' ? s : 'unreadable';
  } catch {
    return 'unreadable';
  }
}

/** Whether the workspace running now has footage search, and if not, why (for whoever asks). */
export function footageState(): { on: boolean; why?: string } {
  if (footageOffEverywhere()) return { on: false, why: 'footage search is off on this machine or server (footage: "off" / LAMPO_FOOTAGE=off)' };
  const s = readSetting();
  if (s === 'unreadable')
    return { on: false, why: 'footage search is off: its setting (footage.json) can’t be read — lampo footage on or off writes it again' };
  if (s) return s.on ? { on: true } : { on: false, why: 'footage search is off for this workspace (lampo footage on turns it on)' };
  if (isHosted()) return { on: false, why: 'footage search is off for this workspace: an owner or admin turns it on (lampo footage on)' };
  return { on: true };
}

export const footageOn = (): boolean => footageState().on;

export function writeSetting(on: boolean, by: string): FootageSetting {
  const s: FootageSetting = { on, by, at: new Date().toISOString() };
  fs.mkdirSync(path.dirname(file()), { recursive: true });
  writeAtomic(file(), `${JSON.stringify(s, null, 2)}\n`);
  return s;
}
