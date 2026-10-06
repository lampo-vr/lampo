// `vr playbook skill --files` and `vr playbook export` write files a server names. A server `vr` is logged in to may not
// be honest (taken over, or not what the agent thinks it is): whatever names it sends — a skill called "../../x", a file
// called "../.zshrc" or "/etc/x", a name through a symbolic link that points elsewhere — nothing lands outside the folder
// the command writes to, and the command refuses before it writes anything (A12 AGENT-8). Honest names still work.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { isolatedEnv, tmpdir, VR } from '../lib/helpers.ts';

const { env } = isolatedEnv();

interface FakeSkill {
  name: string;
  files: string[];
}
// What the fake server says: the skills of the House playbook and their files, as the test sets them.
let skills: FakeSkill[] = [];
const summary = (s: FakeSkill) => ({
  name: s.name,
  description: 'Export a reel',
  files: s.files.map((name) => ({ name, size: 6 })),
  updated: '2026-10-02T10:00:00+02:00',
  by: 'Sam',
});

let server: http.Server;
let base = '';
before(async () => {
  server = http.createServer((req, res) => {
    const u = new URL(req.url || '/', 'http://x');
    const json = (body: unknown) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify(body));
    };
    if (u.pathname === '/api/playbook')
      return json({
        scope: '',
        label: 'House',
        playbook: { proposals: [] },
        layers: [],
        skills: skills.map((s) => ({ ...summary(s), from: '' })),
        stamp: [],
        markdown: '# Playbook: House\n',
      });
    if (u.pathname === '/api/playbook/skill') {
      const s = skills.find((x) => x.name === u.searchParams.get('name')) ?? skills[0];
      return json({ ...summary(s), body: 'Use the preset.', from: '', markdown: `---\nname: ${s.name}\n---\n\nUse the preset.\n` });
    }
    if (u.pathname === '/api/playbook/skill/files') return res.end('landed');
    res.statusCode = 404;
    json({ error: 'not found' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => server.close());

const remote = () => ({ ...env, VR_SERVER: base, VR_TOKEN: 'vr_test' });
/** `vr` against the fake server, which answers from this process: run without blocking it. */
const vr = (args: string[], e: NodeJS.ProcessEnv, { cwd }: { cwd?: string } = {}): Promise<{ code: number; out: string; err: string }> =>
  new Promise((resolve) =>
    execFile(process.execPath, [VR, ...args], { env: e, cwd, encoding: 'utf8', timeout: 60_000 }, (error, out, err) =>
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) || 1 : 0, out, err }),
    ),
  );
/** Every file under `root` named "landed…" or holding the server's bytes, relative to `root`. */
const landed = (root: string): string[] =>
  (fs.readdirSync(root, { recursive: true }) as string[]).filter((f) => {
    const p = path.join(root, f);
    return fs.lstatSync(p).isFile() && fs.readFileSync(p, 'utf8') === 'landed';
  });

test('honest names: --files downloads into this folder, export writes <dir>/<skill>/', async () => {
  skills = [{ name: 'reels-export', files: ['reels.epr', 'look.cube'] }];
  const work = tmpdir('vr-remote-skill-');
  const r = await vr(['playbook', 'skill', 'reels-export', '--files'], remote(), { cwd: work });
  assert.equal(r.code, 0, r.err);
  assert.deepEqual(landed(work).sort(), ['look.cube', 'reels.epr']);
  const to = path.join(tmpdir('vr-remote-export-'), 'skills');
  const e = await vr(['playbook', 'export', '--to', to], remote());
  assert.equal(e.code, 0, e.err);
  assert.ok(fs.existsSync(path.join(to, 'reels-export', 'SKILL.md')));
  assert.deepEqual(landed(to).sort(), ['reels-export/look.cube', 'reels-export/reels.epr']);
});

test('vr playbook skill --files: a file name that climbs out, is absolute or has a folder is refused, and nothing is written', async () => {
  const home = tmpdir('vr-remote-home-');
  const work = path.join(home, 'project', 'work');
  fs.mkdirSync(work, { recursive: true });
  for (const bad of ['../../landed-rc', '../landed', path.join(home, 'landed-abs'), 'sub/landed', 'a\\..\\..\\landed', '..', '.', '']) {
    skills = [{ name: 'reels-export', files: ['fine.epr', bad] }];
    const r = await vr(['playbook', 'skill', 'reels-export', '--files'], remote(), { cwd: work });
    assert.notEqual(r.code, 0, `${JSON.stringify(bad)} was accepted: ${r.out}`);
    assert.match(r.err, /refus|outside/, r.err);
    assert.deepEqual(landed(home), [], `nothing written for ${JSON.stringify(bad)}, not even the good file`);
  }
});

test('vr playbook skill --files: a symbolic link in the folder that points out is not followed', async () => {
  const home = tmpdir('vr-remote-link-');
  const work = path.join(home, 'work');
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(work, { recursive: true });
  fs.mkdirSync(elsewhere);
  fs.symlinkSync(path.join(elsewhere, '.zshrc'), path.join(work, 'preset.epr'));
  skills = [{ name: 'reels-export', files: ['preset.epr'] }];
  const r = await vr(['playbook', 'skill', 'reels-export', '--files'], remote(), { cwd: work });
  assert.notEqual(r.code, 0, r.out);
  assert.equal(fs.existsSync(path.join(elsewhere, '.zshrc')), false, 'the link was not written through');
});

test('vr playbook export: a skill name or file name that climbs out, or a link out of the folder, is refused before anything is written', async () => {
  const cases: ((home: string) => { skills: FakeSkill[]; link?: string })[] = [
    () => ({ skills: [{ name: '../../landed-skill', files: [] }] }),
    () => ({ skills: [{ name: '..', files: [] }] }),
    (home) => ({ skills: [{ name: path.join(home, 'landed-skill'), files: [] }] }),
    () => ({ skills: [{ name: 'Reels Export', files: [] }] }),
    () => ({ skills: [{ name: 'reels-export', files: ['../../../landed-file'] }] }),
    (home) => ({ skills: [{ name: 'reels-export', files: [path.join(home, 'landed-file')] }] }),
    () => ({
      skills: [
        { name: 'fine', files: ['ok.cube'] },
        { name: 'reels-export', files: ['../landed'] },
      ],
    }),
    // a folder of the skill's name that is a link to somewhere else
    () => ({ skills: [{ name: 'reels-export', files: ['look.cube'] }], link: 'reels-export' }),
  ];
  for (const make of cases) {
    const home = tmpdir('vr-remote-exp-');
    const c = make(home);
    skills = c.skills;
    const to = path.join(home, 'a', 'b', 'skills');
    fs.mkdirSync(to, { recursive: true });
    const elsewhere = path.join(home, 'elsewhere');
    fs.mkdirSync(elsewhere);
    if (c.link) fs.symlinkSync(elsewhere, path.join(to, c.link));
    const r = await vr(['playbook', 'export', '--to', to], remote());
    assert.notEqual(r.code, 0, `${JSON.stringify(c)} was accepted: ${r.out}`);
    assert.match(r.err, /refus|outside/, r.err);
    assert.deepEqual(landed(home), [], `nothing written for ${JSON.stringify(c)}`);
    assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing through the link');
    assert.equal(fs.existsSync(path.join(to, 'PLAYBOOK.md')), false, 'refused before anything is written');
  }
});
