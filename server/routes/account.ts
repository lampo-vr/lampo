// What an emailed link starts, and what asks for one: signing up (LAMPO_SIGNUP), confirming an address, a password
// reset, and sending a link again. Every answer that could tell whether an address has an account is the same either
// way ({ok: true}) and takes as long; tokens come in the request body, never in a URL (the emails put them in the
// fragment and the page posts them); all of it is rate-limited per address and per email.
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { LINK_TOKEN, peekLink, useLink, voidLinks } from '../../lib/accountLinks.ts';
import * as auth from '../../lib/auth.ts';
import { afterNewPassword } from '../../lib/newPassword.ts';
import { revokeAppsOf } from '../../lib/oauth/store.ts';
import { isInternal } from '../../lib/publicError.ts';
import { addressKey, RateLimit } from '../../lib/rateLimit.ts';
import { isSignupPlan } from '../../lib/setupFlow.ts';
import * as workspaces from '../../lib/workspaces.ts';
import { WorkspaceError } from '../../lib/workspaces.ts';
import { CLEAR_SITE_DATA, sessionCookies, sha256 } from '../auth.ts';
import type { ServerContext } from '../context.ts';
import { sampleForFirstRun } from '../firstSample.ts';
import { body, fail, failFrom, router } from '../http.ts';

const Email = z.string().max(254);
const Lang = z.enum(['en', 'de']).optional();
// With LAMPO_SIGNUP=invite only the address counts (an invite's link asks for the rest); open sign-up needs all three.
// `plan`: what the website's sign-up link named (`?plan=`); a known id rides with the account, anything else is ignored.
const Signup = z
  .object({ name: z.string().max(80).optional(), email: Email, password: z.string().max(1024).optional(), lang: Lang, plan: z.string().max(40).optional() })
  .strict();
const AskLink = z.object({ email: Email.optional(), lang: Lang }).strict();
const Token = z.object({ token: z.string().max(200) }).strict();
const Reset = Token.extend({ password: z.string().max(1024) });
// A held account's confirm link opened anywhere but the browser that chose its password: that password, or a new one.
// `name`: another name to join with, when someone in the invite's workspace goes by this one (409 `name`).
const Verify = Token.extend({
  password: z.string().max(1024).optional(),
  new_password: z.string().max(1024).optional(),
  name: z.string().max(200).optional(),
  // the page's language: what a new account's first things are written in (the sample's notes)
  lang: Lang,
});

/** "m•••@example.com": enough for the person to recognise their address on the reset page, not to learn one. */
export const maskEmail = (email: string) => {
  const [local = '', domain = ''] = email.split('@');
  return `${local.slice(0, 1)}•••@${domain}`;
};

