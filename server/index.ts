// Lampo's server: serves the UI, streams videos (HTTP range), grabs exact frames, watches linked renders for
// re-renders. One app on a hosted server (LAMPO_MODE=server) and on a person's own machine, where its owner is signed in
// automatically and the machine's extras switch on. All state lives in data/ (see lib/store.ts); the server is just one
// writer next to the `lampo` CLI.
//   node server/index.ts [--dev] [--lan]
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Express } from 'express';
import { forgetHeldChanges, listUsers, localOwner, secret, sweepUnconfirmed } from '../lib/auth.ts';
import { migrateAvatars } from '../lib/avatars.ts';
import { loadConfig, startupProblems } from '../lib/config.ts';
import { jobsInterrupted } from '../lib/crashGuard.ts';
import { settings, spelledAs, spellingWarnings } from '../lib/env.ts';
import { bindShareLinks } from '../lib/folders.ts';
import { unknownOperators } from '../lib/operator.ts';
import { CACHE, DATA, openToOthers, ROOT, VERSIONS } from '../lib/paths.ts';
import { DEFAULT_WORKSPACE, inWorkspace } from '../lib/scope.ts';
import { migrateShareTokens, shareSecret } from '../lib/shares.ts';
import { rootStorage } from '../lib/storage/index.ts';
import * as store from '../lib/store.ts';
import { preloadStt, stopStt } from '../lib/stt/index.ts';
import { checkWorkspaces, migrateWorkspaces, syncRoleMirrors, WorkspacesLostError, workspaceIds } from '../lib/workspaces.ts';
import { createApp, staticUi } from './app.ts';
import { createContext } from './context.ts';
import { callerOf, hostContext, installExtension, loadExtension, ModuleRouteError, sameOriginOf } from './extension.ts';
import { startServerFeed } from './feed.ts';
import { lanIps } from './guard.ts';
import { listen, serverTimeouts } from './listen.ts';
import { purgeEveryWorkspace } from './routes/files.ts';
import { cleanVoiceCache } from './routes/voice.ts';
import { drain } from './shutdown.ts';
import { onSignup } from './signup.ts';
import { startWatching } from './watch.ts';

/** Why dir can't be written (an error code), or null: created when missing, a file written and removed. */
function writable(dir: string): string | null {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = path.join(dir, `.write-${process.pid}`);
    fs.writeFileSync(probe, '');
    fs.rmSync(probe, { force: true });
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code || (e as Error).message;
  }
}

