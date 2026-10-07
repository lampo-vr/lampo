// The command is `lampo`; `vr`, its name before, is the same command for setups made then (agents' skills, scripts,
// CI). Both print the same, byte for byte, on stdout — agents parse it — whether the settings are spelled LAMPO_ or
// VR_, and `vr` says nothing more unless a person at a terminal runs it. bin/lampo-mcp and bin/vr-mcp serve the same.
// (LAMPO_TEST_CLI=lampo runs every CLI test file through bin/lampo instead of bin/vr.)
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { age, isolatedEnv, makeVideo, must, ROOT } from '../lib/helpers.ts';

const { dir, env } = isolatedEnv();
for (const k of ['REMOTE', 'SERVER', 'TOKEN', 'BY']) {
  delete env[`VR_${k}`];
  delete env[`LAMPO_${k}`];
}
/** The same settings in the old spelling (what `vr` setups have) and the new one. */
const spelled = (to: 'VR_' | 'LAMPO_'): NodeJS.ProcessEnv =>
  Object.fromEntries(Object.entries(env).map(([k, v]) => [k.startsWith('VR_') ? to + k.slice(3) : k, v]));
const OLD = { ...spelled('VR_'), VR_REMOTE: '0' };
const NEW = { ...spelled('LAMPO_'), LAMPO_REMOTE: '0' };
const run = (name: 'vr' | 'lampo', args: string[], e: NodeJS.ProcessEnv = name === 'vr' ? OLD : NEW) => {
  const r = spawnSync(process.execPath, [path.join(ROOT, 'bin', name), ...args], { env: e, encoding: 'utf8', timeout: 60_000 });
  return { code: r.status, out: r.stdout, err: r.stderr };
};

const video = makeVideo(path.join(dir, 'proj/export/names.mp4'), { dur: 1 });
age(video);
const closers: (() => Promise<void>)[] = [];
after(async () => {
  for (const c of closers) await c().catch(() => {});
});

test('a store made through lampo, read through either name: the same stdout, byte for byte, and nothing on stderr', () => {
  assert.equal(run('lampo', ['track', video, '--session', 'names-test', '--folder', 'Proj/Cuts']).code, 0);
  const added = run('lampo', ['add', 'names.mp4', '--frame', '12', '--text', 'Logo zu früh', '--severity', 'must', '--box', '10,10,40,20', '--by', 'alex']);
  assert.equal(added.code, 0, added.err);
  const id = must(/(c_[0-9a-f]{6}) pinned/.exec(added.out)?.[1], added.out);
  const asked = run('vr', ['add', 'names.mp4', '--frame', '6', '--text', 'Name richtig?', '--choice', 'Ja', '--choice', 'Nein', '--by', 'agent:names']);
  assert.equal(asked.code, 0, asked.err);
  const question = must(/(c_[0-9a-f]{6}) pinned/.exec(asked.out)?.[1], asked.out);
  assert.equal(run('lampo', ['reply', id, '--note', 'siehe v1', '--by', 'agent:names']).code, 0);

  // what agents parse most, a command's --help, a config, and a refusal (each run is a Node start: a few, not all)
  const reads = [
    ['help'],
    ['ls', '--json'],
    ['folders'],
    ['open', 'names.mp4'],
    ['show', question],
    ['inbox'],
    ['prompt', 'names.mp4'],
    ['whoami', '--json'],
    ['push', '--help'],
    ['mcp', 'config', 'claude', '--stdio'],
    ['frobnicate'],
  ];
  for (const args of reads) {
    const now = run('lampo', args);
    const old = run('vr', args);
    const what = `${args.join(' ')}`;
    assert.equal(old.out, now.out, `${what}: the same stdout`);
    assert.equal(old.code, now.code, `${what}: the same exit`);
    if (now.code === 0 && !args.includes('mcp')) assert.equal(old.err, '', `${what}: vr adds nothing on stderr`);
  }
  assert.match(run('lampo', ['help']).out, /^lampo — frame-exact video feedback for agents/);
  assert.match(run('lampo', ['open', 'names.mp4']).out, /Logo zu früh/, 'what lampo wrote, vr reads');
});

