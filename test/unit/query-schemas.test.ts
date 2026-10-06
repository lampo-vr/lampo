// "Zod on every input" (AGENTS.md, server mode is hostile territory): a query string is input like a body. Every read
// of `req.query` in the server goes through a schema — `query(Schema, req)` or `parse`/`safeParse` of it — so arrays
// (`?v=1&v=2`), objects (`?v[x]=1`) and junk are refused or ignored by one rule instead of being coerced by hand at
// each route (A12 INV-9). server/http.ts, where `query()` lives, is the one place that touches it directly.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const files = (dir: string): string[] =>
  fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((e) => (e.isDirectory() ? files(path.join(dir, e.name)) : e.name.endsWith('.ts') ? [path.join(dir, e.name)] : []));

test('the server reads a query string only through a schema', () => {
  const raw: string[] = [];
  for (const f of [...files(path.join(ROOT, 'server')), ...files(path.join(ROOT, 'mcp'))]) {
    const rel = path.relative(ROOT, f);
    if (rel === path.join('server', 'http.ts')) continue;
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/req\.query\b/g)) {
      const before = src.slice(Math.max(0, (m.index ?? 0) - 60), m.index);
      if (/(?:\bparse\(\s*\w+,\s*|\.safeParse\(\s*|\.parse\(\s*)$/.test(before)) continue;
      raw.push(`${rel}:${src.slice(0, m.index).split('\n').length}: ${src.slice(m.index, (m.index ?? 0) + 40).split('\n')[0]}`);
    }
  }
  assert.deepEqual(raw, [], 'parse it: query(Schema, req) (server/http.ts)');
});