const args = process.argv.slice(2);
const DEV_MODE = args.includes('--dev');
// A setting the server can't work with ends the start with one plain line each, never a stack trace and never a
// half-working server (docs/go-live.md).
const fatal = (problems: string[]): never => {
  for (const p of problems) console.error(`lampo: ${p}`);
  process.exit(1);
};
const cfg = (() => {
  try {
    return loadConfig();
  } catch (e) {
    return fatal([(e as Error).message]);
  }
})();
// LAMPO_SIGNUP=open starts only once something gives each sign-up a workspace of its own (server/signup.ts).
const problems = startupProblems(cfg, process.env, { signupSeam: !!onSignup });
// A setting given in both spellings, differently (names only): an emptied LAMPO_ one would leave the VR_ one in force.
// Said before a refusal too, since it may be the reason for one.
for (const line of spellingWarnings()) console.warn(line);
if (problems.length) fatal(problems);
const SERVER = cfg.mode === 'server';
const LAN = !SERVER && (args.includes('--lan') || settings.LAMPO_LAN === '1');
const HOST = SERVER ? cfg.host : LAN ? '0.0.0.0' : cfg.host;
// The store's folders must be ours to write (the container points TMPDIR into its volume: the root file system is
// read-only there), its keys whole, and remote storage configured before anything is served.
{
  const found: string[] = [];
  // On a person's own machine a new store is theirs alone (A12 AGENT-9): reviews, notes and agents' logs.
  if (!SERVER)
    for (const dir of [DATA, CACHE, VERSIONS])
      if (!fs.existsSync(dir))
        try {
          fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
        } catch {}
  for (const dir of [DATA, CACHE, ...(cfg.storage.kind === 'local' ? [VERSIONS] : []), os.tmpdir()]) {
    const why = writable(dir);
    if (why)
      found.push(
        `can't write to ${dir} (${why}): the app must own its store. In Docker, use the named volume from docker-compose.yml, or give a bind-mounted folder to uid 1000 (chown -R 1000:1000 <folder>).`,
      );
  }
  if (!found.length)
    // the storage adapter as configured (no workspace's view: nothing runs in one yet)
    for (const check of [secret, shareSecret, rootStorage])
      try {
        check();
      } catch (e) {
        found.push((e as Error).message);
      }
  if (found.length) fatal(found);
}
// A hosted store moves to workspaces once (lib/workspaces.ts): a backup of what it touches, then workspace #1 named
// outright. Nothing moves on disk; the app on a person's own machine stays one workspace without any of it. A store
// that moved once and has lost its workspaces.json (or can't read it) doesn't start: its memberships are never implied.
const startIds = (() => {
  try {
    checkWorkspaces();
    if (SERVER) {
      const moved = migrateWorkspaces();
      if (moved.migrated) console.log(`workspaces: this store is workspace w1 from now on (backup: ${moved.backup})`);
      // Someone who left workspace #1 before the account kept a mirror of none keeps no role of #1's on it.
      syncRoleMirrors();
    }
    // the workspaces the start works through below (a list that went missing meanwhile is the same refusal)
    return workspaceIds();
  } catch (e) {
    if (!(e instanceof WorkspacesLostError)) throw e;
    return fatal([e.message]);
  }
})();
// Review-link tokens in clear from an older shares.json (only workspace #1 is old enough to have one): stored as hashes
// + sealed copies from now on, and every link from before link ids gets its id stored.
if (inWorkspace(DEFAULT_WORKSPACE, migrateShareTokens)) console.log('review links: shares.json migrated (tokens stored hashed, link ids stored)');
// Profile pictures move from the disposable cache into data/ (what backups keep), once.
{
  const moved = migrateAvatars();
  if (moved) console.log(`profile pictures: ${moved} moved from cache/avatars to data/avatars`);
}
// Links from before links knew what they were made for, in every workspace: each bound to its video or folder once, and
// one whose video or folder is already gone ended — it would cover the next one of that name (lib/shares.ts).
for (const ws of startIds)
  inWorkspace(ws, () => {
    try {
      const { bound, ended } = bindShareLinks();
      if (bound || ended) console.log(`review links (${ws}): ${bound} bound to their video or folder, ${ended} ended (their video or folder is gone)`);
    } catch (e) {
      console.error(`review links (${ws}): not bound yet (${(e as Error).message}); the next start tries again`);
    }
  });

// The LAN token survives restarts so the QR code on a phone keeps working.
function lanToken(): string {
  const file = path.join(CACHE, 'lan-token');
  if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8').trim();
  const t = crypto.randomBytes(12).toString('hex');
  fs.writeFileSync(file, t);
  return t;
}

const ctx = createContext({ cfg, lan: LAN, dev: DEV_MODE, token: lanToken() });
// Lampo Cloud's plans and billing, when LAMPO_CLOUD_MODULE names the module (server/extension.ts); none when self-hosted.
if (settings.LAMPO_CLOUD_MODULE) {
  const publicUrl = cfg.public_url || `http://localhost:${cfg.port}`;
  const host = hostContext({
    publicUrl,
    who: callerOf,
    sameOrigin: sameOriginOf(cfg.public_url ?? null),
    mail: (m) => ctx.accountMail.workspaceNotice(m),
  });
  const ext = await loadExtension(host).catch((e: Error) => {
    console.error(`lampo: ${spelledAs('LAMPO_CLOUD_MODULE')} could not be loaded: ${e.message}`);
    process.exit(1);
  });
  // its sign-up answer (a module's plans for a newcomer) takes the place of the app's own
  installExtension(ctx, ext);
  console.log(`extension: ${ctx.extension.name}${ext.onSignup ? ' (answers sign-ups)' : ''}${ext.billing ? ' (billing)' : ''}`);
}
if (SERVER) store.setInboxFile(false);
// Linked renders and outside writes: the machine's (workspace #1's) only.
ctx.watchers = inWorkspace(DEFAULT_WORKSPACE, () => startWatching(ctx.broadcast, ctx.background, ctx.activity));
// What agents on this machine do through `lampo` and the stdio MCP server (lib/activity.ts appends, this reads).
if (!ctx.hosted) ctx.activity.tail();
ctx.hub.startPing();
startServerFeed(ctx);
// Posts people published go out from here, in every workspace (lib/publish/queue.ts); an upload cut off by a stop
// resumes on the next start.
ctx.publisher.start();

