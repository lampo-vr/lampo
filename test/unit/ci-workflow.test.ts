// What the CI workflows promise (.github/workflows/): every job has a time limit (GitHub's default is six hours); no
// workflow touches a secret; the browser parts together run every suite but WebKit exactly once, so a suite can't fall
// out of CI unnoticed; the suites run on the browser their time budgets were measured on (chrome-headless-shell from
// `npm run chrome:install`, cached per version — not the runner's Chrome, which CHROME_PATH would force); and macOS
// runs only when asked. The public repository runs every job on GitHub's ubuntu-latest. Only a private copy sends
// check, unit and e2e to a self-hosted runner, for main, runs by hand and the team's pull requests, never a fork's or
// Dependabot's (code nobody there read); nothing that can run there calls sudo, and every job there cleans up after
// itself; Docker stays on GitHub's runners.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT, tmpdir } from '../lib/helpers.ts';

const DIR = path.join(ROOT, '.github/workflows');
const workflows = Object.fromEntries(
  fs
    .readdirSync(DIR)
    .filter((f) => f.endsWith('.yml'))
    .map((f) => [f, fs.readFileSync(path.join(DIR, f), 'utf8')]),
);
const ci = workflows['ci.yml'];
/** The jobs of a workflow: each two-space indented key under `jobs:` with its block. */
const jobsOf = (yml: string): Record<string, string> => {
  const body = yml.slice(yml.indexOf('\njobs:\n') + 7);
  const out: Record<string, string> = {};
  for (const block of body.split(/\n(?= {2}[\w-]+:\n)/)) {
    const name = /^ {2}([\w-]+):/.exec(block)?.[1];
    if (name) out[name] = block;
  }
  return out;
};

test('every job of every workflow has a time limit, and no workflow reads a secret', () => {
  assert.ok(ci && workflows['macos.yml'], 'ci.yml and macos.yml');
  for (const [file, yml] of Object.entries(workflows)) {
    const jobs = jobsOf(yml);
    assert.ok(Object.keys(jobs).length, `${file} has jobs`);
    for (const [name, block] of Object.entries(jobs)) assert.match(block, /\n {4}timeout-minutes: \d+\n/, `${file}: ${name} has timeout-minutes`);
    assert.doesNotMatch(yml, /secrets\./, `${file} reads no secret`);
  }
});

test('the browser parts together run every suite except WebKit, each once', async () => {
  const { shard, suiteNames } = await import(pathToFileURL(path.join(ROOT, 'test/e2e/lib/suites.mjs')).href);
  const e2e = jobsOf(ci).e2e;
  const parts = Number(/\n {8}part: \[([\d, ]+)\]/.exec(e2e)?.[1].split(',').length);
  assert.match(e2e, new RegExp(`npm run test:e2e -- --except webkit --shard \\$\\{\\{ matrix\\.part \\}\\}/${parts} --jobs 2\\n`));
  const run = Array.from({ length: parts }, (_, i) =>
    shard(
      (suiteNames() as string[]).filter((s) => s !== 'webkit'),
      i + 1,
      parts,
    ),
  ).flat();
  assert.deepEqual(
    [...run].sort(),
    (suiteNames() as string[]).filter((s) => s !== 'webkit'),
  );
  assert.ok(suiteNames().includes('webkit') && /npm run test:webkit/.test(workflows['macos.yml']), 'WebKit runs on macOS');
});

