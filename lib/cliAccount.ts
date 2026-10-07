// `lampo login | logout | whoami` (which store this lampo talks to) and `lampo admin …` (accounts, run on the server itself).
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import * as auth from './auth.ts';
import { type Credentials, clearCredentials, readCredentials, saveCredentials } from './backend/credentials.ts';
import { createApi } from './backend/remote.ts';
import { BROWSER_WAIT_MS, browserCommand, browserLogin, LoginEnded, launchBrowser } from './browserLogin.ts';
import { loadConfig } from './config.ts';
import { settings } from './env.ts';
import { FoldersUnreadableError } from './folderIds.ts';
import { repairFolders } from './folders.ts';
import { mailProblems } from './mail/config.ts';
import { checkAddress } from './mail/mime.ts';
import { sendTestMail } from './mail/testMail.ts';
import { mailLang } from './mail/words.ts';
import { afterNewPassword } from './newPassword.ts';
import { vrTokenName } from './oauth/clients.ts';
import { CACHE, currentWorkspace, DATA, inWorkspace, USER } from './paths.ts';
import { keepLines, oneLine } from './time.ts';
import * as workspaces from './workspaces.ts';

type Opts = Record<string, string | true | string[] | undefined>;
const str = (v: Opts[string]): string | undefined => (typeof v === 'string' ? v : undefined);
// Read line by line like `lampo`'s own output: only `\n` ends a line (lib/time.ts keepLines).
const out = (s: string): void => {
  process.stdout.write(`${keepLines(s)}\n`);
};

// Piped stdin (scripts) is read by one reader for the whole run: a reader per prompt would buffer the password line
// while reading the email and drop it when closed.
let piped: AsyncIterator<string> | null = null;
async function nextPipedLine(): Promise<string> {
  piped ??= readline.createInterface({ input: process.stdin })[Symbol.asyncIterator]();
  const next = await piped.next();
  return next.done ? '' : next.value;
}

/** A password from LAMPO_PASSWORD, a hidden prompt on a terminal, or the next line of stdin (scripts). */
export async function readSecret(prompt: string): Promise<string> {
  if (settings.LAMPO_PASSWORD) return settings.LAMPO_PASSWORD;
  if (!process.stdin.isTTY) return nextPipedLine();
  return hiddenPrompt(prompt);
}

function hiddenPrompt(prompt: string): Promise<string> {
  process.stderr.write(prompt);
  return new Promise((resolve) => {
    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    const onData = (d: Buffer) => {
      for (const ch of d.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.off('data', onData);
          process.stderr.write('\n');
          return resolve(value);
        }
        if (ch === '\u0003') process.exit(130);
        if (ch === '\u007f') value = value.slice(0, -1);
        else value += ch;
      }
    };
    stdin.on('data', onData);
  });
}

