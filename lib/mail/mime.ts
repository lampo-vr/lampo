// One email as it travels (RFC 5322 + MIME): plain text and HTML as alternatives, the HTML with its inline pictures
// (`cid:` references, never a remote image). Bodies are quoted-printable and headers ASCII (RFC 2047 encoded words for
// anything else), so the message is 7-bit clean and passes any relay unchanged.
import crypto from 'node:crypto';
import { domainToASCII } from 'node:url';

export interface Address {
  name: string | null;
  address: string;
}

export interface Inline {
  /** Referenced from the HTML as `cid:<cid>`. */
  cid: string;
  type: string;
  name: string;
  data: Buffer;
}

export interface Draft {
  from: Address;
  to: string;
  replyTo?: Address | null;
  subject: string;
  text: string;
  html: string;
  /** BCP 47 language of the body (Content-Language). */
  lang: string;
  inline?: Inline[];
  /** The host part of the Message-ID: the server's public host. */
  host: string;
  date?: Date;
}

export interface Composed {
  raw: string;
  messageId: string;
  /** The headers as written (decoded values), for the log transport. */
  headers: Record<string, string>;
}

const CRLF = '\r\n';

/** Header values never carry a line break or a control character: a name can't inject a header. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
const oneLine = (v: string) => v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();

/** What an address may hold: no spaces, brackets, quotes, commas, colons or line breaks, one @. */
const ADDRESS_SHAPE = /^[^\s<>()[\]\\,;:"@]+@[^\s<>()[\]\\,;:"@]+$/;

/** An address part we accept: no spaces, brackets or line breaks, one @. */
export function checkAddress(address: string): string {
  const a = address.trim();
  if (!ADDRESS_SHAPE.test(a) || a.length > 254) throw new Error(`not an email address: ${a.slice(0, 40)}`);
  return a;
}

// RFC 5321's dot-atom in lower case, and a DNS label in its ASCII form.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*$/;
const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;

/**
 * The one spelling of an address an account may have, or null when what was typed is none (A12 INV-REV-9). NFKC and
 * lower case (full-width letters, the Kelvin sign: the same letters, the same account); nothing invisible; a plain
 * ASCII local part — the mailer speaks no SMTPUTF8, and a letter from another script that looks like ours would be
 * another account —; the domain in its ASCII (IDNA) form without a trailing dot; and inside checkAddress's rule, so
 * every account's address is one the mailer sends to.
 */
export function accountAddress(typed: string): string | null {
  const s = typed.trim().normalize('NFKC').toLowerCase();
  if (/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(s)) return null;
  const at = s.indexOf('@');
  if (at < 1 || s.lastIndexOf('@') !== at) return null;
  const local = s.slice(0, at);
  const domain = domainToASCII(s.slice(at + 1).replace(/\.$/, ''));
  if (local.length > 64 || !LOCAL_PART.test(local) || !domain || !domain.split('.').every((l) => LABEL.test(l))) return null;
  const a = `${local}@${domain}`;
  return a.length <= 254 && ADDRESS_SHAPE.test(a) ? a : null;
}

/** "Lampo <hello@example.com>" or "hello@example.com" → {name, address}. */
export function parseAddress(value: string): Address {
  const m = /^\s*(?:"?([^"<]*?)"?\s*)?<([^<>]+)>\s*$/.exec(value);
  if (m) return { name: oneLine(m[1] || '') || null, address: checkAddress(m[2] as string) };
  return { name: null, address: checkAddress(value) };
}

const ascii = (s: string) => /^[\x20-\x7e]*$/.test(s);

/** RFC 2047 encoded words (UTF-8, base64), each at most 60 characters (a header line stays under 78 with its name),
 * never splitting a character. */
export function encodeWords(s: string): string {
  const words: string[] = [];
  let chunk = '';
  for (const ch of s) {
    if (Buffer.byteLength(chunk + ch) > 36) {
      words.push(chunk);
      chunk = '';
    }
    chunk += ch;
  }
  if (chunk) words.push(chunk);
  return words.map((w) => `=?UTF-8?B?${Buffer.from(w).toString('base64')}?=`).join(`${CRLF} `);
}

/** An unstructured header value (Subject): as is when it is plain ASCII, else encoded words. */
export function headerText(value: string): string {
  const v = oneLine(value);
  return ascii(v) && v.length <= 900 ? v : encodeWords(v);
}

