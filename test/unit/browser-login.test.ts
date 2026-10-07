// `vr login <url>` in the browser (lib/browserLogin.ts): vr's own client at /oauth/authorize, the consent screen's API,
// a one-time code on vr's loopback port, PKCE, and the same API token `vr login --email` makes (POST /api/auth/token).
// The "browser" is plain HTTP with a signed-in session; vr's opener is injected (in-process) or a stand-in script named
// by BROWSER (the real `vr`). Never a real browser.
import assert from 'node:assert/strict';
import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import type http from 'node:http';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import type { User } from '../../lib/auth.ts';
import type { OAuthRequestView } from '../../lib/types.ts';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, must, tmpdir, until, VR } from '../lib/helpers.ts';

isolatedEnv({ vars: { VR_MODE: 'server' } });
const auth = await import('../../lib/auth.ts');
const { COOKIE } = await import('../../server/auth.ts');
const { PERSON_ONLY_ERROR } = await import('../../server/permissions.ts');
const { browserCommand, browserLogin, LoginEnded } = await import('../../lib/browserLogin.ts');
const grants = await import('../../lib/oauth/store.ts');
const { afterNewPassword } = await import('../../lib/newPassword.ts');

const { base, server } = await startApp();
/** Every address the server was asked for (path and query): the token must never be in one. */
const asked: string[] = [];
server.prependListener('request', (req: http.IncomingMessage) => asked.push(req.url || ''));