/** "review.example.com" → https://review.example.com; localhost may stay http. */
export function serverUrl(raw: string): string {
  const s = raw.trim().replace(/\/+$/, '');
  if (/^https?:\/\//.test(s)) return s;
  return /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(s) ? `http://${s}` : `https://${s}`;
}

/**
 * Whether a server URL is plain http to another machine: the password, the token and every note would cross the network
 * as they are. This machine (localhost, 127.x, ::1) is fine: nothing leaves it.
 */
export function plainHttpElsewhere(server: string): boolean {
  let u: URL;
  try {
    u = new URL(server);
  } catch {
    return false;
  }
  return u.protocol === 'http:' && !/^(localhost|.+\.localhost|127(\.\d{1,3}){3}|\[::1\])$/i.test(u.hostname);
}

interface Me {
  user: { name: string; email: string; role: string } | null;
  name: string;
  role: string;
  mode: string;
  /** The workspace the token acts in, on a server that has them. */
  workspace?: { id: string; name: string };
  workspaces?: { id: string }[];
}

/** `--expires 90d` (or `90`): how many days the token `lampo login` asks for works; without it, until revoked. */
export function tokenDays(raw: string | undefined): number | null {
  if (!raw) return null;
  const m = /^(\d{1,4})d?$/.exec(raw.trim());
  const days = m ? Number(m[1]) : Number.NaN;
  if (!(days >= 1 && days <= 3650)) throw new Error('--expires takes days, e.g. --expires 90d (1–3650)');
  return days;
}

/**
 * The API token `lampo login` signs in with: `--token -` reads it from stdin (a hidden prompt on a terminal), since a
 * process's arguments are readable by other users of the machine while it runs (ps) and stay in the shell's history.
 */
async function givenToken(opt: Opts): Promise<string | undefined> {
  const flag = str(opt.token);
  if (flag === '-') {
    const token = (process.stdin.isTTY ? await hiddenPrompt('API token: ') : await nextPipedLine()).trim();
    if (!token) throw new Error('no token on stdin: paste it at the prompt, or pipe it in (… | lampo login <url> --token -)');
    return token;
  }
  if (flag) {
    process.stderr.write(
      'lampo: warning: a token on the command line shows in the process list and your shell history; use --token - to paste or pipe it in\n',
    );
    return flag;
  }
  return settings.LAMPO_TOKEN && !str(opt.email) ? settings.LAMPO_TOKEN : undefined;
}

/**
 * `lampo login <url>`: in the browser by default (lib/browserLogin.ts: the person allows it there, lampo gets an API token
 * named after this machine); `--email` signs in with the password instead and `--token -` takes a token, for where no
 * browser can reach (CI, containers, scripts).
 */
export async function login({ pos, opt }: { pos: string[]; opt: Opts }): Promise<void> {
  const raw = pos[0];
  if (!raw) throw new Error('say which server: lampo login https://review.example.com [--email you@example.com | --token -]');
  const server = serverUrl(raw);
  // Plain http to another machine sends the password (or the token) and then every note unencrypted: only when asked.
  if (plainHttpElsewhere(server)) {
    if (!opt.insecure)
      throw new Error(
        `${server} is plain http: your password or token, and every note after it, would cross the network unencrypted. Use https, or add --insecure if this network is yours alone`,
      );
    process.stderr.write('lampo: warning: plain http to another machine (--insecure): the token and every note travel unencrypted\n');
  }
  let creds: Credentials;
  const days = tokenDays(str(opt.expires));
  const token = await givenToken(opt);
  if (token) {
    creds = { server, token };
  } else if (opt.email !== undefined) {
    const email =
      str(opt.email) ||
      (await (async () => {
        process.stderr.write('email: ');
        return readSecretLine();
      })());
    const password = await readSecret('password: ');
    const res = await fetch(`${server}/api/auth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // --workspace <id>: the token acts in that workspace of a server with several (else the person's first)
      body: JSON.stringify({
        email,
        password,
        name: vrTokenName(os.hostname()),
        ...(days ? { days } : {}),
        ...(str(opt.workspace) ? { workspace: str(opt.workspace) } : {}),
      }),
    }).catch((e: Error) => {
      throw new Error(`cannot reach ${server}: ${e.message}`);
    });
    const body = (await res.json().catch(() => ({}))) as { token?: string; info?: { id: string }; error?: string };
    if (!res.ok || !body.token) throw new Error(body.error || `sign-in failed (HTTP ${res.status})`);
    creds = { server, token: body.token, token_id: body.info?.id };
  } else {
    // In the browser the token acts where the person works there, and the consent screen names that workspace.
    if (opt.workspace !== undefined)
      throw new Error('--workspace goes with --email: in the browser, the token is for the workspace you work in there (the page names it)');
    const got = await signInWithBrowser(server, days);
    if (!got) return;
    creds = { server, token: got.token, token_id: got.info.id };
  }
  const me = await createApi(creds).get<Me>('/api/auth/me');
  if (me.user) creds.user = { name: me.user.name, email: me.user.email, role: me.user.role };
  creds.saved = new Date().toISOString();
  const file = saveCredentials(creds);
  // Who, and in which workspace whenever the server has them: a token acts in one.
  const where = me.workspace ? ` in workspace "${oneLine(me.workspace.name)}" (${me.workspace.id})` : '';
  out(`signed in to ${server} as ${oneLine(me.name)}${me.user ? ` <${me.user.email}> (${me.role})` : ''}${where}`);
  out(`every lampo command and the MCP server now use that server (credentials: ${file}; lampo logout to go back to the local store)`);
}

/**
 * The browser sign-in with what the terminal needs: progress on stderr, the system's browser (none over SSH), an
 * address pasted on stdin, Ctrl-C. Null when the person cancelled (said here; the exit code is 130).
 */
async function signInWithBrowser(server: string, days: number | null) {
  const cmd = browserCommand();
  const stop = new AbortController();
  const cancel = () => stop.abort();
  process.once('SIGINT', cancel);
  try {
    return await browserLogin({
      server,
      machine: os.hostname(),
      days,
      open: cmd ? (url) => launchBrowser(cmd, url) : null,
      say: (line) => process.stderr.write(`${keepLines(line)}\n`),
      input: process.stdin,
      timeoutMs: BROWSER_WAIT_MS,
      signal: stop.signal,
    });
  } catch (e) {
    if (e instanceof LoginEnded && e.reason === 'cancelled') {
      process.stderr.write(`\nvr: ${e.message}\n`);
      process.exitCode = 130;
      return null;
    }
    throw e;
  } finally {
    process.off('SIGINT', cancel);
  }
}

// The email prompt is visible; only the password is hidden.
async function readSecretLine(): Promise<string> {
  if (!process.stdin.isTTY) return (await nextPipedLine()).trim();
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    rl.close();
    return line.trim();
  }
  return '';
}

export async function logout(): Promise<void> {
  const c = readCredentials();
  if (!c) return out('not signed in to a server; lampo uses the local store.');
  if (settings.LAMPO_SERVER && settings.LAMPO_TOKEN)
    return out('LAMPO_SERVER / LAMPO_TOKEN are set in the environment; unset them to go back to the local store.');
  if (c.token_id)
    await createApi(c)
      .call('DELETE', `/api/auth/tokens/${encodeURIComponent(c.token_id)}`)
      .catch(() => {});
  clearCredentials();
  out(`signed out of ${c.server}${c.token_id ? ' (token revoked)' : ''}; lampo uses the local store again.`);
}

export async function whoami({ opt }: { opt: Opts }, author: string): Promise<void> {
  const c = readCredentials();
  if (!c) {
    if (opt.json) return out(JSON.stringify({ kind: 'local', data: DATA, author }, null, 2));
    return out(`local store: ${DATA}\nwriting as: ${author}`);
  }
  const me = await createApi(c).get<Me>('/api/auth/me');
  if (opt.json) return out(JSON.stringify({ kind: 'remote', server: c.server, user: me.user, name: me.name, role: me.role, author }, null, 2));
  out(`server: ${c.server}\nsigned in as: ${me.name}${me.user ? ` <${me.user.email}> (${me.role})` : ''}\nwriting as: ${author}`);
}

// ---------------------------------------------------------------- lampo admin (on the server's own store)

export async function admin({ pos, opt }: { pos: string[]; opt: Opts }): Promise<void> {
  const [sub] = pos;
  if (sub === 'list-users') {
    // Every account, with its role in the workspace this command works in (LAMPO_WORKSPACE or --workspace, else #1; '–'
    // when it isn't a member there) — never the account's own `role`, workspace #1's mirror — and, on a store with
    // several workspaces, its role in each of the others.
    const ws = workspaceOpt(opt);
    const here = new Map(ws.membersOf(ws.id).map((m) => [m.user, m.role]));
    const many = ws.listWorkspaces().length > 1;
    const users = auth.listUsers();
    const others = (u: auth.User) => ws.workspacesOf(u.id).filter((m) => m.workspace.id !== ws.id);
    if (opt.json)
      return out(
        JSON.stringify(
          users.map((u) => ({
            ...auth.publicUser(u),
            role: here.get(u.id) ?? null,
            workspaces: ws.workspacesOf(u.id).map((m) => ({ id: m.workspace.id, name: m.workspace.name, role: m.role })),
          })),
          null,
          2,
        ),
      );
    if (!users.length) return out(`no accounts yet (store: ${DATA}).`);
    if (many) out(`roles in ${ws.id} (${oneLine(ws.getWorkspace(ws.id)?.name ?? '')}); another: --workspace <id>`);
    for (const u of users) {
      const also = many ? others(u).map((m) => `${m.role} in ${m.workspace.id}`) : [];
      out(
        `${(here.get(u.id) ?? '–').padEnd(8)} ${u.email.padEnd(32)} ${u.name}${u.disabled ? '  (disabled)' : ''}${also.length ? `  (also ${also.join(', ')})` : ''}`,
      );
    }
    return;
  }
  if (sub === 'workspaces') return workspacesAdmin(pos.slice(1), opt);
  if (sub === 'create-user') {
    const email = str(opt.email);
    const name = str(opt.name);
    const ws = workspaceOpt(opt);
    const role = (str(opt.role) || (ws.membersOf(ws.id).length ? 'member' : 'owner')) as auth.Role;
    if (!email || !name)
      throw new Error(`lampo admin create-user --email you@example.com --name "Your Name" [--role ${auth.ROLES.join('|')}] [--workspace <id>]`);
    if (!auth.ROLES.includes(role)) throw new Error(`--role must be one of ${auth.ROLES.join(', ')}`);
    const password = str(opt.password) || (await readSecret(`password for ${email}: `));
    // made here like in the app: a new person starts with the first run, unless the instance turned it off
    auth.setOnboarding(loadConfig().onboarding !== false);
    const u = await ws.createAccountIn(ws.id, { email, name, password, role });
    return out(`created ${role} ${u.email} (${u.name}) in ${ws.id === 'w1' ? DATA : `workspace ${ws.id}`}`);
  }
  if (sub === 'reset-password') {
    const email = str(opt.email);
    const u = email ? auth.findUserByEmail(email) : null;
    if (!u) throw new Error('lampo admin reset-password --email you@example.com (an existing account)');
    const password = str(opt.password) || (await readSecret(`new password for ${u.email}: `));
    await auth.updateUser(u.id, { password, disabled: false });
    afterNewPassword(u.id);
    return out(`password of ${u.email} changed; their sessions are signed out.`);
  }
  if (sub === 'invite') {
    const role = (str(opt.role) || 'member') as auth.Role;
    if (!auth.ROLES.includes(role)) throw new Error(`--role must be one of ${auth.ROLES.join(', ')}`);
    const days = str(opt.days) ? Number(str(opt.days)) : undefined;
    const ws = workspaceOpt(opt);
    // Who the invitee is told invites them: the name notes from here are signed with (config.json "user" / LAMPO_USER —
    // "admin" in the container), never the OS account the command runs as ("node" there).
    const { token, invite } = auth.createInvite({
      role,
      name: str(opt.name),
      email: str(opt.email),
      days,
      by: { id: 'cli', name: USER },
      ...(ws.id !== 'w1' ? { workspace: ws.id } : {}),
      ...(ws.isMigrated() ? { isMember: (u: auth.User) => !!ws.roleIn(ws.id, u.id) } : {}),
    });
    const base = loadConfig().public_url || 'https://<your server>';
    const url = `${base}/#/invite/${token}`;
    if (opt.json) return out(JSON.stringify({ invite, url }, null, 2));
    out(url);
    // which team the link brings someone into, said whenever the store has more than one (LAMPO_WORKSPACE may be set)
    out(
      `invites a ${invite.role}${invite.email ? ` (${invite.email})` : ''}${whereIn(ws.id, 'into')}; works once, until ${invite.expires.slice(0, 16).replace('T', ' ')}.`,
    );
    return;
  }
  if (sub === 'invites') {
    // The workspace this command works in (LAMPO_WORKSPACE or --workspace, else #1); --all: every workspace's, each named.
    const ws = workspaceOpt(opt);
    const all = opt.all === true;
    const list = auth.listInvites(all ? undefined : ws.id);
    if (opt.json)
      return out(
        JSON.stringify(
          list.map((i) => ({ ...i, workspace: i.workspace ?? 'w1' })),
          null,
          2,
        ),
      );
    const many = ws.listWorkspaces().length > 1;
    if (many && !all) out(`invites into ${ws.id} (${oneLine(ws.getWorkspace(ws.id)?.name ?? '')}); every workspace's: --all`);
    if (!list.length) return out('no invites.');
    for (const i of list)
      out(
        `${i.status.padEnd(9)} ${i.role.padEnd(8)} ${(i.email || i.name || '–').padEnd(32)} by ${i.by}, until ${i.expires.slice(0, 10)}  ${i.id}${all && many ? `  ${i.workspace ?? 'w1'}` : ''}`,
      );
    return;
  }
  if (sub === 'mail-test') return mailTest(pos[1], opt);
  if (sub === 'delete-account') return deleteAccountAdmin(pos[1], opt);
  if (sub === 'delete-workspace') return deleteWorkspaceAdmin(pos[1], opt);
  if (sub === 'export-account') return exportAccountAdmin(pos[1], opt);
  if (sub === 'erasures') return erasuresAdmin(opt);
  if (sub === 'import') return importAdmin(pos[1], opt);
  if (sub === 'repair-folders') return repairFoldersAdmin(opt);
  if (sub === 'revoke-invite') {
    if (!pos[1]) throw new Error('lampo admin revoke-invite <invite id>  (ids: lampo admin invites)');
    // only an invite of the workspace this command works in: another team's is --workspace <id> away, never by accident
    const ws = workspaceOpt(opt);
    if (!auth.revokeInvite(pos[1], ws.id)) throw new Error(`no pending invite ${pos[1]}${whereIn(ws.id)}`);
    return out(`revoked ${pos[1]}${whereIn(ws.id)}`);
  }
  throw new Error(
    'lampo admin create-user | reset-password | list-users | invite | invites | revoke-invite | workspaces | repair-folders | mail-test <to> | import <bundle.tar> | delete-account <email|id> | delete-workspace <id> | export-account <email|id> | erasures  (run on the server, with its data directory)',
  );
}

// ---------------------------------------------------------------- people's data (A13 PEOPLE-1)

/** An account by its address or its id (`u_…`). */
function accountArg(raw: string | undefined, usage: string): auth.User {
  const u = raw ? (auth.getUser(raw) ?? auth.findUserByEmail(raw)) : null;
  if (!u) throw new Error(`${usage}  (an existing account: its address or id; lampo admin list-users)`);
  return u;
}

/**
 * The server's mail, as the running server sends it (server/accountMail.ts): what a deletion tells its people. Sent now
 * (flush), not left in the queue for the server's next round. Null without a public URL (no links, nothing sent).
 */
async function mailNow() {
  const cfg = loadConfig();
  if (!cfg.public_url) return null;
  const { createMailer } = await import('./mail/index.ts');
  const { senderOf } = await import('./mail/config.ts');
  const { createAccountMail } = await import('../server/accountMail.ts');
  const host = new URL(cfg.public_url).hostname;
  const mailer = createMailer({
    config: cfg.mail,
    dir: path.join(DATA, 'mail'),
    outbox: path.join(CACHE, 'outbox'),
    from: senderOf(cfg.mail, host),
    host,
    secret: auth.secret,
    log: (line) => process.stderr.write(`lampo admin: ${line}\n`),
  });
  return { mail: createAccountMail(cfg, mailer), flush: () => mailer.flush() };
}

/**
 * The billing module the server runs (LAMPO_CLOUD_MODULE), loaded for one deletion: it hears it and stops billing the
 * workspace, as it would in the server. None configured: nothing to tell.
 */
async function moduleFor(): Promise<{ idle(): Promise<void>; stop(): void } | null> {
  if (!settings.LAMPO_CLOUD_MODULE?.trim()) return null;
  const { hostContext, loadExtension } = await import('../server/extension.ts');
  const cfg = loadConfig();
  const host = hostContext({
    publicUrl: cfg.public_url ?? 'http://localhost',
    who: () => null,
    sameOrigin: () => false,
    log: (event, fields) => process.stderr.write(`lampo admin: ${event} ${JSON.stringify(fields ?? {})}\n`),
  });
  return loadExtension(host);
}

const sizeOf = (bytes: number) =>
  bytes >= 1e12 ? `${(bytes / 1e12).toFixed(1)} TB` : bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`;

/**
 * `lampo admin delete-workspace <id> [--yes] [--json]`: what deleting a workspace takes with it, and with --yes, deleted
 * (lib/deletion.ts: its files and storage objects, links, invites, tokens, apps, the accounts it leaves in no
 * workspace; the billing module stops billing it; its people are emailed). Never workspace #1.
 */
async function deleteWorkspaceAdmin(id: string | undefined, opt: Opts): Promise<void> {
  const usage = 'lampo admin delete-workspace <workspace id> [--yes]';
  if (!id || !workspaces.getWorkspace(id)) throw new Error(`${usage}  (ids: lampo admin workspaces)`);
  const { deleteWorkspace, planWorkspaceDeletion } = await import('./deletion.ts');
  const plan = planWorkspaceDeletion(id);
  if (opt.json && opt.yes !== true) return out(JSON.stringify(plan, null, 2));
  out(`workspace ${plan.id} "${oneLine(plan.name)}"`);
  out(
    `  ${plan.videos} videos (${sizeOf(plan.bytes)}), ${plan.links} review links, ${plan.invites} invites, ${plan.tokens} API tokens, ${plan.apps} connected apps`,
  );
  out(`  ${plan.members.total} members; ${plan.members.accountsGone} of them work nowhere else: their accounts go too`);
  if (plan.refused) throw new Error(plan.refused);
  if (opt.yes !== true) return out('nothing deleted (a dry run): run it again with --yes to delete all of it');
  const ext = await moduleFor();
  const mail = await mailNow();
  const done = await deleteWorkspace(id, 'cli');
  const told = mail ? mail.mail.workspaceDeleted(plan.name, 'operator', done.people) : 0;
  await mail?.flush();
  await ext?.idle();
  ext?.stop();
  if (opt.json) return out(JSON.stringify({ deleted: plan.id, accountsGone: done.people.filter((p) => p.accountGone).length, told }, null, 2));
  out(`deleted ${plan.id}; ${done.people.filter((p) => p.accountGone).length} accounts went with it; ${told} people emailed`);
}

/**
 * `lampo admin delete-account <email|id> [--yes] [--json]`: what deleting an account means (the workspaces that go with it,
 * those it leaves, those it must hand over first) and with --yes, deleted with everything it kept (lib/erasure.ts).
 */
async function deleteAccountAdmin(raw: string | undefined, opt: Opts): Promise<void> {
  const u = accountArg(raw, 'lampo admin delete-account <email|id> [--yes]');
  const { deleteAccount, planAccountDeletion } = await import('./deletion.ts');
  const plan = planAccountDeletion(u.id);
  if (opt.json && opt.yes !== true) return out(JSON.stringify(plan, null, 2));
  const names = (ws: { id: string; name: string }[]) => ws.map((w) => `${w.id} "${oneLine(w.name)}"`).join(', ') || 'none';
  out(`account ${u.id} <${u.email}> (${oneLine(u.name)})`);
  out(`  workspaces that go with it (nobody else works there): ${names(plan.goWith)}`);
  out(`  workspaces it leaves: ${names(plan.leave)}`);
  if (plan.refused) throw new Error(plan.refused);
  if (plan.blockedBy.length)
    throw new Error(
      `it is the last owner of ${names(plan.blockedBy)}, where others work: make someone else an owner there, or delete the workspace first (lampo admin delete-workspace)`,
    );
  if (opt.yes !== true) return out('nothing deleted (a dry run): run it again with --yes to delete it');
  const ext = plan.goWith.length ? await moduleFor() : null;
  const mail = await mailNow();
  await deleteAccount(u.id, 'cli');
  mail?.mail.removed(u);
  await mail?.flush();
  await ext?.idle();
  ext?.stop();
  if (opt.json) return out(JSON.stringify({ deleted: u.id, workspaces: plan.goWith.map((w) => w.id) }, null, 2));
  out(`deleted ${u.id}${plan.goWith.length ? ` and ${plan.goWith.length} workspace${plan.goWith.length === 1 ? '' : 's'}` : ''}`);
}

/** `lampo admin export-account <email|id> --out <file.zip>`: the account's own data as one zip (lib/accountExport.ts). */
async function exportAccountAdmin(raw: string | undefined, opt: Opts): Promise<void> {
  const u = accountArg(raw, 'lampo admin export-account <email|id> --out data.zip');
  const to = str(opt.out);
  if (!to) throw new Error('lampo admin export-account <email|id> --out data.zip  (where to write the zip)');
  const { accountExport, exportZip } = await import('./accountExport.ts');
  const files = await accountExport(u.id);
  const plan = exportZip(files);
  const file = path.resolve(to);
  const fs = await import('node:fs');
  const fd = fs.openSync(file, 'wx', 0o600);
  try {
    for await (const chunk of plan.bytes()) fs.writeSync(fd, chunk);
  } finally {
    fs.closeSync(fd);
  }
  out(`wrote ${files.length} files (${sizeOf(plan.length)}) for ${u.email} to ${file}`);
}

/**
 * `lampo admin erasures [--apply] [--json]`: the deletions written down (data/erasures.jsonl). After restoring a backup
 * taken before some of them: what is back that was deleted, and with --apply, deleted again.
 */
async function erasuresAdmin(opt: Opts): Promise<void> {
  const { listErasures } = await import('./erasure.ts');
  const { reapplyErasures } = await import('./deletion.ts');
  const apply = opt.apply === true;
  const back = await reapplyErasures({ apply });
  if (opt.json) return out(JSON.stringify({ erasures: listErasures().length, back, applied: apply }, null, 2));
  out(`${listErasures().length} deletions written down`);
  if (!back.accounts.length && !back.workspaces.length) return out('none of them is back in this store');
  out(`back in this store: ${back.accounts.length} accounts, ${back.workspaces.length} workspaces (${[...back.workspaces, ...back.accounts].join(', ')})`);
  out(apply ? 'deleted again' : 'run it again with --apply to delete them again');
}

/**
 * `lampo admin repair-folders [--write] [--take-back <link id,…>] [--workspace <id>] [--json]`: a workspace's folders.json
 * that can't be parsed any more, rebuilt from what it still says, the videos' folders and the review links' ids
 * (lib/folders.ts repairFolders). A dry run unless --write; the damaged file is kept beside the new one. Each link whose
 * id the damage took is named with what became of it; one nothing in the store vouches for is a person's call.
 */
async function repairFoldersAdmin(opt: Opts): Promise<void> {
  const ws = workspaceOpt(opt);
  let r: ReturnType<typeof repairFolders>;
  try {
    const takeBack = (str(opt.take_back) ?? '')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean);
    if (opt.take_back !== undefined && !takeBack.length) throw new Error('--take-back needs the ids of links (s_…, comma-separated)');
    r = inWorkspace(ws.id, () => repairFolders({ write: !!opt.write, takeBack }));
  } catch (e) {
    if (e instanceof FoldersUnreadableError) throw new Error(`${e.message}: fix that first (repair-folders rebuilds a damaged file, not one it can't read)`);
    throw e;
  }
  if (r.state !== 'damaged' && opt.take_back !== undefined) throw new Error('--take-back is for a damaged folders.json: this one has nothing to take back');
  if (opt.json) return out(JSON.stringify(r, null, 2));
  const working = r.links.filter((l) => l.works).length;
  if (r.state === 'missing') return out(`there is no ${r.file}: nothing to repair (the folders are the videos')`);
  if (r.state === 'ok') return out(`${r.file} reads fine: nothing to repair (${r.folders.length} folders, ${r.ids.length} review-link ids)`);
  const from = (k: 'file' | 'link') => r.ids.filter((i) => i.from === k).length;
  out(`${r.file} is damaged (${oneLine(r.problem ?? '')})`);
  out(`rebuilt: ${r.folders.length} folders, ${r.ids.length} review-link ids (${from('file')} from the damaged file, ${from('link')} from review links)`);
  out(`folder review links that work with it: ${working} of ${r.links.length}`);
  // Each link whose id the damage took, and what became of it: given back, ended before, or a person's call.
  for (const l of r.links) {
    if (!l.state) continue;
    const name = `"${oneLine(l.label)}" on ${oneLine(l.folder)} (${l.id ?? 'no id'})`;
    if (l.state === 'taken back') out(`  given back: ${name}${l.why ? `: ${l.why}` : ''}`);
    else if (l.state === 'ended') out(`  stays ended: ${name}: ${l.why ?? 'its folder had ended'}`);
    else
      out(
        `  not given back: ${name}: nothing in the store shows that this ${oneLine(l.folder)} is the folder it was made on (another may have taken its name); if it is: --take-back ${l.id ?? ''}`,
      );
  }
  out(
    r.kept
      ? `written; the damaged file is kept as ${r.kept}`
      : 'nothing written (a dry run): run it again with --write to write it (the damaged file is kept beside it)',
  );
}

/**
 * `lampo admin import <bundle.tar> --workspace <id> --owner <email> [--dry-run] [--people "Name=email,…"] [--no-derive]
 * [--json]`: a bundle from `lampo export` into a workspace of this store (lib/bundleImport.ts, docs/moving.md). Says what
 * happens to every video, folder, playbook and name; `--dry-run` says it and writes nothing.
 */
async function importAdmin(file: string | undefined, opt: Opts): Promise<void> {
  const usage = 'lampo admin import <bundle.tar> --workspace <id> --owner you@example.com [--dry-run] [--people "Name=email,…"] [--no-derive]';
  const workspace = str(opt.workspace);
  const owner = str(opt.owner);
  if (!file || !workspace || !owner) throw new Error(usage);
  const { importBundle } = await import('./bundleImport.ts');
  // A hosted server renders the inbox per request and keeps no INBOX.md (server/index.ts): neither does its import.
  if (loadConfig().mode === 'server') (await import('./store.ts')).setInboxFile(false);
  const r = await importBundle({
    file: path.resolve(file),
    workspace,
    owner,
    people: str(opt.people),
    dryRun: opt.dry_run === true,
    derive: opt.no_derive !== true,
    log: (line) => process.stderr.write(`lampo admin import: ${oneLine(line)}\n`),
  });
  if (opt.json) return out(JSON.stringify(r, null, 2));
  // Every string the report prints came from the bundle or was made from it: one line each, no control character.
  const gb = (n: number) => `${(n / 1e9).toFixed(2)} GB`;
  const where = (p: { folder: string | null; name: string }) => oneLine(p.folder ? `${p.folder}/${p.name}` : p.name);
  const go = r.reviews.filter((x) => x.action !== 'skip');
  out(
    `bundle ${r.bundle.id} (made ${oneLine(r.bundle.created.slice(0, 16).replace('T', ' '))}, Lampo ${oneLine(r.bundle.app) || '?'}) into ${r.workspace}, owner ${oneLine(r.owner.name)} <${r.owner.email}>`,
  );
  out(`videos: ${go.length} ${r.dry_run ? 'to import' : 'imported'}, ${r.reviews.length - go.length} skipped`);
  for (const x of r.reviews) {
    if (x.action === 'skip') out(`  skip    ${where(x)}: ${oneLine(x.why ?? '')}`);
    else
      out(
        `  ${x.action === 'resume' ? 'resume' : 'import'}  ${where(x)} → ${x.slug} · ${x.versions} version${x.versions === 1 ? '' : 's'} (${gb(x.bytes)})${x.missing_versions ? ` + ${x.missing_versions} without bytes` : ''} · ${x.notes} notes · ${x.replies} replies · ${x.files} files`,
      );
    const renamed = Object.entries(x.renamed);
    if (renamed.length) out(`          note ids taken here, renamed: ${renamed.map(([a, b]) => `${a} → ${b}`).join(', ')}`);
  }
  const by = (a: string) => r.folders.filter((f) => f.action === a).map((f) => oneLine(f.name));
  out(
    `folders: ${by('create').length ? `create ${by('create').join(', ')}` : 'none to create'}${by('there').length ? ` · there already: ${by('there').join(', ')}` : ''}`,
  );
  for (const f of r.folders.filter((x) => x.action === 'skip')) out(`  skip ${oneLine(f.name)}: ${oneLine(f.why ?? '')}`);
  for (const p of r.playbooks) out(`playbook ${p.scope ? oneLine(p.scope) : 'House'}: ${p.action}${p.why ? ` (${oneLine(p.why)})` : ''}`);
  out('people:');
  for (const p of r.people) out(`  ${oneLine(p.name)} ${oneLine(p.to)}`);
  out(
    `history: ${r.events.append} events ${r.dry_run ? 'to add' : 'added'}, marked as imported (no agent, webhook or push hears of them)${r.events.there ? `; ${r.events.there} there already` : ''}`,
  );
  if (r.taste.length) out(`taste: written again from the notes (for the library and its folders; the rest when an agent asks)`);
  if (r.derive) out(`posters, waveforms and loudness: ${r.dry_run ? 'queued' : 'made'} for ${r.derive} video(s); proxies when a player opens one`);
  for (const w of r.warnings) out(`note: ${oneLine(w)}`);
  out(r.dry_run ? `dry run: nothing was written (the import writes ${gb(r.bytes)})` : `done: ${gb(r.bytes)} written`);
}

/** ' in workspace <id> (<name>)' on a store with several workspaces, else nothing: what a line about one says of it. */
const whereIn = (id: string, word = 'in'): string =>
  workspaces.listWorkspaces().length > 1 ? ` ${word} workspace ${id} (${oneLine(workspaces.getWorkspace(id)?.name ?? '')})` : '';

/** `--workspace <id>`, else the one this process works in (LAMPO_WORKSPACE, else #1), checked against the store's. */
function workspaceOpt(opt: Opts) {
  const id = str(opt.workspace) || currentWorkspace();
  const w = workspaces;
  if (!w.getWorkspace(id)) throw new Error(`no workspace ${id} (lampo admin workspaces lists them)`);
  return { ...w, id };
}

/**
 * `lampo admin workspaces [list]` — every workspace with its members; `create --name "Acme" --owner you@example.com` — a new
 * one, its owner an existing account (migrates the store first, with a backup); `migrate` — just that, once.
 */
async function workspacesAdmin(pos: string[], opt: Opts): Promise<void> {
  const [sub = 'list'] = pos;
  if (sub === 'list') {
    const list = workspaces.listWorkspaces().map((w) => ({ ...workspaces.workspaceInfo(w), members: w.members.length }));
    if (opt.json) return out(JSON.stringify({ migrated: workspaces.isMigrated(), workspaces: list }, null, 2));
    for (const w of list) out(`${w.id.padEnd(15)} ${String(w.members).padStart(3)} member${w.members === 1 ? ' ' : 's'}  ${w.name}`);
    if (!workspaces.isMigrated()) out('(one workspace: this store has not moved to workspaces yet — `lampo admin workspaces migrate`)');
    return;
  }
  if (sub === 'create') {
    const name = str(opt.name);
    const email = str(opt.owner);
    const owner = email ? auth.findUserByEmail(email) : null;
    if (!name || !owner) throw new Error('lampo admin workspaces create --name "Acme" --owner you@example.com  (an existing account)');
    const w = workspaces.createWorkspace({ name, ownerId: owner.id });
    if (opt.json) return out(JSON.stringify(w, null, 2));
    return out(`created workspace ${w.id} "${w.name}", owned by ${owner.email}`);
  }
  if (sub === 'migrate') {
    const r = workspaces.migrateWorkspaces();
    if (opt.json) return out(JSON.stringify(r, null, 2));
    return out(r.migrated ? `moved to workspaces: everything is workspace w1 (backup: ${r.backup})` : 'already on workspaces: nothing to do.');
  }
  throw new Error('lampo admin workspaces [list] | create --name "Acme" --owner you@example.com | migrate');
}

/**
 * `lampo admin mail-test <to> [--lang de]`: one message through the server's own mail settings, sent now (not queued),
 * so a wrong password or a blocked port shows here instead of in a log later. The log transport writes it to the
 * outbox and says where.
 */
async function mailTest(to: string | undefined, opt: Opts): Promise<void> {
  if (!to) throw new Error('lampo admin mail-test you@example.com [--lang de]');
  const address = checkAddress(to);
  const cfg = loadConfig();
  const problems = mailProblems({ ...cfg, signup: 'off' });
  if (problems.length) throw new Error(problems.join('\n'));
  const sent = await sendTestMail(
    { mail: cfg.mail, site: cfg.public_url || `http://localhost:${cfg.port}`, org: cfg.org_name ?? null },
    address,
    mailLang(str(opt.lang)),
  );
  if (sent.transport === 'log') {
    out(`no LAMPO_SMTP_URL: the test was written to ${sent.where} (open the .eml or .html there), not sent.`);
    out('set LAMPO_SMTP_URL and LAMPO_MAIL_FROM to send for real (docs/email.md).');
  } else out(`sent a test to ${address} through ${sent.where}, from ${sent.from}. Check the inbox (and the spam folder).`);
}
