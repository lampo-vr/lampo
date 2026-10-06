// The emails accounts get, in one place: which message, in which language, to which address, with which link. The
// routes call these and go on (the mailer queues; nothing here waits for a relay).
// Rules:
// - links are made only when this server has a public URL (`enabled`); without one nothing is sent;
// - an address nobody confirmed gets only what confirms it (verify, reset): notices, the welcome and sign-in alerts go
//   to confirmed addresses only, so a typo'd address never gets someone else's account news;
// - the language is the account's choice (prefs.lang), else the one the person was using when they asked (`lang`).
import crypto from 'node:crypto';
import { issueLink, type LinkKind } from '../lib/accountLinks.ts';
import { getUser } from '../lib/auth.ts';
import type { Config } from '../lib/config.ts';
import type { Mailer } from '../lib/mail/index.ts';
import { type MailParams, type MailSite, mailLinks, renderMail, siteOf } from '../lib/mail/templates.ts';
import { type MailLang, mailLang } from '../lib/mail/words.ts';
import { DEFAULT_WORKSPACE } from '../lib/scope.ts';
import type { PublicInvite, PublicUser, Role } from '../lib/types.ts';
import { getWorkspace, listWorkspaces, membersOf, workspaceNamed } from '../lib/workspaces.ts';

type Person = Pick<PublicUser, 'id' | 'email' | 'name' | 'prefs' | 'unverified'>;

export interface AccountMail {
  /** Links can be built (a public URL): the email flows are available. */
  enabled: boolean;
  site: MailSite | null;
  /** The account's language, else the one asked in. */
  langOf(u: Person | null | undefined, asked?: string | null): MailLang;
  /**
   * A confirm link to `email` (the account's own address, or a pending new one); false when nothing was sent. `asker`:
   * the address that asked for it signed out (lib/mail MailMessage.asker: one at a time waits per asker).
   */
  verify(u: Person, email: string, lang: MailLang, opts?: { invited?: boolean; asker?: string }): boolean;
  reset(u: Person, lang: MailLang, opts?: { asker?: string }): boolean;
  /**
   * What depends on whether an address has an account (a link issued, a message queued), run a random 100–500 ms after
   * the answer that is the same either way: never right after it, where a request sent next would feel it (A12
   * INV-REV-8). `what` names it in the log when it fails.
   */
  afterwards(what: string, work: () => void): void;
  passwordChanged(u: Person): void;
  /** To the address the account had before, when that one was confirmed. */
  emailChanged(previous: string, u: Person, previousConfirmed: boolean): void;
  /** False when not sent: no address, over the recipient's limit, or the workspace's share of the hour is used up. */
  invite(invite: PublicInvite, token: string, lang: MailLang, sender?: string): boolean;
  /** Seconds until `workspace` may email invites again; 0 while its share of the hour has room. */
  workspaceWait(workspace: string): number;
  /** Seconds until `account` may cause mail again (invites, address changes), across its workspaces; 0 while it may. */
  accountWait(account: string): number;
  welcome(u: Person): void;
  newSignIn(u: Person, device: string): void;
  removed(u: Person): void;
  disabled(u: Person): void;
  /** The person deleted their own account: the last message to their (confirmed) address. */
  deleted(u: Person): void;
  /** The server's operator suspended a workspace (`on`), or lifted it: every active member with a confirmed address. */
  workspaceSuspended(ws: string, on: boolean): number;
  /**
   * A workspace was deleted: its people as they were (their accounts may be gone), each told whether theirs went too.
   * `actor`: the owner who deleted it (told that they did).
   */
  workspaceDeleted(name: string, by: 'operator' | 'owner', people: { user: Person; accountGone: boolean }[], actor?: string): number;
  /** Someone tried to sign up with the address of an existing account: its owner hears, the asker doesn't. */
  signupExists(u: Person, lang: MailLang): void;
  /**
   * A module's message about a workspace (server/extension.ts `mail`) to its people in `roles` (owners and admins by
   * default): confirmed addresses only, never a suspended member or a disabled account, each in their language (else
   * the English words). How many were queued.
   */
  workspaceNotice(m: NoticeMail): number;
}

