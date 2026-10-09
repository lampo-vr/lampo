// The first start of a fresh checkout builds what the app serves: the UI and the MCP review card, each only when it is
// missing (server/uiBuild.ts, what server/index.ts runs before it listens). Vite is a stand-in that writes the file each
// build makes; nothing is really built here.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { tmpdir } from '../lib/helpers.ts';

const { buildMissing } = await import('../../server/uiBuild.ts');

/** A web/ folder without its builds, and a vite that records what it was asked to build and makes its output. */
function checkout() {
  const web = tmpdir('vr-web-');
  fs.mkdirSync(path.join(web, 'mcp-app'), { recursive: true });
  const built: string[] = [];
  const build = async ({ root }: { root: string }) => {
    built.push(path.relative(web, root) || '.');
    const out = root === web ? path.join(web, 'dist', 'index.html') : path.join(web, 'dist-mcp', 'review.html');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, '<!doctype html>');
  };
  return { web, built, build };
}

test('a fresh checkout: the UI and the review card are both built', async () => {
  const c = checkout();
  assert.deepEqual(await buildMissing(c.web, c.build), ['UI', 'review card']);
  assert.deepEqual(c.built, ['.', 'mcp-app']);
  assert.ok(fs.existsSync(path.join(c.web, 'dist-mcp', 'review.html')), 'the card an MCP client is served');
});

test('a UI built earlier without the card (an older first start): only the card', async () => {
  const c = checkout();
  fs.mkdirSync(path.join(c.web, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(c.web, 'dist', 'index.html'), '<!doctype html>');
  assert.deepEqual(await buildMissing(c.web, c.build), ['review card']);
  assert.deepEqual(c.built, ['mcp-app']);
});

test('both there: nothing is built again', async () => {
  const c = checkout();
  await buildMissing(c.web, c.build);
  c.built.length = 0;
  assert.deepEqual(await buildMissing(c.web, c.build), []);
  assert.deepEqual(c.built, []);
});
