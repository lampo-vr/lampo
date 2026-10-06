// The first screens of a hosted server: setting up the owner account, signing in, accepting an invite, and letting an
// app connect through OAuth — each the product's one entrance (ui/Entrance.tsx): the brand film on the left, the form
// on the right, in the same design as a review link's password gate (guest/Gate.tsx): the fields, the eye, the line
// kept for a miss and the orange way in are one set of parts (ui/EntryForm.tsx).
import { type FormEvent, Fragment, type ReactElement, type ReactNode, useEffect, useState } from 'react';
import { BRAND_NAME } from '../../../lib/brand.ts';
import { isScope } from '../../../lib/scopes.ts';
import { useResend } from '../api/account.ts';
import { useAcceptInvite, useAuthStatus, useOAuthDecision, useOAuthRequest, usePeekInvite, useSetup, useSignIn, useSignOut } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { useInfo } from '../api/queries.ts';
import type { Info, Role } from '../api/types.ts';
import { useSwitchWorkspace } from '../api/workspaces.ts';
import { useCooldown } from '../lib/hooks.ts';
import type { OAuthErrorCode } from '../lib/nav.ts';
import { Cmd, Entrance, EntranceFrom, EntranceFromPending, EntranceHead, Fine, Qm, useDisclosure } from '../ui/Entrance.tsx';
import { AltButton, EntryField, ErrorLine, GoButton, GoLink, PasswordField, useMisses } from '../ui/EntryForm.tsx';
import { I, Wordmark } from '../ui/icons.tsx';
import { Skeleton, SkLine } from '../ui/Skeleton.tsx';
import '../styles/auth.css';
import { locale, perLang, t } from '../i18n/index.ts';
import { scopeHint, scopeLabel } from '../i18n/scopeTerms.ts';
import { T } from '../i18n/T.tsx';
import { roleWord } from '../i18n/terms.ts';
import { SendAgain } from './SendAgain.tsx';

/** Kept room for words still on their way (the foot's version and source): there, unseen, so nothing slides once they come. */
const Waiting = ({ children }: { children: ReactNode }) => (
  <span className="ent-wait" aria-hidden="true">
    {children}
  </span>
);

/** The operator's legal pages (A13 CLOUD-1, lib/legal.ts), each where it is set, with a quiet dot between them. */
export function legalLinks(info: Info | null | undefined): ReactNode[] {
  const links = [
    info?.imprint_url && (
      <a key="imprint" href={info.imprint_url} target="_blank" rel="noreferrer" data-testid="imprint-link">
        {t('Imprint')}
      </a>
    ),
    info?.privacy_url && (
      <a key="privacy" href={info.privacy_url} target="_blank" rel="noreferrer" data-testid="privacy-link">
        {t('Privacy')}
      </a>
    ),
    info?.terms_url && (
      <a key="terms" href={info.terms_url} target="_blank" rel="noreferrer" data-testid="terms-link">
        {t('Terms')}
      </a>
    ),
    // § 312k BGB, where a billing provider runs: the operator's own page (no sign-in), else Billing's cancellation
    (info?.cancel_url || info?.billing) && (
      <a
        key="cancel"
        href={info.cancel_url || '#/settings/billing/cancel'}
        {...(info.cancel_url ? { target: '_blank', rel: 'noreferrer' } : {})}
        data-testid="cancel-link"
      >
        {t('Cancel contracts here')}
      </a>
    ),
  ].filter((l): l is ReactElement => !!l);
  return links.map((l, i) => (
    <Fragment key={l.key}>
      {i > 0 && <i aria-hidden="true">·</i>}
      {l}
    </Fragment>
  ));
}

/** Under the server's line: who runs it and on what terms — held in place until /api/info says, like the version. */
function LegalLine({ info }: { info: Info | null | undefined }) {
  if (!info)
    return (
      <p className="ent-foot-line">
        <Waiting>{t('Imprint')}</Waiting>
        <Waiting>·</Waiting>
        <Waiting>{t('Privacy')}</Waiting>
      </p>
    );
  const links = legalLinks(info);
  return links.length ? (
    <p className="ent-foot-line" data-testid="ent-legal">
      {links}
    </p>
  ) : null;
}

