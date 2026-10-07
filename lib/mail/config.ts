// How this server sends email, and who may sign up. Environment first, then config.json:
//   LAMPO_SMTP_URL / mail.smtp_url     smtp://user:pass@host:587 (STARTTLS) or smtps://…:465 — without it, the log transport
//   LAMPO_MAIL_FROM / mail.from        "Lampo <hello@review.example.com>", the sender people see (required with SMTP)
//   LAMPO_MAIL_REPLY_TO / mail.reply_to where replies go (optional)
//   LAMPO_MAIL_PER_HOUR / mail.per_hour the server's own cap on messages an hour (default 200)
//   LAMPO_MAIL_PER_WORKSPACE_HOUR / mail.per_workspace_hour  what one workspace's people may send an hour (invites):
//                                    its own share, so one team can't use up the server's (default a quarter of it)
//   LAMPO_SIGNUP / signup              off (default) · invite · open (needs both of the next two)
//   LAMPO_TERMS_URL, LAMPO_PRIVACY_URL     the operator's terms and privacy policy: linked from the sign-up screen and the
//                                    checkout (the other legal links: lib/legal.ts)
// The log transport writes every message to <cache>/outbox/ instead of sending it: the default, and what tests use.

import { settingsIn } from '../env.ts';
import { httpUrl } from '../legal.ts';
import type { ConfigFile } from '../paths.ts';
import { type Address, parseAddress } from './mime.ts';
import { parseSmtpUrl } from './smtp.ts';

export type SignupMode = 'off' | 'invite' | 'open';
export const SIGNUP_MODES: readonly SignupMode[] = ['off', 'invite', 'open'];

export interface MailConfig {
  transport: 'log' | 'smtp';
  /** Holds the relay's credentials: never logged, never sent to a client. */
  smtp_url: string | null;
  from: string | null;
  reply_to: string | null;
  per_hour: number;
  /** One workspace's share of `per_hour` (what its admins' invites may use); absent: a quarter of it. */
  per_workspace_hour?: number;
}

export interface MailFileConfig {
  smtp_url?: string;
  from?: string;
  reply_to?: string;
  per_hour?: number;
  per_workspace_hour?: number;
}

/** One workspace's share of the server's hourly budget: what is set, at most the whole, by default a quarter. */
export const workspaceShare = (c: Pick<MailConfig, 'per_hour' | 'per_workspace_hour'>): number =>
  Math.max(1, Math.min(c.per_hour, Math.floor(c.per_workspace_hour ?? c.per_hour / 4)));

export const DEFAULT_PER_HOUR = 200;

export function mailConfig(file: ConfigFile & { mail?: MailFileConfig }, env: NodeJS.ProcessEnv): MailConfig {
  const s = settingsIn(env);
  const m = file.mail ?? {};
  const smtp = s.LAMPO_SMTP_URL?.trim() || m.smtp_url?.trim() || null;
  const perHour = Number(s.LAMPO_MAIL_PER_HOUR || m.per_hour || DEFAULT_PER_HOUR);
  const perWorkspace = Number(s.LAMPO_MAIL_PER_WORKSPACE_HOUR || m.per_workspace_hour || 0);
  return {
    transport: smtp ? 'smtp' : 'log',
    smtp_url: smtp,
    from: s.LAMPO_MAIL_FROM?.trim() || m.from?.trim() || null,
    reply_to: s.LAMPO_MAIL_REPLY_TO?.trim() || m.reply_to?.trim() || null,
    per_hour: Number.isFinite(perHour) && perHour > 0 ? Math.floor(perHour) : DEFAULT_PER_HOUR,
    ...(Number.isFinite(perWorkspace) && perWorkspace > 0 ? { per_workspace_hour: Math.floor(perWorkspace) } : {}),
  };
}

/** The sender: the configured one, else the brand at this server's host (fine for the log transport). */
export function senderOf(mail: MailConfig, host: string): Address {
  if (mail.from) return parseAddress(mail.from);
  return { name: 'Lampo', address: `lampo@${host.replace(/:\d+$/, '') || 'localhost'}` };
}