/** An address for From / To / Reply-To, its name quoted or encoded. */
export function formatAddress({ name, address }: Address): string {
  const a = checkAddress(address);
  const n = name ? oneLine(name) : '';
  if (!n) return a;
  if (!ascii(n)) return `${encodeWords(n)}${CRLF} <${a}>`;
  return /^[\w !#$%&'*+\-/=?^`{|}~]+$/.test(n) ? `${n} <${a}>` : `"${n.replace(/["\\]/g, '\\$&')}" <${a}>`;
}

/**
 * Quoted-printable (RFC 2045): printable ASCII as is, everything else as =XX, lines at most 76 characters with soft
 * breaks, line ends as CRLF, and a space or tab at a line's end encoded so no relay strips it.
 */
export function quotedPrintable(text: string): string {
  const out: string[] = [];
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bytes = Buffer.from(line, 'utf8');
    let cur = '';
    for (let i = 0; i < bytes.length; i++) {
      const b = bytes[i] as number;
      const last = i === bytes.length - 1;
      const plain = (b >= 33 && b <= 126 && b !== 61) || ((b === 32 || b === 9) && !last);
      const token = plain ? String.fromCharCode(b) : `=${b.toString(16).toUpperCase().padStart(2, '0')}`;
      if (cur.length + token.length > 75) {
        out.push(`${cur}=`);
        cur = '';
      }
      cur += token;
    }
    out.push(cur);
  }
  return out.join(CRLF);
}

const base64Lines = (data: Buffer) => (data.toString('base64').match(/.{1,76}/g) || []).join(CRLF);
const boundary = () => `=_lampo_${crypto.randomBytes(12).toString('hex')}`;

/** RFC 5322 date: "Fri, 02 Oct 2026 09:30:00 +0000". */
export const mailDate = (d: Date) => d.toUTCString().replace(/GMT$/, '+0000');

export function compose(d: Draft): Composed {
  const messageId = `<${crypto.randomBytes(12).toString('hex')}@${d.host.replace(/[^\w.-]/g, '') || 'localhost'}>`;
  const readable = (a: Address) => (a.name ? `${oneLine(a.name)} <${checkAddress(a.address)}>` : checkAddress(a.address));
  const headers: Record<string, string> = {
    From: readable(d.from),
    To: checkAddress(d.to),
    ...(d.replyTo ? { 'Reply-To': readable(d.replyTo) } : {}),
    Subject: oneLine(d.subject),
    Date: mailDate(d.date ?? new Date()),
    'Message-ID': messageId,
    'MIME-Version': '1.0',
    'Content-Language': d.lang,
    // Machine-sent (RFC 3834): no out-of-office replies back to the sender.
    'Auto-Submitted': 'auto-generated',
    'X-Auto-Response-Suppress': 'All',
  };
  const alt = boundary();
  const lines: string[] = [];
  const encoded: Record<string, string> = { From: formatAddress(d.from), Subject: headerText(headers.Subject as string) };
  if (d.replyTo) encoded['Reply-To'] = formatAddress(d.replyTo);
  for (const [k, v] of Object.entries(headers)) lines.push(`${k}: ${encoded[k] ?? v}`);
  lines.push(`Content-Type: multipart/alternative;${CRLF} boundary="${alt}"`, '', 'This is a message in MIME format.', '');
  lines.push(`--${alt}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(d.text));
  const inline = d.inline ?? [];
  // The CRLF before each boundary belongs to the boundary (RFC 2046): a part ends right before it.
  const htmlPart = ['Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: quoted-printable', '', quotedPrintable(d.html)];
  if (inline.length) {
    const rel = boundary();
    lines.push(`--${alt}`, `Content-Type: multipart/related;${CRLF} boundary="${rel}"`, '', `--${rel}`, ...htmlPart);
    for (const img of inline) {
      lines.push(
        `--${rel}`,
        `Content-Type: ${img.type}`,
        'Content-Transfer-Encoding: base64',
        `Content-ID: <${img.cid}>`,
        `Content-Disposition: inline; filename="${img.name.replace(/[^\w.-]/g, '')}"`,
        '',
        base64Lines(img.data),
      );
    }
    lines.push(`--${rel}--`);
  } else {
    lines.push(`--${alt}`, ...htmlPart);
  }
  lines.push(`--${alt}--`, '');
  return { raw: lines.join(CRLF), messageId, headers };
}