// The owner's screens stand on the product's one entrance, like a review link: the film, the theme at the top, the form,
// and a quiet line at the foot — which server this is, its version, its source — and under it the operator's legal pages. `screen`: which screen this is, shared
// by its loading state (Entrance holds the column where that put it); `busy`: the column is that loading state.
export function Frame({ children, testid, screen, busy }: { children: ReactNode; testid?: string; screen?: string; busy?: boolean }) {
  const info = useInfo();
  return (
    <Entrance
      className="auth"
      testid={testid}
      screen={screen}
      caption={t('Video feedback your AI agent can act on.')}
      logo={
        <a className="brand" href="#/">
          <Wordmark />
        </a>
      }
      foot={
        // the version and the source held in place until /api/info says them: the line grew from the host alone and
        // slid sideways to stay centred
        <>
          <p className="ent-foot-line">
            <span>{location.host}</span>
            {info ? (
              info.version && (
                <>
                  <i aria-hidden="true">·</i>
                  <span>v{info.version}</span>
                </>
              )
            ) : (
              <>
                <Waiting>·</Waiting>
                <Waiting>v0.0.0</Waiting>
              </>
            )}
            {info ? (
              info.source_url && (
                <>
                  <i aria-hidden="true">·</i>
                  <a href={info.source_url} target="_blank" rel="noreferrer" data-testid="source-link">
                    {t('source')}
                  </a>
                </>
              )
            ) : (
              <>
                <Waiting>·</Waiting>
                <Waiting>{t('source')}</Waiting>
              </>
            )}
          </p>
          <LegalLine info={info} />
        </>
      }
    >
      {busy ? (
        <div className="ent-busy" role="status" aria-busy="true" aria-label={t('Loading')} data-testid="skeleton">
          {children}
        </div>
      ) : (
        children
      )}
    </Entrance>
  );
}

/** How long a password is, under its field: plain until 10, a warning below it. */
export function PasswordHint({ value }: { value: string }) {
  const short = value.length > 0 && value.length < 10;
  return (
    <span className={short ? 'warn' : ''}>
      {value.length
        ? short
          ? t('{n} characters — at least 10', { n: value.length })
          : t('{n} characters', { n: value.length })
        : t('At least 10 characters.')}
    </span>
  );
}

/** A link-like button inside a sentence of the fine print ("use another address", "Sign out"), as a <T> tag. */
export const linkTag = (onClick: () => void, testid?: string) => (c: ReactNode) => (
  <button type="button" className="ent-link-btn" onClick={onClick} data-testid={testid}>
    {c}
  </button>
);

/** Typing again takes back what the last miss said. */
const typing = (set: (v: string) => void, clear: () => void) => (e: { target: { value: string } }) => {
  set(e.target.value);
  clear();
};

export function SignInScreen({ resumed }: { resumed: boolean }) {
  const info = useInfo();
  const server = info?.public_url || location.origin;
  const signup = info?.signup && info.signup !== 'off' ? info.signup : null;
  const signIn = useSignIn();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const tries = useMisses();
  const cooldown = useCooldown();
  const agent = useDisclosure();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (cooldown.left || signIn.isPending) return;
    if (!email.trim()) return tries.miss(t('Type your email first.'), 'email');
    if (!password) return tries.miss(t('Type your password first.'), 'password');
    tries.clear();
    try {
      await signIn.mutateAsync({ email: email.trim(), password });
    } catch (err) {
      setPassword('');
      if (err instanceof ApiError && err.status === 429 && err.retryAfter) {
        cooldown.start(err.retryAfter);
        tries.miss(t('Too many sign-in attempts from here.'), 'password');
      } else
        tries.miss(
          err instanceof ApiError && err.status === 401 ? t('That email and password don’t match an account.') : String((err as Error).message),
          'password',
        );
    }
  };
  // In front of an app's request to connect (#/oauth/<request>): the app sent the person here, so the screen says so
  // and leaves agents' own sign-in out of it
  const forApp = /^#\/oauth\/[A-Za-z0-9_-]+$/.test(location.hash);
  return (
    <Frame testid="signin">
      <EntranceHead title={t('Sign in')}>
        {forApp
          ? t('An app asks to work with your reviews. Sign in, then decide what it may do.')
          : resumed
            ? t('Your session ended. Sign in and you’re back where you were.')
            : t('Frame-exact notes, straight to the agents that made the cut.')}
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={signIn.isPending}>
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
        <PasswordField
          label={t('Password')}
          name="password"
          autoComplete="current-password"
          value={password}
          bad={!!tries.error && tries.shakeOf('password') !== undefined}
          shake={tries.shakeOf('password')}
          onChange={typing(setPassword, tries.clear)}
          aside={
            // its place there from the first paint, held unseen until /api/info says this server sends mail
            !info ? (
              <Waiting>{t('Forgot password?')}</Waiting>
            ) : info.mail ? (
              <a href="#/forgot" data-testid="forgot-link">
                {t('Forgot password?')}
              </a>
            ) : undefined
          }
        />
        <ErrorLine>
          {tries.error}
          {tries.error && cooldown.left > 0 && (
            <>
              {' '}
              <T k="Try again in <0>{label}</0>." values={{ label: cooldown.label }} tags={[(c) => <b className="mono">{c}</b>]} />
            </>
          )}
        </ErrorLine>
        <GoButton busy={signIn.isPending} disabled={signIn.isPending || cooldown.left > 0}>
          {t('Sign in')}
        </GoButton>
      </form>
      <Fine after={forApp ? undefined : agent.body(<Cmd name="vr login" args={server} label={t('Agents sign in with')} />)}>
        <p>
          {/* the line kept while /api/info says whether this server has sign-up: the sign-up-off sentence showed first
              on every server, then swapped */}
          {!info ? (
            <SkLine w="14em" />
          ) : signup === 'open' ? (
            <T k="New here? <0>Create an account</0>" tags={[(c) => <a href="#/signup">{c}</a>]} />
          ) : signup === 'invite' ? (
            <>
              <T k="Invited? <0>Create your account</0>" tags={[(c) => <a href="#/signup">{c}</a>]} />{' '}
              <Qm side="start">{t('Use the address the invite went to.')}</Qm>
            </>
          ) : (
            t('No account? Ask whoever runs this server to add you.')
          )}
        </p>
        {!forApp && agent.button('command', t('Sign in an agent'))}
      </Fine>
    </Frame>
  );
}

