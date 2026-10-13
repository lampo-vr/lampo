// The Lampo plugin as the ZIP OpenAI's plugin portal takes (platform.openai.com → Plugins → upload; ChatGPT and Codex):
// plugins/lampo in the Agent Plugins format — plugin.json, mcp.json, skills/, assets/, README.md. Claude's own files
// (.claude-plugin/, .mcp.json) stay out: Claude's directory reads the plugin from the GitHub repository instead.
// The package is checked first: plugin.json and mcp.json against the Agent Plugins 1.0.0 schemas (scripts/agent-plugins/,
// as published at agent-plugins.org/schemas/1.0.0/), then the limits OpenAI's portal states.
//   node scripts/plugin-zip.ts [out.zip]   default dist/lampo-<version>-openai.zip; prints the path, or the problems
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import { planZip, type ZipEntry } from '../lib/zip.ts';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PLUGIN_DIR = path.join(ROOT, 'plugins', 'lampo');
const SCHEMAS = path.join(ROOT, 'scripts', 'agent-plugins');

/** What the Agent Plugins format reads at the plugin's root; nothing else goes into the package. */
const PACKAGED = ['plugin.json', 'mcp.json', 'README.md', 'skills', 'assets'];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Schema = { [key: string]: Json };

const typeOf = (v: Json): string => (v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v);

/**
 * The part of JSON Schema (2020-12) the two Agent Plugins schemas use: type, const, enum, pattern, min/maxLength,
 * properties, required, additionalProperties, propertyNames, items, oneOf and local $refs. Answers the problems found,
 * each with the path it is at; none: the value fits.
 */
export function schemaProblems(schema: Schema, value: Json, root: Schema = schema, at = '$'): string[] {
  if (typeof schema.$ref === 'string') {
    const target = schema.$ref
      .replace(/^#\//, '')
      .split('/')
      .reduce<Json>((s, k) => (s && typeof s === 'object' && !Array.isArray(s) ? s[k] : null), root);
    if (!target || typeof target !== 'object' || Array.isArray(target)) return [`${at}: unresolved ${schema.$ref}`];
    return schemaProblems(target, value, root, at);
  }
  if (Array.isArray(schema.oneOf)) {
    const fits = schema.oneOf.filter((s) => s && typeof s === 'object' && !Array.isArray(s) && !schemaProblems(s, value, root, at).length);
    if (fits.length !== 1) return [`${at}: matches ${fits.length} of the ${schema.oneOf.length} shapes (exactly one is allowed)`];
  }
  const problems: string[] = [];
  const t = typeOf(value);
  if (typeof schema.type === 'string' && schema.type !== t && !(schema.type === 'number' && t === 'integer')) return [`${at}: is ${t}, not ${schema.type}`];
  if ('const' in schema && JSON.stringify(schema.const) !== JSON.stringify(value)) problems.push(`${at}: must be ${JSON.stringify(schema.const)}`);
  if (Array.isArray(schema.enum) && !schema.enum.some((e) => JSON.stringify(e) === JSON.stringify(value)))
    problems.push(`${at}: not one of the allowed values`);
  if (typeof value === 'string') {
    if (typeof schema.minLength === 'number' && [...value].length < schema.minLength) problems.push(`${at}: shorter than ${schema.minLength}`);
    if (typeof schema.maxLength === 'number' && [...value].length > schema.maxLength) problems.push(`${at}: longer than ${schema.maxLength}`);
    if (typeof schema.pattern === 'string' && !new RegExp(schema.pattern, 'u').test(value)) problems.push(`${at}: doesn't match ${schema.pattern}`);
  }
  if (Array.isArray(value) && schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items)) {
    const items = schema.items;
    for (const [i, v] of value.entries()) problems.push(...schemaProblems(items, v, root, `${at}[${i}]`));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const props = schema.properties && typeof schema.properties === 'object' && !Array.isArray(schema.properties) ? schema.properties : {};
    if (Array.isArray(schema.required)) for (const k of schema.required) if (typeof k === 'string' && !(k in value)) problems.push(`${at}: ${k} is missing`);
    for (const [k, v] of Object.entries(value)) {
      const own = props[k];
      if (own && typeof own === 'object' && !Array.isArray(own)) problems.push(...schemaProblems(own, v, root, `${at}.${k}`));
      else if (schema.additionalProperties === false) problems.push(`${at}: ${k} isn't allowed here`);
      else if (schema.additionalProperties && typeof schema.additionalProperties === 'object' && !Array.isArray(schema.additionalProperties))
        problems.push(...schemaProblems(schema.additionalProperties, v, root, `${at}.${k}`));
      const names = schema.propertyNames;
      if (names && typeof names === 'object' && !Array.isArray(names)) problems.push(...schemaProblems(names, k, root, `${at} (the name ${k})`));
    }
  }
  if (schema.not && typeof schema.not === 'object' && !Array.isArray(schema.not) && !schemaProblems(schema.not, value, root, at).length)
    problems.push(`${at}: is a value that isn't allowed`);
  return problems;
}

