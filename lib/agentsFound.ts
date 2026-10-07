// Which agents are installed on this machine, for the local setup's agent tiles ("Found · 2.1.4"): found by looking,
// never by running anything — an executable named `claude`, `codex` or `cursor` on PATH (Claude Code also where
// findClaude looks), or Cursor's app in /Applications. The version only when a file says it: the package.json of an
// npm-installed CLI beside its real path, a native install's versioned file name, Cursor's Info.plist. Remembered for a
// minute. The machine's owner only (server/routes/onboarding.ts).
import fs from 'node:fs';
import path from 'node:path';
import { settings } from './env.ts';
import { findClaude } from './sessions.ts';
import type { OnboardingAgentsFound } from './types.ts';

type Found = OnboardingAgentsFound['found'][number];

export interface LookOptions {
  /** PATH as the server runs with it. */
  pathVar?: string;
  /** Where Claude Code is when findClaude finds it (LAMPO_CLAUDE_BIN, PATH, the usual places), or null. */
  claude?: string | null;
  /** Where macOS keeps apps (Cursor.app). */
  apps?: string;
}

/** The packages that ship each CLI, read for their version. */
const PACKAGES: Record<string, string> = { 'claude-code': '@anthropic-ai/claude-code', codex: '@openai/codex' };
const VERSION = /^\d+\.\d+\.\d+(?:[-+][\w.]+)?$/;

const isExecutable = (p: string): boolean => {
  try {
    const st = fs.statSync(p);
    if (!st.isFile()) return false;
    fs.accessSync(p, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

/** The first executable named `name` on PATH, or null. */
function onPath(name: string, pathVar: string): string | null {
  for (const dir of pathVar.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    if (isExecutable(p)) return p;
  }
  return null;
}

/** A version a file says: the npm package beside the CLI's real path, or a native install's versioned name. */
function versionOf(bin: string, pkg: string | undefined): string | null {
  let real: string;
  try {
    real = fs.realpathSync(bin);
  } catch {
    return null;
  }
  if (VERSION.test(path.basename(real))) return path.basename(real);
  if (!pkg) return null;
  let dir = path.dirname(real);
  for (let i = 0; i < 6; i++) {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as { name?: string; version?: string };
      if (j.name === pkg) return typeof j.version === 'string' && VERSION.test(j.version) ? j.version : null;
    } catch {}
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return null;
}

/** Cursor's version from its app bundle's Info.plist (CFBundleShortVersionString), or null. */
function cursorVersion(app: string): string | null {
  try {
    const plist = fs.readFileSync(path.join(app, 'Contents', 'Info.plist'), 'utf8');
    const v = /<key>CFBundleShortVersionString<\/key>\s*<string>([^<]+)<\/string>/.exec(plist)?.[1]?.trim();
    return v && VERSION.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** The Cursor.app a `cursor` CLI lives in (its real path runs through the bundle), else null. */
function bundleOf(bin: string): string | null {
  try {
    const real = fs.realpathSync(bin);
    const i = real.indexOf('.app/');
    return i > 0 ? real.slice(0, i + 4) : null;
  } catch {
    return null;
  }
}

export function lookForAgents({
  pathVar = process.env.PATH || '',
  claude = (() => {
    const p = findClaude();
    return path.isAbsolute(p) && fs.existsSync(p) ? p : null;
  })(),
  apps = '/Applications',
}: LookOptions = {}): OnboardingAgentsFound {
  const found: Found[] = [];
  const claudeBin = claude ?? onPath('claude', pathVar);
  if (claudeBin) found.push({ kind: 'claude-code', version: versionOf(claudeBin, PACKAGES['claude-code']) });
  const codex = onPath('codex', pathVar);
  if (codex) found.push({ kind: 'codex', version: versionOf(codex, PACKAGES.codex) });
  const cursorCli = onPath('cursor', pathVar);
  const app = (cursorCli && bundleOf(cursorCli)) || (fs.existsSync(path.join(apps, 'Cursor.app')) ? path.join(apps, 'Cursor.app') : null);
  if (cursorCli || app) found.push({ kind: 'cursor', version: app ? cursorVersion(app) : null });
  return { found };
}

let memo: { at: number; key: string; value: OnboardingAgentsFound } | null = null;

/** What lookForAgents finds, remembered for a minute (the setup asks as its tiles show). */
export function agentsFound(now = Date.now()): OnboardingAgentsFound {
  const key = `${process.env.PATH || ''}\u0000${settings.LAMPO_CLAUDE_BIN || ''}`;
  if (memo && memo.key === key && now - memo.at < 60_000) return memo.value;
  memo = { at: now, key, value: lookForAgents() };
  return memo.value;
}