/** What went wrong with the setup, in the reader's language where the server's answer is known. */
function setupError(err: unknown): string {
  if (err instanceof ApiError && err.status === 403)
    return t('That isn’t the setup token. Copy it again from the server log: it is printed each time the server starts.');
  if (err instanceof ApiError && err.status === 409) return t('This server is set up already: reload the page to sign in.');
  return (err as Error).message;
}

/** What went wrong accepting an invite, in the reader's language where the server's answer is known. */
function inviteError(err: unknown): string {
  if (err instanceof ApiError && err.status === 404)
    return t('The invite link was already used, revoked or has expired. Ask whoever invited you for a new one.');
  if (err instanceof ApiError && /another e-mail/.test(err.message)) return t('This invite is for another email address: use the one you were invited with.');
  return (err as Error).message;
}

/** Who invites, as what (the line under the inviter's name; `<0>` is the role). */
const invitesAs = (role: Role) => {
  const tags = [(c: ReactNode) => <b>{c}</b>];
  if (role === 'owner') return <T k="invites you as an <0>owner</0>" tags={tags} />;
  if (role === 'admin') return <T k="invites you as an <0>admin</0>" tags={tags} />;
  if (role === 'member') return <T k="invites you as a <0>member</0>" tags={tags} />;
  return <T k="invites you as a <0>reviewer</0>" tags={tags} />;
};

/** What the role lets you do, in one sentence. */
const roleLine = (role: Role) =>
  role === 'owner'
    ? t('As an owner you can do everything, including managing other owners.')
    : role === 'admin'
      ? t('As an admin you can do everything except managing owners.')
      : role === 'member'
        ? t('As a member you upload videos, write notes, share review links and work with agents.')
        : t('As a reviewer you watch, leave notes, check fixes and approve.');

const tokenFromUrl = () => {
  const t = new URLSearchParams(location.search).get('setup');
  return t && t.length > 8 ? t : '';
};

