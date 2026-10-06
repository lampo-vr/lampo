// Which tests a change can affect, from facts rather than a list kept by hand: the files a branch changed (git), the
// code's import graph (the same imports Vite and Node follow) and one line at the top of each browser suite naming what
// it tests. `npm run test:e2e -- --changed [base]` and `npm run test:changed [base]` run what this selects.
//
// Browser suites. A suite's first line is `// covers: <paths>`: the screens and modules it tests (a path is a file, a
// folder ending in `/`, or a name with `*`, as in AUDITS.md). Its reach is its own file, those files and everything
// they import statically, transitively. A dynamic import is a chunk of its own (a screen the router loads): the reach
// stops there, and a suite that tests that screen names it. Test code is the exception: what a suite or its helpers
// import dynamically runs in the suite's process. A changed file selects every suite whose reach holds it. Files under
// every screen (EVERYTHING) select every suite; so does code the app runs that no suite reaches (the shell, server
// plumbing, a new module) — the run says which file did it, and adding it to the covers line of the suite that tests
// it narrows the next one. Anything the app doesn't run (docs, unit tests, the CLI, bench/) selects no suite.
//
// Unit tests. A test file's reach is everything it imports, statically or dynamically (tests import after setting the
// environment), the repository paths it names as strings (`path.join(ROOT, 'docs')`, a spawned `bin/vr`: a file is
// followed into its imports, a folder only read) and an optional `// covers:` line for files it reads in a way no
// string shows. A changed file selects every test whose reach holds it; a changed test selects itself; package*.json
// selects them all.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { covers } from '../../scripts/audits.ts';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

/** A change here can break any screen: every browser suite runs. The data contract, the app and its shell, the UI
 * building blocks, the tokens and the dependencies. The harness every suite imports (test/e2e/lib/checks.mjs,
 * browser.mjs, server.mjs, test/lib/helpers.ts) selects every suite through the import graph; the runner itself
 * (suites.mjs) and a helper only some suites use select those. */
export const EVERYTHING = [
  'lib/types.ts',
  'server/app.ts',
  'server/index.ts',
  'web/index.html',
  'web/vite.config.ts',
  'web/src/main.tsx',
  'web/src/boot.tsx',
  'web/src/App.tsx',
  'web/src/ui/',
  'web/src/styles/base.css',
  'web/src/styles/index.css',
  'package.json',
  'package-lock.json',
];

/** Every unit test runs when one of these changes. */
export const EVERY_UNIT = ['package.json', 'package-lock.json'];

/** Where the app starts: code reachable from here (by any import) is code a browser suite can run. */
const APP_ENTRIES = ['server/index.ts', 'web/src/main.tsx', 'web/mcp-app/main.ts', 'web/sw/sw.js'];

/** How a file reaches another: `import` (not `import type`), `import()`, `new URL(…, import.meta.url)`, a path test
 * code spells out, or a path a test helper's function uses that a test imports by name. */
type Kind = 'static' | 'dynamic' | 'url' | 'path' | 'named';
interface Edge {
  to: string;
  kind: Kind;
}

/** A view of one checkout: its files (tracked, and new ones git doesn't ignore) and their imports, read once. */
export class Repo {
  readonly root: string;
  readonly files: string[];
  private readonly set: Set<string>;
  private readonly dirs = new Set<string>();
  private readonly edges = new Map<string, Edge[]>();
  private readonly named = new Map<string, Map<string, string[]>>();
  private readonly suites = new Map<string, Set<string>>();
  private app: Set<string> | null = null;

  constructor(root = ROOT, files?: string[]) {
    this.root = root;
    this.files = files ?? listFiles(root);
    this.set = new Set(this.files);
    for (const f of this.files) for (let i = f.indexOf('/'); i > 0; i = f.indexOf('/', i + 1)) this.dirs.add(f.slice(0, i + 1));
  }

  has(file: string): boolean {
    return this.set.has(file);
  }

  /** The files a covers path names: a file, a folder's files, the names a `*` matches, or `**`, every file (a test
   * that checks every tracked file). */
  expand(spec: string): string[] {
    if (spec === '**') return this.files;
    if (spec.endsWith('/') || spec.includes('*')) return this.files.filter((f) => covers(spec, f));
    return this.set.has(spec) ? [spec] : [];
  }

  /** The `// covers:` paths of a file (every such line, in order). */
  coversOf(file: string): string[] {
    const text = this.read(file);
    return [...text.matchAll(/^\/\/ covers: (.+)$/gm)].flatMap((m) => m[1].trim().split(/\s+/));
  }