export interface SignupSettings {
  signup: SignupMode;
  terms_url: string | null;
  privacy_url: string | null;
}

export function signupConfig(file: ConfigFile & { signup?: string; terms_url?: string; privacy_url?: string }, env: NodeJS.ProcessEnv) {
  const s = settingsIn(env);
  const raw = (s.LAMPO_SIGNUP || file.signup || 'off').trim().toLowerCase();
  return {
    signup: raw as SignupMode,
    terms_url: s.LAMPO_TERMS_URL?.trim() || file.terms_url?.trim() || null,
    privacy_url: s.LAMPO_PRIVACY_URL?.trim() || file.privacy_url?.trim() || null,
  };
}

export interface MailProblemInput extends SignupSettings {
  mail: MailConfig;
  mode: 'local' | 'server';
  public_url: string | null;
}

/**
 * Settings the server must not start with, each as one sentence. `signupSeam`: something creates a workspace for each
 * person who signs up (the onSignup seam is filled); without it an open sign-up would put strangers into this store.
 */
export function mailProblems(c: MailProblemInput, { signupSeam = false }: { signupSeam?: boolean } = {}): string[] {
  const out: string[] = [];
  if (c.mail.smtp_url) {
    try {
      parseSmtpUrl(c.mail.smtp_url);
    } catch (e) {
      out.push((e as Error).message);
    }
    if (!c.mail.from) out.push('LAMPO_SMTP_URL needs LAMPO_MAIL_FROM, the sender people see, e.g. LAMPO_MAIL_FROM="Lampo <hello@review.example.com>".');
  }
  for (const [name, value] of [
    ['LAMPO_MAIL_FROM', c.mail.from],
    ['LAMPO_MAIL_REPLY_TO', c.mail.reply_to],
  ] as const) {
    if (!value) continue;
    try {
      parseAddress(value);
    } catch {
      out.push(`${name} is not an email address: write it as "Name <address@example.com>" or address@example.com.`);
    }
  }
  if (!SIGNUP_MODES.includes(c.signup)) out.push(`LAMPO_SIGNUP must be off, invite or open (got "${c.signup}").`);
  else if (c.signup !== 'off' && !c.public_url)
    out.push(`LAMPO_SIGNUP=${c.signup} needs LAMPO_PUBLIC_URL: sign-up confirms each address with an emailed link, and links are built from it.`);
  // Open sign-up gives each person a workspace of their own (server/signup.ts): only a hosted server has workspaces.
  else if (c.signup === 'open' && (c.mode !== 'server' || !signupSeam))
    out.push(
      c.mode === 'server'
        ? 'LAMPO_SIGNUP=open needs workspaces: everyone who signs up gets a workspace of their own, and this server has none yet, so they would join the existing team. Until workspaces exist, use LAMPO_SIGNUP=invite (the people you invited sign up themselves) or off.'
        : 'LAMPO_SIGNUP=open is for a hosted server with workspaces (LAMPO_MODE=server): on your own machine everyone who signs up would join your own store. Use LAMPO_SIGNUP=invite or off.',
    );
  for (const [name, value] of [
    ['LAMPO_TERMS_URL', c.terms_url],
    ['LAMPO_PRIVACY_URL', c.privacy_url],
  ] as const)
    if (value && !httpUrl(value)) out.push(`${name} must be an http(s) URL.`);
  // Strangers who sign up agree to terms and are told what happens to their data before they have an account (A13 CLOUD-1).
  const missing = [!c.terms_url && 'LAMPO_TERMS_URL', !c.privacy_url && 'LAMPO_PRIVACY_URL'].filter((x): x is string => !!x);
  if (c.signup === 'open' && missing.length)
    out.push(
      `LAMPO_SIGNUP=open needs ${missing.join(' and ')}: everyone who signs up accepts your terms and is told how their data is used, so link your own pages first.`,
    );
  return out;
}
