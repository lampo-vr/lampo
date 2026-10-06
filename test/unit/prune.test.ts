// Caches that fill up on their own (scrub copies, exact frames for agents) stay under their cap, oldest first.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { pruneDir } from '../../lib/prune.ts';
import { tmpdir } from '../lib/helpers.ts';

test('pruneDir removes the oldest matching files until the rest fits, and leaves everything else alone', () => {
  const dir = tmpdir('vr-prune-');
  const write = (name: string, size: number, age: number) => {
    const f = path.join(dir, name);
    fs.writeFileSync(f, Buffer.alloc(size));
    const t = new Date(Date.now() - age * 1000);
    fs.utimesSync(f, t, t);
  };
  write('a_1.png', 400, 30);
  write('a_2.png', 400, 20);
  write('a_3.png', 400, 10);
  write('notes.json', 5000, 40);
  fs.mkdirSync(path.join(dir, 'sub'));
  pruneDir(dir, 900, (f) => f.endsWith('.png'));
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a_2.png', 'a_3.png', 'notes.json', 'sub']);
  pruneDir(path.join(dir, 'missing'), 0);
});
