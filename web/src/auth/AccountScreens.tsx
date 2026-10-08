// What an email starts, on the product's one entrance (ui/Entrance.tsx): signing up, "Forgot password?", choosing a
// new password from a reset link, confirming an address from its link, and — for a sign-up whose address isn't
// confirmed yet — "Check your inbox". Every answer that could tell whether an address has an account reads the same
// either way; every link that can't be used says which way it ended (expired, used, cut off) and what to do instead.
// The frame, the fields and the way in are the sign-in's (AuthScreens.tsx), in the review link's design
// (ui/EntryForm.tsx). Loaded on demand (App.tsx, AuthGate): no part of this is in the library's first paint.
import { type FormEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { BRAND_NAME } from '../../../lib/brand.ts';
import { isGated } from '../../../lib/gate.ts';
import {
  useCancelEmail,
  useForgot,
  useResend,
  useResetPassword,
  useResetPeek,
  useSignUp,
  useVerifyLink,
  type VerifyAsks,
  type VerifyResult,
} from '../api/account.ts';
import { useAuthStatus, useSignOut } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { keptFromBefore } from '../api/persist.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { roleWord } from '../i18n/terms.ts';
import { Cmd, EntranceHead, Fine } from '../ui/Entrance.tsx';
import { AltButton, EntryField, ErrorLine, GoButton, GoLink, PasswordField, useMisses } from '../ui/EntryForm.tsx';
import { I } from '../ui/icons.tsx';
import { Skeleton, SkLine } from '../ui/Skeleton.tsx';
import { Frame, linkTag, PasswordHint } from './AuthScreens.tsx';
import { SendAgain } from './SendAgain.tsx';
import { signedInTo, withPlan } from './signupLink.ts';

/** A link's end as the server says it (404 invalid, 410 expired/used, 409 the address changed meanwhile, or the link is another account's while someone is signed in here). */
type Ended = 'expired' | 'used' | 'invalid' | 'stale' | 'other';
const endedOf = (e: unknown): Ended | null => {
  if (!(e instanceof ApiError)) return null;
  const s = e.details.state;
  return s === 'expired' || s === 'used' || s === 'invalid' || s === 'stale' || s === 'other' ? s : e.status === 404 ? 'invalid' : null;
};
const message = (e: unknown) => (e instanceof Error ? e.message : String(e));
const tooMany = (e: unknown) => e instanceof ApiError && e.status === 429;

/** Typing again takes back what the last miss said. */
const typing = (set: (v: string) => void, clear: () => void) => (e: { target: { value: string } }) => {
  set(e.target.value);
  clear();
};

// ---------------------------------------------------------------- sign-up

export function SignUpScreen() {
  const info = useInfo();
  const mode = info?.signup ?? null;
  const signUp = useSignUp();
  const resend = useResend();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const tries = useMisses();
  const [sentTo, setSentTo] = useState<string | null>(null);
  // Invited people only give the address: the invite goes there again, and its link makes the account.
  const invited = mode === 'invite';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (signUp.isPending) return;
    if (!invited && !name.trim()) return tries.miss(t('Type your name first.'), 'name');
    if (!email.trim()) return tries.miss(t('Type your email first.'), 'email');
    if (!invited && password.length < 10) return tries.miss(t('The password needs at least 10 characters.'), 'password');
    tries.clear();
    try {
      await signUp.mutateAsync(invited ? { email: email.trim() } : { name: name.trim(), email: email.trim(), password });
      setSentTo(email.trim());
      setPassword('');
    } catch (err) {
      tries.miss(tooMany(err) ? t('Too many sign-ups from here. Try again in a few minutes.') : message(err));
    }
  };
  const clear = tries.clear;
  // Signed in already (the website's Start free, opened while signed in): into the app, not a second account — a paid
  // plan to Billing's picker (signupLink.ts). Once the server has said so: a status kept from an earlier visit may be a
  // session that has ended since; until then the form waits.
  const status = useAuthStatus();
  const inside = !!status.data?.user && !isGated(status.data.user);
  const sure = inside && !keptFromBefore(status.dataUpdatedAt) && !!info;
  const billing = !!info?.billing;
  useEffect(() => {
    if (sure) location.replace(signedInTo(location.hash, location.search, billing));
  }, [sure, billing]);
  if (inside) return null;
  // Sign-up is off here (or the page was opened from an old link): say so, and where to go instead.
  if (info && (!mode || mode === 'off' || !info.mail))
    return (
      <Frame testid="signup-off">
        <EntranceHead icon="lock" title={t('Sign-up is closed here')}>
          {t('Accounts on this server come from an invite. Ask whoever runs it to invite you.')}
        </EntranceHead>
        <GoLink href="#/">{t('Go to sign-in')}</GoLink>
      </Frame>
    );
  if (sentTo)
    return (
      <Frame testid="signup-sent">
        <EntranceHead icon="mail" title={t('Check your inbox')}>
          {mode === 'invite' ? (
            <T
              k="If an invite is waiting for <0>{email}</0>, it is on its way there again. Its link makes your account."
              values={{ email: sentTo }}
              tags={[(c) => <b>{c}</b>]}
            />
          ) : (
            <T k="We sent a message to <0>{email}</0>. Open it to go on: its link works for 24 hours." values={{ email: sentTo }} tags={[(c) => <b>{c}</b>]} />
          )}
        </EntranceHead>
        <SendAgain send={() => resend.mutateAsync(sentTo)} />
        <Fine>
          <p>
            <T k="Nothing yet? Check spam, or <0>use another address</0>." tags={[linkTag(() => setSentTo(null))]} />
          </p>
        </Fine>
      </Frame>
    );
  const terms = info?.terms_url ?? null;
  const privacy = info?.privacy_url ?? null;
  const ext = (href: string) => (c: ReactNode) => (
    <a href={href} target="_blank" rel="noreferrer">
      {c}
    </a>
  );
  return (
    <Frame testid="signup">
      <EntranceHead title={t('Create your account')}>
        {invited
          ? t('For people invited to {host}: the address the invite went to, and its link comes to you again.', { host: location.hostname })
          : t('A minute, then your inbox: a link confirms the address and you’re in.')}
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={signUp.isPending}>
        {!invited && (
          <EntryField
            label={t('Your name')}
            name="name"
            autoComplete="name"
            autoCapitalize="words"
            autoFocus
            value={name}
            maxLength={80}
            shake={tries.shakeOf('name')}
            onChange={typing(setName, clear)}
          />
        )}
        <EntryField
          label={t('Email')}
          type="email"
          name="email"
          autoComplete="email"
          autoFocus={invited}
          value={email}
          shake={tries.shakeOf('email')}
          onChange={typing(setEmail, clear)}
        />
        {!invited && (
          <PasswordField
            label={t('Password')}
            name="password"
            autoComplete="new-password"
            value={password}
            shake={tries.shakeOf('password')}
            onChange={typing(setPassword, clear)}
            hint={<PasswordHint value={password} />}
          />
        )}
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={signUp.isPending} disabled={signUp.isPending}>
          {invited ? t('Send my invite') : t('Create account')}
        </GoButton>
        {(terms || privacy) && (
          <p className="terms" data-testid="terms">
            {terms && privacy ? (
              <T k="By creating an account you agree to the <0>terms</0> and the <1>privacy policy</1>." tags={[ext(terms), ext(privacy)]} />
            ) : terms ? (
              <T k="By creating an account you agree to the <0>terms</0>." tags={[ext(terms)]} />
            ) : (
              <T k="How your data is handled: the <0>privacy policy</0>." tags={[ext(privacy as string)]} />
            )}
          </p>
        )}
      </form>
      <Fine>
        <p>
          <T k="Have an account? <0>Sign in</0>" tags={[(c) => <a href={withPlan('#/', location.hash, location.search)}>{c}</a>]} />
        </p>
      </Fine>
    </Frame>
  );
}

