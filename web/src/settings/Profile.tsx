// Your name (it signs your notes), picture, email, password, and signing out everywhere (the theme and language are
// Appearance). The owner of the machine the app runs on is signed in there without one; their first password (for other
// devices) needs no current one. Last, your data (A13 PEOPLE-1): taken home as a zip, and — on a hosted server — the
// account deleted, once you aren't the last owner of a workspace others work in.
import { type FormEvent, useRef, useState } from 'react';
import type { AccountDeletionPlan, WorkspaceInfo } from '../../../lib/types.ts';
import { exportMyData, useAccountDeletion, useCancelEmail, useDeleteAccount, useResend } from '../api/account.ts';
import { avatarSrc, useAuthStatus, useAvatar, useSignOut, useUpdateMe } from '../api/auth.ts';
import { ApiError } from '../api/client.ts';
import { useInfo } from '../api/queries.ts';
import { WorkspaceMark } from '../auth/Workspaces.tsx';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { toast, toastError } from '../lib/toast.ts';
import { Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Card, Confirm, when } from './parts.tsx';

const MAX_PICTURE = 8 * 1024 * 1024;

/** Your picture beside your notes: any still picture, cut to its centre square by the server. */
function ProfilePicture({ name, file }: { name: string; file?: string }) {
  const { set, remove } = useAvatar();
  const input = useRef<HTMLInputElement>(null);
  const busy = set.isPending || remove.isPending;
  const choose = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_PICTURE) return toastError(new Error(t('A profile picture may be at most 8 MB.')));
    const reader = new FileReader();
    reader.onload = () => {
      const data = String(reader.result).split(',')[1] ?? '';
      set.mutateAsync(data).then(() => toast(t('Picture saved'), 'ok'), toastError);
    };
    reader.readAsDataURL(f);
  };
  return (
    <div className="set-picture" data-testid="profile-picture">
      <Avatar name={name} src={avatarSrc(file)} size={64} kind="person" />
      <div className="set-picture-text">
        <b>{t('Profile picture')}</b>
        <span>{t('Shown beside your notes and replies. Any picture: it is cut to a square from the middle.')}</span>
        <div className="set-actions">
          <button type="button" className="btn sm" onClick={() => input.current?.click()} disabled={busy}>
            {set.isPending ? <Spinner /> : <I name="upload" size={14} />} {file ? t('Change picture') : t('Upload a picture')}
          </button>
          {file && (
            <button type="button" className="btn sm ghost" onClick={() => remove.mutateAsync().catch(toastError)} disabled={busy}>
              {t('Remove')}
            </button>
          )}
        </div>
      </div>
      <input
        ref={input}
        type="file"
        hidden
        accept="image/png,image/jpeg,image/webp,image/gif"
        data-testid="picture-input"
        onChange={(e) => {
          choose(e.target.files?.[0]);
          e.target.value = '';
        }}
      />
    </div>
  );
}

/**
 * An address waiting for its emailed link (a change, or the one someone typed when they joined): where the link went,
 * what to do, and the way back.
 */
