// The mailer (lib/mail/): composing a message, the SMTP client against a stand-in relay on this machine, the queue on
// disk (retries with backoff, limits, expiry, a restart), the log transport's outbox, the start-up refusals — and that
// no log line ever names an address or carries a token. Nothing here sends a real email: the relay is a socket in this
// process, everything else is the log transport.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { after, test } from 'node:test';
import { tmpdir } from '../lib/helpers.ts';

const { compose, quotedPrintable, encodeWords, formatAddress, parseAddress } = await import('../../lib/mail/mime.ts');
const { parseSmtpUrl, sendSmtp, SmtpError, dotStuff } = await import('../../lib/mail/smtp.ts');
const { createMailer, logTransport, readOutbox, BACKOFF_MS, addrHash } = await import('../../lib/mail/index.ts');
const { mailConfig, mailProblems, signupConfig } = await import('../../lib/mail/config.ts');

const SECRET = Buffer.alloc(32, 7);
const secret = () => SECRET;
const FROM = { name: 'Lampo', address: 'hello@review.test' };

/** Quoted-printable back to text, to check the round trip. */
const unQp = (s: string) =>
  Buffer.from(
    s
      .replace(/=\r\n/g, '')
      .replace(/=([0-9A-F]{2})/g, (_m, h: string) => String.fromCharCode(Number.parseInt(h, 16)))
      .split('')
      .map((c) => c.charCodeAt(0)),
  ).toString('utf8');

// ---------------------------------------------------------------- MIME

test('a message is 7-bit clean: German in the subject and body survives, lines stay under 78 characters', () => {
  const text = 'Hallo Jürgen,\n\nBestätige deine Adresse: https://review.test/#/verify/vt_abc\n. a line with a dot\n';
  const c = compose({
    from: { name: 'Lampo für Grüße', address: 'hello@review.test' },
    to: 'mia@example.com',
    subject: 'Bestätige deine E-Mail-Adresse für Lampo — ein ziemlich langer Betreff, damit er gefaltet wird',
    text,
    html: `<p>${'Grüße '.repeat(40)}</p>`,
    lang: 'de',
    host: 'review.test',
    inline: [{ cid: 'lampo-icon', type: 'image/png', name: 'lampo.png', data: Buffer.alloc(300, 1) }],
  });
  assert.ok(![...c.raw].some((ch) => ch.charCodeAt(0) > 127), 'only ASCII on the wire');
  for (const line of c.raw.split('\r\n')) assert.ok(line.length <= 78, `long line: ${line}`);
  assert.ok(!/[^\r]\n/.test(c.raw), 'CRLF line ends only');
  assert.match(c.raw, /^Subject: =\?UTF-8\?B\?/m);
  assert.match(c.raw, /^From: =\?UTF-8\?B\?[^\r]+\?=\r\n( =\?UTF-8\?B\?[^\r]+\?=\r\n)* <hello@review\.test>\r$/m);
  assert.equal(c.headers.From, 'Lampo für Grüße <hello@review.test>');
  assert.match(c.raw, /^Content-Language: de$/m);
  assert.match(c.raw, /^Auto-Submitted: auto-generated$/m);
  assert.match(c.raw, /Content-Type: multipart\/related/);
  assert.match(c.raw, /Content-ID: <lampo-icon>/);
  // The text part decodes back to what was written.
  const body = c.raw.split('Content-Transfer-Encoding: quoted-printable\r\n\r\n')[1]?.split('\r\n--')[0] ?? '';
  assert.equal(unQp(body).replace(/\r\n/g, '\n'), text);
  assert.equal(c.headers.Subject.startsWith('Bestätige'), true, 'the headers as written are kept readable for the outbox');
});

test('names cannot inject headers; encoded words never split a character', () => {
  assert.equal(formatAddress({ name: 'Eve\r\nBcc: all@example.com', address: 'e@example.com' }), '"Eve Bcc: all@example.com" <e@example.com>');
  assert.throws(() => formatAddress({ name: null, address: 'a@b.c\r\nBcc: x@y.z' }));
  assert.throws(() => parseAddress('not an address'));
  assert.deepEqual(parseAddress('Lampo <hello@review.test>'), { name: 'Lampo', address: 'hello@review.test' });
  assert.deepEqual(parseAddress('hello@review.test'), { name: null, address: 'hello@review.test' });
  const words = encodeWords('😀'.repeat(30));
  for (const w of words.split('\r\n ')) {
    assert.ok(w.length <= 75, w);
    const b64 = /=\?UTF-8\?B\?(.+)\?=/.exec(w)?.[1] as string;
    assert.ok(!Buffer.from(b64, 'base64').toString('utf8').includes('�'), 'a whole character per word');
  }
  // A space at the end of a line is kept (encoded), a long line gets soft breaks.
  assert.match(quotedPrintable('end \nnext'), /=20\r\nnext/);
  assert.ok(
    quotedPrintable('x'.repeat(200))
      .split('\r\n')
      .every((l) => l.length <= 76),
  );
  assert.equal(dotStuff('a\r\n.b\r\n'), 'a\r\n..b\r\n.\r\n');
  assert.equal(dotStuff('.start'), '..start\r\n.\r\n');
});

