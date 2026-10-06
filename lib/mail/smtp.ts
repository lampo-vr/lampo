// A small SMTP submission client (RFC 5321 + STARTTLS + AUTH PLAIN/LOGIN), enough for a relay such as Brevo's:
// `smtps://` speaks TLS from the first byte (port 465), `smtp://` upgrades with STARTTLS (port 587) and refuses to go on
// without it, except to this machine itself (a local relay or a test catcher). One message per connection: transactional
// mail is a trickle, and a fresh connection never inherits a broken state. Errors say whether trying again could help
// (4xx and network trouble) or not (5xx).
import net from 'node:net';
import tls from 'node:tls';

export interface SmtpTarget {
  /** TLS from the start (smtps://). */
  secure: boolean;
  host: string;
  port: number;
  user: string | null;
  pass: string | null;
  /** smtp:// to another machine: STARTTLS or nothing. Loopback may stay plain when the server offers no STARTTLS. */
  requireTls: boolean;
}

export class SmtpError extends Error {
  /** A 5xx answer (bad address, refused sender, wrong credentials): sending the same again won't help. */
  readonly permanent: boolean;
  readonly code: number | null;
  constructor(message: string, { permanent = false, code = null }: { permanent?: boolean; code?: number | null } = {}) {
    super(message);
    this.permanent = permanent;
    this.code = code;
  }
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);

/** `smtp[s]://user:pass@host[:port]`; the user name and password URL-encoded (an @ in a login is %40). */
export function parseSmtpUrl(url: string): SmtpTarget {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error('VR_SMTP_URL is not a URL: write it as smtp://user:password@host:587 or smtps://user:password@host:465');
  }
  if (u.protocol !== 'smtp:' && u.protocol !== 'smtps:')
    throw new Error('VR_SMTP_URL must start with smtp:// (STARTTLS, usually port 587) or smtps:// (TLS, port 465)');
  const host = u.hostname.replace(/^\[|\]$/g, '');
  if (!host) throw new Error('VR_SMTP_URL names no host');
  const secure = u.protocol === 'smtps:';
  const port = u.port ? Number(u.port) : secure ? 465 : 587;
  const user = u.username ? decodeURIComponent(u.username) : null;
  const pass = u.password ? decodeURIComponent(u.password) : null;
  return { secure, host, port, user, pass, requireTls: !secure && !LOOPBACK.has(host) };
}

/** Where a target points, for logs and `vr admin mail-test`: never the credentials. */
export const describeTarget = (t: SmtpTarget) => `${t.secure ? 'smtps' : 'smtp'}://${t.host}:${t.port}`;

interface Reply {
  code: number;
  text: string;
  lines: string[];
}

/** Reads SMTP replies off a socket: lines up to "NNN text" (a "NNN-text" line means more follow). */
class Replies {
  private buf = '';
  private lines: string[] = [];
  private ready: Reply[] = [];
  private waiter: { resolve: (r: Reply) => void; reject: (e: Error) => void; timer: NodeJS.Timeout } | null = null;
  private failure: Error | null = null;
  private readonly onData = (d: Buffer) => this.feed(d.toString('latin1'));
  private readonly onError = (e: Error) => this.fail(new SmtpError(`connection failed: ${e.message}`));
  private readonly onClose = () => this.fail(new SmtpError('the server closed the connection'));

  readonly socket: net.Socket;
  constructor(socket: net.Socket) {
    this.socket = socket;
    socket.on('data', this.onData);
    socket.on('error', this.onError);
    socket.on('close', this.onClose);
  }

  /** Stops listening (before the socket is handed to TLS). */
  detach(): void {
    this.socket.off('data', this.onData);
    this.socket.off('error', this.onError);
    this.socket.off('close', this.onClose);
  }

  private feed(s: string): void {
    this.buf += s;
    if (this.buf.length > 1_000_000) {
      this.fail(new SmtpError('the server sent too much'));
      return;
    }
    let i = this.buf.indexOf('\n');
    while (i >= 0) {
      const line = this.buf.slice(0, i).replace(/\r$/, '');
      this.buf = this.buf.slice(i + 1);
      this.lines.push(line);
      const m = /^(\d{3})([ -]|$)/.exec(line);
      if (!m) {
        this.fail(new SmtpError(`not an SMTP answer: ${line.slice(0, 80)}`));
        return;
      }
      if (m[2] !== '-') {
        const lines = this.lines.map((l) => l.slice(4));
        this.lines = [];
        this.push({ code: Number(m[1]), text: lines.join(' ').trim(), lines });
      }
      i = this.buf.indexOf('\n');
    }
  }

  private push(r: Reply): void {
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      const w = this.waiter;
      this.waiter = null;
      w.resolve(r);
    } else this.ready.push(r);
  }

  private fail(e: Error): void {
    if (this.failure) return;
    this.failure = e;
    if (this.waiter) {
      clearTimeout(this.waiter.timer);
      const w = this.waiter;
      this.waiter = null;
      w.reject(e);
    }
  }

  next(timeoutMs: number): Promise<Reply> {
    const r = this.ready.shift();
    if (r) return Promise.resolve(r);
    if (this.failure) return Promise.reject(this.failure);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new SmtpError(`no answer from the server within ${Math.round(timeoutMs / 1000)} s`));
      }, timeoutMs);
      this.waiter = { resolve, reject, timer };
    });
  }
}

