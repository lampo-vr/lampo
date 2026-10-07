// The browser suites share one harness (test/e2e/lib): Chrome is found and launched there, and the throwaway server
// starts there with a stand-in for the `claude` CLI. Nothing else in test/e2e does either — a suite that started its
// own server or asked the real `claude agents` could put the maintainer's Claude Code sessions into screenshots.
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { ROOT, tmpdir, VR } from '../lib/helpers.ts';

const E2E = path.join(ROOT, 'test/e2e');
const withoutComments = (src: string) => src.replace(/^\s*\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');

test('no suite finds or launches Chrome, picks a port, starts a server or runs `claude` itself', () => {
  const rules: [RegExp, string][] = [
    [/Google Chrome\.app|\/usr\/bin\/(google-chrome|chromium)/, 'its own Chrome list (requireChrome in lib/browser.mjs)'],
    [/puppeteer\.launch|puppeteer-core/, 'its own Chrome launch (launch in lib/browser.mjs)'],
    [/\.listen\(0\b|(const|function) freePort\b/, 'its own free-port helper (freePort in test/lib/helpers.ts)'],
    [/server\/index\.ts/, 'its own server (startServer in lib/server.mjs)'],
    [/['"`]claude['"`]|VR_CLAUDE_BIN|'agents', '--json'/, 'the `claude` CLI (the server helper stands in for it)'],
  ];
  const found: string[] = [];
  for (const f of fs.readdirSync(E2E).filter((f) => f.endsWith('.mjs'))) {
    const src = withoutComments(fs.readFileSync(path.join(E2E, f), 'utf8'));
    for (const [re, what] of rules) if (re.test(src)) found.push(`${f}: ${what}`);
  }
  assert.deepEqual(found, []);
});

test('the server helper stands in for `claude` and ignores the shell’s instance settings', async () => {
  // A specifier the type checker doesn't resolve: the harness is plain JavaScript.
  const { startServer } = await import(pathToFileURL(path.join(E2E, 'lib/server.mjs')).href);
  const shell = { VR_PUBLIC_URL: process.env.VR_PUBLIC_URL, VR_MODE: process.env.VR_MODE, CLAUDE_PID: process.env.CLAUDE_PID };
  process.env.VR_PUBLIC_URL = 'https://review.example.com';
  process.env.VR_MODE = 'server';
  process.env.CLAUDE_PID = '1';
  const session = { name: 'e2e-session', sessionId: 's-1', pid: 4242, cwd: '/tmp/e2e', kind: 'interactive' };
  const srv = await startServer({ prefix: 'vr-harness-', sessions: [session] });
  for (const [k, v] of Object.entries(shell)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    assert.equal(srv.env.VR_PUBLIC_URL, undefined);
    assert.equal(srv.env.VR_MODE, undefined, 'local mode unless the suite asks for server mode');
    assert.equal(srv.env.CLAUDE_PID, undefined);
    assert.equal(srv.env.VR_HOST, '127.0.0.1');
    const r = (await (await fetch(`${srv.base}/api/sessions?fresh=1`)).json()) as { sessions: { name: string }[] };
    assert.deepEqual(
      r.sessions.map((s) => s.name),
      ['e2e-session'],
      'only what the suite gave the stand-in',
    );
  } finally {
    await srv.stop();
    fs.rmSync(srv.dir, { recursive: true, force: true });
  }
});

// The machine a suite runs on may be signed in to a hosted server: `vr login` keeps it in
// ~/.config/video-review/credentials.json. A `vr` that a suite runs with its server's environment works on the suite's
// store, never on that server (record.mjs's `vr show` and `vr inbox` once read a real inbox that way).
test('a `vr` run with the suite’s environment never reads the machine’s saved login', async () => {
  // The machine: its home holds a saved login to a server that writes down every request it gets.
  const asked: string[] = [];
  const signedIn = http.createServer((req, res) => {
    asked.push(`${req.method} ${req.url}`);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ user: { name: 'Machine', email: 'machine@example.com', role: 'owner' }, name: 'Machine', role: 'owner' }));
  });
  await new Promise<void>((r) => signedIn.listen(0, '127.0.0.1', r));
  const home = tmpdir('vr-harness-home-');
  const saved = path.join(home, '.config', 'video-review', 'credentials.json');
  fs.mkdirSync(path.dirname(saved), { recursive: true });
  fs.writeFileSync(saved, JSON.stringify({ server: `http://127.0.0.1:${(signedIn.address() as AddressInfo).port}`, token: 'vr_machine' }));

  const { startServer } = await import(pathToFileURL(path.join(E2E, 'lib/server.mjs')).href);
  const shell = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: process.env.XDG_CACHE_HOME };
  process.env.HOME = home;
  delete process.env.XDG_CONFIG_HOME;
  delete process.env.XDG_CACHE_HOME;
  let srv: Awaited<ReturnType<typeof startServer>>;
  try {
    srv = await startServer({ prefix: 'vr-harness-login-' });
  } finally {
    for (const [k, v] of Object.entries(shell)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
  try {
    // Asynchronous: the signed-in server answers from this process.
    const run = await new Promise<{ code: number; out: string; err: string }>((resolve) =>
      execFile(process.execPath, [VR, 'whoami', '--json'], { env: srv.env, encoding: 'utf8', timeout: 30_000 }, (e, out, err) =>
        resolve({ code: e ? 1 : 0, out, err }),
      ),
    );
    assert.equal(run.code, 0, run.err);
    assert.deepEqual(asked, [], 'nothing reaches the server this machine is signed in to');
    const me = JSON.parse(run.out) as { kind: string; data?: string };
    assert.equal(me.kind, 'local', run.out);
    assert.equal(me.data, srv.env.VR_DATA, 'the suite’s own store');
  } finally {
    await srv.stop();
    signedIn.close();
    fs.rmSync(srv.dir, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
});
