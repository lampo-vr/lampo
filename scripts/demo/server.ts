// Start a Lampo server on a throwaway store for the demo and the screenshots. It runs with its own HOME and a
// stub `claude` that reports two made-up sessions, so nothing about the machine it runs on ends up on screen.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { ROOT } from '../../lib/paths.ts';

export const DEMO_SESSIONS = [
  { name: 'launch-edit', sessionId: '6b1f2c1e-demo-4a51-9d2e-launchedit01', pid: 1, cwd: '/work/northwind/launch-film', status: 'idle' },
  { name: 'teaser-edit', sessionId: '0c9e7d44-demo-4f0b-8a61-teaseredit01', pid: 2, cwd: '/work/field-notes/teaser', status: 'working' },
];

export interface DemoServer {
  url: string;
  proc: ChildProcess;
  /** Everything the server printed so far (the setup token in server mode). */
  log: () => string;
  stop: () => Promise<void>;
}

export const freePort = (): Promise<number> =>
  new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address() as net.AddressInfo;
      s.close(() => resolve(port));
    });
  });

/** The store lives in `dir`; `mediaRoot` becomes the browse root, so projects read "Northwind/launch-film". `user` is the
 * machine's reviewer as config.json names them (what the owner account starts as). */
export async function startServer(
  dir: string,
  { mediaRoot, port, vars = {}, user = 'Alex' }: { mediaRoot: string; port?: number; vars?: Record<string, string>; user?: string },
): Promise<DemoServer> {
  const home = path.join(dir, 'home');
  fs.mkdirSync(home, { recursive: true });
  const claude = path.join(dir, 'claude');
  fs.writeFileSync(claude, `#!/bin/sh\necho '${JSON.stringify(DEMO_SESSIONS)}'\n`, { mode: 0o755 });
  const config = path.join(dir, 'config.json');
  fs.writeFileSync(config, JSON.stringify({ browse_root: mediaRoot, user }));
  const p = port || (await freePort());
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: home,
    LAMPO_DATA: path.join(dir, 'data'),
    LAMPO_CACHE: path.join(dir, 'cache'),
    LAMPO_CONFIG: config,
    LAMPO_PORT: String(p),
    LAMPO_CLAUDE_BIN: claude,
    // the demo is a store in use (and the README's screenshots come from it): no first run
    LAMPO_ONBOARDING: 'off',
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    ...vars,
  };
  let out = '';
  const proc = spawn(process.execPath, [path.join(ROOT, 'server/index.ts')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  proc.stdout?.on('data', (d) => {
    out += d;
  });
  proc.stderr?.on('data', (d) => {
    out += d;
  });
  const url = `http://127.0.0.1:${p}`;
  for (let i = 0; i < 150; i++) {
    if (proc.exitCode !== null) throw new Error(`server exited:\n${out}`);
    const ok = await fetch(`${url}/healthz`).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return {
    url,
    proc,
    log: () => out,
    stop: () =>
      new Promise((resolve) => {
        if (proc.exitCode !== null) return resolve();
        proc.once('exit', () => resolve());
        proc.kill();
      }),
  };
}
