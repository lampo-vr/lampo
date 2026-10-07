// A throwaway server for one browser suite: its own store in a temp dir, a free port on 127.0.0.1, speech off, and a
// stand-in for the `claude` CLI, so a suite never lists the machine's real Claude Code sessions (their names would
// end up in screenshots). Settings from the shell that change what a server is (mode, storage, URLs, tokens,
// proxies, tunnels) are dropped; a suite states the ones it needs. Its environment (srv.env) never sees the machine's
// `vr login`, so a `vr` run with it stays on the suite's store. The server is stopped when the suite exits, however it
// exits, so no test server outlives its run.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { freePort, ROOT, sleep, tmpdir } from '../../lib/helpers.ts';

// Mail settings are dropped too: a suite never reaches a real relay, its messages land in <cache>/outbox/.
const DROPPED =
  /^(CLAUDE_PID|CLAUDE_CODE_SESSION_ID|LAMPO_OPERATOR|VR_(MODE|HOST|PORT|DATA|CACHE|CONFIG|HOME|USER|BY|PASSWORD|STORAGE|BUNNY_\w+|S3_\w+|PUBLIC_URL|SOURCE_URL|ALLOW_NO_PUBLIC_URL|TRUST_PROXY|SERVER|TOKEN|REMOTE|LAN|TUNNEL|WEBHOOK_\w+|CLAUDE_BIN|STT\w*|MIN_FREE|ONBOARDING|ONBOARDING_SAMPLE|SMTP_URL|MAIL_\w+|SIGNUP|TERMS_URL|PRIVACY_URL|IMPRINT_URL|WITHDRAWAL_URL|CANCEL_URL))$/;

/**
 * The operator's legal pages a suite's server links (lib/legal.ts): `VR_SIGNUP=open` refuses to start without the terms
 * and the privacy policy (A13 CLOUD-1). Placeholder addresses; nothing fetches them.
 */
export const LEGAL = {
  VR_IMPRINT_URL: 'https://example.com/imprint',
  VR_TERMS_URL: 'https://example.com/terms',
  VR_PRIVACY_URL: 'https://example.com/privacy',
  VR_WITHDRAWAL_URL: 'https://example.com/withdrawal',
};

/**
 * A `claude` that answers `claude agents --json` with `sessions` (none by default). Anything else — the app starting
 * a session for a request — is written down in bin/runs.log (a `--- <folder>` line, then the arguments one per line),
 * prints bin/stream.jsonl if a suite put one there (Claude Code's stream-json, a line every bin/stream.delay seconds,
 * 0.5 by default: what Lampo reads into the live view) and waits while bin/hold exists (a suite holds a run open, then
 * lets it finish or stops it). Nothing real runs.
 */
function claudeStub(dir, sessions) {
  const file = path.join(dir, 'bin', 'claude');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    `#!/bin/sh
d="$(dirname "$0")"
if [ "$1" = agents ]; then
cat <<'JSON'
${JSON.stringify(sessions)}
JSON
exit 0
fi
{ echo "--- $(pwd -P)"; for a in "$@"; do printf '%s\\n' "$a"; done; } >> "$d/runs.log"
if [ -f "$d/stream.jsonl" ]; then
  delay="$(cat "$d/stream.delay" 2>/dev/null || echo 0.5)"
  while IFS= read -r line; do printf '%s\\n' "$line"; sleep "$delay"; done < "$d/stream.jsonl"
fi
while [ -f "$d/hold" ]; do sleep 0.2; done
exit 0
`,
    { mode: 0o755 },
  );
  return file;
}

/**
 * Starts server/index.ts and waits until it answers.
 * @param {object} o
 * @param {string} o.prefix          temp dir name prefix (the store, cache, config and the `claude` stand-in live there)
 * @param {'local' | 'server'} [o.mode]
 * @param {string} [o.user]          VR_USER, the local reviewer's name
 * @param {boolean | string} [o.publicUrl]  server mode: true = its own address, or that URL; without one the server
 *                                   starts with VR_ALLOW_NO_PUBLIC_URL=1 (a real one refuses to)
 * @param {object | ((dir: string) => object)} [o.config]  config.json (default: browse_root = the temp dir locally,
 *                                   {} in server mode)
 * @param {Record<string, string> | ((at: { port: number, base: string }) => Record<string, string>)} [o.env]  more
 *                                   variables, or a function of the server's port and address (a second host name)
 * @param {object[]} [o.sessions]    what `claude agents --json` reports
 * @param {string} [o.ready]         polled until it answers 2xx (default /api/library locally, /healthz in server mode)
 * @param {(env: Record<string, string>) => void} [o.seed]  writes the store before the server starts, with the server's
 *                                   environment (VR_DATA, VR_CACHE, VR_CONFIG, VR_USER): a history no API could backdate
 * @param {boolean} [o.onboarding]   new accounts start with the first run (lib/onboarding.ts) and find the sample in
 *                                   their library, as on a real instance. Off by default: a suite's fresh store stands
 *                                   for one in use, not for someone new
 */
