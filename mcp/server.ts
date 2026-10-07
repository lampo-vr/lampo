// Lampo as an MCP server over stdio: any MCP-capable agent can read frame-exact feedback — including the
// marked frames as images — and answer it. Same store as the UI and the `lampo` CLI: data/ on this machine, or the
// hosted server `lampo login` points at (lib/backend). The same tools are served over HTTP at /mcp by the app.
//   claude mcp add lampo -- /path/to/lampo/bin/lampo-mcp     (or: lampo mcp config <client>)
// Never write to stdout here except through the transport: it is the protocol channel.
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { openActivitySink } from '../lib/activity.ts';
import { readCredentials } from '../lib/backend/credentials.ts';
import { openBackend } from '../lib/backend/index.ts';
import { loadConfig } from '../lib/config.ts';
import { localStopLine } from '../lib/runs.ts';
import { enterProcessWorkspace } from '../lib/scope.ts';
import { checkProcessWorkspace } from '../lib/workspaces.ts';
import { createReviewServer } from './core.ts';
import { ownQuiet, ownTold, type Wake } from './feedback.ts';
import { followChanges } from './follow.ts';

// The local store's workspace (LAMPO_WORKSPACE, else #1), for everything this process serves — one the store has.
try {
  const ws = enterProcessWorkspace();
  if (!readCredentials()) checkProcessWorkspace(ws);
} catch (e) {
  // Written out before the exit: stderr to a pipe is asynchronous on macOS.
  await new Promise((done) => process.stderr.write(`lampo-mcp: ${(e as Error).message}\n`, done));
  process.exit(1);
}
const backend = openBackend();
const cfg = loadConfig();
// Where the reviewer's player lives, for "open in the player" links: the hosted server, or the app on this machine.
const appUrl = readCredentials()?.server.replace(/\/+$/, '') || `http://localhost:${cfg.port}`;

const onerror = (e: Error) => process.stderr.write(`lampo-mcp: ${e.message}\n`);

// Against a hosted server, wait_for_feedback sleeps until the live stream this connection follows anyway (follow.ts)
// says something happened — then one small read of what is new, and every 20 s for safety — instead of reading the
// server's recent log once a second (A12-D13). The local store keeps its cheap poll of the cached log.
const waiting = new Set<() => void>();
const wake: Wake | undefined = readCredentials()
  ? (ms, signal) =>
      new Promise((resolve) => {
        const done = () => {
          clearTimeout(timer);
          waiting.delete(done);
          signal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        waiting.add(done);
        signal.addEventListener('abort', done, { once: true });
      })
  : undefined;
const woken = () => {
  for (const w of [...waiting]) w();
};
// What the agent does through these tools shows live in the app (a line in the cache, or a batch to the hosted server).
const activity = openActivitySink();
const remote = !!readCredentials();
// What this agent (the process) was told was waiting for it, across its connections: each thing once.
const told = ownTold();
// How long it has heard only "no new feedback" in a row, across its connections (after 30 min it is told to stop).
const quiet = ownQuiet();

serveStdio(
  ({ era }) => {
    const server = createReviewServer({
      backend,
      principal: { via: 'local', name: cfg.user, role: 'owner' },
      sessionAuthor: true,
      appUrl,
      // What the agent does shows in the app; the person stopped its work: the line its next answer ends with, once —
      // from this machine's runs, or what the hosted server answered an earlier batch with.
      activity: (a) => {
        activity.record(a);
        return remote
          ? activity.heard().join('\n') || null
          : localStopLine(a.agent, { kind: a.kind, slug: a.slug ?? null, video: a.video ?? null, target: a.target ?? null });
      },
      sourceUrl: cfg.source_url,
      told,
      quiet,
      ...(wake ? { wake } : {}),
    });
    followChanges(server, { backend, era, onerror, onEvent: woken });
    return server;
  },
  { onerror },
);
