// `vr login <url>` in the browser, the way gh and gcloud sign in (RFC 8252, OAuth for native apps): vr listens on a
// one-time loopback port, opens the server's /oauth/authorize as its own client (`vr`, lib/oauth/clients.ts), the person
// signs in there if they aren't yet and presses Allow on the consent screen, and the browser brings a one-time code back
// to that port. vr trades the code and its PKCE verifier for the same API token `vr login --email` makes (POST
// /api/auth/token): the token never travels in an address, only in that answer to vr. Over SSH (no browser here) vr
// prints the address to open elsewhere; the browser there then ends on a page that can't load, and its address, pasted
// into the terminal, does what the loopback port would have.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import readline from 'node:readline';
import { VR_CLIENT_ID } from './oauth/clients.ts';

/** How long vr waits for the browser by default. */
export const BROWSER_WAIT_MS = 5 * 60_000;

export interface BrowserLoginOptions {
  server: string;
  /** The computer's name, as the consent screen and the token's name say it. */
  machine: string;
  /** Days the token works; null: until revoked. */
  days?: number | null;
  /**
   * Opens an address in the person's browser; null when there is none here (SSH, no screen): the address is then for
   * another computer. Tests pass their own — never a real browser.
   */
  open: ((url: string) => Promise<unknown> | unknown) | null;
  /** A line for the person (stderr in the CLI). */
  say: (line: string) => void;
  /** Where an address pasted by hand comes from (stdin in the CLI). */
  input?: NodeJS.ReadableStream | null;
  timeoutMs?: number;
  /** Aborts the wait (Ctrl-C). */
  signal?: AbortSignal;
}

export interface BrowserLoginResult {
  token: string;
  /** The token as Settings → API tokens lists it: its id is what `vr logout` revokes. */
  info: { id: string; name: string };
}

/** Why a browser sign-in ended without a token: the person said no, nobody answered, Ctrl-C. */
export class LoginEnded extends Error {
  reason: 'denied' | 'timeout' | 'cancelled';
  constructor(reason: LoginEnded['reason'], message: string) {
    super(message);
    this.reason = reason;
  }
}

const b64url = (b: Buffer) => b.toString('base64url');
const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** What came back to the loopback address: a code, or the server's no — only for this sign-in's `state`. */
type Answer = { code: string } | { error: string };
function answerOf(params: URLSearchParams, state: string): Answer | null {
  if (!same(params.get('state') ?? '', state)) return null;
  const code = params.get('code');
  if (code) return { code };
  const error = params.get('error');
  return error ? { error } : null;
}

/** A listener on a random loopback port of this computer: 127.0.0.1, or ::1 where there is no IPv4 loopback. */
async function listen(handler: http.RequestListener): Promise<{ server: http.Server; redirect: string }> {
  for (const [host, shown] of [
    ['127.0.0.1', '127.0.0.1'],
    ['::1', '[::1]'],
  ]) {
    const server = http.createServer(handler);
    const ok = await new Promise<boolean>((resolve) => {
      server.once('error', () => resolve(false));
      server.listen(0, host, () => resolve(true));
    });
    if (ok) return { server, redirect: `http://${shown}:${(server.address() as AddressInfo).port}/` };
  }
  throw new Error('cannot listen on this computer’s loopback address (127.0.0.1 or ::1) for the browser’s answer: use --email or --token -');
}