function AddressState({ email, pending, unconfirmed }: { email: string; pending?: string; unconfirmed: boolean }) {
  const resend = useResend();
  const cancel = useCancelEmail();
  const again = () =>
    resend.mutateAsync(undefined).then(() => toast(t('Sent again to {email}. Only the newest link works.', { email: pending || email }), 'ok'), toastError);
  if (!pending && !unconfirmed) return null;
  return (
    <div className="set-note set-address" role="status" data-testid="address-state">
      <I name="send" size={14} />
      <div className="grow">
        {pending ? (
          <T k="A link went to <0>{pending}</0>. Until it is opened you keep signing in with {email}." values={{ pending, email }} tags={[(c) => <b>{c}</b>]} />
        ) : (
          <T k="<0>{email}</0> isn’t confirmed yet: open the link we sent there, so password links reach you." values={{ email }} tags={[(c) => <b>{c}</b>]} />
        )}
        <div className="set-actions start">
          <button type="button" className="btn sm" onClick={again} disabled={resend.isPending}>
            {resend.isPending ? <Spinner /> : null} {t('Send it again')}
          </button>
          {pending && (
            <button type="button" className="btn sm ghost" onClick={() => cancel.mutateAsync().catch(toastError)} disabled={cancel.isPending}>
              {t('Keep {email}', { email })}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

/** Workspaces as the deletion card names them: their mark and name, one row each. */
function WorkspaceRows({ list, testid }: { list: WorkspaceInfo[]; testid: string }) {
  return (
    <div className="set-rows" data-testid={testid}>
      {list.map((w) => (
        <div key={w.id} className="set-row">
          <WorkspaceMark name={w.name} size="md" />
          <b className="grow ellipsis">{w.name}</b>
        </div>
      ))}
    </div>
  );
}

/** Your data as a zip of plain files: what the account is, what you wrote and made, never anyone else's words. */
function YourData() {
  const [busy, setBusy] = useState(false);
  const take = async () => {
    setBusy(true);
    try {
      await exportMyData();
      toast(t('Your data is downloading'), 'ok');
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Card
      title={t('Your data')}
      lede={t(
        'Everything your account holds — your profile, the notes and replies you wrote, your drafts and recordings, what you uploaded — in one zip of plain files. Never anyone else’s notes.',
      )}
      testid="your-data"
    >
      <div className="set-actions">
        <button type="button" className="btn" onClick={() => void take()} disabled={busy} data-testid="export-data">
          {busy ? <Spinner /> : <I name="download" size={15} />} {t('Export my data')}
        </button>
      </div>
    </Card>
  );
}

/**
 * Deleting your account (a hosted server): what goes with it and what stops it, said before anyone confirms; your
 * password confirms it (or, without one, a sign-in this moment).
 */
function DeleteAccount({ name }: { name: string }) {
  const q = useAccountDeletion();
  const del = useDeleteAccount();
  const [asking, setAsking] = useState(false);
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const plan: AccountDeletionPlan | undefined = q.data;
  const blocked = !!plan && (!!plan.refused || plan.blockedBy.length > 0);
  const go = async () => {
    try {
      await del.mutateAsync(plan?.password ? password : null);
      toast(t('Your account is deleted. Goodbye, {name}.', { name: name.split(/\s+/)[0] ?? name }), 'ok');
    } catch (err) {
      if (err instanceof ApiError && err.status === 403 && err.details.password !== undefined) {
        setWrong(true);
        return;
      }
      setAsking(false);
      toastError(err);
    }
  };
  return (
    <Card
      title={t('Delete account')}
      danger
      testid="delete-account"
      lede={t(
        'Your profile, picture, drafts, unsent recordings, devices and sign-ins go for good. The notes you wrote stay in their workspaces, signed with your name.',
      )}
    >
      {!plan ? (
        <SkLine w="18em" />
      ) : plan.refused ? (
        <p className="set-note set-sub">{plan.refused}</p>
      ) : (
        <>
          {plan.blockedBy.length > 0 && (
            <div className="set-del-part" data-testid="delete-blocked">
              <p className="set-warn">
                {t(
                  'You’re the last owner of this workspace, and others work in it: make someone else an owner under Members and invites, or delete the workspace, first.|You’re the last owner of these workspaces, and others work in them: make someone else an owner under Members and invites, or delete each workspace, first.',
                  { n: plan.blockedBy.length },
                )}
              </p>
              <WorkspaceRows list={plan.blockedBy} testid="delete-blocked-list" />
            </div>
          )}
          {plan.goWith.length > 0 && (
            <div className="set-del-part">
              <p className="set-sub">
                {t('Nobody else works in this workspace: it goes with your account.|Nobody else works in these workspaces: they go with your account.', {
                  n: plan.goWith.length,
                })}
              </p>
              <WorkspaceRows list={plan.goWith} testid="delete-gowith-list" />
            </div>
          )}
        </>
      )}
      <div className="set-actions">
        <button
          type="button"
          className="btn danger-outline"
          disabled={!plan || blocked}
          onClick={() => {
            setPassword('');
            setWrong(false);
            setAsking(true);
          }}
          data-testid="delete-account-open"
        >
          <I name="trash" size={15} /> {t('Delete my account…')}
        </button>
      </div>
      {asking && plan && (
        <Confirm
          title={t('Delete your account?')}
          action={t('Delete my account')}
          danger
          busy={del.isPending}
          ready={!plan.password || !!password}
          onClose={() => setAsking(false)}
          onConfirm={() => void go()}
        >
          <div className="set-del-ask">
            <p>
              {plan.goWith.length
                ? t(
                    'It can’t be undone, and the workspace only you work in goes with it.|It can’t be undone, and the {n} workspaces only you work in go with it.',
                    {
                      n: plan.goWith.length,
                    },
                  )
                : t('It can’t be undone. You leave every workspace you’re in; the notes you wrote stay there, signed with your name.')}
            </p>
            {plan.password && (
              <label className="set-field">
                <span>{t('Your password')}</span>
                <input
                  className={`input ${wrong ? 'invalid' : ''}`}
                  type="password"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setWrong(false);
                  }}
                  autoComplete="current-password"
                  data-testid="delete-account-password"
                  data-autofocus=""
                />
                {wrong && <span className="set-warn">{t('That’s not your password.')}</span>}
              </label>
            )}
          </div>
        </Confirm>
      )}
    </Card>
  );
}

export function Profile() {
  const status = useAuthStatus().data;
  const mail = !!useInfo()?.mail;
  const user = status?.user;
  // No password yet, at the machine itself: the first one (and the email) is set without a current one.
  const first = status?.via === 'local' && user?.has_password === false;
  const update = useUpdateMe();
  const signOut = useSignOut();
  const [name, setName] = useState(user?.name || '');
  const [email, setEmail] = useState(user?.email || '');
  const [current, setCurrent] = useState('');
  const [pw, setPw] = useState({ current: '', next: '', again: '' });
  const [everywhere, setEverywhere] = useState(false);
  if (!user) return null;
  const emailChanged = email.trim().toLowerCase() !== user.email.toLowerCase();
  const dirty = name.trim() !== user.name || emailChanged;

  const saveProfile = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const { user: saved } = await update.mutateAsync({
        ...(name.trim() !== user.name ? { name: name.trim() } : {}),
        ...(emailChanged ? { email: email.trim(), ...(first ? {} : { current_password: current }) } : {}),
      });
      setCurrent('');
      // A new address waits for its link: the field shows the address in use until then.
      if (emailChanged && saved.pending_email) {
        setEmail(saved.email);
        toast(t('Open the link sent to {email} to finish the change.', { email: saved.pending_email }), 'ok');
      } else toast(t('Profile saved'), 'ok');
    } catch (err) {
      toastError(err);
    }
  };
  const mismatch = !!pw.again && pw.next !== pw.again;
  const savePassword = async (e: FormEvent) => {
    e.preventDefault();
    try {
      await update.mutateAsync({ password: pw.next, ...(first ? {} : { current_password: pw.current }) });
      setPw({ current: '', next: '', again: '' });
      toast(first ? t('Password set: sign in with it from your other devices.') : t('Password changed. Other sessions are signed out.'), 'ok');
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <>
      <header className="set-head">
        <h1>{t('Profile')}</h1>
        <p>
          {status?.via === 'local' ? (
            <T
              k={'Signed in at this machine as <0>{email}</0> · <1>{x}</1> · since {when}'}
              values={{ email: user.email, x: user.role.toUpperCase(), when: when(user.created) }}
              tags={[(c) => <b>{c}</b>, (c) => <span className={`badge role-${user.role}`}>{c}</span>]}
            />
          ) : (
            <T
              k={'Signed in as <0>{email}</0> · <1>{x}</1> · since {when}'}
              values={{ email: user.email, x: user.role.toUpperCase(), when: when(user.created) }}
              tags={[(c) => <b>{c}</b>, (c) => <span className={`badge role-${user.role}`}>{c}</span>]}
            />
          )}
        </p>
      </header>

      <Card title={t('You')} lede={t('Your name signs every note and reply you write, so agents and the people you share with know who asked.')}>
        <ProfilePicture name={user.name} file={user.avatar} />
        <form className="set-form" onSubmit={saveProfile}>
          <label className="set-field">
            <span>{t('Name')}</span>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} autoComplete="name" maxLength={80} />
          </label>
          <label className="set-field">
            <span>{t('Email')}</span>
            <input className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" />
          </label>
          {emailChanged && !first && (
            <label className="set-field">
              <span>{t('Current password')}</span>
              <input className="input" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} autoComplete="current-password" />
            </label>
          )}
          {emailChanged && !first && mail && <p className="set-sub set-hint">{t('A link goes to the new address; it takes over once you open it.')}</p>}
          <AddressState email={user.email} pending={user.pending_email} unconfirmed={!!user.unverified && mail} />
          <div className="set-actions">
            <button type="submit" className="btn primary" disabled={!dirty || !name.trim() || (emailChanged && !first && !current) || update.isPending}>
              {update.isPending && <Spinner />} {t('Save')}
            </button>
          </div>
        </form>
      </Card>

      <Card
        title={t('Password')}
        lede={
          first
            ? t('At this machine you never need one. Set one (at least 10 characters) to sign in from your phone or another computer.')
            : t('At least 10 characters. Changing it signs you out on every other device.')
        }
      >
        <form className="set-form" onSubmit={savePassword}>
          {!first && (
            <label className="set-field">
              <span>{t('Current password')}</span>
              <input
                className="input"
                type="password"
                value={pw.current}
                onChange={(e) => setPw({ ...pw, current: e.target.value })}
                autoComplete="current-password"
              />
            </label>
          )}
          <div className="set-pair">
            <label className="set-field">
              <span>{t('New password')}</span>
              <input className="input" type="password" value={pw.next} onChange={(e) => setPw({ ...pw, next: e.target.value })} autoComplete="new-password" />
            </label>
            <label className="set-field">
              <span>{t('Again')}</span>
              <input
                className={`input ${mismatch ? 'invalid' : ''}`}
                type="password"
                value={pw.again}
                onChange={(e) => setPw({ ...pw, again: e.target.value })}
                autoComplete="new-password"
              />
            </label>
          </div>
          {mismatch && <div className="set-warn">{t('The two new passwords differ.')}</div>}
          <div className="set-actions">
            <button type="submit" className="btn primary" disabled={(!first && !pw.current) || pw.next.length < 10 || pw.next !== pw.again || update.isPending}>
              {first ? t('Set password') : t('Change password')}
            </button>
          </div>
        </form>
      </Card>

      <Card
        title={t('Sessions')}
        lede={t(
          'Lost a laptop, or signed in on a shared machine? This ends every browser session of yours, including this one. API tokens keep working; revoke those under API tokens.',
        )}
      >
        <div className="set-actions">
          {status?.via !== 'local' && (
            <button type="button" className="btn" onClick={() => signOut.mutateAsync(false).catch(toastError)} data-testid="sign-out">
              {t('Sign out')}
            </button>
          )}
          <button type="button" className="btn danger-outline" onClick={() => setEverywhere(true)}>
            {t('Sign out everywhere')}
          </button>
        </div>
      </Card>

      {everywhere && (
        <Confirm
          title={t('Sign out everywhere?')}
          action={t('Sign out everywhere')}
          danger
          busy={signOut.isPending}
          onClose={() => setEverywhere(false)}
          onConfirm={() => signOut.mutateAsync(true).catch(toastError)}
        >
          {t('Every browser that is signed in as {name} has to sign in again, this one too.', { name: user.name })}
        </Confirm>
      )}

      <YourData />
      {status?.mode === 'server' && status.via === 'cookie' && <DeleteAccount name={user.name} />}
    </>
  );
}