const olivia = await auth.createUser({ email: 'olivia@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
const cookieOf = (u: User) => `${COOKIE}=${auth.signSession(u)}`;
const OLIVIA = cookieOf(olivia);

const b64url = (b: Buffer) => b.toString('base64url');
const pkce = () => {
  const verifier = b64url(crypto.randomBytes(32));
  return { verifier, challenge: b64url(crypto.createHash('sha256').update(verifier).digest()) };
};

interface Browsed {
  /** Where /oauth/authorize sent the browser. */
  location: string;
  view?: OAuthRequestView;
  /** The address the consent screen hands the browser to after the decision: vr's loopback port. */
  answer?: URL;
  /** What vr's port said to the browser's last step. */
  landed?: number;
}

/** The person's browser: /oauth/authorize, the consent screen's request, Allow (or Deny), then on to vr's port. */
async function browse(url: string, cookie: string, { allow = true, follow = true } = {}): Promise<Browsed> {
  const first = await fetch(url, { redirect: 'manual', headers: { cookie } });
  const location = first.headers.get('location') || '';
  const id = /^\/\?consent#\/oauth\/([A-Za-z0-9_-]+)$/.exec(location)?.[1];
  if (!id) return { location };
  const view = (await (await fetch(`${base}/api/oauth/requests/${id}`, { headers: { cookie } })).json()) as OAuthRequestView;
  const decided = await fetch(`${base}/api/oauth/requests/${id}`, {
    method: 'POST',
    headers: { cookie, origin: base, 'content-type': 'application/json' },
    // like the screen: the workspace it named, on a server with several
    body: JSON.stringify({ allow, ...(view.workspace ? { workspace: view.workspace.id } : {}) }),
  });
  assert.equal(decided.status, 200, await decided.clone().text());
  const answer = new URL(((await decided.json()) as { redirect: string }).redirect);
  const landed = follow ? (await fetch(answer)).status : undefined;
  return { location, view, answer, landed };
}

/** An authorize address of vr's client, made by hand (the server half alone). */
const authorizeUrl = (q: Record<string, string>) =>
  `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: 'vr', code_challenge_method: 'S256', state: 'st-1', machine: 'studio-mac', ...q })}`;

/** A vr code the person allowed, with the verifier that redeems it. */
async function vrCode(redirect = 'http://127.0.0.1:61000/') {
  const { verifier, challenge } = pkce();
  const b = await browse(authorizeUrl({ redirect_uri: redirect, code_challenge: challenge }), OLIVIA, { follow: false });
  const code = must(b.answer?.searchParams.get('code'), 'code');
  return { code, verifier, redirect };
}
const redeem = (body: Record<string, string>) =>
  fetch(`${base}/api/auth/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** browserLogin with a "browser" that does what `run` says with the address vr opens. */
function login(run: (url: string) => Promise<unknown>, o: Partial<Parameters<typeof browserLogin>[0]> = {}) {
  const said: string[] = [];
  let browsing: Promise<unknown> = Promise.resolve();
  const result = browserLogin({
    server: base,
    machine: 'studio-mac',
    open: (url) => {
      // the browser goes on by itself; vr only started it
      browsing = run(url);
    },
    say: (line) => said.push(line),
    ...o,
  });
  return { result, said, browsing: () => browsing };
}

test('in the browser: the consent screen names the machine and the token, Allow brings the same API token --email makes', async () => {
  const { result, said, browsing } = login((url) => browse(url, OLIVIA));
  const got = await result;
  const b = (await browsing()) as Browsed;
  assert.match(got.token, /^vr_/);
  assert.equal(got.info.name, 'lampo on studio-mac', 'named like --email names it');
  const held = must(auth.verifyToken(got.token));
  assert.equal(held.user.id, olivia.id);
  assert.equal(held.token.expires, undefined, 'until revoked');
  // the consent screen: vr, the machine, the token's name; no scopes; the local answer, warned about
  const view = must(b.view);
  assert.deepEqual(view.vr, { machine: 'studio-mac', days: null, token: 'lampo on studio-mac' });
  assert.equal(view.client_name, 'lampo', 'the client id stays vr, its name is the command’s');
  assert.deepEqual(view.scopes, []);
  assert.equal(view.local_redirect, true);
  assert.match(view.redirect_host, /^127\.0\.0\.1:\d+$/);
  // the address vr opened: its own client, PKCE S256, an answer on this computer's loopback port
  const authorize = new URL(must(asked.find((u) => u.startsWith('/oauth/authorize'))), base);
  assert.equal(authorize.searchParams.get('client_id'), 'vr');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.match(authorize.searchParams.get('code_challenge') || '', /^[A-Za-z0-9_-]{43}$/);
  assert.equal(authorize.searchParams.get('machine'), 'studio-mac');
  assert.match(authorize.searchParams.get('redirect_uri') || '', /^http:\/\/127\.0\.0\.1:\d+\/$/);
  // the browser's last step reached vr, which answered without a page (the consent screen stays: "Back to the terminal")
  assert.equal(b.landed, 204);
  assert.ok(b.answer?.searchParams.get('code') && b.answer.searchParams.get('state'));
  // the token goes to vr in the answer to its POST, never in an address: not to the server, not to the loopback port
  assert.ok(!asked.some((u) => u.includes(got.token)), 'never in an address the server saw');
  assert.ok(!String(b.answer).includes(got.token), 'never in the loopback address');
  assert.deepEqual(
    said.filter((l) => !l.startsWith('  ')),
    [`Opening your browser to sign in to ${base}.`, 'If it doesn’t open, go to:', 'Waiting for you to allow it in the browser… (Ctrl-C cancels)'],
  );
  assert.ok(said.includes(`  ${authorize}`), 'the address, in case no browser opens');
  // the loopback port is gone once vr has its answer
  await assert.rejects(fetch(String(b.answer)), 'nothing listens there any more');
});

test('--expires: the consent screen says how long, and the token ends then', async () => {
  const { result, browsing } = login((url) => browse(url, OLIVIA), { days: 30 });
  const got = await result;
  const b = (await browsing()) as Browsed;
  assert.equal(b.view?.vr?.days, 30);
  const expires = Date.parse(must(must(auth.verifyToken(got.token)).token.expires));
  assert.ok(Math.abs(expires - (Date.now() + 30 * 86400_000)) < 120_000, 'about 30 days from now');
});

test('Deny: vr hears no, and nothing is made', async () => {
  const before = auth.listTokens().length;
  const { result } = login((url) => browse(url, OLIVIA, { allow: false }));
  await assert.rejects(result, (e: Error) => e instanceof LoginEnded && e.reason === 'denied' && /you said no in the browser/.test(e.message));
  assert.equal(auth.listTokens().length, before);
});

test('a wrong state is never taken: vr refuses it and waits for its own answer, whose code still works', async () => {
  let wrong = 0;
  const { result } = login(async (url) => {
    const b = await browse(url, OLIVIA, { follow: false });
    const answer = must(b.answer);
    const forged = new URL(answer);
    forged.searchParams.set('state', 'not-the-state');
    wrong = (await fetch(forged)).status;
    const denied = new URL(answer);
    denied.searchParams.delete('code');
    denied.searchParams.set('error', 'access_denied');
    denied.searchParams.set('state', 'not-the-state');
    assert.equal((await fetch(denied)).status, 400, 'a no for another sign-in is no answer either');
    assert.equal((await fetch(new URL('/favicon.ico', answer))).status, 404);
    return (await fetch(answer)).status;
  });
  const got = await result;
  assert.equal(wrong, 400);
  assert.ok(auth.verifyToken(got.token), 'the code the forged answer carried was never redeemed: the real one made the token');
});

test('a code works once: a second try is refused and revokes the token the first one made', async () => {
  const { code, verifier, redirect } = await vrCode();
  const first = await redeem({ code, code_verifier: verifier, redirect_uri: redirect });
  assert.equal(first.status, 200, await first.clone().text());
  const made = (await first.json()) as { token: string; info: { id: string; name: string }; user: { name: string } };
  assert.equal(made.info.name, 'lampo on studio-mac');
  assert.equal(made.user.name, 'Olivia');
  assert.match(first.headers.get('cache-control') || '', /\bno-store\b/);
  assert.ok(auth.verifyToken(made.token));
  const again = await redeem({ code, code_verifier: verifier, redirect_uri: redirect });
  assert.equal(again.status, 400);
  assert.match(((await again.json()) as { error: string }).error, /already used/);
  assert.equal(auth.verifyToken(made.token), null, 'whoever saw the code also saw the answer: the token is gone');
});

test('a wrong verifier is refused, and the code is used up by it', async () => {
  const { code, verifier, redirect } = await vrCode();
  const bad = await redeem({ code, code_verifier: pkce().verifier, redirect_uri: redirect });
  assert.equal(bad.status, 400);
  assert.match(((await bad.json()) as { error: string }).error, /PKCE/);
  const late = await redeem({ code, code_verifier: verifier, redirect_uri: redirect });
  assert.equal(late.status, 400, 'the right verifier comes too late');
  // and an answer brought to another address than the code went to
  const other = await vrCode();
  const moved = await redeem({ code: other.code, code_verifier: other.verifier, redirect_uri: 'http://127.0.0.1:61001/' });
  assert.equal(moved.status, 400);
  assert.match(((await moved.json()) as { error: string }).error, /redirect_uri/);
});

test('an expired code is refused', async () => {
  const keep = grants.VR_CODE.ttlMs;
  grants.VR_CODE.ttlMs = 0;
  try {
    const { code, verifier, redirect } = await vrCode();
    const r = await redeem({ code, code_verifier: verifier, redirect_uri: redirect });
    assert.equal(r.status, 400);
    assert.match(((await r.json()) as { error: string }).error, /unknown or has expired/);
  } finally {
    grants.VR_CODE.ttlMs = keep;
  }
  assert.ok(keep <= 120_000, 'a vr code works two minutes at most');
});

test('the answer goes to 127.0.0.1 or [::1] on this computer, any port, and nowhere else', async () => {
  const { challenge } = pkce();
  const go = async (redirect_uri: string, q: Record<string, string> = {}) =>
    (await fetch(authorizeUrl({ redirect_uri, code_challenge: challenge, ...q }), { redirect: 'manual', headers: { cookie: OLIVIA } })).headers.get('location');
  const refused = '/#/oauth/error?error=invalid_request';
  for (const uri of [
    'http://localhost:61000/',
    'http://evil.example/',
    'http://evil.example:61000/',
    'https://127.0.0.1:61000/',
    'http://127.0.0.1:61000/callback',
    'http://127.0.0.1:61000/?next=x',
    'http://user@127.0.0.1:61000/',
    'http://127.0.0.1.evil.example:61000/',
    'http://0x7f.0.0.1:61000/',
    'http://127.0.0.2:61000/',
    'http://[::1]:61000/#x',
    'vr://callback',
  ])
    assert.equal(await go(uri), refused, uri);
  for (const uri of ['http://127.0.0.1:61000/', 'http://[::1]:61000/', 'http://127.0.0.1:1/'])
    assert.match((await go(uri)) || '', /^\/\?consent#\/oauth\//, uri);
  // vr's client asks with PKCE S256, a state and a machine, always
  assert.equal(await go('http://127.0.0.1:61000/', { code_challenge_method: 'plain' }), refused);
  assert.equal(await go('http://127.0.0.1:61000/', { machine: '' }), refused);
  assert.equal(await go('http://127.0.0.1:61000/', { machine: '‮\u0007' }), refused, 'nothing left of the name once cleaned');
  assert.equal(await go('http://127.0.0.1:61000/', { days: '0' }), refused);
  assert.equal(await go('http://127.0.0.1:61000/', { days: '3651' }), refused);
  const noState = new URL(authorizeUrl({ redirect_uri: 'http://127.0.0.1:61000/', code_challenge: challenge }));
  noState.searchParams.delete('state');
  assert.equal((await fetch(noState, { redirect: 'manual' })).headers.get('location'), refused);
});

test('the machine name is shown as one line: control and direction characters go', async () => {
  const { challenge } = pkce();
  const b = await browse(authorizeUrl({ redirect_uri: 'http://127.0.0.1:61000/', code_challenge: challenge, machine: 'studio‮-mac\n\u0007 two' }), OLIVIA, {
    follow: false,
  });
  assert.equal(b.view?.vr?.machine, 'studio-mac two');
  assert.equal(b.view?.vr?.token, 'lampo on studio-mac two');
});

test('the OAuth store never turns a vr code into an app’s connection, whichever client asks', async () => {
  // /oauth/token can't even name vr as its client (above); the store refuses it on its own too
  const v = await vrCode();
  assert.throws(
    () => grants.redeemCode({ code: v.code, client_id: 'vr', redirect_uri: v.redirect, code_verifier: v.verifier }),
    (e: Error) => e instanceof grants.GrantError && /unknown or has expired/.test(e.message),
  );
  assert.equal((await redeem({ code: v.code, code_verifier: v.verifier, redirect_uri: v.redirect })).status, 400, 'and that try used it up');
  assert.equal(grants.listApps(olivia.id).length, 0);
});

test('an app’s code is never an API token, and vr’s code never an app’s connection', async () => {
  // vr's code at the OAuth token endpoint: vr isn't a client there, and another client's id gets nothing either
  const reg = (await (
    await fetch(`${base}/oauth/register`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ client_name: 'Some App', redirect_uris: ['http://127.0.0.1:61000/'] }),
    })
  ).json()) as { client_id: string };
  for (const client_id of ['vr', reg.client_id]) {
    const v = await vrCode();
    const r = await fetch(`${base}/oauth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: v.code, code_verifier: v.verifier, client_id, redirect_uri: v.redirect }).toString(),
    });
    assert.ok(r.status === 400 || r.status === 401, `${client_id}: ${r.status}`);
    assert.ok(!('access_token' in ((await r.json()) as object)));
  }
  assert.equal(grants.listApps(olivia.id).length, 0, 'no connection was made');
  // an app's code at vr's token endpoint
  const { verifier, challenge } = pkce();
  const app = await browse(
    `${base}/oauth/authorize?${new URLSearchParams({ response_type: 'code', client_id: reg.client_id, redirect_uri: 'http://127.0.0.1:61000/', code_challenge: challenge, code_challenge_method: 'S256', state: 's' })}`,
    OLIVIA,
    { follow: false },
  );
  assert.equal(app.view?.vr, undefined, 'an app’s consent screen is the app’s');
  const r = await redeem({ code: must(app.answer?.searchParams.get('code')), code_verifier: verifier, redirect_uri: 'http://127.0.0.1:61000/' });
  assert.equal(r.status, 400);
  assert.ok(!('token' in ((await r.json()) as object)));
});

