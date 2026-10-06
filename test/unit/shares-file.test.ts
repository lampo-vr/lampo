// shares.json (every review link of a workspace) and links.json (which workspace a link is in) as files: a read that
// fails is never taken as "no links", so the next new link can't be written over every other one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const shares = await import('../../lib/shares.ts');
const { DATA, inWorkspace } = await import('../../lib/paths.ts');
const FILE = path.join(DATA, 'shares.json');
const INDEX = path.join(DATA, 'links.json');
const root = process.getuid?.() === 0;

test('a shares.json that can’t be read is never taken as empty: a new link fails, and every link is still there afterwards', () => {
  const a = shares.createShare({ slug: '__a.mp4' }, { label: 'A' });
  const b = shares.createShare({ slug: '__b.mp4' }, { label: 'B' });
  const whole = fs.readFileSync(FILE, 'utf8');

  // damaged: a disk that filled up while it was copied back, a bad restore
  const damaged = whole.slice(0, Math.floor(whole.length / 2));
  fs.writeFileSync(FILE, damaged);
  assert.throws(() => shares.createShare({ slug: '__c.mp4' }, { label: 'C' }), SyntaxError);
  assert.equal(fs.readFileSync(FILE, 'utf8'), damaged, 'nothing was written');
  assert.throws(() => shares.resolveShare(a.token), 'a visitor gets an error, not "this link is not valid any more"');
  assert.throws(() => shares.revokeShare(b.token));

  // unreadable: permissions after a restore (root reads anything, so only as anyone else)
  fs.writeFileSync(FILE, whole);
  if (!root) {
    fs.chmodSync(FILE, 0o000);
    try {
      assert.throws(() => shares.createShare({ slug: '__c.mp4' }, { label: 'C' }), /EACCES/);
    } finally {
      fs.chmodSync(FILE, 0o600);
    }
  }
  assert.equal(fs.readFileSync(FILE, 'utf8'), whole);
  assert.equal(shares.resolveShare(a.token)?.label, 'A', 'once it reads again, every link works');
  assert.equal(shares.resolveShare(b.token)?.label, 'B');
  assert.equal(shares.listShares().length, 2);
});

test('no shares.json yet is no links, and the first link makes it', () => {
  fs.rmSync(FILE);
  assert.deepEqual(shares.listShares(), []);
  const c = shares.createShare({ slug: '__c.mp4' }, { label: 'C' });
  assert.equal(shares.resolveShare(c.token)?.label, 'C');
});

test('links.json likewise: a link of another workspace is never written over the index', () => {
  const ws = 'w_abcdefghijkl';
  const x = inWorkspace(ws, () => shares.createShare({ slug: '__x.mp4' }, { label: 'X' }));
  assert.equal(shares.linkWorkspace(x.token), ws);
  const whole = fs.readFileSync(INDEX, 'utf8');
  fs.writeFileSync(INDEX, '{"links":');
  assert.throws(() => inWorkspace(ws, () => shares.createShare({ slug: '__y.mp4' }, { label: 'Y' })), SyntaxError);
  assert.throws(() => shares.linkWorkspace(x.token), 'the guest path fails rather than looking in workspace #1');
  assert.equal(fs.readFileSync(INDEX, 'utf8'), '{"links":', 'the index was left as it was');
  fs.writeFileSync(INDEX, whole);
  assert.equal(shares.linkWorkspace(x.token), ws);
  assert.equal(
    inWorkspace(ws, () => shares.resolveShare(x.token)?.label),
    'X',
  );
});
