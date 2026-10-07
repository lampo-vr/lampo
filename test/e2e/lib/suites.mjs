#!/usr/bin/env node
// The browser suites and the one way to run them. A suite is any test/e2e/*.mjs that reports through ./lib/checks.mjs,
// so there is no list to keep. `npm run test:e2e` runs every suite one after another; `npm run test:e2e:parallel` runs
// them side by side (VR_E2E_JOBS=<n>, default half the cores, at most 4). Either way every suite runs, whatever failed
// before it, each failure is listed at the end, and the run fails then. A suite that hangs is stopped after
// VR_E2E_SUITE_MINUTES (default 15) and counts as failed, so one stuck browser can't hide the others' results.
//
//   node test/e2e/lib/suites.mjs [--changed [base]] [--jobs <n>] [--only a,b] [--except a,b] [--shard <i>/<n>] [--perf] [--list]
//
// perf (the speed budgets at CPU 4×, about a minute and a half) runs on CI, with --perf, when --only names it or when
// --changed picks it; a plain local run leaves it out and says so (`npm run test:all` passes --perf).
//
// --changed runs only the suites what this branch changed can affect (since it left `base`, default main or
// origin/main, plus what isn't committed): each suite's `// covers:` line and the import graph decide
// (test/lib/affected.ts); the run says which file chose which suite, or which file made it all of them.
// --shard splits the suites into n parts of about equal time (CI runs two). Side by side, timing-sensitive checks see
// more load than one at a time, so a failure there that doesn't repeat alone is worth a second look, not a test fix.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseRef, changedFiles, suitesFor } from '../../lib/affected.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const E2E = path.join(ROOT, 'test/e2e');

// Seconds each suite took in a full run (2026-10-05 at 3d20808, one after another, on a Mac other work kept busy;
// insights, library, player and range measured again alone): only for splitting --shard evenly and starting the longest
// first side by side. A new suite counts as DEFAULT_SECONDS until it is added here.
const SECONDS = {
  quality: 101,
  'quality-load': 83,
  mobile: 111,
  inbox: 104,
  // an agent's work that needs you in the inbox: two servers, the matrix at six widths, both themes and German (estimate)
  'inbox-agents': 60,
  perf: 87,
  player: 70,
  account: 62,
  share: 59,
  'guest-compare': 34,
  'guest-look': 22,
  // an Embed link's player in another site's page (measured alone, 2026-10-06)
  embed: 45,
  settings: 49,
  range: 47,
  theme: 42,
  library: 41,
  insights: 40,
  record: 35,
  german: 31,
  workspaces: 30,
  server: 27,
  transcript: 27,
  monitor: 26,
  'media-host': 25,
  ui: 24,
  billing: 45,
  limits: 30,
  operator: 20,
  'operator-admin': 60,
  takedown: 45,
  conversion: 45,
  checkout: 16,
  options: 21,
  partial: 21,
  notes: 20,
  publish: 19,
  refs: 19,
  thread: 19,
  drafts: 17,
  onboarding: 23,
  'onboarding-setup': 26,
  getstarted: 20,
  webkit: 17,
  playbook: 15,
  styleguide: 15,
  zoom: 14,
  // a folder's zip, then one version from the player's and a card's ⋯, the menus at 1440 and 390 in both themes
  download: 14,
  status: 12,
  // archived projects: archive with Undo, the lists, the Archived page, the banner, ⌘K, restore, 390–1440 both themes
  archive: 18,
  moving: 10,
  // an agent's work in every state: the strip, the Agent view, cards, phone, 390–1920 both themes and German
  'agents-at-work': 130,
  wake: 9,
  phone: 8,
  run: 8,
  'mcp-app': 6,
  oauth: 5,
};
const DEFAULT_SECONDS = 20;
const weight = (name) => SECONDS[name] ?? DEFAULT_SECONDS;