// ---------------------------------------------------------------- SMTP

interface Relay {
  port: number;
  got: { from: string; to: string; data: string; auth: string | null }[];
  close: () => void;
}

/** A relay on this machine: speaks just enough SMTP; `reply` may answer a command its own way. */
async function relay({ starttls = false, reply }: { starttls?: boolean; reply?: (cmd: string) => string | null } = {}): Promise<Relay> {
  const got: Relay['got'] = [];
  const server = net.createServer((sock) => {
    let buf = '';
    let data: string | null = null;
    let cur = { from: '', to: '', data: '', auth: null as string | null };
    const say = (l: string) => sock.write(`${l}\r\n`);
    say('220 relay.test ESMTP');
    sock.on('data', (d) => {
      buf += d.toString('latin1');
      for (let i = buf.indexOf('\r\n'); i >= 0; i = buf.indexOf('\r\n')) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data !== null) {
          if (line === '.') {
            cur.data = data;
            got.push(cur);
            cur = { from: '', to: '', data: '', auth: cur.auth };
            data = null;
            say(reply?.('.') ?? '250 2.0.0 Ok: queued as ABC123');
          } else data += `${line}\r\n`;
          continue;
        }
        const own = reply?.(line);
        if (own) {
          say(own);
          continue;
        }
        if (/^EHLO /.test(line)) {
          sock.write(`250-relay.test\r\n${starttls ? '250-STARTTLS\r\n' : ''}250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n`);
        } else if (/^AUTH PLAIN /.test(line)) {
          cur.auth = Buffer.from(line.slice(11), 'base64').toString('utf8');
          say('235 2.7.0 Authentication successful');
        } else if (/^MAIL FROM:/.test(line)) {
          cur.from = line;
          say('250 Ok');
        } else if (/^RCPT TO:/.test(line)) {
          cur.to = line;
          say('250 Ok');
        } else if (line === 'DATA') {
          data = '';
          say('354 End data with <CR><LF>.<CR><LF>');
        } else if (line === 'QUIT') {
          say('221 Bye');
          sock.end();
        } else if (line === 'STARTTLS') {
          say('454 TLS not available');
        } else say('502 Command not implemented');
      }
    });
    sock.on('error', () => {});
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { port: (server.address() as net.AddressInfo).port, got, close: () => server.close() };
}

