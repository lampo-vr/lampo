// Addresses become routes. A malformed escape in the hash (a folder named "100%", a pasted half URL) must not stop
// the app before its first render: it is taken as written.
import assert from 'node:assert/strict';
import test from 'node:test';

// nav.ts is browser code (it also sets location.hash): imported by URL, so the backend typecheck doesn't take it in.
type Parse = (hash: string, pathname: string) => { name: string; view?: unknown };
const { parseRoute, canonicalHash, isOldOpenNotes } = (await import(new URL('../../web/src/lib/nav.ts', import.meta.url).href)) as {
  parseRoute: Parse;
  canonicalHash: (hash: string) => string | null;
  isOldOpenNotes: (hash: string) => boolean;
};
const { planIn, withPlan, signedInTo } = (await import(new URL('../../web/src/auth/signupLink.ts', import.meta.url).href)) as {
  planIn: (hash: string, search: string) => string | undefined;
  withPlan: (to: '#/signup' | '#/', hash: string, search: string) => string;
  signedInTo: (hash: string, search: string, billing: boolean) => string;
};

test('a malformed % in the hash is taken as written, not a blank page', () => {
  assert.deepEqual(parseRoute('#/folder/100%', '/'), { name: 'library', view: { kind: 'folder', id: '100%' } });
  assert.deepEqual(parseRoute('#/playbook/a%', '/'), { name: 'library', view: { kind: 'playbook', id: 'a%' } });
  assert.equal(parseRoute('#/print/%E0%A4%A', '/').name, 'print');
  assert.equal(parseRoute('#/v/x%zz?f=3', '/').name, 'player');
  assert.equal(parseRoute('#/session/%', '/').name, 'library');
  // Well-formed escapes still decode.
  assert.deepEqual(parseRoute('#/folder/Acme%2FReels', '/'), { name: 'library', view: { kind: 'folder', id: 'Acme/Reels' } });
});

test("the sidebar is Inbox · All videos · Insights: the old views' addresses land where their videos are now", () => {
  const view = (h: string) => parseRoute(h, '/').view;
  assert.deepEqual(view('#/inbox'), { kind: 'inbox' });
  assert.deepEqual(view('#/unsorted'), { kind: 'unsorted' });
  // fixes to check are the inbox's; the inbox's old page too
  for (const h of ['#/verify', '#/for-you', '#/for-you/']) {
    assert.deepEqual(view(h), { kind: 'inbox' }, h);
    assert.equal(canonicalHash(h), '#/inbox', h);
  }
  // open notes: All videos (App puts it on the Being fixed lane)
  assert.deepEqual(view('#/open'), { kind: 'all' });
  assert.equal(canonicalHash('#/open'), '#/');
  assert.ok(isOldOpenNotes('#/open') && !isOldOpenNotes('#/'));
  assert.equal(canonicalHash('#/inbox'), null);
  assert.equal(canonicalHash('#/'), null);
});

test('A12 WEB-6: the OAuth error page takes a known code and no words from the address', () => {
  assert.deepEqual(parseRoute('#/oauth/error?error=unsupported_response_type', '/'), { name: 'oauth-error', error: 'unsupported_response_type' });
  // Anyone can send a link to it: an unknown code is a plain invalid_request, and a description is never kept.
  const spoof = '#/oauth/error?error=account_suspended&error_description=Your%20workspace%20was%20suspended.%20Pay%20at%20evil.example';
  assert.deepEqual(parseRoute(spoof, '/'), { name: 'oauth-error', error: 'invalid_request' });
  assert.deepEqual(parseRoute('#/oauth/error?error=invalid_scope&error_description=x', '/'), { name: 'oauth-error', error: 'invalid_scope' });
  assert.deepEqual(parseRoute('#/oauth/error', '/'), { name: 'oauth-error', error: 'invalid_request' });
});

test('Settings → Billing’s checkout and its cancellation (§ 312k) are steps of their own; no other section has one', () => {
  assert.deepEqual(parseRoute('#/settings/billing/checkout?plan=team&interval=year', '/'), { name: 'settings', section: 'billing' });
  assert.deepEqual(parseRoute('#/settings/billing/checkout', '/'), { name: 'settings', section: 'billing' });
  assert.deepEqual(parseRoute('#/settings/billing/cancel', '/'), { name: 'settings', section: 'billing' });
  assert.deepEqual(parseRoute('#/settings/billing?checkout=done', '/'), { name: 'settings', section: 'billing' });
  assert.notEqual(parseRoute('#/settings/profile/checkout', '/').name, 'settings');
  assert.notEqual(parseRoute('#/settings/profile/cancel', '/').name, 'settings');
  assert.notEqual(parseRoute('#/settings/billing/checkoutx', '/').name, 'settings');
  assert.notEqual(parseRoute('#/settings/billing/cancelled', '/').name, 'settings');
});