// Dev: Vite middleware with hot reload. Otherwise the built UI (built once on first start).
async function uiMount(): Promise<(app: Express) => void> {
  const webRoot = path.join(ROOT, 'web');
  if (DEV_MODE) {
    const { createServer } = await import('vite');
    const vite = await createServer({ root: webRoot, server: { middlewareMode: true, ws: { port: cfg.port + 10000 } }, appType: 'spa' });
    // an Embed link's player is a page of its own (web/embed.html), not the app's
    return (app) =>
      app.use((req, _res, next) => {
        if (/^\/e\/[A-Za-z0-9_-]+$/.test(req.path)) req.url = '/embed.html';
        next();
      }, vite.middlewares);
  }
  const dist = path.join(webRoot, 'dist');
  if (!fs.existsSync(path.join(dist, 'index.html'))) {
    console.log('building UI (first start)…');
    const { build } = await import('vite');
    await build({ root: webRoot, logLevel: 'warn' });
  }
  return staticUi(dist);
}

cleanVoiceCache();
const ui = await uiMount();
let app: Express;
try {
  app = createApp(ctx, { ui });
} catch (e) {
  // a module whose routes are the app's own: one line, no stack trace
  if (!(e instanceof ModuleRouteError)) throw e;
  console.error(`lampo: ${spelledAs('LAMPO_CLOUD_MODULE')} refused: ${e.message}`);
  process.exit(1);
}
const http = await listen(app, cfg.port, HOST).catch((e: Error) => {
  console.error(`lampo: ${e.message}`);
  process.exit(1);
});
// Kept-alive connections outlast a proxy's idle ones; a render's body may stream for hours, any other within 5 minutes
// (server/listen.ts).
serverTimeouts(http);
const lan = LAN
  ? `  (LAN: ${lanIps()
      .map((ip) => `http://${ip}:${cfg.port}/?t=${ctx.token}`)
      .join('  ')})`
  : '';
console.log(`Lampo${SERVER ? ' (hosted)' : ''} on http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${cfg.port}${lan}`);
console.log(`data: ${DATA}`);
// Other accounts on this machine can read a store their folders don't keep them out of (and, on systems that can't
// tell who connects, reach the app on localhost as you: SECURITY.md).
const open = SERVER ? null : openToOthers(DATA);
if (open) console.warn(`warning: ${open}: chmod 700 it if anyone else signs in to this machine (SECURITY.md)`);
const owner = SERVER ? null : localOwner();
if (owner)
  console.log(
    `owner: ${owner.name}, signed in on this machine${owner.password ? '' : ' (set an email and a password in Settings → Profile to sign in from other devices)'}`,
  );
if (SERVER) {
  const url = cfg.public_url || `http://localhost:${cfg.port}`;
  console.log(`public url: ${cfg.public_url || '(not set: set LAMPO_PUBLIC_URL so only that host is served and cookies are Secure)'}`);
  console.log(`storage: ${rootStorage().kind}`);
  // Without a relay nothing reaches anyone: invites, sign-up links and password resets wait in the outbox.
  if (ctx.mail.transport === 'log')
    console.warn(
      `mail: LAMPO_SMTP_URL is not set, so emails (invites, sign-up confirmations, password resets) are written to ${ctx.mail.outbox} instead of being sent (docs/email.md)`,
    );
  else console.log(`mail: through ${ctx.mail.where}`);
  // LAMPO_OPERATOR names who runs this server (lib/operator.ts): an entry that is no account here is said once, plainly
  const strangers = unknownOperators(cfg, listUsers());
  if (strangers.length)
    console.warn(
      `operator: LAMPO_OPERATOR names ${strangers.join(', ')}, which ${strangers.length === 1 ? 'is' : 'are'} no account here (yet): ${strangers.length === cfg.operators.length ? 'nobody sees the operator pages until one is' : 'only the others on the list see the operator pages'}`,
    );
  else if (cfg.operators.length) console.log(`operator: ${cfg.operators.length} account${cfg.operators.length === 1 ? '' : 's'} from LAMPO_OPERATOR`);
  if (cfg.trust_proxy_legacy)
    console.warn(
      `trust proxy: ${spelledAs('LAMPO_TRUST_PROXY')}=true or a hop count now trusts only a proxy on this machine or a private network (${cfg.trust_proxy}); name the proxy's address or subnet to be exact (docs/server-mode.md)`,
    );
  if (ctx.setup.token) {
    console.log('');
    console.log('No account exists yet. Open the app and create the owner account with this one-time setup token:');
    console.log(`  ${ctx.setup.token}`);
    console.log(`  (${url}/?setup)  — or on this machine: lampo admin create-user --role owner`);
    console.log('');
  }
}
// Sign-ups nobody confirmed within a week could do nothing; their address and name are free again. A held account
// from before AUTH-1 waiting for a change of address loses it (A12-D7): its confirmation goes to its own inbox only.
const sweep = () => {
  const moved = forgetHeldChanges();
  if (moved)
    console.log(`accounts: ${moved} unconfirmed sign-up${moved === 1 ? '' : 's'} lost a pending change of address (only their own inbox confirms them)`);
  const n = sweepUnconfirmed();
  if (n) console.log(`accounts: removed ${n} sign-up${n === 1 ? '' : 's'} nobody confirmed within 7 days`);
};
sweep();
setInterval(sweep, 6 * 3600e3).unref();
// Project files' safety net (the trash, replaced versions: 30 days, at most a quarter of the plan) and bytes nothing
// names any more, every workspace in turn: a few minutes after start, then hourly.
const purgeFiles = () => void purgeEveryWorkspace(ctx);
setTimeout(purgeFiles, 5 * 60e3).unref();
setInterval(purgeFiles, 3600e3).unref();
inWorkspace(DEFAULT_WORKSPACE, () => {
  ctx.watchers.refresh();
  ctx.sessions.refresh();
});
preloadStt(cfg.stt);
if (SERVER) ctx.readiness.logStartup().catch(() => {});
// Every workspace's newest renders get their posters and checks, each in its own workspace.
for (const ws of startIds)
  inWorkspace(ws, () => {
    for (const r of store.listReviews()) if (!r.archived) ctx.background.warm(r);
    // footage search: what no video needs any more leaves its index; what isn't indexed yet is queued (after the rest)
    try {
      ctx.background.footage.queueAll();
    } catch (e) {
      console.error(`footage: ${(e as Error).message}`);
    }
  });