test('every command’s --help: its own lines, under lampo', async () => {
  const { usageOf } = await import('../../lib/cli.ts');
  const help = run('lampo', ['help']).out;
  const names = [...new Set([...help.matchAll(/^ {2}lampo ([a-z-]+)\b/gm)].map((m) => m[1] as string))];
  assert.ok(names.length > 30, names.join(' '));
  for (const name of names) {
    const lines = usageOf(name, help);
    assert.notEqual(lines, help, `${name} has lines of its own`);
    assert.match(lines, new RegExp(`^ {2}lampo ${name}\\b`), name);
    assert.match(lines, /\nOptions: --json on every read command/, `${name}: and the options every command takes`);
  }
});

test('writes through vr with the old settings and through lampo with the new land in the same store', () => {
  const a = run('vr', ['add', 'names.mp4', '--frame', '3', '--text', 'Farbe wärmer', '--by', 'agent:old-skill']);
  const b = run('lampo', ['add', 'names.mp4', '--frame', '4', '--text', 'Schnitt früher', '--by', 'agent:new-skill']);
  assert.equal(a.code, 0, a.err);
  assert.equal(b.code, 0, b.err);
  const json = JSON.parse(run('lampo', ['open', 'names.mp4', '--json']).out) as { comments: { text: string }[] };
  const texts = json.comments.map((c) => c.text);
  assert.ok(texts.includes('Farbe wärmer') && texts.includes('Schnitt früher'), texts.join(' · '));
  // LAMPO_ wins where both are set: a LAMPO_DATA elsewhere is another, empty store
  const elsewhere = path.join(dir, 'elsewhere');
  const empty = run('vr', ['ls'], { ...OLD, LAMPO_DATA: path.join(elsewhere, 'data'), LAMPO_CACHE: path.join(elsewhere, 'cache') });
  assert.equal(empty.out.trim(), 'no videos under review.');
});

/** Runs a command in a terminal of its own (script(1)), or null where there is none. */
function inTerminal(name: 'vr' | 'lampo', args: string[]): string | null {
  const cmd = [process.execPath, path.join(ROOT, 'bin', name), ...args];
  const quoted = cmd.map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ');
  const r =
    process.platform === 'darwin'
      ? spawnSync('script', ['-q', '/dev/null', ...cmd], {
          env: name === 'vr' ? OLD : NEW,
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      : spawnSync('script', ['-qec', quoted, '/dev/null'], {
          env: name === 'vr' ? OLD : NEW,
          encoding: 'utf8',
          timeout: 60_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
  return r.error || r.status !== 0 ? null : r.stdout;
}

test('a person who types vr in a terminal is told the new name, on stderr; lampo says nothing of it', (t) => {
  const old = inTerminal('vr', ['ls']);
  if (old === null) return t.skip('no script(1) here');
  assert.match(old, /vr is now called lampo/);
  assert.match(old, /names\.mp4/, 'and the command runs');
  assert.doesNotMatch(inTerminal('lampo', ['ls']) ?? '', /is now called/);
});

test('bin/lampo-mcp and bin/vr-mcp serve the same tools and resources', async () => {
  const seen: string[] = [];
  for (const [bin, e] of [
    ['lampo-mcp', NEW],
    ['vr-mcp', OLD],
  ] as const) {
    const c = new Client({ name: 'names-test', version: '1.0.0' });
    await c.connect(
      new StdioClientTransport({ command: process.execPath, args: [path.join(ROOT, 'bin', bin)], env: e as Record<string, string>, stderr: 'ignore' }),
    );
    closers.push(() => c.close());
    const tools = (await c.listTools()).tools.map((x) => x.name).sort();
    const resources = (await c.listResources()).resources.map((x) => x.uri).sort();
    seen.push(JSON.stringify({ tools, resources }));
    assert.ok(resources.includes('lampo://inbox'), bin);
    assert.ok(fs.existsSync(path.join(ROOT, 'bin', bin)));
  }
  assert.equal(seen[0], seen[1]);
});
