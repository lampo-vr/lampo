// `npm run link` is the quick start's second step (README, docs/agents.md). Run here the way npm runs it — the script
// line through sh, from the checkout — with HOME a fresh folder, like a stock Mac without ~/.local/bin (A12 OSS-10).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const script = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).scripts.link as string;
const run = (home: string, PATH: string) =>
  execFileSync('sh', ['-c', script], { cwd: ROOT, env: { HOME: home, PATH, PWD: ROOT }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
const NODE_PATH = path.dirname(process.execPath);

test('npm run link puts vr in ~/.local/bin on a machine without the folder, and says when the shell won’t look there', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-link-'));
  try {
    const out = run(home, `${NODE_PATH}:/usr/bin:/bin`);
    const link = path.join(home, '.local/bin/vr');
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, 'bin/vr')), 'a link to this checkout’s vr');
    assert.match(out, /linked vr → .*\.local\/bin\/vr/);
    assert.match(out, /not on your PATH[\s\S]*export PATH="\$HOME\/\.local\/bin:\$PATH"/, 'how to make the shell find it');
    // Again, with the folder on the PATH: the link is replaced in place, and nothing more to do.
    const again = run(home, `${path.join(home, '.local/bin')}:${NODE_PATH}:/usr/bin:/bin`);
    assert.equal(fs.realpathSync(link), fs.realpathSync(path.join(ROOT, 'bin/vr')));
    assert.doesNotMatch(again, /not on your PATH/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
