// The Lampo plugin (plugins/lampo/), one folder in two formats: Claude's (.claude-plugin/plugin.json, .mcp.json; the
// self-hosted marketplace in .claude-plugin/marketplace.json at the repository's root) and the Agent Plugins format
// OpenAI's portal takes (plugin.json, mcp.json). Both say the same: the name, the version Lampo is at, the one
// connector (the address docs/mcp.md gives), the one skill both read from the same file. What the directories refuse
// isn't there: symbolic links, files they can't read, a reserved name.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { approxTokens } from '../../bench/tokens/count.ts';
import { buildZip, PLUGIN_DIR, packageFiles, packageProblems, schemaProblems } from '../../scripts/plugin-zip.ts';
import { ROOT, tmpdir } from '../lib/helpers.ts';

type Obj = Record<string, unknown>;
const json = (p: string): Obj => JSON.parse(fs.readFileSync(path.join(ROOT, p), 'utf8'));
const claude = json('plugins/lampo/.claude-plugin/plugin.json');
const portable = json('plugins/lampo/plugin.json');
const marketplace = json('.claude-plugin/marketplace.json');
const SKILL = 'plugins/lampo/skills/lampo/SKILL.md';
/** Who makes Lampo, as the README's copyright, the privacy page and the terms name it; the product stays Lampo. */
const COMPANY = 'nprompt UG (haftungsbeschränkt)';

