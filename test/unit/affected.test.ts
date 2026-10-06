// What `npm run test:e2e -- --changed` and `npm run test:changed` run (test/lib/affected.ts): the browser suites a
// change can affect by each suite's covers line and the import graph, the unit tests by what they import, and the
// files a branch changed by git. Every suite says what it covers, and every path it names still names a file, so the
// map can't rot quietly when code moves.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { baseRef, changedFiles, EVERYTHING, Repo, suitesFor, unitTestsFor } from '../lib/affected.ts';
import { ROOT, tmpdir } from '../lib/helpers.ts';

// A specifier the type checker doesn't resolve: the runner is plain JavaScript.
const { suiteNames } = await import(pathToFileURL(path.join(ROOT, 'test/e2e/lib/suites.mjs')).href);
const SUITES: string[] = suiteNames();
const repo = new Repo();
const picks = (...files: string[]) => suitesFor(files, SUITES, repo);

test('a change to the notes panel runs the notes, player and quality suites, not account or insights', () => {
  const { names, why, everything } = picks('web/src/player/NotesPanel.tsx');
  assert.equal(everything, undefined);
  for (const s of ['notes', 'player', 'quality']) assert.ok(names.includes(s), `${s} runs`);
  for (const s of ['account', 'insights']) assert.ok(!names.includes(s), `${s} doesn't`);
  assert.deepEqual(why.get('notes'), ['web/src/player/NotesPanel.tsx'], 'each suite names the file that chose it');
});

test('the data contract, the shell, the UI blocks, the tokens and the dependencies run every suite', () => {
  for (const f of ['lib/types.ts', 'server/app.ts', 'web/src/ui/system.tsx', 'web/src/styles/base.css', 'package-lock.json']) {
    const { names, everything } = picks(f);
    assert.deepEqual(names, SUITES, f);
    assert.match(everything ?? '', new RegExp(f.replace(/[.]/g, '\\.')));
  }
  assert.deepEqual(picks('test/e2e/lib/checks.mjs').names, SUITES, 'the harness every suite imports: all of them, through the graph');
});

test('docs, unit tests and the runner run no suite; a suite file runs itself', () => {
  assert.deepEqual(picks('docs/agents.md', 'test/unit/range.test.ts', 'CHANGELOG.md', 'test/e2e/lib/suites.mjs').names, []);
  assert.deepEqual(picks('test/e2e/range.mjs').names, ['range']);
});

test('every suite says what it covers on its first lines, and every path there names files', () => {
  const wrong: string[] = [];
  for (const s of SUITES) {
    const file = `test/e2e/${s}.mjs`;
    const top = repo
      .read(file)
      .split('\n')
      .filter((l) => !l.startsWith('#!'));
    if (!top[0]?.startsWith('// covers: ')) wrong.push(`${file}: the first line (after a #!) is // covers: <paths>`);
    for (const c of repo.coversOf(file)) if (!repo.expand(c).length) wrong.push(`${file}: covers ${c}, which names no file`);
  }
  assert.deepEqual(wrong, []);
});

test('code the app runs that no suite covers runs every suite, and says which file', () => {
  const uncovered = [...repo.appCode()].filter((f) => !EVERYTHING.some((e) => (e.endsWith('/') ? f.startsWith(e) : f === e)) && !picks(f).why.size);
  for (const f of uncovered) assert.match(picks(f).everything ?? '', new RegExp(`no suite.*${f.replace(/[.]/g, '\\.')}`), f);
  // plumbing every request goes through, nothing a single suite tests: keep the list short by adding a covers path
  assert.ok(uncovered.length <= 12, `few files fall through to every suite: ${uncovered.join(', ')}`);
});