export function SetupScreen() {
  const setup = useSetup();
  const [token, setToken] = useState(tokenFromUrl);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const tries = useMisses();
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (setup.isPending) return;
    if (!token.trim()) return tries.miss(t('Paste the setup token first.'), 'token');
    if (!name.trim()) return tries.miss(t('Type your name first.'), 'name');
    if (!email.trim()) return tries.miss(t('Type your email first.'), 'email');
    if (password.length < 10) return tries.miss(t('The password needs at least 10 characters.'), 'password');
    tries.clear();
    try {
      await setup.mutateAsync({ token: token.trim(), name: name.trim(), email: email.trim(), password });
      if (location.search) history.replaceState(null, '', location.pathname + location.hash);
    } catch (err) {
      tries.miss(setupError(err), err instanceof ApiError && err.status === 403 ? 'token' : null);
    }
  };
  const clear = tries.clear;
  return (
    <Frame testid="setup">
      <EntranceHead title={t('Set up this server')}>
        {t('This server has no accounts yet. Create the owner account; everyone else you invite from Settings.')}
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={setup.isPending}>
        <EntryField
          label={t('Setup token')}
          mono
          name="token"
          autoComplete="one-time-code"
          spellCheck={false}
          autoFocus={!token}
          value={token}
          shake={tries.shakeOf('token')}
          bad={tries.shakeOf('token') !== undefined}
          onChange={typing(setToken, clear)}
          hint={
            <>
              <span>{t('Printed in the server log at start. Or run on the server:')}</span>
              <Cmd name="vr admin" args="create-user --role owner" label={t('Create the owner on the server')} />
            </>
          }
        />
        <EntryField
          label={t('Your name')}
          name="name"
          autoComplete="name"
          autoFocus={!!token}
          value={name}
          shake={tries.shakeOf('name')}
          onChange={typing(setName, clear)}
          hint={t('It signs your notes, so agents and the people you share with know who asked.')}
        />
        <EntryField
          label={t('Email')}
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          shake={tries.shakeOf('email')}
          onChange={typing(setEmail, clear)}
        />
        <PasswordField
          label={t('Password')}
          name="password"
          autoComplete="new-password"
          value={password}
          shake={tries.shakeOf('password')}
          onChange={typing(setPassword, clear)}
          hint={<PasswordHint value={password} />}
        />
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={setup.isPending} disabled={setup.isPending}>
          {t('Create the owner account')}
        </GoButton>
      </form>
    </Frame>
  );
}