test('a route an outside link opens takes a query: the website’s Start free (#/signup?plan=…), utm tags, an email’s link', () => {
  // lampo.video's Start free opened the sign-in screen: #/signup?plan=cloud-free was read as the library
  for (const hash of [
    '#/signup',
    '#/signup/',
    '#/signup?plan=cloud-free',
    '#/signup/?plan=cloud-solo&utm_source=x',
    '#/signup?utm_source=site&utm_campaign=launch',
  ])
    assert.deepEqual(parseRoute(hash, '/'), { name: 'signup' }, hash);
  for (const hash of ['#/forgot', '#/forgot/', '#/forgot?utm_source=x']) assert.deepEqual(parseRoute(hash, '/'), { name: 'forgot' }, hash);
  assert.deepEqual(parseRoute('#/invite/inv_Ab-1_z?utm_source=mail', '/'), { name: 'invite', token: 'inv_Ab-1_z' });
  assert.deepEqual(parseRoute('#/reset/rt_Ab-1_z?utm_medium=email', '/'), { name: 'reset', token: 'rt_Ab-1_z' });
  assert.deepEqual(parseRoute('#/verify/vt_Ab-1_z?utm_medium=email', '/'), { name: 'verify', token: 'vt_Ab-1_z' });
  assert.deepEqual(parseRoute('#/welcome?utm_source=x', '/'), { name: 'welcome', step: null });
  assert.deepEqual(parseRoute('#/welcome/team?utm_source=x', '/'), { name: 'welcome', step: 'team' });
  assert.deepEqual(parseRoute('#/inbox?utm_source=push', '/'), { name: 'library', view: { kind: 'inbox' } });
  assert.deepEqual(parseRoute('#/insights?utm_source=x', '/'), { name: 'library', view: { kind: 'insights' } });
  // only the query: what each route accepts before it stays as strict
  for (const hash of [
    '#/signupx',
    '#/signup/x',
    '#/signup//?a',
    '#/forgotten',
    '#/invite/inv_a/b',
    '#/invite/x_1?plan=1',
    '#/reset/rt_a b',
    '#/verify/vt_a#b',
    '#/inbox/x',
  ])
    assert.deepEqual(parseRoute(hash, '/'), { name: 'library', view: { kind: 'all' } }, hash);
  // the token is the token, never the query after it
  assert.deepEqual(parseRoute('#/reset/rt_a?x=rt_b', '/'), { name: 'reset', token: 'rt_a' });
  // routes that read their query keep reading it
  assert.deepEqual(parseRoute('#/settings/billing?plan=cloud-solo', '/'), { name: 'settings', section: 'billing' });
  assert.equal(parseRoute('#/v/a?c=n1&utm_source=x', '/').name, 'player');
});

test('the website’s sign-up link: its plan, the links between sign-in and sign-up keep it, and where it takes someone signed in', () => {
  // the plan in the hash's query or the address's; known ids only (Start free's cloud-free is the default: no id)
  assert.equal(planIn('#/signup?plan=cloud-solo&utm_source=x', ''), 'cloud-solo');
  assert.equal(planIn('#/signup', '?plan=cloud-team'), 'cloud-team');
  assert.equal(planIn('#/signup?plan=cloud-free', ''), undefined);
  assert.equal(planIn('#/signup?plan=enterprise', ''), undefined);
  assert.equal(withPlan('#/signup', '#/?plan=cloud-business', ''), '#/signup?plan=cloud-business');
  assert.equal(withPlan('#/', '#/signup?plan=cloud-solo', ''), '#/?plan=cloud-solo');
  assert.equal(withPlan('#/signup', '#/?plan=cloud-free&utm_source=x', ''), '#/signup');
  // signed in: the app (the session's workspace, the one last used); a paid plan to Billing's picker where billing runs
  assert.equal(signedInTo('#/signup?plan=cloud-free', '', true), '#/');
  assert.equal(signedInTo('#/signup?plan=cloud-solo', '', false), '#/');
  assert.equal(signedInTo('#/signup?plan=cloud-solo&utm_source=x', '', true), '#/settings/billing?plan=cloud-solo');
  assert.equal(signedInTo('#/signup?plan=cloud-team&interval=year&currency=usd', '', true), '#/settings/billing?plan=cloud-team&interval=year&currency=usd');
  assert.equal(signedInTo('#/signup', '?plan=cloud-business&interval=weekly&currency=xyz', true), '#/settings/billing?plan=cloud-business');
});

test('the operator’s pages: the funnel, the workspaces and the accounts, a list or one of it — nothing else', () => {
  for (const hash of ['#/operator', '#/operator/funnel', '#/operator/workspaces', '#/operator/workspaces/w_0a1b2c3d4e5f', '#/operator/accounts/u_0a1b2c3d4e5f'])
    assert.deepEqual(parseRoute(hash, '/'), { name: 'settings', section: 'operator' }, hash);
  for (const hash of ['#/operator/billing', '#/operator/workspaces/a/b', '#/operator/accounts/x y'])
    assert.notEqual(parseRoute(hash, '/').name, 'settings', hash);
});