export async function startServer({ prefix, mode = 'local', user, publicUrl, config, env: extra = {}, sessions = [], ready, seed, onboarding = false }) {
  const dir = tmpdir(prefix);
  const port = await freePort();
  const base = `http://127.0.0.1:${port}`;
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !DROPPED.test(k)));
  Object.assign(env, {
    VR_DATA: path.join(dir, 'data'),
    VR_CACHE: path.join(dir, 'cache'),
    VR_CONFIG: path.join(dir, 'config.json'),
    VR_HOST: '127.0.0.1',
    VR_PORT: String(port),
    VR_STT: 'off',
    // no footage index behind a suite's back (and never a model download)
    VR_FOOTAGE: 'off',
    VR_CLAUDE_BIN: claudeStub(dir, sessions),
    VR_ONBOARDING: onboarding ? 'on' : 'off',
    // …and with it, as on a real instance, the sample in a new first run's library (server/firstSample.ts)
    VR_ONBOARDING_SAMPLE: onboarding ? 'on' : 'off',
    ...(user ? { VR_USER: user } : {}),
    ...(mode === 'server'
      ? { VR_MODE: 'server', ...(publicUrl ? { VR_PUBLIC_URL: publicUrl === true ? base : publicUrl } : { VR_ALLOW_NO_PUBLIC_URL: '1' }) }
      : {}),
    ...(typeof extra === 'function' ? extra({ port, base }) : extra),
    // A `vr` a suite runs with this environment works on the suite's store, never on a server this machine is signed
    // in to (`vr login`'s credentials.json and its download cache: lib/backend/credentials.ts). Last, so no suite's
    // settings undo it; a suite that wants a remote `vr` sets VR_REMOTE and the rest on that one command.
    VR_REMOTE: '0',
    XDG_CONFIG_HOME: path.join(dir, 'xdg-config'),
    XDG_CACHE_HOME: path.join(dir, 'xdg-cache'),
  });
  const cfg = typeof config === 'function' ? config(dir) : (config ?? (mode === 'server' ? {} : { browse_root: dir }));
  fs.writeFileSync(env.VR_CONFIG, JSON.stringify(cfg));
  seed?.(env);

  let log = '';
  let stdout = '';
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout.on('data', (d) => {
    log += d;
    stdout += d;
  });
  proc.stderr.on('data', (d) => (log += d));
  const running = () => proc.exitCode === null && proc.signalCode === null;
  // A suite that throws or exits early still takes its server down.
  process.on('exit', () => running() && proc.kill('SIGKILL'));

  const srv = {
    dir,
    port,
    base,
    env,
    proc,
    /** Everything the server printed so far. */
    log: () => log,
    /**
     * The one-time setup token a hosted server prints at its first start, or null if none came within `ms`. Read from
     * its stdout alone: in `log` a warning on stderr can land between the sentence and the token.
     */
    async setupToken(ms = 15000) {
      for (const t = Date.now(); Date.now() - t < ms; await sleep(100)) {
        const token = /one-time setup token:\n {2}(\S+)\n/.exec(stdout)?.[1];
        if (token) return token;
      }
      return null;
    },
    /** Stops the server (SIGTERM, then SIGKILL after 3 s: shutdown waits for a running job) and waits for it. */
    async stop() {
      if (!running()) return;
      const exited = new Promise((r) => proc.once('exit', r));
      proc.kill();
      const t = setTimeout(() => running() && proc.kill('SIGKILL'), 3000);
      await exited;
      clearTimeout(t);
    },
  };

  const probe = ready ?? (mode === 'server' ? '/healthz' : '/api/library');
  for (const t = Date.now(); Date.now() - t < 20000; await sleep(100)) {
    if (!running()) throw new Error(`the server exited (${proc.exitCode ?? proc.signalCode}) before it answered:\n${log.slice(-1500)}`);
    try {
      if ((await fetch(base + probe)).ok) return srv;
    } catch {}
  }
  await srv.stop();
  throw new Error(`the server didn't answer ${probe} within 20 s:\n${log.slice(-1500)}`);
}