// An invite link: whoever opens it first chooses a name, email and password and is signed in with the role the invite
// was made for. The token lives in the URL fragment, so it never reaches the server's logs.
export function InviteScreen({ token }: { token: string }) {
  const status = useAuthStatus().data;
  const signedIn = status?.user ?? null;
  const peek = usePeekInvite(token);
  const accept = useAcceptInvite();
  const signOut = useSignOut();
  const go = useSwitchWorkspace();
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const tries = useMisses();
  // The address the confirm link went to (a server with workspaces: the invite's link alone vouches for no inbox).
  const [sentTo, setSentTo] = useState<string | null>(null);
  const invite = peek.data;
  const resend = useResend();
  useEffect(() => {
    if (!invite) return;
    setName((n) => n || invite.name || '');
    setEmail((e) => e || invite.email || '');
  }, [invite]);
  // An invite into a workspace on a server with several: someone signed in here joins it with their own account.
  const joining = !!invite?.several && !!signedIn && status?.via === 'cookie' && invite.you === 'join';
  // Someone in that workspace already (whoever made the invite, trying the link): it stays for whoever it is meant for.
  const member = !!invite?.several && !!signedIn && status?.via === 'cookie' && invite.you === 'member';
  const openWorkspace = () => {
    const id = invite?.workspace_id;
    if (!id || status?.workspace?.id === id) location.hash = '#/';
    else go.mutateAsync(id).catch((err: Error) => tries.say(err.message));
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (accept.isPending) return;
    if (joining) {
      if (!password) return tries.miss(t('Type your password first.'), 'password');
    } else {
      if (!name.trim()) return tries.miss(t('Type your name first.'), 'name');
      if (!email.trim()) return tries.miss(t('Type your email first.'), 'email');
      if (password.length < 10) return tries.miss(t('The password needs at least 10 characters.'), 'password');
    }
    tries.clear();
    try {
      const r =
        joining && signedIn
          ? await accept.mutateAsync({ token, name: signedIn.name, email: signedIn.email, password })
          : await accept.mutateAsync({ token, name: name.trim(), email: email.trim(), password });
      if ('held' in r) {
        setSentTo(email.trim());
        setPassword('');
      }
    } catch (err) {
      tries.miss(inviteError(err), joining ? 'password' : null);
    }
  };
  const clear = tries.clear;
  const gone = peek.error instanceof ApiError && peek.error.status === 404;
  // who invites, as what — the invite's own line above its title (the inviter has no picture here: their initials)
  const from = invite && (
    <EntranceFrom name={invite.by} org={invite.workspace}>
      {invitesAs(invite.role)}
    </EntranceFrom>
  );
  if (sentTo)
    return (
      <Frame testid="invite-sent">
        <EntranceHead icon="mail" title={t('Check your inbox')}>
          <T k="We sent a message to <0>{email}</0>. Open it to go on: its link works for 24 hours." values={{ email: sentTo }} tags={[(c) => <b>{c}</b>]} />
        </EntranceHead>
        {/* as a sign-up's: the held account's link again (POST /api/auth/verify/resend) */}
        <SendAgain send={() => resend.mutateAsync(sentTo)} />
        <Fine>
          <p>
            <T k="Nothing yet? Check spam, or <0>use another address</0>." tags={[linkTag(() => setSentTo(null))]} />
          </p>
        </Fine>
      </Frame>
    );
  if (status?.via === 'local')
    // The machine the app runs on is its owner's: the invite is for the person it was made for, on their device.
    return (
      <Frame testid="invite-owner">
        <EntranceHead icon="user" title={t('This link is for someone else')}>
          {t('You’re at the machine the app runs on, signed in as its owner. Send the link to the person you invited: they open it on their own device.')}
        </EntranceHead>
        <GoLink href="#/">{t('Open the library')}</GoLink>
      </Frame>
    );
  if (member && invite && signedIn)
    return (
      <Frame testid="invite-member">
        <EntranceHead
          icon="users"
          title={invite.workspace ? t('You’re in {workspace} already', { workspace: invite.workspace }) : t('You’re in this workspace already')}
        >
          <T
            k={'You’re signed in as <0>{name}</0>, one of its members. The invite stays unused, for whoever it was made for.'}
            values={{ name: signedIn.name }}
            tags={[(c) => <b>{c}</b>]}
          />
        </EntranceHead>
        <div className="inv-form">
          {tries.error && <ErrorLine>{tries.error}</ErrorLine>}
          <GoButton type="button" onClick={openWorkspace} busy={go.isPending} disabled={go.isPending} data-testid="invite-open">
            {invite.workspace ? t('Open {workspace}', { workspace: invite.workspace }) : t('Open the workspace')}
          </GoButton>
        </div>
      </Frame>
    );
  if (joining && invite && signedIn)
    return (
      <Frame testid="invite-joining">
        {from}
        <EntranceHead title={invite.workspace ? t('Join {workspace}', { workspace: invite.workspace }) : t('Join {by}’s workspace', { by: invite.by })}>
          <T
            k="You’re signed in as <0>{name}</0>: your password joins this account to the workspace."
            values={{ name: signedIn.name }}
            tags={[(c) => <b>{c}</b>]}
          />
        </EntranceHead>
        <form className="inv-form" onSubmit={submit} noValidate aria-busy={accept.isPending}>
          <PasswordField
            label={t('Your password')}
            name="password"
            autoComplete="current-password"
            autoFocus
            value={password}
            bad={!!tries.error}
            shake={tries.shakeOf('password')}
            onChange={typing(setPassword, clear)}
          />
          <ErrorLine>{tries.error}</ErrorLine>
          <GoButton busy={accept.isPending} disabled={accept.isPending} data-testid="invite-join">
            {t('Join')}
          </GoButton>
        </form>
        <Fine>
          <p>
            <T k="Not you? <0>Sign out</0>" tags={[linkTag(() => signOut.mutate(false))]} />
          </p>
        </Fine>
      </Frame>
    );
  // (once the invite is known: while it is looked up, a signed-in person most likely joins with it — below)
  if (signedIn && invite)
    return (
      <Frame testid="invite-signed-in">
        <EntranceHead icon="user" title={t('You’re already signed in')}>
          <T
            k={'You’re signed in as <0>{name}</0>. This invite is for someone new: sign out first if you want to create another account with it.'}
            values={{ name: signedIn.name }}
            tags={[(c) => <b>{c}</b>]}
          />
        </EntranceHead>
        <GoButton type="button" onClick={() => signOut.mutate(false)} busy={signOut.isPending} disabled={signOut.isPending}>
          {t('Sign out and use the invite')}
        </GoButton>
        <Fine>
          <p>
            <T k={'Or go <0>back to the library</0>.'} tags={[(c) => <a href="#/">{c}</a>]} />
          </p>
        </Fine>
      </Frame>
    );
  if (!invite && !peek.isPending)
    return (
      <Frame testid="invite-gone">
        <EntranceHead icon="unlink" title={gone ? t('This invite can’t be used') : t('Hold on')}>
          {gone
            ? t('The invite link was already used, revoked or has expired. Ask whoever invited you for a new one.')
            : (peek.error as Error | null)?.message || t('The server didn’t answer.')}
        </EntranceHead>
        <GoLink href="#/">{t('Go to sign-in')}</GoLink>
      </Frame>
    );
  // While the invite is looked up: the form itself, who invites and as what on the way (a separate skeleton, then the
  // form 238 px higher, was an invite's first look). Someone signed in here most likely joins with their password.
  if (!invite && signedIn)
    return (
      <Frame screen="invite-joining" busy>
        <EntranceFromPending />
        <EntranceHead title={<SkLine w="9em" />}>
          <SkLine w="100%" /> <SkLine w="40%" />
        </EntranceHead>
        <div className="inv-form">
          <PasswordField label={t('Your password')} name="password" value="" disabled onChange={() => {}} />
          <ErrorLine />
          <GoButton type="button" disabled>
            {t('Join')}
          </GoButton>
        </div>
        <Fine>
          <p>
            <SkLine w="8em" />
          </p>
        </Fine>
      </Frame>
    );
  return (
    <Frame testid={invite ? 'invite' : undefined} screen="invite" busy={!invite}>
      {from ?? <EntranceFromPending />}
      <EntranceHead title={invite ? invite.workspace ? t('Join {workspace}', { workspace: invite.workspace }) : t('You’re invited') : <SkLine w="9em" />}>
        {invite ? (
          roleLine(invite.role)
        ) : (
          <>
            <SkLine w="100%" /> <SkLine w="40%" />
          </>
        )}
      </EntranceHead>
      <form className="inv-form" onSubmit={submit} noValidate aria-busy={accept.isPending}>
        <EntryField
          label={t('Your name')}
          name="name"
          autoComplete="name"
          autoFocus
          value={name}
          shake={tries.shakeOf('name')}
          onChange={typing(setName, clear)}
          hint={t('It signs your notes.')}
        />
        <EntryField
          label={t('Email')}
          type="email"
          name="email"
          autoComplete="username"
          value={email}
          shake={tries.shakeOf('email')}
          onChange={typing(setEmail, clear)}
          aside={
            invite?.several ? (
              <>
                {t('Have an account?')} <Qm>{t('Use its email and password here: it joins with that account.')}</Qm>
              </>
            ) : undefined
          }
        />
        <PasswordField
          label={t('Password')}
          name="password"
          autoComplete="new-password"
          value={password}
          shake={tries.shakeOf('password')}
          onChange={typing(setPassword, clear)}
          hint={<PasswordHint value={password} />}
        />
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={accept.isPending} disabled={accept.isPending || !invite}>
          {t('Join')}
        </GoButton>
      </form>
      <Fine>
        <p>
          {invite ? (
            t('The link works once, until {until}.', {
              until: new Date(invite.expires).toLocaleDateString(locale(), { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' }),
            })
          ) : (
            <SkLine w="16em" />
          )}
        </p>
      </Fine>
    </Frame>
  );
}

// ---------------------------------------------------------------- an app asking to connect (OAuth)

/** The way back where there is nothing to fill in: the quiet button, as a link. */
const LibraryLink = () => (
  <a className="gate-alt" href="#/">
    {t('Open the library')}
  </a>
);

// The consent screen of the OAuth sign-in for MCP clients (ChatGPT, Claude, Cursor, …). The server already checked the
// app, where the answer goes and PKCE; this is where the person decides, seeing who asks, where the answer goes and
// what the app may do — capped by their role either way. `vr login` asks here too (`r.vr`): the same screen names the
// computer, the API token it gets and what that token may do.
export function ConsentScreen({ request }: { request: string }) {
  const { data: status, refetch: refetchStatus } = useAuthStatus();
  const me = status?.user ?? null;
  const q = useOAuthRequest(request, !!me);
  const decide = useOAuthDecision(request);
  const [handedTo, setHandedTo] = useState<'allowed' | 'denied' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const r = q.data;
  const answer = async (allow: boolean) => {
    setError(null);
    try {
      const { redirect } = await decide.mutateAsync({ allow, workspace: r?.workspace?.id });
      setHandedTo(allow ? 'allowed' : 'denied');
      location.assign(redirect);
    } catch (err) {
      // Another tab switched the session's workspace since this was shown: show where the app would work now, and ask
      // again (the app gets the workspace the person saw, never another).
      if (err instanceof ApiError && err.status === 409 && err.details.state === 'workspace') {
        await Promise.all([q.refetch(), refetchStatus()]);
        setError(t('You switched to another workspace in the meantime. Check where the app will work, then answer again.'));
      } else setError((err as Error).message);
    }
  };
  const gone = q.error instanceof ApiError && q.error.status === 404;
  const vr = r?.vr ?? null;
  if (handedTo) {
    // vr's loopback port answers without a page of its own: the browser stays here, and this says where to go on
    const name = vr ? t('vr on {machine}', { machine: vr.machine }) : r?.client_name;
    return (
      <Frame testid="consent-done">
        <EntranceHead
          icon={handedTo === 'allowed' ? 'check' : 'x'}
          title={handedTo === 'allowed' ? (vr ? t('Back to the terminal') : t('Back to the app')) : t('Access denied')}
        >
          {handedTo === 'allowed'
            ? name
              ? t('{name} takes it from here.', { name })
              : t('The app takes it from here.')
            : name
              ? t('{name} was told no.', { name })
              : t('The app was told no.')}{' '}
          {vr ? t('You can close this tab.') : t('If your browser doesn’t switch back by itself, you can close this tab.')}
        </EntranceHead>
      </Frame>
    );
  }
  // While the request is looked up: the screen itself, who asks and for what on the way (a separate skeleton, then the
  // screen 238 px higher, was its first look)
  if (q.isPending)
    return (
      <Frame screen="consent" busy>
        <EntranceHead title={t('Let it in?')}>
          <SkLine w="100%" /> <SkLine w="45%" />
        </EntranceHead>
        <ul className="consent-facts">
          {[0, 1].map((i) => (
            <li key={i}>
              <Skeleton w={14} h={14} r="var(--r-sm)" />
              <span>
                <SkLine w={i ? '14em' : '17em'} />
              </span>
            </li>
          ))}
        </ul>
        <ul className="consent-scopes">
          {[0, 1].map((i) => (
            <li key={i}>
              <b>
                <SkLine w="8em" />
              </b>
              <span>
                <SkLine w="18em" />
              </span>
            </li>
          ))}
        </ul>
        <div className="inv-form">
          <div className="consent-actions">
            <AltButton disabled>{t('Deny')}</AltButton>
            <GoButton type="button" disabled>
              {t('Allow')}
            </GoButton>
          </div>
        </div>
        <Fine>
          <p>{t('It never sees your password. Disconnect it any time under Settings → API tokens.')}</p>
        </Fine>
      </Frame>
    );
  if (!r)
    return (
      <Frame testid="consent-gone">
        <EntranceHead icon="clock" title={gone ? t('This request has ended') : t('Hold on')}>
          {gone
            ? t('The request expired or was already answered. Start the connection again from the app.')
            : (q.error as Error | null)?.message || t('The server didn’t answer.')}
        </EntranceHead>
        <LibraryLink />
      </Frame>
    );
  const capped = new Set(r.capped);
  const bold = (c: ReactNode) => <b>{c}</b>;
  const code = (c: ReactNode) => <code>{c}</code>;
  return (
    <Frame testid="consent" screen="consent">
      <EntranceHead title={t('Let it in?')}>
        {vr ? (
          <T
            k="<0>vr</0> on <1>{machine}</1> wants to work with your reviews in {brand}, as <2>{name}</2>."
            values={{ machine: vr.machine, name: me?.name ?? '', brand: BRAND_NAME }}
            tags={[bold, bold, bold]}
          />
        ) : (
          <T
            k="<0>{app}</0> wants to work with your reviews in {brand}, as <1>{name}</1>."
            values={{ app: r.client_name, name: me?.name ?? '', brand: BRAND_NAME }}
            tags={[bold, bold]}
          />
        )}
      </EntranceHead>
      <ul className="consent-facts">
        {vr ? (
          // what vr gets, named as Settings → API tokens will list it
          <li>
            <I name="key" size={14} />
            <span>
              {vr.days ? (
                <T
                  k="vr gets an API token named <0>{token}</0>, valid for {n} day.|vr gets an API token named <0>{token}</0>, valid for {n} days."
                  values={{ token: vr.token, n: vr.days }}
                  tags={[code]}
                />
              ) : (
                <T k="vr gets an API token named <0>{token}</0>, valid until you revoke it." values={{ token: vr.token }} tags={[code]} />
              )}
            </span>
          </li>
        ) : (
          <li className={r.verified ? '' : 'warn'}>
            <I name={r.verified ? 'check' : 'shield'} size={14} />
            {r.verified ? (
              <span>
                <T k="Its name comes from <0>{host}</0>." values={{ host: r.client_host }} tags={[(c) => <code>{c}</code>]} />
              </span>
            ) : (
              <span>
                {r.client_host ? (
                  <T
                    k="It named itself and says it is from <0>{host}</0>: not verified. Continue only if you just started this from {app}."
                    values={{ host: r.client_host, app: r.client_name }}
                    tags={[(c) => <code>{c}</code>]}
                  />
                ) : (
                  t('It named itself: not verified. Continue only if you just started this from {app}.', { app: r.client_name })
                )}
              </span>
            )}
          </li>
        )}
        {r.workspace && (
          <li>
            <I name="layers" size={14} />
            <span>
              <T k="It works in <0>{workspace}</0> only." values={{ workspace: r.workspace.name }} tags={[(c) => <b>{c}</b>]} />
            </span>
          </li>
        )}
        <li className={r.local_redirect ? 'warn' : ''}>
          <I name="link" size={14} />
          <span>
            {r.local_redirect ? (
              <T
                k="The answer goes to <0>{host}</0> on this computer: any program here could be asking, so only continue if you started the sign-in yourself."
                values={{ host: r.redirect_host }}
                tags={[(c) => <code>{c}</code>]}
              />
            ) : (
              <T k="The answer goes to <0>{host}</0>." values={{ host: r.redirect_host }} tags={[(c) => <code>{c}</code>]} />
            )}
          </span>
        </li>
      </ul>
      {vr ? (
        // an API token is the account's role in this workspace, minus what only a person does in the app
        <ul className="consent-scopes" aria-label={t('What vr may do')}>
          <li>
            <b>{t('Works as you')}</b>
            <span>{t('Whatever your role ({role}) lets you do here, as you would in the app.', { role: me ? roleWord(me.role) : '—' })}</span>
          </li>
          <li>
            <b>{t('Stays with you')}</b>
            <span>{t('Approving, publishing, review links, and managing people and tokens: only in the app, signed in.')}</span>
          </li>
        </ul>
      ) : (
        <ul className="consent-scopes" aria-label={t('What the app may do')}>
          {r.scopes.filter(isScope).map((s) => (
            <li key={s} className={capped.has(s) ? 'capped' : ''}>
              <b>{scopeLabel(s)}</b>
              <span>{scopeHint(s)}</span>
              {capped.has(s) && <em>{t('only as far as your role ({role}) allows', { role: me ? roleWord(me.role) : '—' })}</em>}
            </li>
          ))}
        </ul>
      )}
      <div className="inv-form">
        {error && <ErrorLine>{error}</ErrorLine>}
        <div className="consent-actions">
          <AltButton onClick={() => answer(false)} disabled={decide.isPending}>
            {t('Deny')}
          </AltButton>
          <GoButton type="button" onClick={() => answer(true)} busy={decide.isPending} disabled={decide.isPending}>
            {t('Allow')}
          </GoButton>
        </div>
      </div>
      <Fine>
        <p>
          {vr
            ? t('It never sees your password. Revoke the token any time under Settings → API tokens, or with vr logout.')
            : t('It never sees your password. Disconnect it any time under Settings → API tokens.')}
        </p>
      </Fine>
    </Frame>
  );
}

const OAUTH_ERRORS = perLang(
  (): Record<OAuthErrorCode, string> => ({
    invalid_client: t('The app isn’t known here.'),
    invalid_request: t('The app asked in a way this server can’t accept.'),
    slow_down: t('Too many attempts.'),
    unsupported_response_type: t('The app asked for a kind of sign-in this server doesn’t offer.'),
    invalid_target: t('The app asked for access to another server.'),
    invalid_scope: t('The app asked for access this server doesn’t give.'),
  }),
);

// Problems found before the person decided are shown here, never sent to the app's address; the page is told a code of
// a fixed set (lib/nav.ts) and says it in its own words — a link to it carries nobody else's.
export function OAuthErrorScreen({ error }: { error: OAuthErrorCode }) {
  return (
    <Frame testid="oauth-error">
      <EntranceHead icon="plug" title={t('The app can’t connect')}>
        {OAUTH_ERRORS()[error]}
      </EntranceHead>
      <LibraryLink />
      <Fine>
        <p>{t('Nothing was shared with the app. Start the connection again from it, or tell whoever made it.')}</p>
      </Fine>
    </Frame>
  );
}