// ---------------------------------------------------------------- forgot password

export function ForgotScreen() {
  const info = useInfo();
  const forgot = useForgot();
  const [email, setEmail] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const tries = useMisses();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (forgot.isPending) return;
    if (!email.trim()) return tries.miss(t('Type your email first.'), 'email');
    tries.clear();
    try {
      await forgot.mutateAsync(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      tries.miss(tooMany(err) ? t('Too many requests from here. Try again in a few minutes.') : message(err));
    }
  };
  const back = (
    <Fine>
      <p>
        <T k="Remembered it? <0>Back to sign-in</0>" tags={[(c) => <a href="#/">{c}</a>]} />
      </p>
    </Fine>
  );
  if (info && !info.mail)
    return (
      <Frame testid="forgot-off">
        <EntranceHead icon="key" title={t('Ask for a new password')}>
          {t('This server can’t send email. Whoever runs it can set a new password for you in Settings → Users, or on the server:')}
        </EntranceHead>
        <Cmd name="lampo admin" args="reset-password --email you@example.com" label={t('Set a new password on the server')} />
        <a className="gate-alt" href="#/">
          {t('Back to sign-in')}
        </a>
      </Frame>
    );
  if (sentTo)
    return (
      <Frame testid="forgot-sent">
        <EntranceHead icon="mail" title={t('Check your inbox')}>
          <T
            k="If <0>{email}</0> has an account here, a link to choose a new password is on its way. It works for 60 minutes."
            values={{ email: sentTo }}
            tags={[(c) => <b>{c}</b>]}
          />
        </EntranceHead>
        <SendAgain send={() => forgot.mutateAsync(sentTo)} />
        {back}
      </Frame>
    );
  return (
    <Frame testid="forgot">
      <EntranceHead title={t('Forgot your password?')}>
        {t('Enter the email you sign in with, and a link to choose a new password is on its way.')}
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={forgot.isPending}>
        <EntryField
          label={t('Email')}
          type="email"
          name="email"
          autoComplete="username"
          autoFocus
          value={email}
          shake={tries.shakeOf('email')}
          onChange={typing(setEmail, tries.clear)}
        />
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={forgot.isPending} disabled={forgot.isPending}>
          {t('Send the link')}
        </GoButton>
      </form>
      {back}
    </Frame>
  );
}