test('the SMTP URL: smtps on 465, smtp with STARTTLS on 587, credentials decoded, never shown', async () => {
  const t = parseSmtpUrl('smtp://login%40smtp-brevo.com:s%3Acret@smtp-relay.brevo.com');
  assert.deepEqual(t, { secure: false, host: 'smtp-relay.brevo.com', port: 587, user: 'login@smtp-brevo.com', pass: 's:cret', requireTls: true });
  assert.equal(parseSmtpUrl('smtps://u:p@mail.example.com').port, 465);
  assert.equal(parseSmtpUrl('smtp://127.0.0.1:1025').requireTls, false, 'a catcher on this machine may stay plain');
  assert.throws(() => parseSmtpUrl('https://mail.example.com'), /smtp:\/\//);
  assert.throws(() => parseSmtpUrl('not a url'), /not a URL/);
});

test('sendSmtp signs in, names the envelope and sends the message dot-stuffed', async () => {
  const r = await relay();
  try {
    const raw = 'Subject: hi\r\n\r\n.leading dot\r\nbody\r\n';
    const answer = await sendSmtp(parseSmtpUrl(`smtp://bob%40x.test:pw@127.0.0.1:${r.port}`), {
      from: 'hello@review.test',
      to: 'mia@example.com',
      raw,
      helo: 'review.test',
    });
    assert.match(answer, /queued as ABC123/);
    assert.equal(r.got.length, 1);
    assert.equal(r.got[0]?.from, 'MAIL FROM:<hello@review.test>');
    assert.equal(r.got[0]?.to, 'RCPT TO:<mia@example.com>');
    assert.equal(r.got[0]?.auth, '\0bob@x.test\0pw');
    assert.equal(r.got[0]?.data, 'Subject: hi\r\n\r\n..leading dot\r\nbody\r\n', 'the dot is stuffed on the wire');
  } finally {
    r.close();
  }
});

test('a relay that refuses: 4xx may be tried again, 5xx not; no STARTTLS to another machine means no sending', async () => {
  const busy = await relay({ reply: (c) => (c.startsWith('RCPT') ? '451 4.7.1 Try again later' : null) });
  const gone = await relay({ reply: (c) => (c.startsWith('RCPT') ? '550 5.1.1 No such user' : null) });
  const plain = await relay();
  try {
    const send = (port: number, requireTls = false) =>
      sendSmtp({ ...parseSmtpUrl(`smtp://127.0.0.1:${port}`), requireTls }, { from: 'a@review.test', to: 'b@example.com', raw: 'x\r\n', helo: 'review.test' });
    await assert.rejects(send(busy.port), (e: unknown) => e instanceof SmtpError && !e.permanent && e.code === 451);
    await assert.rejects(send(gone.port), (e: unknown) => e instanceof SmtpError && e.permanent && e.code === 550);
    // A relay that offers no STARTTLS on another machine: the password and the mail would travel in clear.
    await assert.rejects(send(plain.port, true), (e: unknown) => e instanceof SmtpError && e.permanent && /STARTTLS/.test(e.message));
    assert.equal(plain.got.length, 0);
    await assert.rejects(
      sendSmtp(parseSmtpUrl('smtp://127.0.0.1:9'), { from: 'a@review.test', to: 'b@example.com', raw: 'x\r\n', helo: 'r', timeoutMs: 2000 }),
      (e: unknown) => e instanceof SmtpError && !e.permanent,
    );
  } finally {
    busy.close();
    gone.close();
    plain.close();
  }
});

// ---------------------------------------------------------------- the queue

const dirs: string[] = [];
after(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
});

function setup({
  transport,
  now,
  per_hour = 200,
}: {
  transport?: Parameters<typeof createMailer>[0]['transport'];
  now?: () => number;
  per_hour?: number;
} = {}) {
  const dir = tmpdir('vr-mail-');
  dirs.push(dir);
  const lines: string[] = [];
  const opts = {
    config: { transport: 'log' as const, smtp_url: null, from: null, reply_to: null, per_hour },
    dir: path.join(dir, 'data', 'mail'),
    outbox: path.join(dir, 'cache', 'outbox'),
    from: FROM,
    host: 'review.test',
    secret,
    log: (l: string) => lines.push(l),
    transport,
    now,
  };
  return { dir, lines, opts, mailer: createMailer(opts) };
}

const message = (to: string, extra: object = {}) => ({
  kind: 'reset' as const,
  to,
  lang: 'en',
  subject: 'Reset your Lampo password',
  text: 'Choose a new password:\nhttps://review.test/#/reset/rt_SECRETTOKEN0123456789\n',
  html: '<p><a href="https://review.test/#/reset/rt_SECRETTOKEN0123456789">Choose</a></p>',
  ...extra,
});

test('the log transport writes each message to the outbox: JSON, the raw message and a preview, for the server only', async () => {
  const { mailer, opts, lines } = setup();
  assert.equal(mailer.send(message('mia@example.com')), true);
  await mailer.flush();
  const box = readOutbox(opts.outbox);
  assert.equal(box.length, 1);
  assert.equal(box[0]?.to, 'mia@example.com');
  assert.equal(box[0]?.kind, 'reset');
  assert.match(box[0]?.text ?? '', /rt_SECRETTOKEN/);
  const files = fs.readdirSync(opts.outbox).sort();
  assert.deepEqual(
    files.map((f) => path.extname(f)),
    ['.eml', '.html', '.json'],
  );
  for (const f of files) assert.equal((fs.statSync(path.join(opts.outbox, f)).mode & 0o777).toString(8), '600', f);
  assert.equal(mailer.waiting(), 0);
  // The logs say what happened by kind and a hash: never the address, never the link.
  assert.ok(
    lines.some((l) => l.includes(`sent reset to ${addrHash(SECRET, 'mia@example.com')}`)),
    lines.join('\n'),
  );
  for (const l of lines) assert.ok(!/@|rt_|https?:/.test(l), l);
});