test('the consent screen and its decision are a person’s: an API token is refused (PERSON_ONLY), signed out is asked to sign in', async () => {
  const { challenge } = pkce();
  const location = (await fetch(authorizeUrl({ redirect_uri: 'http://127.0.0.1:61000/', code_challenge: challenge }), { redirect: 'manual' })).headers.get(
    'location',
  );
  const id = must(/#\/oauth\/([A-Za-z0-9_-]+)$/.exec(location || '')?.[1]);
  const token = auth.createToken(olivia.id, 'agent').token;
  const bearer = { authorization: `Bearer ${token}` };
  const look = await fetch(`${base}/api/oauth/requests/${id}`, { headers: bearer });
  assert.equal(look.status, 403);
  assert.match(await look.text(), new RegExp(PERSON_ONLY_ERROR));
  const allow = await fetch(`${base}/api/oauth/requests/${id}`, {
    method: 'POST',
    headers: { ...bearer, 'content-type': 'application/json' },
    body: '{"allow":true}',
  });
  assert.equal(allow.status, 403);
  // signed out: nothing about anyone — sign in first; and a code nobody was given says the same whoever asks
  const out = await fetch(`${base}/api/oauth/requests/${id}`);
  assert.equal(out.status, 401);
  assert.deepEqual(await out.json(), { error: 'please sign in' });
  const guess = await redeem({ code: 'vra_guess', code_verifier: pkce().verifier, redirect_uri: 'http://127.0.0.1:61000/' });
  assert.equal(guess.status, 400);
  assert.deepEqual(await guess.json(), { error: 'the sign-in code is unknown or has expired: run lampo login again' });
  // zod on the body: unknown fields, a short verifier, a missing redirect
  for (const body of [
    { code: 'x', code_verifier: pkce().verifier },
    { code: 'x', code_verifier: 'short', redirect_uri: 'http://127.0.0.1:1/' },
    { code: 'x', code_verifier: pkce().verifier, redirect_uri: 'http://127.0.0.1:1/', email: 'olivia@example.com' },
  ])
    assert.equal((await redeem(body as Record<string, string>)).status, 400, JSON.stringify(body));
});

test('the token is the person’s role in the workspace the screen named, and a reviewer’s stays a reviewer’s', async () => {
  const { result } = login((url) => browse(url, cookieOf(rita)));
  const got = await result;
  const me = (await (await fetch(`${base}/api/auth/me`, { headers: { authorization: `Bearer ${got.token}` } })).json()) as { role: string; name: string };
  assert.deepEqual([me.name, me.role], ['Rita', 'reviewer']);
});

test('a new password voids a code not yet redeemed', async () => {
  const { code, verifier, redirect } = await vrCode();
  afterNewPassword(olivia.id);
  const r = await redeem({ code, code_verifier: verifier, redirect_uri: redirect });
  assert.equal(r.status, 400);
});

test('no answer: vr says so after its wait and keeps nothing; Ctrl-C ends the wait at once', async () => {
  const before = auth.listTokens().length;
  const quiet = login(async () => {}, { timeoutMs: 50 });
  await assert.rejects(
    quiet.result,
    (e: Error) => e instanceof LoginEnded && e.reason === 'timeout' && /no answer from the browser within 1 s; nothing was saved/.test(e.message),
  );
  const stop = new AbortController();
  const cancelled = login(async () => stop.abort(), { signal: stop.signal });
  await assert.rejects(cancelled.result, (e: Error) => e instanceof LoginEnded && e.reason === 'cancelled');
  assert.equal(auth.listTokens().length, before);
});

test('over SSH: the address to open elsewhere, and the address the browser ended on, pasted, signs in', async () => {
  const input = new PassThrough();
  const said: string[] = [];
  const result = browserLogin({ server: base, machine: 'build-box', open: null, say: (l) => said.push(l), input });
  const url = (await until(() => said.find((l) => l.startsWith('  http'))?.trim(), 'the address')) as string;
  assert.deepEqual(
    said.filter((l) => !l.startsWith('  ')),
    [
      `Open this address in a browser to sign in to ${base}:`,
      'After Allow, a browser on another computer ends on a page that doesn’t load: paste its address here.',
      'Waiting for you to allow it in the browser… (Ctrl-C cancels)',
    ],
  );
  // the browser on the other computer can't reach this one's port: the person copies where it ended
  const b = await browse(url, OLIVIA, { follow: false });
  input.write('something else\n');
  await until(() => said.some((l) => l.startsWith('That isn’t the address of this sign-in')), 'a word about a wrong paste');
  input.write(`  ${b.answer}  \n`);
  const got = await result;
  assert.equal(got.info.name, 'lampo on build-box');
});

test('which browser: BROWSER when set; none over SSH or on a Linux without a screen; else the system’s', () => {
  assert.deepEqual(browserCommand({ BROWSER: 'firefox --new-tab' }, 'linux'), ['firefox', '--new-tab']);
  assert.deepEqual(browserCommand({ BROWSER: 'firefox', SSH_CONNECTION: '1 2 3 4' }, 'linux'), ['firefox']);
  assert.equal(browserCommand({ SSH_CONNECTION: '1 2 3 4' }, 'darwin'), null);
  assert.equal(browserCommand({ SSH_TTY: '/dev/ttys001' }, 'darwin'), null);
  assert.equal(browserCommand({}, 'linux'), null);
  assert.deepEqual(browserCommand({ DISPLAY: ':0' }, 'linux'), ['xdg-open']);
  assert.deepEqual(browserCommand({}, 'darwin'), ['open']);
  assert.deepEqual(browserCommand({}, 'win32'), ['rundll32', 'url.dll,FileProtocolHandler']);
});

test('codes brought to the token endpoint are limited per address', async () => {
  const own = await startApp();
  const statuses: number[] = [];
  for (let i = 0; i < 31; i++)
    statuses.push(
      (
        await fetch(`${own.base}/api/auth/token`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ code: `vra_${i}`, code_verifier: pkce().verifier, redirect_uri: 'http://127.0.0.1:61000/' }),
        })
      ).status,
    );
  assert.deepEqual([statuses[0], statuses[29], statuses[30]], [400, 400, 429]);
});

