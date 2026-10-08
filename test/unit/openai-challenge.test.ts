// OpenAI's app directory verifies that whoever submits an MCP server owns its host: it fetches a token from
// /.well-known/openai-apps-challenge on the server's host and expects exactly that token, as plain text. The server
// answers it from LAMPO_OPENAI_APPS_CHALLENGE, to anyone (no sign-in), and only while it is set: unset or malformed,
// the path is what any unknown one is.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { openaiChallenge } = await import('../../server/app.ts');
const { request } = await startApp({ headers: { Connection: 'close', Host: 'review.test' } });

const PATH = '/.well-known/openai-apps-challenge';
// made at run time: nothing in the repository looks like a real token
const TOKEN = `oa-${'0123456789abcdef'.split('').reverse().join('')}-test`;

test('set: the exact token as plain text, to anyone, never cached', async () => {
  process.env.LAMPO_OPENAI_APPS_CHALLENGE = TOKEN;
  try {
    const r = await request('GET', PATH);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.text, TOKEN, 'the token alone: no JSON, no line break');
    assert.match(String(r.headers['content-type']), /^text\/plain/);
    assert.equal(r.headers['cache-control'], 'no-store');
    assert.equal((await request('HEAD', PATH)).status, 200);
    // the setting's surrounding blanks (an env file's) are not part of it
    process.env.LAMPO_OPENAI_APPS_CHALLENGE = `  ${TOKEN}\n`;
    assert.equal((await request('GET', PATH)).text, TOKEN);
    // only that path, spelled exactly, and only read
    for (const [method, p] of [
      ['GET', `${PATH}/`],
      ['GET', PATH.toUpperCase()],
      ['GET', `/.well-known//openai-apps-challenge`],
      ['POST', PATH],
    ]) {
      const r = await request(method, p, method === 'POST' ? { body: {} } : {});
      assert.notEqual(r.status, 200, `${method} ${p}`);
      assert.ok(!r.text.includes(TOKEN), `${method} ${p} says the token`);
    }
  } finally {
    delete process.env.LAMPO_OPENAI_APPS_CHALLENGE;
  }
});

test('unset or malformed: the path is an unknown one, like any other under /.well-known', async () => {
  const unknown = await request('GET', '/.well-known/nothing-here');
  const unset = await request('GET', PATH);
  assert.equal(unset.status, 404);
  assert.equal(unset.status, unknown.status);
  assert.equal(unset.headers['content-type'], unknown.headers['content-type']);
  for (const bad of ['two words', 'line\nbreak', 'x'.repeat(600), '']) {
    process.env.LAMPO_OPENAI_APPS_CHALLENGE = bad;
    assert.equal(openaiChallenge(), null, JSON.stringify(bad.slice(0, 20)));
    assert.equal((await request('GET', PATH)).status, 404, JSON.stringify(bad.slice(0, 20)));
  }
  delete process.env.LAMPO_OPENAI_APPS_CHALLENGE;
});