// ---------------------------------------------------------------- a link that ended

/** The same answer for every link that can't be used: which way it ended, and the one thing to do now. */
function LinkEnded({ kind, ended, signedIn, action }: { kind: 'reset' | 'verify'; ended: Ended; signedIn: boolean; action?: ReactNode }) {
  const signOut = useSignOut();
  const title =
    ended === 'expired'
      ? t('This link has expired')
      : ended === 'used'
        ? t('This link was used already')
        : ended === 'stale'
          ? t('This address changed since')
          : ended === 'other'
            ? t('This link is for another account')
            : t('This link doesn’t work');
  const lede =
    ended === 'expired'
      ? kind === 'reset'
        ? t('Links to choose a new password work for 60 minutes. Ask for a new one: it takes a moment.')
        : t('Links to confirm an address work for 24 hours. Ask for a new one: it takes a moment.')
      : ended === 'used'
        ? t('Each link works once, and a newer one replaces it. Use the newest email, or ask for another link.')
        : ended === 'stale'
          ? t('The account doesn’t use this address any more, so the link has nothing left to confirm.')
          : ended === 'other'
            ? t('Someone else is signed in in this browser, and the link would not sign them out. Sign out first, then open the link again: it still works.')
            : t('It may have been cut off on its way. Open it from the email again, or ask for a new one.');
  if (ended === 'other')
    action ??= (
      <GoButton type="button" onClick={() => signOut.mutate(false, { onSettled: () => location.reload() })}>
        {t('Sign out')}
      </GoButton>
    );
  return (
    <Frame testid={`link-${ended}`}>
      <EntranceHead icon={ended === 'expired' ? 'clock' : ended === 'other' ? 'user' : 'unlink'} title={title}>
        {lede}
      </EntranceHead>
      {action ??
        (kind === 'reset' ? (
          <GoLink href="#/forgot">{t('Send a new link')}</GoLink>
        ) : (
          <GoLink href="#/">{signedIn ? t('Open {brand}', { brand: BRAND_NAME }) : t('Sign in')}</GoLink>
        ))}
      {kind === 'reset' && (
        <Fine>
          <p>
            <T k="Or <0>sign in</0> with the password you have." tags={[(c) => <a href="#/">{c}</a>]} />
          </p>
        </Fine>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------- reset: a new password from the emailed link

export function ResetScreen({ token }: { token: string }) {
  const peek = useResetPeek(token);
  const reset = useResetPassword();
  const signedIn = !!useAuthStatus().data?.user;
  const [password, setPassword] = useState('');
  const tries = useMisses();
  const [ended, setEnded] = useState<Ended | null>(null);
  const gone = ended ?? endedOf(peek.error);
  if (gone) return <LinkEnded kind="reset" ended={gone} signedIn={signedIn} />;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (reset.isPending || peek.isPending || peek.error) return;
    if (password.length < 10) return tries.miss(t('The password needs at least 10 characters.'), 'password');
    tries.clear();
    try {
      await reset.mutateAsync({ token, password });
      location.hash = '#/';
    } catch (err) {
      const end = endedOf(err);
      if (end) setEnded(end);
      else tries.miss(tooMany(err) ? t('Too many attempts from here. Try again in a few minutes.') : message(err));
    }
  };
  if (peek.error)
    return (
      <Frame testid="reset">
        <EntranceHead icon="clock" title={t('Hold on')}>
          {message(peek.error) || t('The server didn’t answer.')}
        </EntranceHead>
        <AltButton onClick={() => peek.refetch()}>
          <I name="refresh" size={14} /> {t('Try again')}
        </AltButton>
      </Frame>
    );
  // While the link is looked up: the screen itself, its address on the way (a separate skeleton, then the form 238 px
  // higher, was the screen's first look)
  const waiting = peek.isPending;
  return (
    <Frame testid="reset" screen="reset" busy={waiting}>
      <EntranceHead title={t('Choose a new password')}>
        <T
          k="For <0>{email}</0>. Every other device signed in to this account is signed out, and its API tokens and connected apps stop working."
          values={{ email: waiting ? <SkLine w="10em" /> : (peek.data?.email ?? '') }}
          tags={[(c) => <b>{c}</b>]}
        />
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={reset.isPending}>
        {/* For password managers: which account the new password is for. */}
        <input type="text" name="username" autoComplete="username" value={peek.data?.email ?? ''} readOnly hidden />
        <PasswordField
          label={t('New password')}
          name="password"
          autoComplete="new-password"
          autoFocus
          value={password}
          shake={tries.shakeOf('password')}
          onChange={typing(setPassword, tries.clear)}
          hint={<PasswordHint value={password} />}
        />
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={reset.isPending} disabled={reset.isPending || waiting}>
          {t('Set password and sign in')}
        </GoButton>
      </form>
      <Fine>
        <p>{t('The link works once.')}</p>
      </Fine>
    </Frame>
  );
}

// ---------------------------------------------------------------- confirming an address from its link

/** What the server answers when a held account's link needs its password (409) or got a wrong one (403). */
const asksOf = (e: unknown): VerifyAsks | null => (e instanceof ApiError && e.details.state === 'password' ? (e.details as unknown as VerifyAsks) : null);

/**
 * A held account's link opened anywhere but the browser that chose its password: whoever opens it types that password
 * (the same person on another device), or chooses a new one (the address's owner when someone else made the account —
 * the invites taken with the other password stay behind). Says what confirming with that password would join, and what
 * a new one leaves behind: never a join that won't happen.
 */
type VerifyBody = { token: string; password?: string; new_password?: string; name?: string };

const joinKey = (j: VerifyAsks['joins'][number]) => `${j.workspace ?? ''}\u0000${j.by}\u0000${j.role}`;

function HeldConfirm({
  token,
  asks,
  verify,
  send,
}: {
  token: string;
  asks: VerifyAsks;
  verify: ReturnType<typeof useVerifyLink>;
  send: (b: VerifyBody) => Promise<unknown>;
}) {
  const [mode, setMode] = useState<'prove' | 'new'>('prove');
  const [password, setPassword] = useState('');
  const tries = useMisses();
  const fresh = mode === 'new';
  const field = fresh ? 'new-password' : 'password';
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (verify.isPending) return;
    if (fresh && password.length < 10) return tries.miss(t('The password needs at least 10 characters.'), field);
    if (!password) return tries.miss(t('Type your password first.'), field);
    tries.clear();
    try {
      await send(fresh ? { token, new_password: password } : { token, password });
    } catch (err) {
      if (nameAskOf(err)) return;
      tries.miss(
        tooMany(err)
          ? t('Too many attempts from here. Try again in a few minutes.')
          : asksOf(err)
            ? t('That isn’t the password this account was made with.')
            : message(err),
        field,
      );
    }
  };
  const switchTo = (m: 'prove' | 'new') => {
    setMode(m);
    setPassword('');
    tries.clear();
  };
  return (
    <Frame testid={fresh ? 'verify-new' : 'verify-password'}>
      <EntranceHead title={fresh ? t('Choose your password') : t('Finish signing up')}>
        {fresh ? (
          <T k="<0>{email}</0> is yours: choose the password you’ll sign in with." values={{ email: asks.email }} tags={[(c) => <b>{c}</b>]} />
        ) : (
          <T
            k="To confirm <0>{email}</0> here, type the password chosen when this account was made."
            values={{ email: asks.email }}
            tags={[(c) => <b>{c}</b>]}
          />
        )}
      </EntranceHead>
      {!fresh && asks.joins.length > 0 && (
        <ul className="auth-list" data-testid="verify-joins">
          {asks.joins.map((j) => (
            <li key={joinKey(j)}>
              {j.workspace
                ? t('Joins {workspace} as {role}, invited by {by}.', { workspace: j.workspace, role: roleWord(j.role), by: j.by })
                : t('Joins a workspace as {role}, invited by {by}.', { role: roleWord(j.role), by: j.by })}
            </li>
          ))}
        </ul>
      )}
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={verify.isPending}>
        {/* For password managers: which account the password is for. */}
        <input type="text" name="username" autoComplete="username" value={asks.email} readOnly hidden />
        <PasswordField
          key={mode}
          label={fresh ? t('New password') : t('Password')}
          name={field}
          autoComplete={fresh ? 'new-password' : 'current-password'}
          autoFocus
          value={password}
          bad={!fresh && !!tries.error}
          shake={tries.shakeOf(field)}
          onChange={typing(setPassword, tries.clear)}
          hint={fresh ? <PasswordHint value={password} /> : undefined}
        />
        {/* A new password drops the invites taken with the old one (the server's placeSignup): what they'd have joined is
            left behind, said as such, so the person knows whom to ask for an invite again. */}
        {fresh && asks.joins.length > 0 && (
          <div className="auth-list" data-testid="verify-left">
            <p>{t('A new password leaves these invites behind: if one was meant for you, ask for it again.')}</p>
            <ul>
              {asks.joins.map((j) => (
                <li key={joinKey(j)}>
                  {j.workspace
                    ? t('{workspace} as {role}, invited by {by}.', { workspace: j.workspace, role: roleWord(j.role), by: j.by })
                    : t('A workspace as {role}, invited by {by}.', { role: roleWord(j.role), by: j.by })}
                </li>
              ))}
            </ul>
          </div>
        )}
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={verify.isPending} disabled={verify.isPending}>
          {fresh ? t('Set password and sign in') : t('Confirm and sign in')}
        </GoButton>
      </form>
      <Fine>
        <p>
          {fresh ? (
            <T k="Know the password it was made with? <0>Type it instead</0>" tags={[linkTag(() => switchTo('prove'), 'verify-prove')]} />
          ) : (
            <T k="Didn’t sign up yourself, or forgot the password? <0>Choose a new one</0>" tags={[linkTag(() => switchTo('new'), 'verify-choose')]} />
          )}
        </p>
      </Fine>
    </Frame>
  );
}

/** The name taken in the workspace the account would join (409 `name`), or null. */
const nameAskOf = (e: unknown): string | null =>
  e instanceof ApiError && e.details.state === 'name' ? String((e.details as { name?: string }).name ?? '') : null;

/**
 * Someone in the workspace this account joins already goes by its name (names tell people apart on notes): another
 * one, and the confirmation goes on (with the password the last try gave, when it needed one).
 */
function NameTaken({ taken, verify, send }: { taken: string; verify: ReturnType<typeof useVerifyLink>; send: (name: string) => Promise<unknown> }) {
  const [name, setName] = useState('');
  const tries = useMisses();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (verify.isPending) return;
    if (!name.trim()) return tries.miss(t('Type your name first.'), 'name');
    tries.clear();
    try {
      await send(name.trim());
    } catch (err) {
      tries.miss(nameAskOf(err) !== null ? t('Someone there goes by that name too. Try another.') : message(err), 'name');
    }
  };
  return (
    <Frame testid="verify-name">
      <EntranceHead title={t('Choose another name')}>
        <T
          k="Someone in the workspace you’re joining already goes by <0>{name}</0>. Names tell people apart on notes: choose another to join."
          values={{ name: taken }}
          tags={[(c) => <b>{c}</b>]}
        />
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={verify.isPending}>
        <EntryField
          label={t('Your name')}
          name="name"
          autoComplete="name"
          autoFocus
          maxLength={80}
          value={name}
          bad={!!tries.error}
          shake={tries.shakeOf('name')}
          onChange={typing(setName, tries.clear)}
        />
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={verify.isPending} disabled={verify.isPending}>
          {t('Join')}
        </GoButton>
      </form>
    </Frame>
  );
}

export function VerifyScreen({ token }: { token: string }) {
  const verify = useVerifyLink();
  const status = useAuthStatus().data;
  const signedIn = !!status?.user;
  const asked = useRef(false);
  // The page posts the token once it is open (it never travels in a URL). A second render must not post it again.
  useEffect(() => {
    if (asked.current) return;
    asked.current = true;
    verify.mutate({ token });
  }, [verify, token]);
  // What the last try sent: a retry with another name sends the password it gave again.
  const last = useRef<VerifyBody>({ token });
  const send = (b: VerifyBody) => {
    last.current = b;
    return verify.mutateAsync(b);
  };
  // A held account opened elsewhere: the server asks for its password (kept while a try is on its way).
  const [asks, setAsks] = useState<VerifyAsks | null>(null);
  const nowAsks = asksOf(verify.error);
  useEffect(() => {
    if (nowAsks) setAsks(nowAsks);
  }, [nowAsks]);
  // Its name is taken in the workspace it joins: another one (kept while a try is on its way).
  const [taken, setTaken] = useState<string | null>(null);
  const nowTaken = nameAskOf(verify.error);
  useEffect(() => {
    if (nowTaken !== null) setTaken(nowTaken);
  }, [nowTaken]);
  if (taken !== null && !verify.data) return <NameTaken taken={taken} verify={verify} send={(name) => send({ ...last.current, name })} />;
  if (asks && !verify.data) return <HeldConfirm token={token} asks={nowAsks ?? asks} verify={verify} send={send} />;
  const ended = endedOf(verify.error);
  if (ended === 'used' && verify.error instanceof ApiError && verify.error.details.confirmed)
    return (
      <Frame testid="verify-done-before">
        <EntranceHead icon="check" title={t('Already confirmed')}>
          {t('This address was confirmed with this link before. Nothing more to do.')}
        </EntranceHead>
        <GoLink href="#/">{signedIn ? t('Open {brand}', { brand: BRAND_NAME }) : t('Sign in')}</GoLink>
      </Frame>
    );
  if (ended) return <LinkEnded kind="verify" ended={ended} signedIn={signedIn} />;
  // An account held for an invite whose invite someone else took first, or that was withdrawn (the link stays unused).
  if (verify.error instanceof ApiError && verify.error.details.state === 'invite')
    return (
      <Frame testid="verify-invite-gone">
        <EntranceHead icon="unlink" title={t('This invite can’t be used')}>
          {t('The invite link was already used, revoked or has expired. Ask whoever invited you for a new one.')}
        </EntranceHead>
        <GoLink href="#/">{t('Go to sign-in')}</GoLink>
      </Frame>
    );
  const r: VerifyResult | undefined = verify.data;
  // the link on its way to the server: the screen's head and its way on, their words to come
  if (verify.isPending || verify.isIdle)
    return (
      <Frame testid="verify" screen="verify" busy>
        <EntranceHead icon="mail" title={t('Confirming your address')}>
          <SkLine w="16em" />
        </EntranceHead>
        <Skeleton w="100%" h="var(--h-lg)" r="var(--r)" className="ent-go-sk" />
      </Frame>
    );
  if (verify.error)
    return (
      <Frame testid="verify">
        <EntranceHead icon="clock" title={t('Not quite yet')}>
          {tooMany(verify.error)
            ? t('Too many attempts from here. Try again in a few minutes.')
            : verify.error instanceof ApiError && verify.error.status === 402
              ? // the plan of a workspace it joins has no room now: its own sentence (the link still works)
                message(verify.error)
              : t('Your account couldn’t be finished just now. The link still works: try again in a moment.')}
        </EntranceHead>
        <GoButton type="button" onClick={() => verify.mutate({ token })}>
          {t('Try again')}
        </GoButton>
      </Frame>
    );
  if (r?.kind === 'changed')
    return (
      <Frame testid="verify">
        <EntranceHead icon="check" title={t('Your address is changed')}>
          <T k="You sign in with <0>{email}</0> from now on." values={{ email: r.email }} tags={[(c) => <b>{c}</b>]} />
        </EntranceHead>
        <GoLink href="#/">{signedIn ? t('Back to {brand}', { brand: BRAND_NAME }) : t('Sign in')}</GoLink>
      </Frame>
    );
  if (r?.released && !r.signedIn && !signedIn)
    return (
      <Frame testid="verify">
        <EntranceHead icon="check" title={t('Address confirmed')}>
          <T k="<0>{email}</0> is confirmed. Sign in with your password to go on." values={{ email: r.email }} tags={[(c) => <b>{c}</b>]} />
        </EntranceHead>
        <GoLink href="#/" data-testid="verify-signin">
          {t('Sign in')}
        </GoLink>
      </Frame>
    );
  if (r?.released)
    return (
      <Frame testid="verify">
        <EntranceHead icon="check" title={t('You’re in')}>
          <T k="<0>{email}</0> is confirmed. Welcome to {brand}." values={{ email: r.email, brand: BRAND_NAME }} tags={[(c) => <b>{c}</b>]} />
        </EntranceHead>
        <GoLink href="#/" data-testid="verify-open">
          {t('Open {brand}', { brand: BRAND_NAME })}
        </GoLink>
      </Frame>
    );
  return (
    <Frame testid="verify">
      <EntranceHead icon="check" title={t('Address confirmed')}>
        <T k="<0>{email}</0> is confirmed: password links and notices reach you there." values={{ email: r?.email ?? '' }} tags={[(c) => <b>{c}</b>]} />
      </EntranceHead>
      <GoLink href="#/">{signedIn ? t('Open {brand}', { brand: BRAND_NAME }) : t('Sign in')}</GoLink>
    </Frame>
  );
}

// ---------------------------------------------------------------- held: a sign-up waiting for its address

/**
 * A sign-up that can sign in but can do nothing until its address is confirmed (the server holds it): check your
 * inbox, send it again, sign out. The address stays the one signed up with (its confirmation goes nowhere else): a
 * mistyped one is a new sign-up. The page notices a confirmation made on another device.
 */
export function HeldScreen() {
  const status = useAuthStatus();
  const user = status.data?.user;
  const resend = useResend();
  const cancel = useCancelEmail();
  const signOut = useSignOut();
  // Confirmed on a phone meanwhile: ask again now and then, and when the tab comes back.
  const { refetch } = status;
  useEffect(() => {
    const again = () => void refetch();
    const id = setInterval(again, 10_000);
    window.addEventListener('focus', again);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', again);
    };
  }, [refetch]);
  if (!user) return null;
  const to = user.pending_email || user.email;
  const again = () =>
    signOut.mutate(false, {
      onSettled: () => {
        location.hash = '#/signup';
      },
    });
  return (
    <Frame testid="held">
      <EntranceHead icon="mail" title={t('Check your inbox')}>
        <T k="We sent a link to <0>{email}</0>. Open it to finish signing up: it works for 24 hours." values={{ email: to }} tags={[(c) => <b>{c}</b>]} />
      </EntranceHead>
      <SendAgain send={() => resend.mutateAsync(undefined)} />
      <Fine>
        <p>
          {user.pending_email ? (
            <T k="Back to <0>{email}</0>? <1>Use it again</1>" values={{ email: user.email }} tags={[(c) => <b>{c}</b>, linkTag(() => cancel.mutate())]} />
          ) : (
            <T k="Mistyped it? <0>Sign up again</0> with the right address." tags={[linkTag(again, 'held-again')]} />
          )}{' '}
          <T k="Or <0>sign out</0>." tags={[linkTag(() => signOut.mutate(false))]} />
        </p>
      </Fine>
    </Frame>
  );
}
