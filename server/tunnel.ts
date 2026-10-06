// Public tunnel on demand (cloudflared quick tunnel, no account). Only share links answer through it: the guard
// treats anything that arrives via the tunnel as remote.
import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Broadcast } from './events.ts';
import { fail } from './http.ts';

export interface Tunnel {
  readonly available: boolean;
  readonly url: string | null;
  start(): Promise<string>;
  stop(): void;
}

export function createTunnel(port: number, broadcast: Broadcast): Tunnel {
  const bin = ['/opt/homebrew/bin/cloudflared', '/usr/local/bin/cloudflared'].find((p) => fs.existsSync(p)) || null;
  let state: { proc: ChildProcess; url: string | null } | null = null;

  return {
    available: !!bin,
    get url() {
      return state?.url || null;
    },
    async start() {
      if (!bin) throw fail(501, 'cloudflared is not installed (brew install cloudflared)');
      if (state?.url) return state.url;
      const proc = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
      const current = { proc, url: null as string | null };
      state = current;
      const url = await new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(fail(504, 'the tunnel did not come up within 30 s')), 30000);
        const scan = (d: Buffer) => {
          const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(d.toString());
          if (m) {
            clearTimeout(timer);
            resolve(m[0]);
          }
        };
        proc.stdout?.on('data', scan);
        proc.stderr?.on('data', scan);
        proc.on('exit', () => {
          clearTimeout(timer);
          if (state === current) state = null;
          broadcast('library');
          reject(fail(500, 'cloudflared exited'));
        });
      });
      current.url = url;
      console.log(`public tunnel: ${url} (share links only)`);
      return url;
    },
    stop() {
      state?.proc.kill();
      state = null;
    },
  };
}
