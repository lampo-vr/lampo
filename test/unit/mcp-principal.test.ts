// Who /mcp serves when it can't tell (A12 AGENT-11): nobody. The principal used to default to the machine's owner
// (`via: 'local'`, role owner) when the SDK handed over no auth info — every tool, file paths on the server's disk
// included. Every path passes auth info today; a future one that doesn't must fail closed, not open.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: 'http://review.test' } });
const { principalOf, authInfoOf } = await import('../../server/routes/mcp.ts');
const { allowed, audienceOf, TOOL_ACCESS } = await import('../../mcp/access.ts');

test('AGENT-11: no auth info, empty auth info or no caller is nobody: no tool, no files, errors as for anyone', () => {
  for (const [what, p] of [
    ['no auth info', principalOf(undefined)],
    ['auth info without extra', principalOf({ token: '', clientId: 'x', scopes: [] })],
    ['an empty extra', principalOf({ token: '', clientId: 'x', scopes: [], extra: {} })],
    ['no caller', principalOf(authInfoOf(undefined))],
  ] as const) {
    assert.notEqual(p.via, 'local', `${what}: never the machine itself`);
    assert.equal(p.role, '', `${what}: no role`);
    assert.equal(audienceOf(p), 'other', what);
    for (const [tool, access] of Object.entries(TOOL_ACCESS)) assert.equal(allowed(p, access), false, `${what}: ${tool}`);
  }
});