/** What server/extension.ts hands over (its WorkspaceMail, checked there: a known workspace, English words, an app link). */
export interface NoticeMail {
  workspace: string;
  roles?: Role[];
  text: Record<string, { subject: string; title: string; body: string[]; button?: string; note?: string }>;
  link?: string;
}

export function createAccountMail(cfg: Config, mailer: Mailer): AccountMail {
  const site = cfg.public_url ? siteOf(cfg.public_url, cfg.org_name ?? null) : null;
  const links = site ? mailLinks(site) : null;
  const langOf = (u: Person | null | undefined, asked?: string | null) => mailLang(u?.prefs?.lang === 'de' || u?.prefs?.lang === 'en' ? u.prefs.lang : asked);
  /**
   * `workspace` / `account`: whose share of the hour it counts against (lib/mail: invites, address changes); `from`: the
   * site as this message names it (an invite into another team's workspace without the server's team name).
   */
  const send = (
    to: string,
    p: MailParams,
    lang: MailLang,
    expires?: number,
    workspace?: string,
    account?: string,
    from?: MailSite,
    asker?: string,
  ): boolean => {
    if (!site) return false;
    const r = renderMail(p, lang, from ?? site);
    return mailer.send({
      kind: r.kind,
      to,
      lang,
      subject: r.subject,
      text: r.text,
      html: r.html,
      ...(expires ? { expires } : {}),
      ...(workspace ? { workspace } : {}),
      ...(account ? { account } : {}),
      ...(asker ? { asker } : {}),
    });
  };
  /** Notices go to confirmed addresses only. */
  const notice = (u: Person, p: MailParams) => {
    if (!u.unverified) send(u.email, p, langOf(u));
  };
  const link = (kind: LinkKind, u: Person, email: string) => issueLink(kind, u.id, email);
  return {
    enabled: !!site,
    site,
    langOf,
    verify(u, email, lang, { invited, asker } = {}) {
      if (!links) return false;
      // one asked from there waits already: no newer link replaces the one mailed (lib/mail drops this message)
      if (asker && mailer.askerWaits('verify', asker)) return false;
      const { token, expires } = link('verify', u, email);
      const change = email !== u.email;
      return send(
        email,
        change
          ? { kind: 'verify-change', name: u.name, email, url: links.verify(token) }
          : { kind: 'verify', name: u.name, email, url: links.verify(token), ...(invited ? { invited } : {}) },
        lang,
        expires,
        undefined,
        // a new address is the account's own doing: its share of the hour (a sign-up's confirmation is the urgent lane's)
        change ? u.id : undefined,
        undefined,
        asker,
      );
    },
    reset(u, lang, { asker } = {}) {
      if (!links) return false;
      if (asker && mailer.askerWaits('reset', asker)) return false;
      const { token, expires } = link('reset', u, u.email);
      return send(u.email, { kind: 'reset', name: u.name, url: links.reset(token) }, lang, expires, undefined, undefined, undefined, asker);
    },
    passwordChanged: (u) => notice(u, { kind: 'password-changed', name: u.name, when: new Date() }),
    emailChanged: (previous, u, previousConfirmed) => {
      if (previousConfirmed && previous !== u.email) send(previous, { kind: 'email-changed', name: u.name, email: u.email }, langOf(u));
    },
    invite(invite, token, lang, sender) {
      if (!links || !site || !invite.email) return false;
      const id = invite.workspace ?? DEFAULT_WORKSPACE;
      // On a server with several workspaces the invite names the one it joins (as the invite screen does) — once someone
      // named it: a sign-up's workspace starts out called after its owner, a person's name, not a team's (the inviter is
      // named anyway).
      const ws = listWorkspaces().length > 1 && workspaceNamed(id) ? getWorkspace(id)?.name : undefined;
      // The server's team name (VR_ORG_NAME) is workspace #1's: an invite into another workspace doesn't carry it.
      const from = id === DEFAULT_WORKSPACE ? site : { ...site, org: null };
      return send(
        invite.email,
        { kind: 'invite', by: invite.by, role: invite.role, url: links.invite(token), until: new Date(invite.expires), ...(ws ? { workspace: ws } : {}) },
        lang,
        Date.parse(invite.expires),
        // counted against the inviting workspace's share of the hour and the inviter's, across their workspaces
        id,
        sender,
        from,
      );
    },
    afterwards(what, work) {
      mailer.later(() => {
        try {
          work();
        } catch (e) {
          console.error(`mail: ${what} failed: ${(e as Error).message}`);
        }
      }, 100 + crypto.randomInt(400));
    },
    workspaceWait: (ws) => mailer.workspaceWait(ws),
    accountWait: (id) => mailer.accountWait(id),
    welcome: (u) => notice(u, { kind: 'welcome', name: u.name }),
    newSignIn: (u, device) => notice(u, { kind: 'new-sign-in', name: u.name, device, when: new Date() }),
    removed: (u) => notice(u, { kind: 'account-removed', name: u.name }),
    disabled: (u) => notice(u, { kind: 'account-disabled', name: u.name }),
    deleted: (u) => notice(u, { kind: 'account-deleted', name: u.name }),
    workspaceSuspended(ws, on) {
      if (!site) return 0;
      const name = getWorkspace(ws)?.name;
      if (!name) return 0;
      let queued = 0;
      for (const member of membersOf(ws)) {
        if (member.suspended) continue;
        const u = getUser(member.user);
        if (!u || u.disabled || u.unverified) continue;
        if (send(u.email, { kind: 'workspace-suspended', name: u.name, workspace: name, on }, langOf(u))) queued++;
      }
      return queued;
    },
    workspaceDeleted(name, by, people, actor) {
      if (!site) return 0;
      let queued = 0;
      for (const { user: u, accountGone } of people) {
        if (u.unverified) continue;
        const who = actor && u.id === actor ? 'you' : by;
        if (send(u.email, { kind: 'workspace-deleted', name: u.name, workspace: name, by: who, accountGone }, langOf(u))) queued++;
      }
      return queued;
    },
    signupExists(u, lang) {
      if (!u.unverified) send(u.email, { kind: 'signup-exists' }, langOf(u, lang));
    },
    workspaceNotice(m) {
      if (!site) return 0;
      const roles = new Set<Role>(m.roles ?? ['owner', 'admin']);
      // named once someone chose a name: a sign-up's workspace is called after its owner until then
      const name = workspaceNamed(m.workspace) ? getWorkspace(m.workspace)?.name : undefined;
      const url = m.link ? `${site.url}/${m.link}` : undefined;
      let queued = 0;
      for (const member of membersOf(m.workspace)) {
        if (!roles.has(member.role) || member.suspended) continue;
        const u = getUser(member.user);
        if (!u || u.disabled || u.unverified) continue;
        const lang = langOf(u);
        const words = m.text[lang] ?? m.text.en;
        if (!words) continue;
        const sent = send(u.email, { kind: 'notice', ...words, ...(url ? { url } : {}), ...(name ? { workspace: name } : {}) }, lang);
        if (sent) queued++;
      }
      return queued;
    },
  };
}

/** "Chrome on macOS" / "Chrome auf macOS" from a User-Agent; coarse on purpose (no versions, no address). */
export function describeDevice(ua: string | undefined, lang: MailLang): string {
  const s = ua || '';
  const browser = /Edg\//.test(s)
    ? 'Edge'
    : /OPR\//.test(s)
      ? 'Opera'
      : /Firefox\//.test(s)
        ? 'Firefox'
        : /Chrome\//.test(s)
          ? 'Chrome'
          : /Safari\//.test(s)
            ? 'Safari'
            : null;
  const os = /iPhone/.test(s)
    ? 'iPhone'
    : /iPad/.test(s)
      ? 'iPad'
      : /Android/.test(s)
        ? 'Android'
        : /CrOS/.test(s)
          ? 'ChromeOS'
          : /Mac OS X|Macintosh/.test(s)
            ? 'macOS'
            : /Windows/.test(s)
              ? 'Windows'
              : /Linux/.test(s)
                ? 'Linux'
                : null;
  if (!browser) return lang === 'de' ? 'ein unbekanntes Programm' : 'an unknown program';
  return os ? `${browser} ${lang === 'de' ? 'auf' : 'on'} ${os}` : browser;
}
