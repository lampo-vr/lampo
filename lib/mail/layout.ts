// The one Lampo email: quiet and native, like a note from a tool you use. The app icon at the top (inline, cid:), a
// heading, a sentence or two, at most one button, the link written out under it, a small note, and a footer that says
// why this arrived. Light by default with a dark set for clients that honour prefers-color-scheme (Apple Mail,
// Outlook's apps); every text colour passes AAA (7:1) on its ground in both. No remote images, no fonts to load, no
// tracking: nothing in it calls home. The plain-text part says the same, the link on its own line.
import { BRAND_NAME } from '../brand.ts';
import { ICON_CID } from './index.ts';

export interface Block {
  /** What clients show beside the subject (hidden in the body). */
  preheader: string;
  title: string;
  /** Paragraphs before the button (plain text; escaped here). */
  body: string[];
  button?: { label: string; url: string };
  /** After the button: the small print (a link may follow it). */
  note?: string;
  noteLink?: string;
  /** The footer: why this arrived. */
  why: string;
  /** "Lampo · review.example.com". */
  sign: string;
  /** "Or open this link:" in the message's language. */
  paste: string;
  lang: string;
}

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Colours (WCAG on their ground): ink 17.2, muted 7.6 on white; ivory 14.9, muted 8.2 on the dark ground.
const C = {
  page: '#ffffff',
  ink: '#1c1b19',
  muted: '#57534c',
  rule: '#e6e2d9',
  button: '#1c1b19',
  buttonInk: '#ffffff',
  darkPage: '#161513',
  darkInk: '#ece8df',
  darkMuted: '#b3ada2',
  darkRule: '#2e2b27',
};
const SANS = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif";
const MONO = "ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace";

const STYLE = `:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0;-webkit-text-size-adjust:100%}
a{color:inherit}
@media (prefers-color-scheme:dark){
.m-page{background:${C.darkPage}!important}
.m-ink{color:${C.darkInk}!important}
.m-muted,.m-muted a{color:${C.darkMuted}!important}
.m-rule{border-color:${C.darkRule}!important}
.m-btn{background:${C.darkInk}!important}
.m-btn a{color:${C.ink}!important}
}
[data-ogsc] .m-ink{color:${C.darkInk}!important}
[data-ogsc] .m-muted,[data-ogsc] .m-muted a{color:${C.darkMuted}!important}
[data-ogsb] .m-btn{background:${C.darkInk}!important}
[data-ogsc] .m-btn a{color:${C.ink}!important}`;

export function html(b: Block): string {
  const p = (text: string, cls: string, style: string) => `<p class="${cls}" style="margin:0 0 16px;${style}">${esc(text)}</p>`;
  const body = b.body.map((t) => p(t, 'm-ink', `font:400 15px/1.6 ${SANS};color:${C.ink};`)).join('\n');
  const button = b.button
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:8px 0 24px;border-collapse:separate;"><tr>
<td class="m-btn" style="border-radius:8px;background:${C.button};"><a href="${esc(b.button.url)}" style="display:inline-block;padding:12px 20px;font:600 15px/1.2 ${SANS};color:${C.buttonInk};text-decoration:none;border-radius:8px;">${esc(b.button.label)}</a></td>
</tr></table>
<p class="m-muted" style="margin:0 0 4px;font:400 13px/1.5 ${SANS};color:${C.muted};">${esc(b.paste)}</p>
<p class="m-muted" style="margin:0 0 24px;font:400 13px/1.5 ${MONO};color:${C.muted};word-break:break-all;"><a href="${esc(b.button.url)}" style="color:${C.muted};">${esc(b.button.url)}</a></p>`
    : '';
  const noteLink = b.noteLink ? ` <a href="${esc(b.noteLink)}" style="color:${C.muted};word-break:break-all;">${esc(b.noteLink)}</a>` : '';
  const note = b.note ? `<p class="m-muted" style="margin:0 0 8px;font:400 13px/1.6 ${SANS};color:${C.muted};">${esc(b.note)}${noteLink}</p>` : '';
  return `<!doctype html>
<html lang="${esc(b.lang)}" dir="ltr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
<meta name="x-apple-disable-message-reformatting">
<title>${esc(b.title)}</title>
<style>${STYLE}</style>
</head>
<body class="m-page" style="margin:0;padding:0;background:${C.page};">
<div style="display:none;max-height:0;overflow:hidden;mso-hide:all;">${esc(b.preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="m-page" style="background:${C.page};">
<tr><td align="center" style="padding:40px 20px 32px;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:480px;">
<tr><td style="padding:0 0 28px;"><img src="cid:${ICON_CID}" width="32" height="32" alt="${BRAND_NAME}" style="display:block;border:0;width:32px;height:32px;border-radius:7px;"></td></tr>
<tr><td>
<h1 class="m-ink" style="margin:0 0 16px;font:600 22px/1.3 ${SANS};color:${C.ink};letter-spacing:-0.01em;">${esc(b.title)}</h1>
${body}
${button}
${note}
<div style="height:16px;line-height:16px;font-size:0;">&nbsp;</div>
</td></tr>
<tr><td class="m-rule" style="padding:0;border-top:1px solid ${C.rule};">
<p class="m-muted" style="margin:24px 0 4px;font:400 12px/1.6 ${SANS};color:${C.muted};">${esc(b.why)}</p>
<p class="m-muted" style="margin:0;font:400 12px/1.6 ${SANS};color:${C.muted};">${esc(b.sign)}</p>
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>
`;
}

/** The plain-text part: the same words, each link on its own line, wrapped by the reader's client. */
export function text(b: Block): string {
  const out = [b.title, '', ...b.body.flatMap((t) => [t, ''])];
  if (b.button) out.push(`${b.button.label}:`, b.button.url, '');
  if (b.note) out.push(b.note, ...(b.noteLink ? [b.noteLink] : []), '');
  out.push('--', b.why, b.sign, '');
  return out.join('\n');
}