export function accountRoutes(ctx: ServerContext): Router {
  const r = router();
  const { cfg, accountMail: mail } = ctx;
  const cookies = sessionCookies(cfg);
  const WINDOW = 15 * 60_000;
  const HOUR = 60 * 60_000;
  // Per address of the asker, per email asked about, and wrong or spent links per address.
  const asksByIp = new RateLimit(20, WINDOW);
  const asksByEmail = new RateLimit(5, HOUR);
  const badLinks = new RateLimit(30, WINDOW);
  // Wrong passwords typed on a held account's confirm page, per account (the link is needed too).
  const heldGuesses = new RateLimit(10, WINDOW);
  const ip = (req: Request) => addressKey(req.ip || 'unknown');
  const limit = (rl: RateLimit, key: string, what: string) => {
    const wait = rl.retryAfter(key);
    if (wait) throw Object.assign(fail(429, `too many ${what}, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
    rl.hit(key);
  };
  const ask = (req: Request, email: string | null) => {
    limit(asksByIp, ip(req), 'requests from here');
    if (email) limit(asksByEmail, email, 'requests for this address');
  };
  const linkTries = (req: Request) => {
    const wait = badLinks.retryAfter(ip(req));
    if (wait) throw Object.assign(fail(429, `too many attempts, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
  };
  /** A link that can't be used: why, without saying anything about any account. */
  const spent = (req: Request, state: 'expired' | 'used' | 'invalid', extra: Record<string, unknown> = {}) => {
    if (state === 'invalid') badLinks.hit(ip(req));
    return fail(
      state === 'invalid' ? 404 : 410,
      state === 'expired' ? 'this link has expired' : state === 'used' ? 'this link was already used' : 'this link is not valid',
      {
        state,
        ...extra,
      },
    );
  };
  const emailOf = (raw: string | undefined) => {
    if (!raw?.trim()) return null;
    try {
      return auth.checkEmail(raw);
    } catch (e) {
      throw fail(400, (e as Error).message);
    }
  };
  // An address a link is asked for: by the rule now, or as an account made before it (A12 INV-REV-9) may still have it.
  const askedOf = (raw: string | undefined) => {
    if (!raw?.trim()) return null;
    if (!auth.mayBeAccountEmail(raw)) throw fail(400, 'that is not an email address');
    return raw;
  };
  const userAsync = async <T>(fn: () => Promise<T>): Promise<T> => {
    try {
      return await fn();
    } catch (e) {
      throw failFrom(isInternal(e) ? 500 : 400, e);
    }
  };
  const mailOn = () => {
    if (!mail.enabled) throw fail(404, 'this server can’t send email (no public URL)');
  };
  /**
   * What depends on whether an address has an account (a link issued, a message queued) happens after the answer has
   * gone, so the answer takes as long either way — and a while after it, so a request sent next doesn't feel it either
   * (A12 INV-REV-8: server/accountMail.ts afterwards).
   */
  const afterwards = (what: string, work: () => void) => mail.afterwards(what, work);

  /**
   * A held account whose address was just proven (`reset`: with a reset link): the seam (workspaces) runs first — if it
   * throws, nothing is used up and the person can try the link again —, then the account is let in and welcomed.
   */
  async function release(user: auth.User, { reset = false }: { reset?: boolean } = {}): Promise<void> {
    if (!auth.isGated(user)) return;
    if (!ctx.onSignup) return;
    // Each workspace it is about to join takes one more person: its plan may have no room now (a 402 with the plan's
    // sentence, the link unused). The invite was checked when it was taken; members may have joined since (A12 INV-REV-7).
    if (!reset) for (const c of auth.heldInvitesOf(user.id)) await ctx.extension.check(c.workspace, 'member');
    try {
      await ctx.onSignup({ user: auth.publicUser(user), ...(reset ? { reset } : {}) });
    } catch (e) {
      // The invite it took was taken by someone else or withdrawn meanwhile (lib/workspaces.ts placeSignup): the link
      // stays unused, and the page says what happened.
      if (e instanceof WorkspaceError && e.status < 500)
        throw fail(e.status, e.message, { state: e.state ?? 'invite', ...(e.state === 'name' ? { name: user.name } : {}) });
      throw e;
    }
  }

  // The signing-up browser (a sign-up's, or an invite's on a server with workspaces): server/auth.ts sessionCookies.
  const signupCookie = cookies.signup;
  const signedUpHere = cookies.signedUpHere;
  /**
   * Someone else is signed in in this browser: a link that would sign a person in (a held sign-up's confirmation, a
   * reset) is refused, unused, and their session stays theirs (login CSRF: opening someone's link must never swap it).
   */
  const notSomeoneElse = (req: Request, user: auth.User) => {
    const me = req.auth?.user;
    if (me && me.id !== user.id)
      throw fail(409, 'this link is for another account: sign out first, then open it again', { state: 'other', email: maskEmail(user.email) });
  };

  // ---------------------------------------------------------------- sign-up

  r.post('/api/auth/signup', express.json(), async (req, res) => {
    // Off, or open without anything to give each person their own workspace (startupProblems refuses that start too).
    if (cfg.signup === 'off' || (cfg.signup === 'open' && (!ctx.onSignup || !ctx.hosted)) || !mail.enabled) throw fail(404, 'sign-up is off on this server');
    const b = body(Signup, req);
    const email = emailOf(b.email) as string;
    ask(req, email);
    const lang = mail.langOf(null, b.lang);
    const browser = cookies.mark(req);
    let result: auth.SignUpResult;
    try {
      // Open sign-up on a hosted server: the person gets a workspace of their own, so their name clashes with nobody's
      // (names are told apart per workspace; a server-wide "taken" would also tell strangers who else is here).
      result = await auth.signUp({
        email,
        name: b.name,
        password: b.password,
        mode: cfg.signup,
        anyName: cfg.signup === 'open' && ctx.hosted,
        browser: sha256(browser),
        plan: isSignupPlan(b.plan) ? b.plan : undefined,
      });
    } catch (e) {
      // A short password or a name that can't be used: the person's to fix, and nothing about the address.
      throw fail(400, (e as Error).message);
    }
    // Every answer sets it (a new account or not), so it says nothing; only a new held account remembers it.
    signupCookie(req, res, browser, 24 * 3600);
    res.json({ ok: true });
    afterwards('sign-up', () => {
      if ('made' in result) mail.verify(result.made, result.made.email, lang);
      else if ('exists' in result) {
        const u = result.exists;
        if (u.disabled) return;
        if (!auth.isGated(u)) mail.signupExists(u, lang);
        // Held (a sign-up never confirmed, or an invite someone took with the address). Its password was chosen by
        // whoever made it, so the address's owner signing up never gets that password confirmed (A12 INV-REV-1):
        // - invite mode: the invites made out to the address, and the held account's link (whose page asks for its
        //   password or a new one);
        // - the same password (the same person again): the link again, signing in this browser now (A12-D14);
        // - another password: a reset link — the inbox takes the address with a password of its own.
        else if (result.invited) {
          sendInvites(result.invited, lang);
          mail.verify(u, u.email, mail.langOf(u, b.lang));
        } else if (result.fits) {
          auth.markSignupBrowser(u.id, sha256(browser));
          mail.verify(u, u.email, mail.langOf(u, b.lang));
        } else mail.reset(u, mail.langOf(u, b.lang));
      } else if ('invited' in result) sendInvites(result.invited, lang);
      // { refused: 'no-invite' }: an address nobody invited gets no mail from this server.
    });
  });

  /**
   * LAMPO_SIGNUP=invite: an invited address asked to sign up. Its invites go to it again — only their links make the
   * account (with the invite's role), so whoever merely knows the address gets nothing out of asking.
   */
  function sendInvites(ids: string[], lang: ReturnType<typeof mail.langOf>) {
    for (const id of ids) {
      const token = auth.inviteToken(id);
      const invite = token ? auth.pendingInvite(id) : null;
      if (token && invite && mail.invite(invite, token, lang)) auth.markInviteSent(id);
    }
  }

  // ---------------------------------------------------------------- confirming an address

  /**
   * What confirming a held account would join, as its confirm page shows it: each invite's workspace (its name once a
   * person named it), role and who made it.
   */
  const joinsOf = (user: auth.User) =>
    auth.heldInvitesOf(user.id).map((c) => {
      const w = workspaces.getWorkspace(c.workspace);
      return { ...(w && workspaces.workspaceNamed(w.id) ? { workspace: w.name } : {}), by: c.by, role: c.role };
    });

  r.post('/api/auth/verify', express.json(), async (req, res) => {
    linkTries(req);
    const b = body(Verify, req);
    const t = b.token.trim();
    const peek = peekLink('verify', t);
    if (peek.state !== 'ok' || !peek.link) {
      const user = peek.link ? auth.getUser(peek.link.user) : null;
      throw spent(
        req,
        peek.state as 'expired' | 'used' | 'invalid',
        peek.state === 'used' && user ? { confirmed: !user.unverified && !user.pending_email } : {},
      );
    }
    let user = auth.getUser(peek.link.user);
    if (!user || user.disabled) throw spent(req, 'invalid');
    // A held sign-up's link lets it in: never in a browser where someone else is signed in (refused, link unused).
    const releases = auth.isGated(user) && (peek.link.email === user.email || peek.link.email === user.pending_email);
    if (releases) notSomeoneElse(req, user);
    // Who may confirm a held account with the password it holds (A12 INV-REV-1, A12-D8). Whoever made it chose that
    // password — the person signing up, or anyone who took an invite with the address (its maker holds its link too) —
    // and the link proves only the inbox. So it confirms at once only for whoever chose the password: the browser that
    // did (its `vr_signup` mark) or the account signed in here. Anyone else types that password, or chooses a new one,
    // which — like a reset from the inbox — leaves behind the invites taken with the old one (placeSignup). Asked
    // without either: 409 `password`, the link unused, the page shows what confirming would join.
    let fresh: string | null = null;
    if (releases && !signedUpHere(req, user) && req.auth?.user?.id !== user.id) {
      const asking = { state: 'password', email: maskEmail(user.email), joins: joinsOf(user) };
      if (b.new_password !== undefined) {
        try {
          auth.checkPassword(b.new_password);
        } catch (e) {
          throw fail(400, (e as Error).message);
        }
        fresh = b.new_password;
      } else if (b.password !== undefined) {
        const wait = heldGuesses.retryAfter(user.id);
        if (wait) throw Object.assign(fail(429, `too many attempts, try again in ${Math.ceil(wait / 60)} min`), { retryAfter: wait });
        if (!(await auth.verifyPassword(b.password, user.password))) {
          heldGuesses.hit(user.id);
          badLinks.hit(ip(req));
          throw fail(403, 'that isn’t the password this account was made with: type it again, or choose a new one', asking);
        }
      } else throw fail(409, 'confirming this account takes the password it was made with, or a new one', asking);
    }
    // Another name to join with (the page asks for one when the name is taken in the invite's workspace): this account's
    // own business, told apart in its workspaces when it joins them (placeSignup), not across the server.
    if (releases && b.name !== undefined) {
      const id = user.id;
      user = await userAsync(() => auth.updateUser(id, { name: b.name }, { memberships: true }));
    }
    if (peek.link.email === user.email || peek.link.email === user.pending_email) await release(user, { reset: fresh !== null });
    const used = useLink('verify', t);
    if (used.state !== 'ok' || !used.link) throw spent(req, used.state as 'expired' | 'used' | 'invalid');
    if (fresh !== null) {
      // The password whoever made the account chose is replaced, and with it everything that password could have made.
      user = await auth.updateUser(user.id, { password: fresh });
      voidLinks(user.id);
      auth.revokeTokensOf(user.id);
      revokeAppsOf(user.id, 'new password at confirmation');
      afterNewPassword(user.id);
    }
    let done: auth.Confirmed;
    try {
      done = auth.confirmAddress(used.link.user, used.link.email);
    } catch (e) {
      throw fail(409, (e as Error).message, { state: 'stale' });
    }
    if (done.kind === 'changed') {
      // The account moved to a new address: what the old inbox still holds (a reset link above all) stops working.
      voidLinks(done.user.id);
      if (done.previous) mail.emailChanged(done.previous, done.user, !!done.previousConfirmed);
    }
    let signedIn = false;
    if (done.released) {
      mail.welcome(done.user);
      // a workspace of their own (an open sign-up): its library has the sample from the start
      const own = workspaces.signupWorkspaceOf(done.user.id);
      if (own) sampleForFirstRun(ctx, { workspace: own, user: done.user, lang: b.lang });
      // The link proves the inbox; with the password proven too (this browser chose it, or it was typed or chosen just
      // now) this browser is signed in. A session of the account itself goes on as it is.
      if (!req.auth?.user) {
        cookies.set(req, res, done.user);
        signedIn = true;
      }
    }
    res.json({ kind: done.kind, email: done.user.email, released: done.released, signedIn, user: auth.publicUser(done.user) });
  });

  // The link again: for the signed-in person (their unconfirmed or new address), or, signed out, for a held sign-up.
  r.post('/api/auth/verify/resend', express.json(), (req, res) => {
    mailOn();
    const b = body(AskLink, req);
    const me = req.auth?.user ?? null;
    if (me && req.auth?.via !== 'token') {
      ask(req, me.email);
      const to = me.pending_email || (me.unverified ? me.email : null);
      if (!to) throw fail(409, 'your address is confirmed already');
      // A new address another account uses gets nothing, and the answer says the same (PATCH /api/auth/me).
      if (to === me.email || !auth.addressKept(to)) mail.verify(me, to, mail.langOf(me, b.lang));
      return void res.json({ ok: true, to: maskEmail(to) });
    }
    const email = askedOf(b.email);
    if (!email) throw fail(400, 'which address?');
    ask(req, auth.emailKey(email));
    res.json({ ok: true });
    const asker = ip(req);
    afterwards('resend', () => {
      const u = auth.findUserByEmail(email);
      // A held account's link (its page asks whoever didn't choose the password for it, or a new one: A12 INV-REV-1).
      if (u && auth.isGated(u) && !u.disabled) mail.verify(u, u.email, mail.langOf(u, b.lang), { asker });
      // LAMPO_SIGNUP=invite: what such an address waits for is its invite — a held account there never stands in for it.
      if ((!u || auth.isGated(u)) && cfg.signup === 'invite') sendInvites(auth.pendingInvitesFor(email), mail.langOf(null, b.lang));
    });
  });

  // A change of address waiting for its link is called off: the account keeps the address it has.
  r.post('/api/auth/email/cancel', (req, res) => {
    const me = req.auth?.user;
    if (!me || req.auth?.via === 'token') throw fail(401, 'please sign in');
    res.json({ user: auth.publicUser(auth.setPendingEmail(me.id, null)) });
  });

  // ---------------------------------------------------------------- forgot password

  r.post('/api/auth/forgot', express.json(), (req, res) => {
    mailOn();
    const b = body(AskLink, req);
    const email = askedOf(b.email);
    if (!email) throw fail(400, 'which address?');
    ask(req, auth.emailKey(email));
    res.json({ ok: true });
    // one asked from an address waits at a time (lib/mail MailMessage.asker)
    const asker = ip(req);
    afterwards('reset', () => {
      const u = auth.findUserByEmail(email);
      // Disabled accounts can't sign in anyway; the machine's owner without a password has nowhere to send it.
      if (!u || u.disabled) return;
      // A sign-up nobody confirmed gets its confirmation, which takes a new password too (the verify route), never a
      // reset: one address asking resets for sign-ups of its own filled the resets' lane (A13 VERIFY-4). The asker
      // hears the same either way.
      if (auth.isGated(u)) mail.verify(u, u.email, mail.langOf(u, b.lang), { asker });
      else mail.reset(u, mail.langOf(u, b.lang), { asker });
    });
  });

  r.post('/api/auth/reset/peek', express.json(), (req, res) => {
    linkTries(req);
    const { token } = body(Token, req);
    const { state, link } = peekLink('reset', token.trim());
    const user = link && auth.getUser(link.user);
    if (state !== 'ok' || !link || !user || user.disabled) throw spent(req, state === 'ok' ? 'invalid' : (state as 'expired' | 'used' | 'invalid'));
    if (link.email !== user.email) throw fail(409, 'this link went to an address the account no longer uses', { state: 'stale' });
    res.json({ email: maskEmail(link.email), expires: new Date(link.expires).toISOString() });
  });

  r.post('/api/auth/reset', express.json(), async (req, res) => {
    linkTries(req);
    const b = body(Reset, req);
    const t = b.token.trim();
    if (!LINK_TOKEN.reset.test(t)) throw spent(req, 'invalid');
    // A password that can't be used is the person's to fix: checked before the link is spent.
    try {
      auth.checkPassword(b.password);
    } catch (e) {
      throw fail(400, (e as Error).message);
    }
    const peek = peekLink('reset', t);
    const before = peek.link && auth.getUser(peek.link.user);
    if (peek.state !== 'ok' || !peek.link || !before || before.disabled)
      throw spent(req, peek.state === 'ok' ? 'invalid' : (peek.state as 'expired' | 'used' | 'invalid'));
    // A reset signs this browser in: never over someone else's session (refused, link unused).
    notSomeoneElse(req, before);
    // It went to an address the account no longer uses: whoever holds that inbox now has no say over the account.
    if (peek.link.email !== before.email) throw fail(409, 'this link went to an address the account no longer uses', { state: 'stale' });
    // The link went to the inbox: a held account whose address that is gets let in, like with its confirm link — but
    // the invites it took were taken with the password this replaces, so they don't follow it (placeSignup).
    if (peek.link.email === before.email) await release(before, { reset: true });
    const used = useLink('reset', t);
    if (used.state !== 'ok' || !used.link) throw spent(req, used.state as 'expired' | 'used' | 'invalid');
    // A new password signs every session out (the epoch); this browser gets a fresh one below. A reset is what a person
    // reaches for when someone else may have had the password: the API tokens and connected apps it could have made go
    // too (made again in Settings in a moment).
    let user = await auth.updateUser(before.id, { password: b.password });
    voidLinks(user.id, 'reset');
    auth.revokeTokensOf(user.id);
    revokeAppsOf(user.id, 'password reset');
    afterNewPassword(user.id);
    // The inbox is proven: confirmed (a held account is let in), and from now on the password is its person's alone —
    // no workspace admin sets it (server/auth.ts).
    const done = auth.confirmAddress(user.id, user.email);
    user = auth.getUser(user.id) ?? user;
    const released = done.released;
    if (released) mail.welcome(user);
    mail.passwordChanged(user);
    cookies.set(req, res, user);
    // This browser keeps nothing from before (server/auth.ts CLEAR_SITE_DATA), the new session's cookie aside.
    res.setHeader('Clear-Site-Data', CLEAR_SITE_DATA);
    res.json({ user: auth.publicUser(user) });
  });

  return r;
}