// ---------------------------------------------------------------- the real vr

// The agent's machine: its own config and cache, nothing of the server's store, no browser of the environment's.
const home = tmpdir('vr-browser-login-');
const env: NodeJS.ProcessEnv = {
  ...process.env,
  XDG_CONFIG_HOME: path.join(home, 'config'),
  XDG_CACHE_HOME: path.join(home, 'cache'),
  VR_DATA: path.join(home, 'no-local-store'),
  VR_CACHE: path.join(home, 'no-local-cache'),
};
for (const k of ['VR_MODE', 'VR_TOKEN', 'VR_SERVER', 'BROWSER', 'SSH_CONNECTION', 'SSH_CLIENT', 'SSH_TTY', 'CLAUDE_PID', 'CLAUDE_CODE_SESSION_ID'])
  delete env[k];
const credentials = path.join(home, 'config', 'lampo', 'credentials.json');
// The stand-in browser: it writes down the address it was asked to open.
const opened = path.join(home, 'opened.txt');
const browser = path.join(home, 'browser.sh');
fs.writeFileSync(browser, `#!/bin/sh\nprintf '%s\\n' "$1" >> '${opened}'\n`, { mode: 0o755 });

interface Running {
  p: ChildProcessWithoutNullStreams;
  out: () => string;
  err: () => string;
  done: Promise<number>;
}
function vr(args: string[], extra: NodeJS.ProcessEnv = {}): Running {
  const p = spawn(process.execPath, [VR, ...args], { env: { ...env, ...extra }, stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  p.stdout.on('data', (d) => {
    out += d;
  });
  p.stderr.on('data', (d) => {
    err += d;
  });
  const done = new Promise<number>((resolve) => p.on('close', (code, signal) => resolve(code ?? (signal ? 128 : 1))));
  return { p, out: () => out, err: () => err, done };
}

test('vr login <url>: the browser BROWSER names opens, Allow, and every line the terminal says', async () => {
  fs.rmSync(opened, { force: true });
  const run = vr(['login', base], { BROWSER: browser });
  const url = await until(() => (fs.existsSync(opened) && fs.readFileSync(opened, 'utf8').trim()) || null, 'the browser was asked to open the address');
  const b = await browse(url, OLIVIA);
  assert.equal(b.landed, 204);
  assert.equal(await run.done, 0, run.err());
  const err = run.err().trimEnd().split('\n');
  assert.deepEqual(err, [
    `Opening your browser to sign in to ${base}.`,
    'If it doesn’t open, go to:',
    `  ${url}`,
    'Waiting for you to allow it in the browser… (Ctrl-C cancels)',
  ]);
  const out = run.out().trimEnd().split('\n');
  assert.match(
    must(out[0]),
    new RegExp(`^signed in to ${base.replace(/[.:/]/g, '\\$&')} as Olivia <olivia@example\\.com> \\(owner\\) in workspace ".+" \\(w1\\)$`),
  );
  assert.match(must(out[1]), /^every lampo command and the MCP server now use that server \(credentials: .+credentials\.json; lampo logout to go back/);
  const saved = JSON.parse(fs.readFileSync(credentials, 'utf8')) as { server: string; token: string; token_id: string };
  assert.equal(saved.server, base);
  assert.equal(must(auth.verifyToken(saved.token)).token.id, saved.token_id);
  assert.match(must(auth.verifyToken(saved.token)).token.name, /^lampo on /);
  // vr logout revokes the token vr login made, as it does --email's
  const logout = vr(['logout']);
  assert.equal(await logout.done, 0);
  assert.match(logout.out(), /signed out of .* \(token revoked\)/);
  assert.equal(auth.verifyToken(saved.token), null);
});

test('vr login over SSH prints the address to open elsewhere and takes the one the browser ended on, pasted', async () => {
  fs.rmSync(opened, { force: true });
  const run = vr(['login', base], { SSH_CONNECTION: '192.0.2.1 50000 192.0.2.2 22' });
  const url = await until(() => /^ {2}(http\S+)$/m.exec(run.err())?.[1], 'the address on stderr');
  assert.match(run.err(), /^Open this address in a browser to sign in to /m);
  const b = await browse(url, OLIVIA, { follow: false });
  run.p.stdin.write(`${b.answer}\n`);
  assert.equal(await run.done, 0, run.err());
  assert.match(run.out(), /^signed in to .* as Olivia/);
  assert.ok(!fs.existsSync(opened), 'no browser was started on the far machine');
  assert.equal(await vr(['logout']).done, 0);
});

test('Ctrl-C while lampo waits for the browser: it says so, keeps nothing, exits 130', async () => {
  fs.rmSync(credentials, { force: true });
  const run = vr(['login', base], { BROWSER: browser });
  await until(() => run.err().includes('Waiting for you to allow it in the browser'), 'waiting');
  run.p.kill('SIGINT');
  assert.equal(await run.done, 130, run.err());
  assert.match(run.err(), /\nlampo: cancelled; nothing was saved\n$/);
  assert.ok(!fs.existsSync(credentials));
});

test('--email and --token - still sign in without a browser; --workspace without --email is refused', async () => {
  fs.rmSync(opened, { force: true });
  const byPassword = vr(['login', base, '--email', 'rita@example.com'], { BROWSER: browser, VR_PASSWORD: 'a long password' });
  assert.equal(await byPassword.done, 0, byPassword.err());
  assert.match(byPassword.out(), /^signed in to .* as Rita <rita@example\.com> \(reviewer\)/);
  assert.equal(await vr(['logout']).done, 0);
  const token = auth.createToken(rita.id, 'pasted').token;
  const byToken = vr(['login', base, '--token', '-'], { BROWSER: browser });
  byToken.p.stdin.end(`${token}\n`);
  assert.equal(await byToken.done, 0, byToken.err());
  assert.match(byToken.out(), /^signed in to .* as Rita/);
  assert.ok(!fs.existsSync(opened), 'neither opened a browser');
  const ws = vr(['login', base, '--workspace', 'w1'], { BROWSER: browser });
  assert.equal(await ws.done, 1);
  assert.match(ws.err(), /--workspace goes with --email/);
});

// Last: it moves the store to workspaces.
test('the token acts in the workspace the screen named, and only while the person is still in it', async () => {
  const workspaces = await import('../../lib/workspaces.ts');
  const team = workspaces.createWorkspace({ name: 'Second team', ownerId: olivia.id });
  workspaces.addMember(team.id, rita.id, 'member');
  const there = `${COOKIE}=${auth.signSession(rita, 30, team.id)}`;
  // allowed there, redeemed while still a member: a token for that workspace, with the role there
  const first = pkce();
  const b = await browse(authorizeUrl({ redirect_uri: 'http://127.0.0.1:61000/', code_challenge: first.challenge }), there, { follow: false });
  assert.equal(b.view?.workspace?.id, team.id, 'the screen names the workspace');
  const ok = await redeem({ code: must(b.answer?.searchParams.get('code')), code_verifier: first.verifier, redirect_uri: 'http://127.0.0.1:61000/' });
  assert.equal(ok.status, 200, await ok.clone().text());
  const made = must(auth.verifyToken(((await ok.json()) as { token: string }).token));
  assert.equal(auth.tokenWorkspace(made.token), team.id);
  // allowed there, then taken out of it before vr redeems the code: no token
  const second = pkce();
  const c = await browse(authorizeUrl({ redirect_uri: 'http://127.0.0.1:61000/', code_challenge: second.challenge }), there, { follow: false });
  workspaces.removeMember(team.id, rita.id);
  const late = await redeem({ code: must(c.answer?.searchParams.get('code')), code_verifier: second.verifier, redirect_uri: 'http://127.0.0.1:61000/' });
  assert.equal(late.status, 403);
  assert.match(((await late.json()) as { error: string }).error, /not a member of that workspace/);
  assert.equal(auth.listTokens(rita.id).filter((t) => auth.tokenWorkspace(t) === team.id).length, 0);
});
