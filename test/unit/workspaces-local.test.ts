// The app on a person's own machine stays one workspace: nothing a request can do moves its store to workspaces.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { WORKSPACES_FILE } = await import('../../lib/workspaces.ts');

test('at the machine, naming or making a workspace is refused and writes no workspaces.json', async () => {
  const { request } = await startApp({ loadSessions: async () => [] });
  assert.equal((await request('PATCH', '/api/workspaces/current', { body: { name: 'Studio' } })).status, 409);
  assert.notEqual((await request('POST', '/api/workspaces', { body: { name: 'Studio' } })).status, 200);
  const list = (await request('GET', '/api/workspaces')).json();
  assert.equal(list.enabled, false);
  assert.ok(!fs.existsSync(WORKSPACES_FILE), 'no workspaces.json');
  assert.ok(!fs.existsSync(path.join(dir, 'data', 'backups')), 'no backup of a move that never happened');
});