test('the graph: static imports, not `import type`; a dynamic import is a chunk a suite must name; test code’s run', () => {
  const dir = tmpdir('vr-affected-');
  const files: Record<string, string> = {
    'web/src/main.tsx': "import './App.tsx';\n",
    'web/src/App.tsx': "import { a } from './a.ts';\nconst Screen = () => import('./screen/Screen.tsx');\n",
    'web/src/a.ts': "import type { T } from '../../server/context.ts';\nexport const a = 1;\n",
    'web/src/screen/Screen.tsx': "import { b } from './b.ts';\nimport '../styles/screen.css';\n",
    'web/src/screen/b.ts': 'export const b = 2;\n',
    'web/src/styles/screen.css': "@import './bits.css';\n",
    'web/src/styles/bits.css': '.x {}\n',
    'server/index.ts': "import './context.ts';\n",
    'server/context.ts': 'export type T = 1;\n',
    'test/lib/helpers.ts':
      "export const ROOT = '';\nconst VR = path.join(ROOT, 'bin/vr');\nexport function vr() {\n  return VR;\n}\nexport const id = 'vr-x';\n",
    'test/lib/builder.ts': "await import('../../web/src/screen/b.ts');\n",
    'bin/vr': "#!/usr/bin/env node\nawait launch(new URL('../lib/cli.ts', import.meta.url));\n",
    'lib/cli.ts': 'export const cli = 1;\n',
    'test/e2e/screen.mjs': "#!/usr/bin/env node\n// covers: web/src/screen/Screen.tsx\nimport './lib/checks.mjs';\n",
    'test/e2e/shell.mjs': "// covers: web/src/a.ts test/lib/builder.ts\nimport { vr } from '../lib/helpers.ts';\nimport './lib/checks.mjs';\n",
    'test/e2e/lib/checks.mjs': '',
    'test/unit/cli.test.ts': "import { vr } from '../lib/helpers.ts';\n",
    'test/unit/id.test.ts': "import { id } from '../lib/helpers.ts';\nconst f = path.join(ROOT, 'docs');\n",
    'docs/x.md': '',
    'package.json': '{}',
  };
  for (const [f, text] of Object.entries(files)) {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  }
  try {
    const r = new Repo(dir, Object.keys(files));
    const suites = ['screen', 'shell'];
    const run = (f: string) => suitesFor([f], suites, r);
    assert.deepEqual(run('web/src/styles/bits.css').names, ['screen'], 'CSS @import is followed');
    assert.deepEqual(run('web/src/screen/b.ts').names, ['screen', 'shell'], 'static from the screen; dynamic from test code');
    assert.deepEqual(run('lib/cli.ts').names, ['shell'], 'vr() runs bin/vr, which runs lib/cli.ts');
    assert.equal(run('server/context.ts').everything, "no suite's covers line reaches server/context.ts", 'not through `import type`');
    assert.deepEqual(run('web/src/screen/Screen.tsx').names, ['screen'], 'App’s dynamic import is not followed into a screen');
    assert.equal(run('docs/x.md').names.length + (run('docs/x.md').everything ? 1 : 0), 0, 'what the app doesn’t run selects nothing');

    const unit = (...f: string[]) => unitTestsFor(f, r).files;
    assert.deepEqual(unit('lib/cli.ts'), ['test/unit/cli.test.ts'], 'only the test that calls vr(), not every importer of the helper');
    assert.deepEqual(unit('docs/x.md'), ['test/unit/id.test.ts'], 'a folder the test names is read');
    assert.deepEqual(unit('test/unit/id.test.ts'), ['test/unit/id.test.ts'], 'a changed test runs itself');
    assert.deepEqual(unit('package.json'), ['test/unit/cli.test.ts', 'test/unit/id.test.ts'], 'package.json runs them all');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('unit tests in this checkout: by what they import, the paths they name, themselves', () => {
  const unit = (f: string) => unitTestsFor([f], repo).files;
  const hashtags = unit('web/src/player/hashtags.ts');
  assert.ok(hashtags.includes('test/unit/hashtags.test.ts'), 'the test that imports it');
  assert.ok(!hashtags.includes('test/unit/ci-workflow.test.ts'));
  assert.ok(unit('.github/workflows/ci.yml').includes('test/unit/ci-workflow.test.ts'), 'a path the test names');
  assert.ok(unit('lib/cli.ts').includes('test/unit/cli.test.ts'), 'through vr() in test/lib/helpers.ts');
  assert.ok(unit('lib/cli.ts').length < 200, 'importing helpers.ts is not running the CLI');
});

test('changed files: the branch since it left its base, plus staged, unstaged and new ones; a script line is not a dependency', () => {
  const dir = tmpdir('vr-affected-git-');
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { cwd: dir, encoding: 'utf8' });
  const write = (f: string, text = f) => {
    fs.mkdirSync(path.join(dir, path.dirname(f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), text);
  };
  try {
    git('init', '-q', '-b', 'main');
    write('a.ts');
    write('old.ts');
    write('package.json', JSON.stringify({ scripts: { a: '1' }, dependencies: { x: '1' } }));
    git('add', '-A');
    git('commit', '-qm', 'base');
    git('checkout', '-qb', 'work');
    write('b.ts');
    git('mv', 'old.ts', 'new.ts');
    git('add', '-A');
    git('commit', '-qm', 'work');
    git('checkout', '-q', 'main');
    write('on-main.ts');
    git('add', '-A');
    git('commit', '-qm', 'main moved on');
    git('checkout', '-q', 'work');
    write('a.ts', 'changed');
    write('staged.ts');
    git('add', 'staged.ts');
    write('untracked.ts');
    write('package.json', JSON.stringify({ scripts: { a: '2' }, dependencies: { x: '1' } }));
    assert.equal(baseRef(undefined, dir), 'main');
    assert.deepEqual(
      changedFiles('main', dir),
      ['a.ts', 'b.ts', 'new.ts', 'old.ts', 'staged.ts', 'untracked.ts'],
      'not on-main.ts, not a scripts-only package.json',
    );
    write('package.json', JSON.stringify({ scripts: { a: '2' }, dependencies: { x: '2' } }));
    assert.ok(changedFiles('main', dir).includes('package.json'), 'a dependency is a change');
    assert.throws(() => baseRef('nope', dir), /no commit nope/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