const readJson = (file: string): Json => JSON.parse(fs.readFileSync(file, 'utf8'));
const isObject = (v: Json | undefined): v is { [key: string]: Json } => !!v && typeof v === 'object' && !Array.isArray(v);

/** Every file of the package, relative to the plugin, "/"-separated, sorted; a symbolic link is a problem, not a file. */
export function packageFiles(dir = PLUGIN_DIR): { files: string[]; problems: string[] } {
  const files: string[] = [];
  const problems: string[] = [];
  const walk = (rel: string) => {
    const abs = path.join(dir, rel);
    const st = fs.lstatSync(abs);
    if (st.isSymbolicLink()) problems.push(`${rel}: a symbolic link (the portals take regular files only)`);
    else if (st.isDirectory()) for (const name of fs.readdirSync(abs).sort()) walk(rel ? `${rel}/${name}` : name);
    else if (path.basename(rel) === '.DS_Store') problems.push(`${rel}: a system file`);
    else files.push(rel);
  };
  for (const top of PACKAGED) if (fs.existsSync(path.join(dir, top))) walk(top);
  return { files: files.sort(), problems };
}

/** What would stop the package: the schemas, then what OpenAI's portal states (lengths, https links, the images). */
export function packageProblems(dir = PLUGIN_DIR): string[] {
  const problems: string[] = [];
  const manifest = readJson(path.join(dir, 'plugin.json'));
  const mcp = readJson(path.join(dir, 'mcp.json'));
  problems.push(...schemaProblems(readJson(path.join(SCHEMAS, 'plugin.schema.json')) as Schema, manifest).map((p) => `plugin.json ${p}`));
  problems.push(...schemaProblems(readJson(path.join(SCHEMAS, 'mcp.schema.json')) as Schema, mcp).map((p) => `mcp.json ${p}`));
  if (isObject(mcp) && isObject(mcp.mcpServers) && Object.keys(mcp.mcpServers).length !== 1) problems.push('mcp.json: one MCP server per plugin');
  const ext = isObject(manifest) && isObject(manifest.extensions) ? manifest.extensions['com.openai'] : undefined;
  const ui = isObject(ext) ? ext.interface : undefined;
  if (!isObject(ui)) return [...problems, 'plugin.json: extensions.com.openai.interface is missing'];
  const limits: [string, number][] = [
    ['displayName', 30],
    ['shortDescription', 30],
    ['longDescription', 4000],
    ['developerName', 80],
  ];
  for (const [k, max] of limits) {
    const v = ui[k];
    if (typeof v !== 'string' || !v.trim()) problems.push(`interface.${k} is missing`);
    else if ([...v].length > max) problems.push(`interface.${k}: ${[...v].length} characters, at most ${max}`);
  }
  // the listing and the manifest name one maker: the company that publishes Lampo, as on the privacy page and the terms
  const author = isObject(manifest) && isObject(manifest.author) ? manifest.author.name : undefined;
  if (typeof author !== 'string' || !author.trim()) problems.push('plugin.json: author.name is missing');
  else if (ui.developerName !== author) problems.push(`interface.developerName must be author.name (${author})`);
  for (const k of ['websiteURL', 'supportURL', 'privacyPolicyURL', 'termsOfServiceURL']) {
    const v = ui[k];
    if (typeof v !== 'string' || !/^https:\/\/[^\s]+$/.test(v) || v.length > 1024) problems.push(`interface.${k}: an https URL is needed`);
  }
  for (const k of ['logo', 'composerIcon']) {
    const v = ui[k];
    const file = typeof v === 'string' && v.startsWith('./') ? path.join(dir, v) : null;
    if (!file || !fs.existsSync(file)) problems.push(`interface.${k}: no file at ${String(v)}`);
    else if (
      !fs
        .readFileSync(file)
        .subarray(0, 8)
        .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    )
      problems.push(`interface.${k}: not a PNG`);
  }
  const prompts = ui.defaultPrompt;
  if (!Array.isArray(prompts) || !prompts.length || prompts.length > 3 || prompts.some((p) => typeof p !== 'string' || p.length > 128 || p.includes('@')))
    problems.push('interface.defaultPrompt: 1–3 prompts of at most 128 characters, no @mentions');
  const review = isObject(ext) ? ext.review : undefined;
  const cases = isObject(review) ? review.test_cases : undefined;
  if (!isObject(cases) || !Array.isArray(cases.positive) || cases.positive.length !== 5 || !Array.isArray(cases.negative) || cases.negative.length !== 3)
    problems.push('review.test_cases: exactly 5 positive and 3 negative');
  const { files, problems: found } = packageFiles(dir);
  problems.push(...found);
  for (const f of files.filter((x) => x.startsWith('skills/'))) {
    const m = /^skills\/([^/]+)\/SKILL\.md$/.exec(f);
    if (!m) continue;
    const head = /^---\n([\s\S]*?)\n---\n/.exec(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!head || !new RegExp(`^name: ${m[1]}$`, 'm').test(head[1] as string) || !/^description: \S/m.test(head[1] as string))
      problems.push(`${f}: front matter with name: ${m[1]} and a description`);
  }
  return problems;
}

