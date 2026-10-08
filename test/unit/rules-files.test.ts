// covers: AGENTS.md CLAUDE.md .claude/rules/ .gitignore
// The rules learned the hard way live per area in .claude/rules/ (AGENTS.md "Rules learned the hard way"): Claude Code
// loads a file when it opens one its `paths` match, and every other agent finds it through the table in AGENTS.md. So
// the table and the files agree, every path still matches code, every rule sits in one place, the files are tracked,
// and the root stays short enough that every session reads all of it.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const RULES = path.join(ROOT, '.claude/rules');
const agents = fs.readFileSync(path.join(ROOT, 'AGENTS.md'), 'utf8');
const files = fs
  .readdirSync(RULES)
  .filter((f) => f.endsWith('.md'))
  .sort();
const text = (f: string) => fs.readFileSync(path.join(RULES, f), 'utf8');

/** A rules file's `paths`, from its front matter (a YAML list of quoted globs, the one form Claude Code reads here). */
function pathsOf(f: string): string[] {
  const m = /^---\npaths:\n((?: {2}- "[^"\n]+"\n)+)---\n/.exec(text(f));
  assert.ok(m, `${f} starts with front matter that lists its paths, one quoted glob per line`);
  return [...m[1].matchAll(/- "([^"]+)"/g)].map((x) => x[1]);
}

/** The table in AGENTS.md: each row's file and paths. */
const table = new Map(
  [...agents.matchAll(/^\| \[([\w-]+\.md)\]\(\.claude\/rules\/\1\) \| [^|]+ \| ([^|]+) \|$/gm)].map((m) => [
    m[1],
    [...m[2].matchAll(/`([^`]+)`/g)].map((x) => x[1]),
  ]),
);

/** Claude Code matches a rule's glob anywhere in a file's path (also inside .claude/worktrees/<name>/): `**` any depth. */
const globRe = (g: string) =>
  new RegExp(
    `(^|/)${g
      .split('**')
      .map((part) => part.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*'))
      .join('.*')}$`,
  );

/** A rule: a bullet and the lines that continue it, by the section it is under. */
function rulesIn(body: string): string[] {
  const out: string[] = [];
  let section = '';
  for (const line of body.split('\n')) {
    if (line.startsWith('#')) section = line.startsWith('### ') ? line.slice(4) : '';
    else if (section && line.startsWith('- ')) out.push(`${section}: ${line}`);
    else if (section && line.startsWith('  ') && out.length) out[out.length - 1] += `\n${line}`;
  }
  return out;
}
const rootRules = agents.slice(agents.indexOf('\n## Rules learned the hard way\n'));

test('AGENTS.md lists every rules file, with the paths it loads for, and nothing else', () => {
  assert.ok(files.length >= 5, 'the rules files are there');
  assert.deepEqual([...table.keys()].sort(), files, 'one row per file in .claude/rules/');
  for (const f of files) assert.deepEqual(table.get(f), pathsOf(f), `${f}: the table's paths are its front matter's`);
});

test('every rules file has the heading people quote, sections and rules', () => {
  for (const f of files) {
    const body = text(f);
    assert.match(body, /^## Rules learned the hard way$/m, `${f}: "Rules learned the hard way"`);
    assert.match(body, /^### .+$/m, `${f}: a section named for its area`);
    assert.ok(rulesIn(body).length >= 3, `${f}: holds rules`);
  }
});

test('every path matches tracked code, so a move or rename never leaves rules that load for nothing', {
  skip: !fs.existsSync(path.join(ROOT, '.git')) && 'not a git checkout',
}, () => {
  const tracked = execFileSync('git', ['ls-files'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  for (const f of files)
    for (const g of pathsOf(f))
      assert.ok(
        tracked.some((t) => globRe(g).test(t)),
        `${f}: ${g} matches no tracked file`,
      );
});

test('each rule lives in one place: the root or one rules file', () => {
  const all = [...rulesIn(rootRules), ...files.flatMap((f) => rulesIn(text(f)))];
  const seen = new Set<string>();
  for (const r of all) {
    assert.ok(!seen.has(r), `twice: ${r.slice(0, 100)}`);
    seen.add(r);
  }
});

test('the rules files are tracked, never ignored', { skip: !fs.existsSync(path.join(ROOT, '.git')) && 'not a git checkout' }, () => {
  for (const f of files) {
    let ignored = true;
    try {
      execFileSync('git', ['check-ignore', '-q', '--no-index', `.claude/rules/${f}`], { cwd: ROOT });
    } catch {
      ignored = false;
    }
    assert.ok(!ignored, `.claude/rules/${f} is ignored by .gitignore`);
  }
});

// .claude/ is private but for skills/ and rules/ (.gitignore): only what this table lists may sit in rules/, so nothing
// else rides along into the public repository with it.
test('.claude/rules/ holds the listed rules files and nothing else', { skip: !fs.existsSync(path.join(ROOT, '.git')) && 'not a git checkout' }, () => {
  const tracked = execFileSync('git', ['ls-files', '.claude/rules'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  const onDisk = fs.readdirSync(RULES, { recursive: true, encoding: 'utf8' }).map((f) => `.claude/rules/${f}`);
  const listed = new Set([...table.keys()].map((f) => `.claude/rules/${f}`));
  for (const f of [...tracked, ...onDisk]) assert.ok(listed.has(f), `${f} is not a rules file the table in AGENTS.md lists`);
});

// The instruction files are public: they say how the project works, never whose machine, address or network it runs on.
// Placeholders stay what they are (you@example.com, 127.0.0.1, the documentation ranges, a GitHub noreply address).
test('the public instruction files carry nothing private: no home paths, addresses, internal networks or keys', {
  skip: !fs.existsSync(path.join(ROOT, '.git')) && 'not a git checkout',
}, () => {
  const publicFiles = execFileSync('git', ['ls-files', '.claude', 'AGENTS.md', 'CLAUDE.md'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
  assert.ok(publicFiles.some((f) => f.startsWith('.claude/rules/')) && publicFiles.includes('AGENTS.md'), 'the scan sees the files');
  const placeholderMail = /@example\.(com|org|net)$|@users\.noreply\.github\.com$|^noreply@/i;
  const placeholderIp = /^(127\.0\.0\.1|0\.0\.0\.0|192\.0\.2\.\d+|198\.51\.100\.\d+|203\.0\.113\.\d+)$/;
  // built from parts, so this file holds no key-shaped string itself
  const keyShapes = new RegExp(['sk_' + 'live_', 'rk_' + 'live_', 'ghp_' + '[A-Za-z0-9]{20}', 'BEGIN [A-Z ]*PRIVATE ' + 'KEY'].join('|'));
  for (const f of publicFiles) {
    const t = fs.readFileSync(path.join(ROOT, f), 'utf8');
    for (const m of t.matchAll(/(?:\/Users|\/home)\/[^/\s`'")]+/g)) assert.fail(`${f}: a home path (${m[0]})`);
    for (const m of t.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)) assert.ok(placeholderMail.test(m[0]), `${f}: an email address (${m[0]})`);
    for (const m of t.matchAll(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g)) assert.ok(placeholderIp.test(m[0]), `${f}: an IP address (${m[0]})`);
    assert.doesNotMatch(t, keyShapes, `${f}: something shaped like a key`);
  }
});

test('the root stays short: what every session reads, and the way to the rest', () => {
  // Anthropic's guidance for an instruction file: under 200 lines (code.claude.com/docs/en/memory). Past it, a rule
  // about one area of the code goes to that area's file.
  assert.ok(agents.split('\n').length <= 200, `AGENTS.md has ${agents.split('\n').length} lines`);
  const head = agents.slice(0, agents.indexOf('\n## '));
  assert.match(head, /\.claude\/rules\//, 'the reading order at the top names .claude/rules/');
  for (const name of ['## How work is done here', '## Invariants', '## Vocabulary', '## Rules learned the hard way'])
    assert.ok(agents.includes(`\n${name}\n`), `AGENTS.md keeps "${name.slice(3)}"`);
  const claude = fs.readFileSync(path.join(ROOT, 'CLAUDE.md'), 'utf8');
  assert.match(claude, /^@AGENTS\.md$/m, 'CLAUDE.md imports AGENTS.md');
  assert.match(claude, /^@AGENTS\.local\.md$/m, 'CLAUDE.md imports AGENTS.local.md');
});

test('the glob reading matches Claude Code: anywhere in the path, ** across folders, * within one', () => {
  assert.ok(globRe('server/**').test('server/routes/files.ts'));
  assert.ok(globRe('server/**').test('.claude/worktrees/x/server/app.ts'), 'a worktree under .claude/worktrees/');
  assert.ok(!globRe('server/**').test('lib/serverless.ts'));
  assert.ok(globRe('README.md').test('README.md'));
  assert.ok(globRe('test/unit/access-ends.test.ts').test('test/unit/access-ends.test.ts'));
  assert.ok(!globRe('lib/*.ts').test('lib/oauth/store.ts'));
});