test('the queue holds messages sealed: neither the address nor the link is readable in the file', async () => {
  const failing = { kind: 'smtp' as const, where: 'smtp://relay.test:587', deliver: async () => Promise.reject(new SmtpError('451 busy', { code: 451 })) };
  const { mailer, opts } = setup({ transport: failing });
  mailer.send(message('mia@example.com'));
  await mailer.flush();
  const raw = fs.readFileSync(path.join(opts.dir, 'queue.json'), 'utf8');
  assert.ok(!raw.includes('mia@example.com') && !raw.includes('rt_SECRET') && !raw.includes('Reset your'), raw);
  assert.equal((fs.statSync(path.join(opts.dir, 'queue.json')).mode & 0o777).toString(8), '600');
  mailer.stop();
});

test('a relay that is down: tried again with growing waits, sent once it is back; a restart keeps what waits', async () => {
  let clock = 1_000_000;
  const now = () => clock;
  let up = false;
  const delivered: string[] = [];
  const relayLike = {
    kind: 'smtp' as const,
    where: 'smtp://relay.test:587',
    deliver: async (m: { to: string }) => {
      if (!up) throw new SmtpError('connection refused');
      delivered.push(m.to);
    },
  };
  const { mailer, opts, lines } = setup({ transport: relayLike, now });
  mailer.send(message('mia@example.com'));
  await mailer.flush();
  assert.equal(delivered.length, 0);
  assert.equal(mailer.waiting(), 1);
  // Not due yet: nothing is tried.
  clock += (BACKOFF_MS[0] as number) - 1000;
  await mailer.flush();
  assert.equal(lines.filter((l) => /not sent/.test(l)).length, 1);
  clock += 2000;
  await mailer.flush();
  assert.equal(lines.filter((l) => /not sent \(try 2\)/.test(l)).length, 1, lines.join('\n'));
  mailer.stop();
  // The process restarts; the relay is back.
  up = true;
  clock += BACKOFF_MS[1] as number;
  const again = createMailer({ ...opts, transport: relayLike, now });
  await again.flush();
  assert.deepEqual(delivered, ['mia@example.com']);
  assert.equal(again.waiting(), 0);
  assert.ok(
    lines.some((l) => /sent reset to \w+ \(smtp, try 3\)/.test(l)),
    lines.join('\n'),
  );
  again.stop();
});

test('a refusal (5xx) is not tried again; after the last backoff a message is given up; an expired link is not sent', async () => {
  let clock = 5_000_000;
  const now = () => clock;
  const refuse = {
    kind: 'smtp' as const,
    where: 'x',
    deliver: async () => Promise.reject(new SmtpError('550 5.1.1 <mia@example.com> no such user', { permanent: true, code: 550 })),
  };
  const a = setup({ transport: refuse, now });
  a.mailer.send(message('mia@example.com'));
  await a.mailer.flush();
  assert.equal(a.mailer.waiting(), 0);
  assert.ok(
    a.lines.some((l) => /dropped reset to \w+: refused: 550 5\.1\.1 <recipient> no such user/.test(l)),
    a.lines.join('\n'),
  );

  const down = { kind: 'smtp' as const, where: 'x', deliver: async () => Promise.reject(new SmtpError('timeout')) };
  const b = setup({ transport: down, now });
  b.mailer.send(message('max@example.com'));
  for (const wait of [0, ...BACKOFF_MS]) {
    clock += wait;
    await b.mailer.flush();
  }
  assert.equal(b.mailer.waiting(), 0);
  assert.ok(
    b.lines.some((l) => /gave up after 9 tries/.test(l)),
    b.lines.join('\n'),
  );

  const c = setup({ transport: down, now });
  c.mailer.send(message('ida@example.com', { expires: clock + 60_000 }));
  await c.mailer.flush();
  clock += 3600e3;
  await c.mailer.flush();
  assert.equal(c.mailer.waiting(), 0);
  assert.ok(c.lines.some((l) => /link expired/.test(l)));
  for (const l of [...a.lines, ...b.lines, ...c.lines]) assert.ok(!l.includes('@example.com'), l);
});

test('limits: an address is not flooded; the server’s own cap holds messages back instead of dropping them', async () => {
  const { mailer, lines, opts } = setup();
  const sent = Array.from({ length: 10 }, () => mailer.send(message('mia@example.com')));
  assert.deepEqual(sent, [true, true, true, true, true, true, true, true, false, false], 'eight an hour to one address');
  assert.ok(lines.some((l) => /too many messages to this address/.test(l)));
  assert.equal(mailer.send(message('max@example.com')), true, 'another address is not affected');
  assert.equal(mailer.send(message('owner@localhost')), false, 'an address that cannot receive mail is skipped');
  await mailer.flush();
  assert.equal(readOutbox(opts.outbox).length, 9);

  const capped = setup({ per_hour: 2 });
  for (const to of ['a@example.com', 'b@example.com', 'c@example.com']) capped.mailer.send(message(to));
  await capped.mailer.flush();
  assert.equal(readOutbox(capped.opts.outbox).length, 2);
  assert.equal(capped.mailer.waiting(), 1, 'the third waits for the window');
  assert.ok(capped.lines.some((l) => /limit \(2 an hour\)/.test(l)));
  capped.mailer.stop();
});

