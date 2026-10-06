// Every email in English and German: the rendered subject and text are snapshots (test/unit/snapshots/mail/, rewrite
// them with VR_UPDATE_SNAPSHOTS=1 and read the diff), and the HTML keeps the rules — links only to the public URL with
// the token in the fragment, no remote image or anything else that calls home, a dark set, every name escaped.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const { renderMail, siteOf, when } = await import('../../lib/mail/templates.ts');
const { WORDS } = await import('../../lib/mail/words.ts');
type Params = Parameters<typeof renderMail>[0];

const DIR = fileURLToPath(new URL('./snapshots/mail/', import.meta.url));
const UPDATE = process.env.VR_UPDATE_SNAPSHOTS === '1';
const site = siteOf('https://review.example.com', null);
const T = new Date('2026-10-02T09:30:00Z');
const URL_V = 'https://review.example.com/#/verify/vt_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';

// Real-shaped values: a long German name with an umlaut, a member's role, a real-looking address.
const INVITE = 'https://review.example.com/#/invite/inv_CCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const CASES: [string, Params][] = [
  ['verify', { kind: 'verify', name: 'Mia Keller', email: 'mia.keller@example.com', url: URL_V }],
  ['verify-invited', { kind: 'verify', name: 'Jürgen Müller-Lüdenscheidt', email: 'juergen@example.com', url: URL_V, invited: true }],
  ['verify-change', { kind: 'verify-change', name: 'Mia Keller', email: 'mia@studio.example', url: URL_V }],
  ['email-changed', { kind: 'email-changed', name: 'Mia Keller', email: 'mia@studio.example' }],
  ['reset', { kind: 'reset', name: 'Mia Keller', url: 'https://review.example.com/#/reset/rt_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' }],
  ['password-changed', { kind: 'password-changed', name: 'Mia Keller', when: T }],
  ['invite-reviewer', { kind: 'invite', by: 'Olivia Hart', role: 'reviewer', url: INVITE, until: T }],
  ['invite-member', { kind: 'invite', by: 'Olivia Hart', role: 'member', url: INVITE, until: T }],
  ['invite-admin', { kind: 'invite', by: 'Olivia Hart', role: 'admin', url: INVITE, until: T }],
  ['invite-owner', { kind: 'invite', by: 'Olivia Hart', role: 'owner', url: INVITE, until: T }],
  ['welcome', { kind: 'welcome', name: 'Mia Keller' }],
  ['new-sign-in', { kind: 'new-sign-in', name: 'Mia Keller', device: 'Safari on iPhone', when: T }],
  ['account-removed', { kind: 'account-removed', name: 'Mia Keller' }],
  ['account-disabled', { kind: 'account-disabled', name: 'Mia Keller' }],
  // a person's own deletion, and a workspace taken down (A13 PEOPLE-1, CLOUD-5)
  ['account-deleted', { kind: 'account-deleted', name: 'Mia Keller' }],
  ['workspace-suspended', { kind: 'workspace-suspended', name: 'Mia Keller', workspace: 'Nordlicht Studio', on: true }],
  ['workspace-restored', { kind: 'workspace-suspended', name: 'Mia Keller', workspace: 'Nordlicht Studio', on: false }],
  ['workspace-deleted-operator', { kind: 'workspace-deleted', name: 'Mia Keller', workspace: 'Nordlicht Studio', by: 'operator', accountGone: true }],
  ['workspace-deleted-owner', { kind: 'workspace-deleted', name: 'Mia Keller', workspace: 'Nordlicht Studio', by: 'owner', accountGone: false }],
  ['workspace-deleted-you', { kind: 'workspace-deleted', name: 'Mia Keller', workspace: 'Nordlicht Studio', by: 'you', accountGone: true }],
  ['signup-exists', { kind: 'signup-exists' }],
  ['test', { kind: 'test', when: T }],
  // a module's words (server/extension.ts mail) in our frame: the footer is ours, in the recipient's language
  [
    'notice',
    {
      kind: 'notice',
      subject: 'Your trial ends in 3 days',
      title: 'Three days left',
      body: ['Your trial of the team plan ends on 17 October.', 'Choose a plan to keep everything as it is.'],
      button: 'See plans',
      url: 'https://review.example.com/#/settings/billing',
      note: 'No card was needed for the trial.',
      workspace: 'Nordlicht Studio',
    },
  ],
  ['notice-own', { kind: 'notice', subject: 'Your trial has ended', title: 'The trial has ended', body: ['The workspace is on the free plan now.'] }],
];
const ALL = CASES.map(([, p]) => p);

