// covers: lib/types.ts lib/bundle.ts lib/bundleExport.ts
// Every field the store keeps on a version, a note, a reply or a reference either travels in a bundle (the strict
// schema of lib/bundle.ts names it) or is left out on purpose (bundleExport.ts LEFT_OUT, with why). A new optional
// field that is neither stops `lampo export` for anyone whose store holds one (an agent's run on a version, a review
// link's id on a reply did): this finds it first, from the types' own source.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { z } from 'zod';
import { isolatedEnv, ROOT } from '../lib/helpers.ts';

// the exporter reads a store's settings when it loads: a throwaway one
isolatedEnv();
const { BundleReview } = await import('../../lib/bundle.ts');
const { LEFT_OUT } = await import('../../lib/bundleExport.ts');

/** The fields of `export interface <name> { … }` in lib/types.ts, at its own level (nested object types skipped). */
function fieldsOf(name: string): string[] {
  const src = fs.readFileSync(path.join(ROOT, 'lib/types.ts'), 'utf8');
  const start = src.indexOf(`export interface ${name} {`);
  assert.ok(start >= 0, `interface ${name} in lib/types.ts`);
  const out: string[] = [];
  let depth = 0;
  let inComment = false;
  for (const line of src.slice(start).split('\n')) {
    const t = line.trim();
    if (inComment) {
      if (t.includes('*/')) inComment = false;
      continue;
    }
    if (t.startsWith('/*')) {
      if (!t.includes('*/')) inComment = true;
      continue;
    }
    if (t.startsWith('//')) continue;
    const field = depth === 1 ? /^(\w+)\??:/.exec(t)?.[1] : undefined;
    if (field) out.push(field);
    for (const ch of t.replace(/\/\/.*$/, '').replace(/'[^']*'/g, '')) {
      if (ch === '{') depth++;
      else if (ch === '}') depth--;
    }
    if (depth === 0) break;
  }
  return out;
}

type Obj = z.ZodObject<z.ZodRawShape>;
const arrayOf = (s: unknown): Obj => {
  let x = s as { unwrap?: () => unknown; element?: unknown };
  while (x.unwrap && !x.element) x = x.unwrap() as typeof x;
  return x.element as Obj;
};
const version = arrayOf(BundleReview.shape.versions);
const comment = arrayOf(BundleReview.shape.comments);
const reply = arrayOf(comment.shape.replies);
const ref = arrayOf(comment.shape.refs);

const records: [string, Obj, readonly string[]][] = [
  ['Version', version, LEFT_OUT.version],
  ['Comment', comment, LEFT_OUT.comment],
  ['Reply', reply, LEFT_OUT.reply],
  ['NoteRef', ref, LEFT_OUT.ref],
];

for (const [name, schema, left] of records)
  test(`${name}: every field travels in a bundle or is left out on purpose`, () => {
    const fields = fieldsOf(name);
    assert.ok(fields.length > 4, `read ${name}'s fields: ${fields}`);
    const carried = new Set(Object.keys(schema.shape));
    const neither = fields.filter((f) => !carried.has(f) && !left.includes(f));
    assert.deepEqual(neither, [], `${name} fields neither in the bundle's schema nor in LEFT_OUT.${name.toLowerCase()}`);
    const stale = left.filter((f) => !fields.includes(f));
    assert.deepEqual(stale, [], `LEFT_OUT names fields ${name} no longer has`);
  });
