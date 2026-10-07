// Every email the server sends, rendered in the recipient's language (lib/mail/words.ts) into the one layout
// (lib/mail/layout.ts). Links are built from the public URL only, tokens in the fragment (#/verify/…, #/reset/…,
// #/invite/…): the page posts them, so they never reach a server log or a proxy's.
import { BRAND_NAME } from '../brand.ts';
import type { Role } from '../types.ts';
import type { MailKind } from './index.ts';
import { type Block, html, text } from './layout.ts';
import { type MailLang, type WordKey, word } from './words.ts';

export interface MailSite {
  /** The public URL, without a trailing slash. */
  url: string;
  /** Its host, as people read it. */
  host: string;
  /** The team's name (LAMPO_ORG_NAME), for an invite's subject. */
  org: string | null;
}

export const siteOf = (publicUrl: string, org: string | null = null): MailSite => {
  const url = publicUrl.replace(/\/+$/, '');
  return { url, host: new URL(url).host, org };
};

/** Where the app's screens live; the tokens ride in the fragment. */
export const mailLinks = (site: MailSite) => ({
  app: `${site.url}/`,
  forgot: `${site.url}/#/forgot`,
  verify: (token: string) => `${site.url}/#/verify/${token}`,
  reset: (token: string) => `${site.url}/#/reset/${token}`,
  invite: (token: string) => `${site.url}/#/invite/${token}`,
});

export type MailParams =
  | { kind: 'verify'; name: string; email: string; url: string; invited?: boolean }
  | { kind: 'verify-change'; name: string; email: string; url: string }
  | { kind: 'email-changed'; name: string; email: string }
  | { kind: 'reset'; name: string; url: string }
  | { kind: 'password-changed'; name: string; when: Date }
  /** `workspace`: its name, on a server with several (it stands where the team's name or the host would). */
  | { kind: 'invite'; by: string; role: Role; url: string; until: Date; workspace?: string }
  | { kind: 'welcome'; name: string }
  | { kind: 'new-sign-in'; name: string; device: string; when: Date }
  | { kind: 'account-removed'; name: string }
  | { kind: 'account-disabled'; name: string }
  /** The person deleted their own account (the last message to the address). */
  | { kind: 'account-deleted'; name: string }
  /** The server's operator suspended a workspace, or lifted it (`on: false`). */
  | { kind: 'workspace-suspended'; name: string; workspace: string; on: boolean }
  /** A workspace was deleted (by the operator or its owner); `accountGone`: the person's account went with it. */
  | { kind: 'workspace-deleted'; name: string; workspace: string; by: 'operator' | 'owner' | 'you'; accountGone: boolean }
  | { kind: 'signup-exists' }
  | { kind: 'test'; when: Date }
  /**
   * A module's message about a workspace (server/extension.ts `mail`): its words in the recipient's language, our frame
   * and footer. `url` is a screen of this app; `workspace` its name once someone named it.
   */
  | { kind: 'notice'; subject: string; title: string; body: string[]; button?: string; url?: string; note?: string; workspace?: string };

export interface Rendered {
  kind: MailKind;
  lang: MailLang;
  subject: string;
  text: string;
  html: string;
}