/** Signs in through the browser and returns the API token the server made for this computer. */
export async function browserLogin(o: BrowserLoginOptions): Promise<BrowserLoginResult> {
  const verifier = b64url(crypto.randomBytes(32));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const state = b64url(crypto.randomBytes(24));
  const timeoutMs = o.timeoutMs ?? BROWSER_WAIT_MS;

  let settle: (a: Answer) => void = () => {};
  const answered = new Promise<Answer>((resolve) => {
    settle = resolve;
  });
  const { server, redirect } = await listen((req, res) => {
    const u = new URL(req.url || '/', 'http://loopback');
    // the answer comes to `/` (the browser asks for its icon too): anything else is nothing of ours
    if (req.method !== 'GET' || u.pathname !== '/') {
      res.writeHead(404, { 'Cache-Control': 'no-store' }).end();
      return;
    }
    const got = answerOf(u.searchParams, state);
    if (!got) {
      // another page poking at the port, or an old tab: never taken, and the real answer is still awaited
      res.writeHead(400, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' }).end('This is not the answer vr login is waiting for.\n');
      return;
    }
    // 204: the browser stays on the server's page, which already says to go back to the terminal
    res.writeHead(204, { 'Cache-Control': 'no-store' }).end();
    settle(got);
  });

  const url = `${o.server}/oauth/authorize?${new URLSearchParams({
    response_type: 'code',
    client_id: VR_CLIENT_ID,
    redirect_uri: redirect,
    state,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    machine: o.machine,
    ...(o.days ? { days: String(o.days) } : {}),
  })}`;

  // The address pasted by hand: the one a browser on another computer ended on (it can't reach this one's port).
  const pasted = o.input ? readline.createInterface({ input: o.input, terminal: false }) : null;
  pasted?.on('line', (line) => {
    const s = line.trim();
    if (!s) return;
    let got: Answer | null = null;
    try {
      got = answerOf(new URL(s).searchParams, state);
    } catch {}
    if (got) settle(got);
    else o.say('That isn’t the address of this sign-in: paste the whole address the browser ended on, after Allow.');
  });

  let timer: NodeJS.Timeout | undefined;
  let onAbort = () => {};
  try {
    if (o.open) {
      o.say(`Opening your browser to sign in to ${o.server}.`);
      o.say('If it doesn’t open, go to:');
      o.say(`  ${url}`);
      try {
        await o.open(url);
      } catch {}
    } else {
      o.say(`Open this address in a browser to sign in to ${o.server}:`);
      o.say(`  ${url}`);
      o.say('After Allow, a browser on another computer ends on a page that doesn’t load: paste its address here.');
    }
    o.say('Waiting for you to allow it in the browser… (Ctrl-C cancels)');
    const ended = new Promise<never>((_, reject) => {
      const minutes = Math.round(timeoutMs / 60_000);
      timer = setTimeout(
        () =>
          reject(
            new LoginEnded(
              'timeout',
              `no answer from the browser within ${minutes >= 1 ? `${minutes} minute${minutes === 1 ? '' : 's'}` : `${Math.ceil(timeoutMs / 1000)} s`}; nothing was saved. Run vr login again, or sign in with --email or --token -`,
            ),
          ),
        timeoutMs,
      );
      onAbort = () => reject(new LoginEnded('cancelled', 'cancelled; nothing was saved'));
      if (o.signal?.aborted) onAbort();
      o.signal?.addEventListener('abort', onAbort, { once: true });
    });
    const got = await Promise.race([answered, ended]);
    if ('error' in got)
      throw new LoginEnded(
        'denied',
        got.error === 'access_denied' ? 'you said no in the browser; nothing was saved' : `the server refused the sign-in (${got.error})`,
      );
    return await exchange(o.server, { code: got.code, code_verifier: verifier, redirect_uri: redirect });
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener('abort', onAbort);
    pasted?.close();
    server.closeAllConnections();
    server.close();
  }
}

/** The code and its verifier for the API token (POST /api/auth/token): the token comes back in this answer only. */
async function exchange(server: string, body: { code: string; code_verifier: string; redirect_uri: string }): Promise<BrowserLoginResult> {
  const res = await fetch(`${server}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).catch((e: Error) => {
    throw new Error(`cannot reach ${server}: ${e.message}`);
  });
  const got = (await res.json().catch(() => ({}))) as { token?: string; info?: { id: string; name: string }; error?: string };
  if (!res.ok || !got.token || !got.info) throw new Error(`sign-in failed: ${got.error || `HTTP ${res.status}`}`);
  return { token: got.token, info: got.info };
}

/**
 * The command that opens an address in the person's browser here, as an argument list (never a shell): `BROWSER` when
 * set; none over SSH (a browser would open on that computer's screen, not in front of the person) or on a Linux without
 * a screen; else the system's own opener.
 */
export function browserCommand(env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): string[] | null {
  const own = env.BROWSER?.trim();
  if (own) return own.split(/\s+/);
  if (env.SSH_CONNECTION || env.SSH_CLIENT || env.SSH_TTY) return null;
  if (platform === 'darwin') return ['open'];
  if (platform === 'win32') return ['rundll32', 'url.dll,FileProtocolHandler'];
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) return null;
  return ['xdg-open'];
}

/** Starts the browser command with the address; true when it started (the address is printed either way). */
export function launchBrowser(cmd: string[], url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(cmd[0] as string, [...cmd.slice(1), url], { stdio: 'ignore', detached: true });
    child.once('error', () => resolve(false));
    child.once('spawn', () => {
      child.unref();
      resolve(true);
    });
  });
}