export interface SmtpSend {
  /** The envelope sender (the From address). */
  from: string;
  to: string;
  /** The whole message, CRLF line ends. */
  raw: string;
  /** Our name in EHLO (the public host). */
  helo: string;
  /** Per answer (the end of DATA gets four times as long). */
  timeoutMs?: number;
  /** Tests: certificates a stand-in server uses. */
  tls?: tls.ConnectionOptions;
}

const connect = (t: SmtpTarget, opts: tls.ConnectionOptions | undefined, timeoutMs: number): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const sock = t.secure
      ? tls.connect({ host: t.host, port: t.port, servername: net.isIP(t.host) ? undefined : t.host, ...opts })
      : net.connect(t.port, t.host);
    const timer = setTimeout(() => {
      sock.destroy();
      reject(new SmtpError(`could not connect to ${t.host}:${t.port} within ${Math.round(timeoutMs / 1000)} s`));
    }, timeoutMs);
    sock.once(t.secure ? 'secureConnect' : 'connect', () => {
      clearTimeout(timer);
      sock.removeAllListeners('error');
      resolve(sock);
    });
    sock.once('error', (e) => {
      clearTimeout(timer);
      reject(new SmtpError(`could not connect to ${t.host}:${t.port}: ${e.message}`));
    });
  });

const upgrade = (sock: net.Socket, t: SmtpTarget, opts: tls.ConnectionOptions | undefined, timeoutMs: number): Promise<tls.TLSSocket> =>
  new Promise((resolve, reject) => {
    const secure = tls.connect({ socket: sock, servername: net.isIP(t.host) ? undefined : t.host, ...opts });
    const timer = setTimeout(() => {
      secure.destroy();
      reject(new SmtpError('the TLS handshake took too long'));
    }, timeoutMs);
    secure.once('secureConnect', () => {
      clearTimeout(timer);
      secure.removeAllListeners('error');
      resolve(secure);
    });
    secure.once('error', (e) => {
      clearTimeout(timer);
      reject(new SmtpError(`TLS failed: ${e.message}`));
    });
  });

/** Lines starting with a dot get one more (RFC 5321 4.5.2); the message ends with CRLF.CRLF. */
export const dotStuff = (raw: string) =>
  `${raw
    .replace(/\r?\n/g, '\r\n')
    .replace(/(^|\r\n)\./g, '$1..')
    .replace(/\r\n$/, '')}\r\n.\r\n`;

/** Sends one message; resolves with the server's answer to the message (its queue id, usually). */
export async function sendSmtp(t: SmtpTarget, m: SmtpSend): Promise<string> {
  const wait = m.timeoutMs ?? 30_000;
  let sock = await connect(t, m.tls, wait);
  let replies = new Replies(sock);
  const write = (s: string) => sock.write(s);
  const expect = async (want: number[], what: string, timeout = wait) => {
    const r = await replies.next(timeout);
    if (!want.includes(r.code)) throw new SmtpError(`${what}: ${r.code} ${r.text}`.slice(0, 300), { permanent: r.code >= 500, code: r.code });
    return r;
  };
  const command = async (line: string, want: number[], what: string, timeout?: number) => {
    write(`${line}\r\n`);
    return expect(want, what, timeout);
  };
  try {
    await expect([220], 'greeting');
    let ehlo = await command(`EHLO ${m.helo}`, [250], 'EHLO');
    const offers = (r: Reply, ext: string) => r.lines.some((l) => l.toUpperCase().split(/\s+/)[0] === ext);
    if (!t.secure) {
      if (offers(ehlo, 'STARTTLS')) {
        await command('STARTTLS', [220], 'STARTTLS');
        replies.detach();
        sock = await upgrade(sock, t, m.tls, wait);
        replies = new Replies(sock);
        ehlo = await command(`EHLO ${m.helo}`, [250], 'EHLO after STARTTLS');
      } else if (t.requireTls) {
        throw new SmtpError(`${t.host} offers no STARTTLS: mail and the password would travel unencrypted (use smtps:// if it speaks TLS on its port)`, {
          permanent: true,
        });
      }
    }
    if (t.user) {
      const auth = ehlo.lines.find((l) => /^AUTH[ =]/i.test(l))?.toUpperCase() ?? '';
      if (/\bPLAIN\b/.test(auth)) {
        const blob = Buffer.from(`\0${t.user}\0${t.pass ?? ''}`, 'utf8').toString('base64');
        await command(`AUTH PLAIN ${blob}`, [235], 'sign-in');
      } else if (/\bLOGIN\b/.test(auth)) {
        await command('AUTH LOGIN', [334], 'sign-in');
        await command(Buffer.from(t.user, 'utf8').toString('base64'), [334], 'sign-in');
        await command(Buffer.from(t.pass ?? '', 'utf8').toString('base64'), [235], 'sign-in');
      } else throw new SmtpError(`${t.host} offers no password sign-in (AUTH PLAIN or LOGIN)`, { permanent: true });
    }
    await command(`MAIL FROM:<${m.from}>`, [250], 'sender');
    await command(`RCPT TO:<${m.to}>`, [250, 251], 'recipient');
    await command('DATA', [354], 'DATA');
    write(dotStuff(m.raw));
    const done = await expect([250], 'message', wait * 4);
    write('QUIT\r\n');
    return done.text;
  } finally {
    // QUIT's answer doesn't matter; the connection ends either way.
    setTimeout(() => sock.destroy(), 200).unref();
  }
}