/** Lampo Cloud's connector, as docs/mcp.md names it for the directories. */
const CONNECTOR = (/Lampo Cloud's connector \(`(https:\/\/[^`]+)`\)/.exec(fs.readFileSync(path.join(ROOT, 'docs/mcp.md'), 'utf8')) ?? [])[1];

test('both manifests say the same, at the version Lampo is at', () => {
  for (const k of ['name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords'])
    assert.deepEqual(portable[k], claude[k], `plugin.json and .claude-plugin/plugin.json agree on ${k}`);
  assert.equal(claude.name, 'lampo');
  assert.equal(claude.displayName, 'Lampo');
  assert.equal(claude.version, json('package.json').version, 'a release raises the plugin with it: an unchanged version keeps installs on the old copy');
  assert.equal(claude.license, json('package.json').license);
  const openai = ((portable.extensions as Obj)['com.openai'] as Obj).interface as Obj;
  assert.equal(openai.displayName, claude.displayName);
  // the maker is the company, in every field that names one; the name people see is Lampo's
  assert.equal((claude.author as Obj).name, COMPANY);
  assert.equal(openai.developerName, COMPANY);
  assert.ok(fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8').includes(`Copyright © 2026 ${COMPANY},`), 'the same name as the copyright');
  // the directory listing's fields point inside the plugin and at https pages
  assert.ok(fs.existsSync(path.join(PLUGIN_DIR, String(claude.icon))), 'the icon is in the plugin');
  for (const k of ['homepage', 'documentationUrl', 'supportUrl', 'privacyPolicyUrl', 'termsOfServiceUrl'])
    assert.match(String(claude[k]), /^https:\/\/lampo\.video(\/|$)/, k);
});

test('one connector in both formats: Lampo Cloud at the address docs/mcp.md gives', () => {
  assert.equal(CONNECTOR, 'https://app.lampo.video/mcp');
  assert.deepEqual(json('plugins/lampo/.mcp.json'), { mcpServers: { lampo: { type: 'http', url: CONNECTOR } } });
  const mcp = json('plugins/lampo/mcp.json');
  assert.deepEqual(mcp.mcpServers, { lampo: { type: 'streamable-http', url: CONNECTOR } });
  assert.ok(fs.readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8').includes(CONNECTOR as string), 'the README says where the data goes');
});

test('the skill: one regular file both formats read, the one the repository has always linked, within its budget', () => {
  assert.ok(fs.lstatSync(path.join(ROOT, SKILL)).isFile(), 'a regular file in the plugin (the directories refuse links)');
  const skill = fs.readFileSync(path.join(ROOT, SKILL), 'utf8');
  assert.match(skill, /^---\nname: lampo\ndescription: \S.*\n---\n/, 'front matter: the name of its folder and when to use it');
  for (const old of ['skills/lampo/SKILL.md', 'skills/video-review/SKILL.md'])
    assert.equal(fs.readFileSync(path.join(ROOT, old), 'utf8'), skill, `${old} still leads to it`);
  // BUDGET.skill in token-budget.test.ts: it is read into context whenever it applies
  assert.ok(approxTokens(skill) <= 1550, `SKILL.md: ${approxTokens(skill)} tokens`);
});

test('the marketplace: one entry, the plugin by its own name, and no name the CLI reserves', () => {
  assert.equal(marketplace.name, 'lampo');
  assert.equal((marketplace.owner as Obj).name, COMPANY);
  assert.deepEqual(
    (marketplace.plugins as Obj[]).map((p) => [p.name, p.source]),
    [[claude.name, './plugins/lampo']],
  );
  // code.claude.com/docs/en/plugins/marketplace-reference#reserved-names and the manifest's name rules
  for (const name of [marketplace.name, claude.name] as string[]) {
    assert.match(name, /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/);
    assert.doesNotMatch(
      name,
      /^(claude|anthropic|anthropics|cc-plugin|claudeai)-|^(claude|anthropic|anthropics|claude-code|claude-mods|official|plugin|mcp|test)$/,
    );
    assert.ok(!['inline', 'builtin', 'skills-dir', 'synced', 'npm', 'pip', 'uv', 'cargo', 'github', 'gh'].includes(name));
  }
});

test('the Agent Plugins package fits its published schemas and what OpenAI states', () => {
  assert.deepEqual(packageProblems(), []);
  // the validator is strict where the schema is: a server entry is a closed shape (the auth block OpenAI's build page
  // shows inside one doesn't fit 1.0.0), and a name follows the pattern
  const schema = json('scripts/agent-plugins/mcp.schema.json');
  const withAuth = { ...json('plugins/lampo/mcp.json') };
  withAuth.mcpServers = { lampo: { type: 'streamable-http', url: CONNECTOR, extensions: { 'com.openai': { auth: { type: 'oauth' } } } } };
  assert.notDeepEqual(schemaProblems(schema as never, withAuth as never), []);
  assert.notDeepEqual(schemaProblems(json('scripts/agent-plugins/plugin.schema.json') as never, { ...portable, name: 'Lampo' } as never), []);
  // a listing whose developer isn't the manifest's author stops the package
  const copy = tmpdir('vr-plugin-dev-');
  fs.cpSync(PLUGIN_DIR, copy, { recursive: true });
  const other = structuredClone(portable) as { extensions: { 'com.openai': { interface: Obj } } };
  other.extensions['com.openai'].interface.developerName = 'Lampo';
  fs.writeFileSync(path.join(copy, 'plugin.json'), JSON.stringify(other));
  assert.deepEqual(packageProblems(copy), [`interface.developerName must be author.name (${COMPANY})`]);
});

test('what the directories take: regular files, small, readable; nothing Claude Code alone could run', () => {
  const all: string[] = [];
  const walk = (rel: string) => {
    for (const name of fs.readdirSync(path.join(PLUGIN_DIR, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(path.join(PLUGIN_DIR, r));
      assert.ok(!st.isSymbolicLink(), `${r}: no symbolic links`);
      if (st.isDirectory()) walk(r);
      else all.push(r);
    }
  };
  walk('');
  assert.ok(!fs.existsSync(path.join(PLUGIN_DIR, 'bin')), 'a bin/ folder keeps claude.ai and Cowork from installing it');
  for (const f of all) {
    assert.ok(!/(^|\/)(\.DS_Store|Thumbs\.db|desktop\.ini)$/.test(f), f);
    const size = fs.statSync(path.join(PLUGIN_DIR, f)).size;
    if (f.endsWith('.png')) assert.ok(size < 5 * 1024 * 1024, f);
    else {
      assert.ok(size < 256 * 1024, `${f}: under 256 KiB`);
      assert.match(f, /\.(md|json)$/, `${f}: text the reviewers read`);
    }
  }
  const words = fs
    .readFileSync(path.join(PLUGIN_DIR, 'README.md'), 'utf8')
    .replace(/```[\s\S]*?```/g, '')
    .split(/\s+/)
    .filter(Boolean).length;
  assert.ok(words >= 40, `README: ${words} words`);
  // the icon is the app's own
  assert.ok(fs.readFileSync(path.join(PLUGIN_DIR, 'assets/icon.png')).equals(fs.readFileSync(path.join(ROOT, 'web/public/icons/icon-512.png'))));
});

test('the ZIP for OpenAI holds the Agent Plugins files only, the same bytes each time', async () => {
  const dir = tmpdir('vr-plugin-');
  const a = path.join(dir, 'a.zip');
  const b = path.join(dir, 'b.zip');
  const files = await buildZip(a);
  await buildZip(b);
  assert.deepEqual(files, ['README.md', 'assets/icon.png', 'mcp.json', 'plugin.json', 'skills/lampo/SKILL.md']);
  assert.deepEqual(files, packageFiles().files);
  assert.ok(fs.readFileSync(a).equals(fs.readFileSync(b)), 'deterministic');
  let unzip = '';
  try {
    unzip = execFileSync('unzip', ['-Z1', a], { encoding: 'utf8' });
  } catch {
    return; // no unzip here: the listing above is what goes in
  }
  assert.deepEqual(unzip.trim().split('\n'), files);
  execFileSync('unzip', ['-t', a], { stdio: 'ignore' });
});