test('the Chrome job installs the suites’ own browser, cached by its version, and never points CHROME_PATH elsewhere', () => {
  const e2e = jobsOf(ci).e2e;
  assert.doesNotMatch(e2e, /CHROME_PATH/, 'CHROME_PATH overrides the shell the budgets were set on');
  const cache = /uses: actions\/cache@v\d+\n(?:\s+.+\n)*?\s+with:\n((?:\s{10}.+\n)+)/.exec(e2e)?.[1] || '';
  assert.match(cache, /path: cache\/chrome\n/, 'caches cache/chrome');
  assert.match(cache, /key: .*\$\{\{ steps\.chrome\.outputs\.version \}\}/, 'keyed on the resolved version');
  assert.match(e2e, /id: chrome\n[\s\S]*?resolveBuildId\(b\.Browser\.CHROMEHEADLESSSHELL/, 'the version is the stable shell’s');
  assert.match(e2e, /if: steps\.chrome-cache\.outputs\.cache-hit != 'true'\n\s+run: npm run chrome:install/, 'installed only on a miss');
  assert.ok(e2e.indexOf('npm run chrome:install') < e2e.indexOf('test:e2e'), 'before the suites run');
});

test('macOS runs only when asked: by hand, or on a pull request labelled macos', () => {
  const mac = workflows['macos.yml'];
  assert.doesNotMatch(mac, /\n {2}push:|\n {2}schedule:/, 'not on pushes or a schedule');
  for (const [name, block] of Object.entries(jobsOf(mac)))
    assert.match(
      block,
      /\n {4}if: github\.event_name == 'workflow_dispatch' \|\| contains\(github\.event\.pull_request\.labels\.\*\.name, 'macos'\)\n/,
      `${name} asks for the label`,
    );
  assert.doesNotMatch(ci, /runs-on: .*macos/, 'nothing in ci.yml runs on macOS');
});

/** The self-hosted runner a private copy of the repository sends its own jobs to. */
const OURS = ['self-hosted', 'linux', 'x64', 'lampo-ci'];
/** A GitHub expression of the shapes ci.yml uses (`github.…` paths, ==, !=, !, &&, ||, fromJSON, strings), evaluated for
 * one event the way GitHub would. A missing property is null, as there. */
const evaluate = (expr: string, github: object): unknown => {
  if (!expr.startsWith('${{')) return expr;
  const js = expr
    .replace(/^\$\{\{\s*|\s*\}\}$/g, '')
    .replace(/\bgithub((?:\.[\w-]+)+)/g, (_, p: string) => `get(${JSON.stringify(p.slice(1))})`)
    .replace(/\bfromJSON\(/g, 'JSON.parse(')
    .replace(/([!=])=/g, '$1==');
  const get = (p: string) => p.split('.').reduce<unknown>((o, k) => (o == null ? null : (o as Record<string, unknown>)[k]), github) ?? null;
  return new Function('get', `return (${js});`)(get);
};
const REPO = 'lampo-vr/lampo';
const pr = (head: object | null, login = 'someone') => ({
  event_name: 'pull_request',
  repository: REPO,
  event: { pull_request: { head: { repo: head }, user: { login } } },
});
/** Each event, and where it runs in a private copy of the repository. */
const PRIVATE: [string, object, 'ours' | 'github'][] = [
  ['a push to main', { event_name: 'push', repository: REPO, ref: 'refs/heads/main' }, 'ours'],
  ['a run by hand', { event_name: 'workflow_dispatch', repository: REPO }, 'ours'],
  ['a pull request from a branch here', pr({ full_name: REPO, fork: false }), 'ours'],
  ['a pull request from a fork', pr({ full_name: 'stranger/lampo', fork: true }), 'github'],
  ['a fork that says it is none', pr({ full_name: 'stranger/lampo', fork: false }), 'github'],
  ['a fork under our name', pr({ full_name: REPO, fork: true }), 'github'],
  ['a pull request whose fork is gone', pr(null), 'github'],
  ['Dependabot’s pull request', pr({ full_name: REPO, fork: false }, 'dependabot[bot]'), 'github'],
];
/** The same event in a repository that is private, public, or (never on GitHub, whose payloads always say) neither. */
const inRepo = (github: { event?: object }, visibility: boolean | null) => ({
  ...github,
  event: { ...github.event, ...(visibility === null ? {} : { repository: { private: visibility } }) },
});
/** Every event three times: in a private copy where it runs as PRIVATE says; in the public repository, and where the
 * payload doesn't say, always on GitHub's runners. */
const EVENTS: [string, object, 'ours' | 'github'][] = PRIVATE.flatMap(([what, github, where]): [string, object, 'ours' | 'github'][] => [
  [`${what} in a private copy`, inRepo(github, true), where],
  [`${what} in the public repository`, inRepo(github, false), 'github'],
  [`${what} where the payload doesn’t say`, inRepo(github, null), 'github'],
]);
const runsOn = (block: string) => /\n {4}runs-on: (.+)\n/.exec(block)?.[1] ?? '';
/** A job's steps, each with its text and its `if:`. */
const stepsOf = (block: string) =>
  block
    .split(/\n {6}- /)
    .slice(1)
    .map((text) => ({ text, if: /^(?: {8})?if: (.+)$/m.exec(text)?.[1] ?? '' }));
/** Whether a job lands on a self-hosted runner for this event (an expression, or a plain label list). */
const lands = (block: string, github: object) => JSON.stringify(evaluate(runsOn(block), github)).includes('self-hosted');
/** The jobs that can land on the self-hosted runner. */
const ourJobs = () => Object.entries(jobsOf(ci)).filter(([, block]) => EVENTS.some(([, github]) => lands(block, github)));

test('the public repository runs every job on GitHub’s ubuntu-latest, whatever the event', () => {
  for (const [name, block] of Object.entries(jobsOf(ci)))
    for (const [what, github] of PRIVATE) assert.equal(evaluate(runsOn(block), inRepo(github, false)), 'ubuntu-latest', `${name}, ${what}`);
});

test('a private copy sends check, unit and e2e to its runner for main, by hand and its own branches; a fork’s or Dependabot’s pull request never', () => {
  const jobs = jobsOf(ci);
  for (const name of ['check', 'test', 'e2e'])
    for (const [what, github, where] of EVENTS)
      assert.deepEqual(evaluate(runsOn(jobs[name]), github), where === 'ours' ? OURS : 'ubuntu-latest', `${name}, ${what}`);
  for (const [name, block] of Object.entries(jobs))
    for (const [what, github, where] of EVENTS) if (where === 'github') assert.ok(!lands(block, github), `${name} never takes ${what} to a self-hosted runner`);
  assert.deepEqual(
    ourJobs().map(([n]) => n),
    ['check', 'test', 'e2e'],
  );
  for (const [name, block] of ourJobs()) {
    assert.match(runsOn(block), /^\$\{\{ github\.event\.repository\.private && /, `${name}: only a private repository asks for the runner`);
    assert.match(runsOn(block), / \|\| 'ubuntu-latest' \}\}$/, `${name}: whatever isn't ours lands on GitHub's`);
  }
});

test('the Docker job stays on GitHub’s runner: a self-hosted one has no Docker access', () => {
  assert.equal(runsOn(jobsOf(ci).docker), 'ubuntu-latest');
  for (const [name, block] of ourJobs()) assert.doesNotMatch(block, /\bdocker /, `${name} calls no docker`);
});

test('nothing that can run on a self-hosted runner calls sudo or installs a package', () => {
  for (const [name, block] of ourJobs())
    for (const step of stepsOf(block))
      if (/\bsudo\b|apt-get|apt install|brew install/.test(step.text))
        assert.equal(step.if, "runner.environment == 'github-hosted'", `${name}: "${step.text.split('\n')[0]}" runs only on GitHub's runners`);
});

test('on a self-hosted runner a job checks for what it needs, keeps its files in the work dir, holds no token and leaves nothing running', () => {
  for (const [name, block] of ourJobs()) {
    const steps = stepsOf(block);
    const at = (re: RegExp) => steps.findIndex((s) => re.test(s.text));
    assert.match(steps[0].text, /^uses: actions\/checkout@v\d+\n\s+with:\n\s+persist-credentials: false$/, `${name}: the token stays out of .git/config`);
    assert.equal(at(/ci-runner\.sh env/), 1, `${name}: temp files and the npm cache move to the work dir first`);
    assert.ok(at(/ci-runner\.sh env/) < at(/actions\/setup-node/), `${name}: before setup-node asks npm where its cache is`);
    const last = steps[steps.length - 1];
    assert.match(last.text, /run: scripts\/ci-runner\.sh cleanup\n*$/, `${name}: the last step stops what the job left running`);
    assert.equal(last.if, "always() && runner.environment == 'self-hosted'", `${name}: even when the job failed or was cancelled`);
  }
  const at = (steps: { text: string }[], re: RegExp) => steps.findIndex((s) => re.test(s.text));
  const unit = stepsOf(jobsOf(ci).test);
  assert.ok(at(unit, /ci-runner\.sh need ffmpeg ocr spelling/) < at(unit, /run: npm test/), 'unit checks ffmpeg, tesseract and hunspell first');
  const e2e = stepsOf(jobsOf(ci).e2e);
  assert.ok(at(e2e, /ci-runner\.sh need ffmpeg/) < at(e2e, /test:e2e/));
  const chrome = at(e2e, /ci-runner\.sh need chrome/);
  assert.ok(at(e2e, /npm run chrome:install/) < chrome && chrome < at(e2e, /test:e2e/), 'Chrome’s libraries are checked once it is there');
});

test('unit test files at a time are held to the self-hosted runner’s CPUs, and left to Node on GitHub’s', () => {
  const jobs = /\n {6}LAMPO_TEST_JOBS: (.+)\n/.exec(jobsOf(ci).test)?.[1] ?? '';
  assert.match(jobs, /^\$\{\{ github\.event\.repository\.private && /, 'the same condition as runs-on');
  for (const [what, github, where] of EVENTS) assert.equal(evaluate(jobs, github), where === 'ours' ? '8' : '', what);
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(
    pkg.scripts.test,
    /^node --test \$\{VR_TEST_JOBS:\+--test-concurrency=\$VR_TEST_JOBS\} \$\{LAMPO_TEST_JOBS:\+--test-concurrency=\$LAMPO_TEST_JOBS\} /,
    'npm test reads it, LAMPO_ last so it wins (before the files: node ignores it after them)',
  );
});

test('a newer push cancels the run before it, on main too', () => {
  assert.match(ci, /\nconcurrency:\n {2}group: ci-\$\{\{ github\.ref \}\}\n {2}cancel-in-progress: true\n/);
});

test('ci-runner.sh names what the runner lacks and fails; it never installs anything', () => {
  const script = path.join(ROOT, 'scripts/ci-runner.sh');
  const code = fs.readFileSync(script, 'utf8').replace(/^\s*#.*$/gm, '');
  assert.doesNotMatch(code, /(^|[;&|]\s*)(sudo|apt-get|apt|dpkg)\s/m, 'checks, never installs');
  const bare = tmpdir('vr-ci-runner-');
  try {
    // a PATH with the shell's own tools and nothing else: no ffmpeg, no tesseract
    for (const tool of ['sh', 'dirname', 'basename', 'tr', 'grep', 'printf', 'find', 'awk', 'cat']) {
      const found = spawnSync('sh', ['-c', `command -v ${tool}`], { encoding: 'utf8' }).stdout.trim();
      if (found.startsWith('/')) fs.symlinkSync(found, path.join(bare, tool));
    }
    const run = (...args: string[]) => spawnSync(path.join(bare, 'sh'), [script, ...args], { encoding: 'utf8', env: { PATH: bare } });
    const r = run('need', 'ffmpeg', 'ocr');
    assert.equal(r.status, 1, r.stderr);
    assert.match(r.stderr, /ffmpeg \(apt: ffmpeg\)/);
    assert.match(r.stderr, /ffprobe/);
    assert.match(r.stderr, /tesseract \(apt: tesseract-ocr/);
    assert.match(r.stderr, /operator installs these/);
    assert.equal(run('need', 'nonsense').status, 2, 'an unknown need is a mistake in the workflow');
    assert.equal(run('frobnicate').status, 2);
  } finally {
    fs.rmSync(bare, { recursive: true, force: true });
  }
});

test('perf runs on CI, with --perf, by --only or --changed, and in test:all; a plain local run leaves it out and says so', async () => {
  const { withPerf } = await import(pathToFileURL(path.join(ROOT, 'test/e2e/lib/suites.mjs')).href);
  const names = ['library', 'perf', 'quality'];
  const local = withPerf(names, { perf: false, only: null, changed: null }, {});
  assert.deepEqual(local.names, ['library', 'quality']);
  assert.match(local.note, /perf left out/);
  for (const [o, env] of [
    [{ perf: true, only: null, changed: null }, {}],
    [{ perf: false, only: null, changed: null }, { GITHUB_ACTIONS: 'true' }],
    [{ perf: false, only: ['perf'], changed: null }, {}],
    [{ perf: false, only: null, changed: '' }, {}],
  ])
    assert.deepEqual(withPerf(names, o, env), { names, note: null }, JSON.stringify([o, env]));
  assert.match(JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts['test:all'], /test:e2e -- --perf$/);
});
