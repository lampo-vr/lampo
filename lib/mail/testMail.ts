// One test message through the server's own mail settings, delivered now (not queued), so a wrong password or a blocked
// port shows at once: `lampo admin mail-test <to>` and the server setup's health check (POST /api/server/mail-test) both
// send it. The log transport writes it to the outbox instead.
import path from 'node:path';
import { CACHE } from '../paths.ts';
import { type MailConfig, senderOf } from './config.ts';
import { iconInline, logTransport, smtpTransport } from './index.ts';
import { compose } from './mime.ts';
import { describeTarget, parseSmtpUrl } from './smtp.ts';
import { renderMail, siteOf } from './templates.ts';
import type { MailLang } from './words.ts';

export interface TestMailSettings {
  mail: MailConfig;
  /** Links in the message and our name toward the relay (the public URL, else this machine). */
  site: string;
  org?: string | null;
}

/** Where mail goes, as it may be shown (never the relay's credentials): the relay's host and port, or null (outbox). */
export function relayOf(mail: MailConfig): string | null {
  if (mail.transport !== 'smtp' || !mail.smtp_url) return null;
  try {
    const t = parseSmtpUrl(mail.smtp_url);
    return `${t.host}:${t.port}`;
  } catch {
    return null;
  }
}

/** Sends the test to `to` now; resolves with how it left (`log`: written to `where`, the outbox). Throws when the relay
 * refused or couldn't be reached (the error names the relay, never its credentials). */
export async function sendTestMail(
  s: TestMailSettings,
  to: string,
  lang: MailLang,
  outbox = path.join(CACHE, 'outbox'),
): Promise<{ transport: 'log' | 'smtp'; where: string; from: string }> {
  const site = siteOf(s.site, s.org ?? null);
  const host = new URL(site.url).hostname;
  const r = renderMail({ kind: 'test', when: new Date() }, lang, site);
  const smtp = s.mail.transport === 'smtp' && s.mail.smtp_url ? s.mail.smtp_url : null;
  const transport = smtp ? smtpTransport(smtp, host) : logTransport(outbox);
  const from = senderOf(s.mail, host);
  const composed = compose({ from, to, subject: r.subject, text: r.text, html: r.html, lang, inline: iconInline(), host });
  await transport.deliver({ ...r, to, id: 'test', from, composed }).catch((e: Error) => {
    throw new Error(`not sent through ${smtp ? describeTarget(parseSmtpUrl(smtp)) : transport.where}: ${e.message}`);
  });
  return { transport: transport.kind, where: transport.where, from: composed.headers.From };
}
