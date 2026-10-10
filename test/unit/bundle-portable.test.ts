// covers: lib/types.ts lib/bundle.ts lib/bundleExport.ts
// Every field the store keeps on a version, a note, a reply, a reference or an event of the history either travels in
// a bundle (the strict schema of lib/bundle.ts names it) or is left out on purpose (bundleExport.ts LEFT_OUT, with why).
// A new optional field that is neither stops `lampo export` for anyone whose store holds one (an agent's run on a
// version, a review link's id on a reply did), or drops the event that has it: this finds it first, from the types'
// own source. And an event that can't travel all the same is never left out without a word.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import type { z } from 'zod';
import { isolatedEnv, makeVideo, ROOT } from '../lib/helpers.ts';

// the exporter reads a store's settings when it loads: a throwaway one
const { dir } = isolatedEnv();
const { BundleEvent, BundleReview } = await import('../../lib/bundle.ts');
const { LEFT_OUT, exportBundle } = await import('../../lib/bundleExport.ts');
const store = await import('../../lib/store.ts');
const { slugify } = await import('../../lib/paths.ts');

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
  ['ReviewEvent', BundleEvent as unknown as Obj, LEFT_OUT.event],
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

test('an event of a video that goes along but doesn’t fit a bundle is left out with a warning, not only counted', async () => {
  const video = makeVideo(path.join(dir, 'renders/spot.mp4'), { dur: 0.5 });
  const { review } = store.createOrGetReview(video, { by: 'alex' });
  const slug = slugify(review.video);
  // a field no version of the exporter knows (a newer store's, or a hand-edited line)
  const line = { at: new Date().toISOString(), type: 'comment', by: 'alex', slug, video: review.video, v: 1, text: 'later', later_field: 1 };
  fs.appendFileSync(store.eventsFile(), `${JSON.stringify(line)}\n`);
  const r = await exportBundle({ out: path.join(dir, 'out.tar') });
  assert.ok(r.manifest.left_out.events >= 1, JSON.stringify(r.manifest.left_out));
  const said = r.warnings.find((w) => /didn't fit a bundle/.test(w));
  assert.ok(said, `a warning names it: ${JSON.stringify(r.warnings)}`);
  assert.match(said as string, /comment: /, 'with what it was and why');
});