/** "2 October 2026, 09:30 UTC" / "2. Oktober 2026, 09:30 UTC": the recipient's time zone is unknown, so say which. */
export function when(d: Date, lang: MailLang): string {
  const f = new Intl.DateTimeFormat(lang === 'de' ? 'de-DE' : 'en-GB', {
    timeZone: 'UTC',
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return `${f.format(d).replace(' um ', ', ').replace(' at ', ', ')} UTC`;
}

export function renderMail(p: MailParams, lang: MailLang, site: MailSite): Rendered {
  const base = { brand: BRAND_NAME, host: site.host, url: site.url };
  const w = (k: WordKey, vars: Record<string, string | number> = {}) => word(k, lang, { ...base, ...vars });
  const links = mailLinks(site);
  const frame = (b: Omit<Block, 'sign' | 'paste' | 'lang' | 'preheader'> & { preheader?: string }): Block => ({
    preheader: b.preheader ?? b.body.at(-1) ?? b.title,
    ...b,
    sign: w('footer.brand'),
    paste: w('link.paste'),
    lang,
  });
  // A greeting by the first name, as people write to each other ("Hi Mia,"), not the whole display name.
  const first = (name: string) => name.trim().split(/\s+/)[0] || name;
  const hi = (name: string) => w('hi', { name: first(name) });
  let subject: string;
  let block: Block;
  switch (p.kind) {
    case 'verify':
      subject = w('verify.subject');
      block = frame({
        title: w('verify.title'),
        body: [hi(p.name), w(p.invited ? 'verify.invited' : 'verify.body', { email: p.email })],
        button: { label: w('verify.button'), url: p.url },
        note: w(p.invited ? 'verify.note.invited' : 'verify.note'),
        why: w(p.invited ? 'footer.account' : 'footer.signup'),
      });
      break;
    case 'verify-change':
      subject = w('change.subject');
      block = frame({
        title: w('change.title'),
        body: [hi(p.name), w('change.body', { email: p.email })],
        button: { label: w('change.button'), url: p.url },
        note: w('change.note'),
        why: w('footer.change'),
      });
      break;
    case 'email-changed':
      subject = w('changed.subject');
      block = frame({
        title: w('changed.title'),
        body: [hi(p.name), w('changed.body', { email: p.email })],
        note: w('changed.note'),
        why: w('footer.account'),
      });
      break;
    case 'reset':
      subject = w('reset.subject');
      block = frame({
        title: w('reset.title'),
        body: [hi(p.name), w('reset.body')],
        button: { label: w('reset.button'), url: p.url },
        note: w('reset.note'),
        why: w('footer.account'),
      });
      break;
    case 'password-changed':
      subject = w('pwchanged.subject');
      block = frame({
        title: w('pwchanged.title'),
        body: [hi(p.name), w('pwchanged.body', { when: when(p.when, lang) })],
        note: w('pwchanged.note'),
        noteLink: links.forgot,
        why: w('footer.account'),
      });
      break;
    case 'invite': {
      // Fixed words: the subject and the sentences are the server's (the team's name from the config may stand in the
      // subject: the operator chose it). The inviter's and the workspace's names, which anyone who runs a workspace
      // types, are quoted in a line of their own.
      subject = site.org ? w('invite.subject.org', { org: site.org }) : w('invite.subject');
      const body = w(`invite.body.${p.role}` as WordKey);
      block = frame({
        preheader: body,
        title: w('invite.title'),
        body: [body, p.workspace ? w('invite.from.workspace', { by: p.by, workspace: p.workspace }) : w('invite.from', { by: p.by })],
        button: { label: w('invite.button'), url: p.url },
        note: w('invite.note', { until: when(p.until, lang) }),
        why: w('footer.invite'),
      });
      break;
    }
    case 'welcome':
      subject = w('welcome.subject');
      block = frame({
        title: w('welcome.title', { name: first(p.name) }),
        body: [w('welcome.body')],
        button: { label: w('welcome.button'), url: links.app },
        note: w('welcome.note'),
        why: w('footer.account'),
      });
      break;
    case 'new-sign-in':
      subject = w('signin.subject');
      block = frame({
        title: w('signin.title'),
        body: [hi(p.name), w('signin.body', { device: p.device, when: when(p.when, lang) })],
        note: w('signin.note'),
        noteLink: links.forgot,
        why: w('signin.why'),
      });
      break;
    case 'account-removed':
      subject = w('removed.subject');
      block = frame({ title: w('removed.title'), body: [hi(p.name), w('removed.body')], note: w('admin.note'), why: w('footer.account') });
      break;
    case 'account-disabled':
      subject = w('disabled.subject');
      block = frame({ title: w('disabled.title'), body: [hi(p.name), w('disabled.body')], note: w('admin.note'), why: w('footer.account') });
      break;
    case 'account-deleted':
      subject = w('deleted.subject');
      block = frame({ title: w('deleted.title'), body: [hi(p.name), w('deleted.body')], note: w('deleted.note'), why: w('footer.account') });
      break;
    case 'workspace-suspended':
      subject = w(p.on ? 'suspended.subject' : 'restored.subject', { workspace: p.workspace });
      block = frame({
        title: w(p.on ? 'suspended.title' : 'restored.title'),
        body: [hi(p.name), w(p.on ? 'suspended.body' : 'restored.body', { workspace: p.workspace })],
        ...(p.on ? { note: w('admin.note') } : { button: { label: w('restored.button'), url: links.app } }),
        why: w('footer.workspace', { workspace: p.workspace }),
      });
      break;
    case 'workspace-deleted':
      subject = w('wsdeleted.subject', { workspace: p.workspace });
      block = frame({
        title: w('wsdeleted.title'),
        body: [
          hi(p.name),
          w(p.by === 'operator' ? 'wsdeleted.body.operator' : p.by === 'you' ? 'wsdeleted.body.you' : 'wsdeleted.body.owner', { workspace: p.workspace }),
          w(p.accountGone ? 'wsdeleted.account' : 'wsdeleted.stays'),
        ],
        note: w('admin.note'),
        why: w('footer.workspace.was', { workspace: p.workspace }),
      });
      break;
    case 'signup-exists':
      subject = w('exists.subject');
      block = frame({
        title: w('exists.title'),
        body: [w('exists.body')],
        button: { label: w('exists.button'), url: links.app },
        note: w('exists.note'),
        noteLink: links.forgot,
        why: w('footer.signup'),
      });
      break;
    case 'notice':
      // one line, whatever the module wrote (a header can't be split by its words)
      subject = p.subject.replace(/\s+/g, ' ').trim();
      block = frame({
        title: p.title,
        body: p.body,
        ...(p.button && p.url ? { button: { label: p.button, url: p.url } } : {}),
        ...(p.note ? { note: p.note } : {}),
        why: p.workspace ? w('footer.workspace', { workspace: p.workspace }) : w('footer.workspace.own'),
      });
      break;
    case 'test':
      subject = w('test.subject');
      block = frame({ title: w('test.title'), body: [w('test.body')], note: w('test.note', { when: when(p.when, lang) }), why: w('footer.test') });
      break;
  }
  return { kind: p.kind, lang, subject, text: text(block), html: html(block) };
}