/**
 * The suites without perf unless it is wanted: on CI (GITHUB_ACTIONS), with --perf, named by --only or picked by
 * --changed. Returns the names to run and, when perf was left out, a line that says so.
 */
export function withPerf(names, o, env = process.env) {
  const wanted = o.perf || env.GITHUB_ACTIONS === 'true' || o.only?.includes('perf') || o.changed != null;
  if (wanted || !names.includes('perf')) return { names, note: null };
  return { names: names.filter((n) => n !== 'perf'), note: 'perf left out: its speed budgets run on CI, with --perf, or when --changed picks them' };
}

/** Every suite's name (file name without .mjs), alphabetically. */
export function suiteNames() {
  return fs
    .readdirSync(E2E)
    .filter((f) => f.endsWith('.mjs') && /from '\.\/lib\/checks\.mjs'/.test(fs.readFileSync(path.join(E2E, f), 'utf8')))
    .map((f) => f.slice(0, -4))
    .sort();
}

/** Part `i` of `n` (1-based): the longest suites dealt out first, each to the part with the least time so far. */
export function shard(names, i, n) {
  const parts = Array.from({ length: n }, () => ({ s: 0, names: [] }));
  for (const name of [...names].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
    const lightest = parts.reduce((min, p) => (p.s < min.s ? p : min));
    lightest.s += weight(name);
    lightest.names.push(name);
  }
  return parts[i - 1].names.sort();
}

function options(argv) {
  const o = { jobs: 1, only: null, except: [], shard: null, list: false, changed: null, perf: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i] ?? '';
    if (a === '--jobs') o.jobs = next() === 'auto' ? 0 : Number(argv[i]);
    else if (a === '--only') o.only = next().split(',').filter(Boolean);
    else if (a === '--except') o.except = next().split(',').filter(Boolean);
    else if (a === '--shard') {
      const [k, n] = next().split('/').map(Number);
      if (!(n >= 1 && k >= 1 && k <= n)) throw new Error(`--shard wants <i>/<n>, got ${argv[i]}`);
      o.shard = [k, n];
    } else if (a === '--list') o.list = true;
    else if (a === '--perf') o.perf = true;
    // the base is optional: `--changed` alone compares with main
    else if (a === '--changed') o.changed = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : '';
    else throw new Error(`unknown option ${a}`);
  }
  if (!o.jobs) o.jobs = Math.max(1, Number(process.env.VR_E2E_JOBS) || Math.min(4, Math.floor(os.cpus().length / 2)));
  return o;
}

