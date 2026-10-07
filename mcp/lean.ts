// What the tool list costs: a client sends every tool's name, description and input schema with every turn of an
// agent's conversation (bench/tokens measures it; test/unit/token-budget.test.ts holds it). Two things keep it small
// here: the schemas a model reads leave out what tells it nothing, and a client may ask for the lean tool set.
import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server';
import type { z } from 'zod';

const SAFE = Number.MAX_SAFE_INTEGER;

/** The bounds a `quiet` field is announced without. */
const BOUNDS = new Set(['maxLength', 'minLength', 'maximum', 'minimum', 'exclusiveMinimum', 'exclusiveMaximum', 'maxItems', 'minItems', 'pattern']);

/**
 * A JSON Schema without what tells a model nothing: the `$schema` URI on every tool, zod's ±2^53 bounds on every
 * integer and the `minimum: 0` of every frame and second (the server still checks them). Fields marked `hidden`
 * (`by`: the default author is right) or `deprecated` (still accepted from older clients) are not announced; a field
 * marked `brief` is announced by its type and description only (a list of references, described once in
 * attach_reference); a field marked `quiet` (the HTTP API's caps, lib/inputs.ts: 20,000 characters of a note and the
 * like, far beyond what a model writes) without its bounds.
 */
export function trimSchema(node: unknown, inQuiet = false): unknown {
  if (Array.isArray(node)) return node.map((n) => trimSchema(n, inQuiet));
  if (!node || typeof node !== 'object') return node;
  const src = node as Record<string, unknown>;
  if (src.brief) {
    const items = src.items as { type?: string } | undefined;
    return { type: src.type, ...(src.description ? { description: src.description } : {}), ...(items ? { items: { type: items.type } } : {}) };
  }
  const quiet = inQuiet || src.quiet === true;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(src)) {
    if (k === '$schema' || k === 'quiet') continue;
    if (quiet && BOUNDS.has(k)) continue;
    if ((k === 'maximum' && v === SAFE) || (k === 'minimum' && (v === -SAFE || v === 0))) continue;
    if (k === 'properties' && v && typeof v === 'object') {
      const props: Record<string, unknown> = {};
      for (const [name, p] of Object.entries(v)) {
        const f = p as { hidden?: boolean; deprecated?: boolean } | null;
        if (!f?.hidden && !f?.deprecated) props[name] = trimSchema(p);
      }
      out[k] = props;
      continue;
    }
    out[k] = trimSchema(v, quiet);
  }
  return out;
}

/** The same zod schema — it still validates every call, hidden fields included — announced through trimSchema. */
export function trimmed<S extends z.ZodObject>(schema: S): StandardSchemaWithJSON<z.input<S>, z.output<S>> {
  const std = schema['~standard'] as unknown as StandardSchemaWithJSON<z.input<S>, z.output<S>>['~standard'];
  return {
    '~standard': {
      ...std,
      jsonSchema: {
        input: (o) => trimSchema(std.jsonSchema.input(o)) as Record<string, unknown>,
        output: (o) => trimSchema(std.jsonSchema.output(o)) as Record<string, unknown>,
      },
    },
  };
}

/**
 * The lean tool set (`LAMPO_MCP_TOOLS=lean`, or `/mcp?tools=lean`): the review loop and nothing else — read the notes and
 * the playbook, look at frames, answer, mark fixed, wait. Folders, render sources, fix previews, references, playbook
 * suggestions, statuses and the MCP App card stay out of the list a model carries on every turn.
 */
export const LEAN_TOOLS: readonly string[] = [
  'list_videos',
  'get_open_notes',
  'get_note',
  'get_frame',
  'get_playbook',
  'get_skill',
  'get_taste',
  'get_transcript',
  'wait_for_feedback',
  'add_note',
  'reply',
  'mark_fixed',
  'wont_fix',
  'track_video',
  'request_upload',
];

/** Which tools a server offers: `all` (the default), `lean`, or a comma-separated list of names. */
export function toolFilter(spec: string | null | undefined): (name: string) => boolean {
  const s = (spec || '').trim();
  if (!s || s === 'all') return () => true;
  const names = new Set(s === 'lean' ? LEAN_TOOLS : s.split(',').map((x) => x.trim()));
  return (name) => names.has(name);
}