  read(file: string): string {
    try {
      return fs.readFileSync(path.join(this.root, file), 'utf8');
    } catch {
      return '';
    }
  }

  /** What a file imports or names: static and dynamic imports, `new URL('…', import.meta.url)`, CSS `@import`, and in
   * test code the repository paths it spells out. Only files of this checkout; packages are not followed. */
  edgesOf(file: string): Edge[] {
    let out = this.edges.get(file);
    if (out) return out;
    out = [];
    this.edges.set(file, out);
    const text = this.read(file);
    const add = (spec: string, kind: Kind, from = path.posix.dirname(file)) => {
      const to = this.resolve(from, spec);
      if (to && to !== file) out.push({ to, kind });
    };
    if (file.endsWith('.css')) {
      for (const m of text.matchAll(/@import\s+(?:url\()?\s*['"]([^'"]+)['"]/g)) add(m[1], 'static');
      return out;
    }
    if (!isScript(file, text)) return out;
    const test = file.startsWith('test/');
    for (const m of text.matchAll(/\b(?:import|export)\s+(type\s+)?([^'"`;]*?)\bfrom\s*['"]([^'"]+)['"]/g)) {
      // `import type` is erased before anything runs (and is the typecheck's business): ServerContext's types would
      // otherwise make every route import the whole server
      if (m[1]) continue;
      add(m[3], 'static');
      // What a test helper or script runs or reads by name (`vr()` spawns bin/vr, `stylesheets()` reads
      // web/src/styles/) is run by the tests that import that name, not by every importer of the module.
      const to = test ? this.resolve(path.posix.dirname(file), m[3]) : null;
      if (!to?.startsWith('test/') && !to?.startsWith('scripts/')) continue;
      // `{ vr, type X, startServer as start }`: the names as the module exports them
      const names = (/\{([^}]*)\}/.exec(m[2])?.[1].split(',') ?? []).map((n) => /^\s*(?:type\s+)?([\w$]+)/.exec(n)?.[1] ?? '');
      for (const name of names) for (const p of this.namedPaths(to).get(name) ?? []) add(p, 'named', '');
    }
    for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) add(m[1], 'static');
    for (const m of text.matchAll(/\bimport\(\s*['"`]([^'"`$]+)['"`]\s*\)/g)) add(m[1], 'dynamic');
    for (const m of text.matchAll(/new URL\(\s*['"`]([^'"`$]+)['"`]\s*,\s*import\.meta\.url\s*\)/g)) add(m[1], 'url');
    if (test) {
      for (const p of pathsIn(text)) add(p, 'path', '');
      // '../../web/src/styles' next to import.meta.dirname: a path from this file's folder
      for (const m of text.matchAll(/['"`](\.\.?\/[\w@.+/-]*)['"`]/g)) add(m[1], 'path');
      // read('Dockerfile'): a file at the top of the checkout, named alone
      for (const m of text.matchAll(/['"]([\w.-]+)['"]/g)) if (this.set.has(m[1])) add(m[1], 'path', '');
    }
    return out;
  }

  /** The repository paths each top-level name of a test helper uses, directly or through the module's other names
   * (`export function vr()` → `VR` → bin/vr): what it joins to ROOT, and paths from its own folder
   * (`path.join(import.meta.dirname, '../../web/src/styles')`). */
  private namedPaths(file: string): Map<string, string[]> {
    let out = this.named.get(file);
    if (out) return out;
    const blocks = new Map<string, string>();
    for (const block of this.read(file).split(/\n(?=(?:export )?(?:async )?(?:function\*?|const|let|class) )/)) {
      const name = /^(?:export )?(?:async )?(?:function\*?|const|let|class) (\w+)/.exec(block)?.[1];
      if (name) blocks.set(name, block);
    }
    out = new Map();
    for (const name of blocks.keys()) {
      const paths = new Set<string>();
      const seen = new Set([name]);
      const todo = [name];
      while (todo.length) {
        const block = blocks.get(todo.pop() as string) ?? '';
        // a helper's other strings are data (a list of paths it compares with), not what it runs
        for (const p of pathsIn(block, true)) paths.add(p);
        for (const m of block.matchAll(/['"`](\.\.?\/[\w@.+/-]*)['"`]/g)) {
          const p = path.posix.normalize(path.posix.join(path.posix.dirname(file), m[1])).replace(/\/$/, '');
          if (p && p !== '.' && !p.startsWith('..')) paths.add(p);
        }
        const code = block.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*|'(?:\\.|[^'\\\n])*'|"(?:\\.|[^"\\\n])*"|`(?:\\.|[^`\\])*`/g, ' ');
        for (const id of code.match(/\b[A-Za-z_$][\w$]*\b/g) ?? [])
          if (blocks.has(id) && !seen.has(id)) {
            seen.add(id);
            todo.push(id);
          }
      }
      out.set(name, [...paths]);
    }
    this.named.set(file, out);
    return out;
  }

  /** A specifier from a file in `from` to a file (or a folder, ending in `/`) of this checkout, or null. */
  private resolve(from: string, spec: string): string | null {
    const relative = spec.startsWith('./') || spec.startsWith('../');
    if (from && !relative) return null;
    const p = path.posix.normalize(from ? path.posix.join(from, spec) : spec).replace(/\/$/, '');
    if (!p || p === '.' || p.startsWith('..')) return null;
    for (const c of [p, `${p}.ts`, `${p}.tsx`, `${p}.mjs`, `${p}.js`, `${p}/index.ts`]) if (this.set.has(c)) return c;
    return this.dirs.has(`${p}/`) ? `${p}/` : null;
  }

  /** Every file `entries` reach through the edges `follow` takes; a folder's files are added and, when `readDirs`,
   * not followed (a test that reads a folder doesn't run it). */
  reach(entries: string[], follow: (from: string, kind: Kind, to: string) => boolean, readDirs = false): Set<string> {
    const seen = new Set<string>();
    const todo: string[] = [];
    const visit = (f: string, run: boolean) => {
      if (f.endsWith('/')) {
        for (const g of this.expand(f)) readDirs ? seen.add(g) : visit(g, true);
        return;
      }
      if (seen.has(f)) return;
      seen.add(f);
      if (run) todo.push(f);
    };
    for (const e of entries) visit(e, true);
    while (todo.length) {
      const f = todo.pop() as string;
      for (const { to, kind } of this.edgesOf(f)) if (follow(f, kind, to)) visit(to, !(readDirs && to.endsWith('/')));
    }
    return seen;
  }

  /** What a browser suite tests: its file, its covers paths and their static imports, the dynamic imports of test code
   * (they run in the suite's process) and what a helper it calls by name runs (`vr()`). Paths spelled out are not
   * followed: the harness starts server/index.ts for every suite, and a string in a check is not code that runs. */
  suiteReach(name: string): Set<string> {
    const known = this.suites.get(name);
    if (known) return known;
    const file = `test/e2e/${name}.mjs`;
    const entries = [file, ...this.coversOf(file).flatMap((c) => (c.endsWith('/') || c.includes('*') ? this.expand(c) : [c]))];
    const reach = this.reach(entries, (from, kind, to) => {
      if (kind === 'static' || kind === 'url') return true;
      if (kind === 'dynamic') return from.startsWith('test/');
      return kind === 'named' && !APP_ENTRIES.includes(to);
    });
    this.suites.set(name, reach);
    return reach;
  }

  /** What a unit test runs or reads: every import, what the helpers it calls by name run, the paths it spells out
   * itself (a file is followed into its imports, a folder only read) and its covers line. */
  unitReach(file: string): Set<string> {
    const specs = this.coversOf(file);
    const globbed = specs.filter((c) => c.includes('*'));
    const reach = this.reach([file, ...specs.filter((c) => !c.includes('*'))], (from, kind) => kind !== 'path' || from === file, true);
    for (const g of globbed) for (const f of this.expand(g)) reach.add(f);
    return reach;
  }

  /** Everything the app can run: the server and the web app, through every kind of import. */
  appCode(): Set<string> {
    this.app ??= this.reach(
      APP_ENTRIES.filter((f) => this.set.has(f)),
      (_from, kind) => kind !== 'path',
    );
    return this.app;
  }
}

/** The browser suites a change selects, each with the changed files that chose it. `everything` names the file that
 * made it all of them. */
export function suitesFor(changed: string[], suites: string[], repo = new Repo()): { names: string[]; why: Map<string, string[]>; everything?: string } {
  const all = () => ({ names: [...suites], why: new Map<string, string[]>() });
  const hit = changed.find((f) => EVERYTHING.some((e) => covers(e, f)));
  if (hit) return { ...all(), everything: `${hit} is under every screen` };
  const why = new Map<string, string[]>();
  const reaches = new Map(suites.map((s) => [s, repo.suiteReach(s)]));
  let app: Set<string> | null = null;
  for (const f of changed) {
    const by = suites.filter((s) => reaches.get(s)?.has(f));
    for (const s of by) why.set(s, [...(why.get(s) ?? []), f]);
    if (by.length) continue;
    app ??= repo.appCode();
    if (app.has(f)) return { ...all(), everything: `no suite's covers line reaches ${f}` };
  }
  return { names: suites.filter((s) => why.has(s)), why };
}

/** The unit test files a change selects (repository paths), each with the changed files that chose it. */
export function unitTestsFor(changed: string[], repo = new Repo()): { files: string[]; why: Map<string, string[]>; everything?: string } {
  const tests = repo.files.filter((f) => /^test\/unit\/[^/]+\.test\.ts$/.test(f)).sort();
  const hit = changed.find((f) => EVERY_UNIT.includes(f));
  if (hit) return { files: tests, why: new Map(), everything: `${hit} changed` };
  const why = new Map<string, string[]>();
  for (const t of tests) {
    const reach = repo.unitReach(t);
    const by = changed.filter((f) => reach.has(f));
    if (by.length) why.set(t, by);
  }
  return { files: tests.filter((t) => why.has(t)), why };
}

/** The base a branch is compared with: the one asked for, else `main`, else `origin/main`. */
export function baseRef(asked?: string, cwd = ROOT): string {
  const exists = (ref: string) => {
    try {
      git(cwd, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`);
      return true;
    } catch {
      return false;
    }
  };
  for (const ref of asked ? [asked] : ['main', 'origin/main']) if (exists(ref)) return ref;
  throw new Error(asked ? `no commit ${asked} to compare with` : 'neither main nor origin/main exists: name a base (--changed <ref>)');
}

/** The files this branch changed since it left `base` (git diff base...HEAD), plus what isn't committed yet: staged,
 * unstaged and new files git doesn't ignore. A rename counts as both names. package.json counts only when more than
 * its scripts changed: a new script line runs nothing new, while a dependency can change anything. */
export function changedFiles(base: string, cwd = ROOT): string[] {
  const lines = (s: string) => s.split('\n').filter(Boolean);
  const files = new Set([
    ...lines(git(cwd, 'diff', '--name-only', '--no-renames', `${base}...HEAD`)),
    ...lines(git(cwd, 'diff', '--name-only', '--no-renames', 'HEAD')),
    ...lines(git(cwd, 'ls-files', '--others', '--exclude-standard')),
  ]);
  if (files.has('package.json') && onlyScripts(base, cwd)) files.delete('package.json');
  return [...files].sort();
}

function onlyScripts(base: string, cwd: string): boolean {
  try {
    const was = JSON.parse(git(cwd, 'show', `${git(cwd, 'merge-base', base, 'HEAD').trim()}:package.json`));
    const now = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf8'));
    delete was.scripts;
    delete now.scripts;
    return JSON.stringify(was) === JSON.stringify(now);
  } catch {
    return false;
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

/** The checkout's files: tracked, and new ones git doesn't ignore (never data/, cache/ or node_modules). */
function listFiles(root: string): string[] {
  return git(root, 'ls-files', '--cached', '--others', '--exclude-standard')
    .split('\n')
    .filter((f) => f && fs.existsSync(path.join(root, f)));
}

/** The repository paths a piece of test code spells out: the literal arguments after ROOT (`path.join(ROOT, 'bin',
 * 'vr-mcp')` is bin/vr-mcp) and, unless `rootOnly`, any other string shaped like a path ('test/e2e/lib/suites.mjs',
 * '.github/workflows'). Whether one names a file of this checkout is the caller's question. */
function pathsIn(text: string, rootOnly = false): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/\bROOT,\s*((?:['"][^'"$\n]+['"]\s*,?\s*)+)\)/g)) out.push([...m[1].matchAll(/['"]([^'"]+)['"]/g)].map((p) => p[1]).join('/'));
  if (!rootOnly) for (const m of text.matchAll(/['"`]((?:\.[\w-]+|[\w@+-][\w@.+-]*)(?:\/[\w@.+-]+)+\/?)['"`]/g)) out.push(m[1]);
  return out;
}

const isScript = (file: string, text: string) =>
  /\.(?:[cm]?[jt]sx?)$/.test(file) || (!path.posix.basename(file).includes('.') && text.startsWith('#!/usr/bin/env node'));