async function main() {
  const o = options(process.argv.slice(2));
  const all = suiteNames();
  for (const n of [...(o.only ?? []), ...o.except]) if (!all.includes(n)) throw new Error(`no suite ${n} (have: ${all.join(', ')})`);
  let names = all.filter((n) => (!o.only || o.only.includes(n)) && !o.except.includes(n));
  if (o.changed !== null) names = changedSuites(names, o.changed);
  const perf = withPerf(names, o);
  if (perf.note) console.error(perf.note);
  names = perf.names;
  if (o.shard) names = shard(names, ...o.shard);
  if (o.list) {
    console.log(names.join('\n'));
    return;
  }

  if (!names.length) {
    console.log('no browser suite to run');
    return;
  }

  const gha = process.env.GITHUB_ACTIONS === 'true';
  const limit = (Number(process.env.VR_E2E_SUITE_MINUTES) || 15) * 60_000;
  const running = new Set();
  // Stopped by hand: every running suite closes its Chrome and server (SIGINT), then their groups go.
  const stopAll = (signal) => {
    for (const p of running) kill(p, 'SIGINT', false);
    setTimeout(() => {
      for (const p of running) kill(p, 'SIGKILL');
      process.exit(signal === 'SIGINT' ? 130 : 143);
    }, 3000);
  };
  process.once('SIGINT', () => stopAll('SIGINT'));
  process.once('SIGTERM', () => stopAll('SIGTERM'));

  const results = new Map();
  const t0 = Date.now();
  const runOne = (name) =>
    new Promise((resolve) => {
      const t = Date.now();
      const alone = o.jobs === 1;
      let out = '';
      if (alone) console.log(gha ? `::group::${name}` : `\n── ${name}`);
      // Its own process group: a suite stopped for hanging takes its server and anything else it started with it.
      const p = spawn(process.execPath, [path.join(E2E, `${name}.mjs`)], { cwd: ROOT, env: process.env, stdio: alone ? 'inherit' : 'pipe', detached: true });
      running.add(p);
      p.stdout?.on('data', (d) => (out += d));
      p.stderr?.on('data', (d) => (out += d));
      let hung = false;
      let force;
      const timer = setTimeout(() => {
        hung = true;
        // SIGINT first: puppeteer kills its Chrome and exits, and the suite's exit handler stops its server; then the group.
        kill(p, 'SIGINT', false);
        force = setTimeout(() => kill(p, 'SIGKILL'), 10_000);
      }, limit);
      p.on('close', (code, signal) => {
        clearTimeout(timer);
        clearTimeout(force);
        // Whatever the suite left in its group (a server it had no time to stop) goes with it.
        kill(p, 'SIGKILL');
        running.delete(p);
        const s = Math.round((Date.now() - t) / 1000);
        const ok = code === 0 && !hung;
        const why = hung ? `stopped after ${limit / 60_000} min` : signal ? `killed (${signal})` : `exit ${code}`;
        results.set(name, { ok, s, why });
        if (alone) {
          if (gha) console.log('::endgroup::');
          console.log(`── ${name}: ${ok ? 'passed' : `failed, ${why}`} (${s} s)`);
        } else console.log(`\n── ${name} (${ok ? 'passed' : `failed, ${why}`}, ${s} s)\n${out.trimEnd()}`);
        if (!ok && gha) console.log(`::error title=${name}.mjs::${name} e2e failed (${why}); its output is in the group above`);
        resolve();
      });
    });

  const queue = o.jobs === 1 ? [...names] : [...names].sort((a, b) => weight(b) - weight(a));
  await Promise.all(
    Array.from({ length: Math.min(o.jobs, queue.length) }, async () => {
      while (queue.length) await runOne(queue.shift());
    }),
  );

  const failed = names.filter((n) => !results.get(n).ok);
  console.log(`\n${names.length} suites, ${o.jobs} at a time, ${Math.round((Date.now() - t0) / 1000)} s:`);
  for (const n of names) {
    const r = results.get(n);
    console.log(`  ${r.ok ? '✓' : '✗'} ${n} (${r.s} s${r.ok ? '' : `, ${r.why}`})`);
  }
  console.log(failed.length ? `\n${failed.length} of ${names.length} suites failed: ${failed.join(', ')}` : `\nall ${names.length} suites passed`);
  process.exitCode = failed.length ? 1 : 0;
}

/** The suites among `names` that this branch's changes select, said on stderr (stdout stays the list for --list). */
function changedSuites(names, asked) {
  const base = baseRef(asked || undefined);
  const files = changedFiles(base);
  const picked = suitesFor(files, names);
  const say = (line) => console.error(line);
  say(`--changed: ${files.length} file${files.length === 1 ? '' : 's'} since ${base}`);
  if (picked.everything) say(`  all ${names.length} suites: ${picked.everything}`);
  else if (!picked.names.length) say('  no browser suite covers them');
  else
    for (const n of picked.names)
      say(`  ${n}: ${picked.why.get(n).slice(0, 3).join(', ')}${picked.why.get(n).length > 3 ? ` +${picked.why.get(n).length - 3}` : ''}`);
  return picked.names;
}

/** Signals a suite's whole process group (it was started detached), or just the suite. */
function kill(p, signal, group = true) {
  try {
    process.kill(group ? -p.pid : p.pid, signal);
  } catch {}
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.message ?? e));
    process.exit(2);
  });
}