test('every email, in English and German, reads as its snapshot', () => {
  fs.mkdirSync(DIR, { recursive: true });
  const changed: string[] = [];
  for (const [name, p] of CASES) {
    for (const lang of ['en', 'de'] as const) {
      const r = renderMail(p, lang, site);
      const got = `Subject: ${r.subject}\n\n${r.text}`;
      const file = path.join(DIR, `${name}.${lang}.txt`);
      if (UPDATE || !fs.existsSync(file)) {
        if (!UPDATE && process.env.CI) throw new Error(`missing snapshot ${file}`);
        fs.writeFileSync(file, got);
        continue;
      }
      if (fs.readFileSync(file, 'utf8') !== got) changed.push(path.relative(process.cwd(), file));
    }
  }
  assert.deepEqual(changed, [], `snapshots differ (VR_UPDATE_SNAPSHOTS=1 rewrites them):\n${changed.join('\n')}`);
});

test('no placeholder is left, every link goes to the public URL, nothing calls home', () => {
  ALL.forEach((p) => {
    for (const lang of ['en', 'de'] as const) {
      const r = renderMail(p, lang, site);
      for (const part of [r.subject, r.text, r.html]) assert.ok(!/\{\w+\}/.test(part), `${p.kind}/${lang}: a placeholder is left`);
      const hrefs = [...r.html.matchAll(/href="([^"]+)"/g)].map((m) => m[1] as string);
      for (const h of hrefs) assert.ok(h.startsWith('https://review.example.com/'), `${p.kind}: link ${h}`);
      // Tokens ride in the fragment, never in the path or the query the server's log would see.
      for (const h of hrefs) assert.ok(!/[?&](token|t)=/.test(h) && !/\/(vt|rt|inv)_/.test(h.split('#')[0] as string), h);
      const srcs = [...r.html.matchAll(/\ssrc="([^"]+)"/g)].map((m) => m[1]);
      assert.deepEqual(srcs, ['cid:lampo-icon'], `${p.kind}: only the inline icon`);
      assert.ok(!/<(link|script|iframe|object|form)\b|url\(|@import|background-image/i.test(r.html), `${p.kind}: no remote resource`);
      assert.match(r.html, /<meta name="color-scheme" content="light dark">/);
      assert.match(r.html, /@media \(prefers-color-scheme:dark\)/);
      assert.match(r.html, new RegExp(`<html lang="${lang}"`));
      assert.equal(r.lang, lang);
    }
  });
});

test('names and addresses are escaped in the HTML and plain in the text', () => {
  const r = renderMail({ kind: 'invite', by: '<b>Eve</b> & "Co"', role: 'admin', url: 'https://review.example.com/#/invite/inv_x', until: T }, 'en', site);
  assert.ok(r.html.includes('&lt;b&gt;Eve&lt;/b&gt; &amp; &quot;Co&quot;'));
  assert.ok(!r.html.includes('<b>Eve</b>'));
  assert.ok(r.text.includes('From an account named “<b>Eve</b> & "Co"”.'));
  assert.equal(r.subject, 'An invite to Lampo on review.example.com');
  const org = renderMail(
    { kind: 'invite', by: 'Olivia', role: 'reviewer', url: 'https://review.example.com/#/invite/inv_x', until: T },
    'de',
    siteOf('https://review.example.com/', 'Northwind'),
  );
  assert.equal(org.subject, 'Eine Einladung zu Northwind auf Lampo');
});

test('WS-3: an invite says what the server says; what people typed is quoted, never the subject or the sentence', () => {
  // Anyone who runs a workspace names it and themselves: neither may read as the server speaking.
  const by = 'Your bank: confirm your account at https://example.net/now';
  const workspace = 'Security team — action required';
  const r = renderMail({ kind: 'invite', by, role: 'admin', url: 'https://review.example.com/#/invite/inv_x', until: T, workspace }, 'en', site);
  assert.equal(r.subject, 'An invite to Lampo on review.example.com');
  assert.ok(!r.subject.includes(by) && !r.subject.includes(workspace));
  const lines = r.text.split('\n');
  const quoted = lines.filter((l) => l.includes(by) || l.includes(workspace));
  assert.deepEqual(quoted, [`From an account named “${by}”, for a workspace named “${workspace}”.`], 'one quoted line, nothing else');
  assert.ok(lines.some((l) => l.startsWith('You’re invited to review.example.com as an admin')));
});

test('both languages carry the same placeholders; dates say their time zone', () => {
  for (const [key, w] of Object.entries(WORDS)) {
    const names = (s: string) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
    assert.deepEqual(names(w.de), names(w.en), key);
    assert.ok(w.de !== w.en || /^\{brand\} · \{host\}$/.test(w.en), `${key} is not translated`);
  }
  assert.equal(when(T, 'en'), '2 October 2026, 09:30 UTC');
  assert.equal(when(T, 'de'), '2. Oktober 2026, 09:30 UTC');
});