/** The package as a ZIP: the files at its root, in a fixed order with a fixed time, so the same files give the same bytes. */
export async function buildZip(out: string, dir = PLUGIN_DIR): Promise<string[]> {
  const { files } = packageFiles(dir);
  const mtime = new Date(2026, 0, 1);
  const entries: ZipEntry[] = files.map((name) => {
    const bytes = fs.readFileSync(path.join(dir, name));
    return {
      name,
      size: bytes.length,
      crc: zlib.crc32(bytes),
      mtime,
      async *read(start: number, end: number) {
        yield bytes.subarray(start, end + 1);
      },
    };
  });
  fs.mkdirSync(path.dirname(out), { recursive: true });
  const chunks: Buffer[] = [];
  for await (const chunk of planZip(entries).bytes()) chunks.push(chunk);
  fs.writeFileSync(out, Buffer.concat(chunks));
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const problems = packageProblems();
  if (problems.length) {
    console.error(`plugin-zip: the package isn't ready:\n${problems.map((p) => `  ${p}`).join('\n')}`);
    process.exit(1);
  }
  const { version } = readJson(path.join(PLUGIN_DIR, 'plugin.json')) as { version: string };
  const out = path.resolve(process.argv[2] ?? path.join(ROOT, 'dist', `lampo-${version}-openai.zip`));
  const files = await buildZip(out);
  console.log(`${out}\n${files.map((f) => `  ${f}`).join('\n')}`);
}
