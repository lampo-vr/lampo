// Playbook suggestions on a hosted server, the way they arrive there: an agent connected through an MCP connector (its
// client calls itself "Anthropic/ClaudeAI") suggests a long brief and long rules for a folder whose playbook is still at
// r0. The project above says suggestions wait inside it; the workspace's owner, signed in in the app, accepts both with
// the revision on their screen — the second isn't held up by the first — and the agent's token can't decide for them.
// Real SDK client over Streamable HTTP against the app in server mode, a session for the person.
import assert from 'node:assert/strict';
import { after, test } from 'node:test';
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';
import { startApp } from '../lib/app.ts';
import { isolatedEnv } from '../lib/helpers.ts';
import { cookieFrom } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const auth = await import('../../lib/auth.ts');
const { base, request } = await startApp({ headers: { Connection: 'close' } });
const clients: Client[] = [];
after(async () => {
  for (const c of clients) await c.close().catch(() => {});
});

const FOLDER = 'Acme/Frühjahr';
const e = encodeURIComponent;
// German markdown of the size a connector writes (synthetic)
const BRIEF = [
  '# Markenbrief',
  '',
  '**Für wen:** Menschen, die zum ersten Mal von Acme hören — neugierig, aber ohne Zeit.',
  '',
  '## Ton',
  '',
  '- Warm, direkt, nie werblich.',
  '- Kein Fachjargon; wenn doch, dann erklärt.',
  '',
  ...Array.from({ length: 24 }, (_, i) => `- Punkt ${i + 1}: Schnitte im Rhythmus der Musik, Übergänge weich, Grafiken ruhig und lesbar.`),
].join('\n');
const RULES = Array.from({ length: 30 }, (_, i) => `- Regel ${i + 1}: Untertitel zweizeilig, höchstens 42 Zeichen pro Zeile, nie über Gesichtern.`).join('\n');

test('hosted: an MCP connector suggests a brief and rules at r0; the owner accepts both in the app, the project above points to them', async () => {
  assert.ok(BRIEF.length > 2000 && RULES.length > 2500, 'real-shaped lengths');
  const owner = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password here', role: 'owner' });
  const login = await request('POST', '/api/auth/login', {
    body: { email: 'olivia@example.com', password: 'a long password here' },
    headers: { Origin: PUBLIC },
  });
  assert.equal(login.status, 200, login.text);
  const person = { Cookie: cookieFrom(login), Origin: PUBLIC };
  for (const path of ['Acme', FOLDER]) assert.equal((await request('POST', '/api/folders', { body: { path }, headers: person })).status, 200);

  const token = auth.createToken(owner.id, 'connector').token;
  const c = new Client({ name: 'Anthropic/ClaudeAI', version: '1.0.0' }, { versionNegotiation: { mode: 'auto' } });
  await c.connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
  clients.push(c);
  for (const [section, content] of [
    ['brief', BRIEF],
    ['rules', RULES],
  ]) {
    const r = (await c.callTool({ name: 'propose_playbook_change', arguments: { folder: FOLDER, section, content, reason: `Vorschlag: ${section}` } })) as {
      isError?: boolean;
      content: { text?: string }[];
    };
    assert.ok(!r.isError, r.content[0]?.text);
  }

  const view = (await request('GET', `/api/playbook?folder=${e(FOLDER)}`, { headers: person })).json();
  assert.equal(view.playbook.rev, 0);
  assert.deepEqual(
    view.playbook.proposals.map((p: { section: string; by: string; base_rev: number; status: string }) => [p.section, p.by, p.base_rev, p.status]),
    [
      ['brief', 'agent:Anthropic-ClaudeAI', 0, 'pending'],
      ['rules', 'agent:Anthropic-ClaudeAI', 0, 'pending'],
    ],
  );
  // where people look first: the project's page says suggestions wait in its folder
  assert.deepEqual((await request('GET', `/api/playbook?folder=Acme`, { headers: person })).json().below, [{ scope: FOLDER, pending: 2 }]);

  const [brief, rules] = view.playbook.proposals as { id: string }[];
  // the connector's own token can't decide: agents suggest, people accept
  assert.equal((await request('POST', `/api/playbook/proposals/${brief?.id}/accept`, { body: {}, headers: { Authorization: `Bearer ${token}` } })).status, 403);
  // both from the screen that showed r0: the brief's revision doesn't hold up the rules
  for (const p of [brief, rules]) {
    const r = await request('POST', `/api/playbook/proposals/${p?.id}/accept`, { body: { base_rev: 0 }, headers: person });
    assert.equal(r.status, 200, r.text);
  }
  const done = (await request('GET', `/api/playbook?folder=${e(FOLDER)}`, { headers: person })).json();
  assert.equal(done.playbook.rev, 2);
  assert.equal(done.playbook.brief, BRIEF);
  assert.equal(done.playbook.rules, RULES);
  assert.deepEqual(
    done.playbook.history.map((h: { by: string; accepted_by: string }) => [h.by, h.accepted_by]),
    [
      ['agent:Anthropic-ClaudeAI', 'Olivia'],
      ['agent:Anthropic-ClaudeAI', 'Olivia'],
    ],
  );
  assert.deepEqual((await request('GET', `/api/playbook?folder=Acme`, { headers: person })).json().below, [], 'nothing waits any more');
});