// SIGTERM (docker stop, a deploy): stop taking connections, end the live streams, and give uploads being registered
// and the running job up to 30 s (compose's stop_grace_period must be longer). Ctrl-C locally stops at once.
async function stop(sig: NodeJS.Signals) {
  if (ctx.stopping) return;
  ctx.stopping = true;
  // nothing new is sent; an upload on its way resumes where it stopped on the next start
  void ctx.publisher.stop();
  // a module's timers (reminders) pick up on the next start
  ctx.extension.stop();
  if (sig === 'SIGTERM') {
    console.log('stopping: finishing uploads and the running job (up to 30 s)…');
    http.close();
    ctx.hub.closeAll();
    http.closeIdleConnections();
    if (!(await drain(ctx.inflight, 30_000))) console.error('stopping: gave up waiting after 30 s');
  }
  ctx.tunnel.stop();
  // the agents Lampo started end with it, and whatever they left running too: waited for, in short steps
  await ctx.agentRuns.stopAll();
  // agents' runs not written yet (their steps go out together, about a second after they happen)
  ctx.runs.flushAll();
  stopStt();
  // a job still running is interrupted, not crashed: the next start runs it again (lib/crashGuard.ts counts only ends
  // without a signal like this one, an out-of-memory kill or a crash)
  jobsInterrupted();
  process.exit(0);
}
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
process.on('exit', () => {
  ctx.tunnel.stop();
  // an exit that didn't come through stop(): nothing is waited for any more, so at once (after stop(), nothing is left)
  ctx.agentRuns.endNow();
  stopStt();
});