test('send never throws and never waits, whatever it is given', () => {
  const { mailer, opts } = setup();
  assert.equal(mailer.send(message('not an address')), false);
  const t = Date.now();
  for (let i = 0; i < 5; i++) mailer.send(message(`p${i}@example.com`));
  // What send() did by the time it returned: queued all five, delivered none (no transport ran inside it). The time is
  // only a backstop against a send that waits for a relay (seconds), not a measure of the disk.
  assert.equal(mailer.waiting(), 5, 'queued before returning');
  assert.equal(readOutbox(opts.outbox).length, 0, 'not sent before returning');
  assert.ok(Date.now() - t < 5000, 'never waits for delivery');
  mailer.stop();
});

test('logTransport keeps the newest messages only', async () => {
  const dir = tmpdir('vr-outbox-');
  dirs.push(dir);
  const t = logTransport(dir);
  const c = compose({ from: FROM, to: 'a@example.com', subject: 's', text: 't', html: 'h', lang: 'en', host: 'review.test' });
  for (let i = 0; i < 305; i++) await t.deliver({ ...message('a@example.com'), id: `m_${String(i).padStart(4, '0')}`, from: FROM, composed: c });
  assert.equal(readOutbox(dir).length, 300);
});

// ---------------------------------------------------------------- configuration

test('mail and sign-up settings: environment over config.json, and the server refuses to start with what can’t work', () => {
  const env = { VR_SMTP_URL: 'smtp://u:p@smtp-relay.brevo.com:587', VR_MAIL_FROM: 'Lampo <hello@review.test>', VR_MAIL_PER_HOUR: '50' };
  const m = mailConfig({ mail: { smtp_url: 'smtps://other', from: 'x@y.z' } }, env);
  assert.deepEqual(m, { transport: 'smtp', smtp_url: env.VR_SMTP_URL, from: env.VR_MAIL_FROM, reply_to: null, per_hour: 50 });
  assert.equal(mailConfig({}, {}).transport, 'log', 'nothing configured: the log transport');
  assert.deepEqual(signupConfig({}, {}), { signup: 'off', terms_url: null, privacy_url: null });

  const base = {
    mail: mailConfig({}, {}),
    mode: 'server' as const,
    public_url: 'https://review.test',
    signup: 'off' as const,
    terms_url: null,
    privacy_url: null,
  };
  assert.deepEqual(mailProblems(base), []);
  assert.match(mailProblems({ ...base, mail: mailConfig({}, { VR_SMTP_URL: 'smtp://relay.test' }) }).join(), /needs VR_MAIL_FROM/);
  assert.match(mailProblems({ ...base, mail: mailConfig({}, { VR_SMTP_URL: 'http://relay.test', VR_MAIL_FROM: 'a@b.c' }) }).join(), /must start with smtp/);
  assert.match(mailProblems({ ...base, mail: mailConfig({}, { VR_MAIL_FROM: 'nobody' }) }).join(), /VR_MAIL_FROM is not an email address/);
  assert.match(mailProblems({ ...base, signup: 'maybe' as 'off' }).join(), /must be off, invite or open/);
  assert.match(mailProblems({ ...base, signup: 'invite', public_url: null }).join(), /needs VR_PUBLIC_URL/);
  assert.match(mailProblems({ ...base, terms_url: 'javascript:alert(1)' }).join(), /VR_TERMS_URL must be an http/);
  assert.deepEqual(mailProblems({ ...base, signup: 'invite' }), []);
});

test('VR_SIGNUP=open refuses to start until something gives each sign-up a workspace (the onSignup seam)', () => {
  const base = {
    mail: mailConfig({}, {}),
    public_url: 'https://review.test',
    signup: 'open' as const,
    terms_url: 'https://review.test/terms',
    privacy_url: 'https://review.test/privacy',
  };
  const hosted = mailProblems({ ...base, mode: 'server' });
  assert.equal(hosted.length, 1);
  assert.match(hosted[0] as string, /^VR_SIGNUP=open needs workspaces: everyone who signs up gets a workspace of their own/);
  assert.match(mailProblems({ ...base, mode: 'local' })[0] as string, /on your own machine everyone who signs up would join your own store/);
  assert.deepEqual(mailProblems({ ...base, mode: 'server' }, { signupSeam: true }), [], 'with the seam filled it starts');
});
