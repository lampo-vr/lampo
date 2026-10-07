// Accounts (owners and admins): invite links first (people set their own password), then the accounts themselves:
// roles, disable, reset, remove. A temporary password stays possible for people without email at hand.
// Owners manage everyone; admins manage everyone but owners. The last owner can't be removed or demoted.
import { type FormEvent, useState } from 'react';
import { avatarSrc, inviteLink, useAuthStatus, useCan, useInviteActions, useInvites, useUserActions, useUsers } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import type { AdminUser, InviteCreated, PublicInvite, Role } from '../api/types.ts';
import { useWorkspaces } from '../auth/Workspaces.tsx';
import { BeyondLine, beyondAction, useBeyond, useSwitchPlan } from '../conversion/InviteBeyond.tsx';
import { nameFromAddress } from '../conversion/limits/model.ts';
import { locale, perLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { roleLabel, roleWord } from '../i18n/terms.ts';
import { copyText, toast, toastError, toastFailed } from '../lib/toast.ts';
import { Avatar, Checkbox } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu, Modal } from '../ui/primitives.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { Select } from '../ui/select.tsx';
import { Card, Code, Confirm, expiry, serverUrl, tempPassword, when } from './parts.tsx';

const rolesFor = (me: Role): Role[] => (me === 'owner' ? ['reviewer', 'member', 'admin', 'owner'] : ['reviewer', 'member', 'admin']);
const roleOptions = (me: Role) => rolesFor(me).map((r) => ({ value: r, label: roleLabel(r) }));
/** What the picked role may do, under the form: a select can't hold a sentence without cutting it off. */
/** What a role may do, as a short phrase. */
/** What a role may do, as a short phrase. */
const roleHint = (r: Role): string =>
  ({
    owner: t('everything, including other owners'),
    admin: t('everything except managing owners'),
    member: t('uploads, notes, folders, links and agents'),
    reviewer: t('watches, leaves notes, checks fixes and approves'),
  })[r];

const roleLine = (r: Role) => `${roleLabel(r)}: ${roleHint(r)}.`;
const DAYS = perLang(() => [
  { value: '1', label: t('1 day') },
  { value: '7', label: t('7 days') },
  { value: '30', label: t('30 days') },
]);

const until = (iso: string) => new Date(iso).toLocaleDateString(locale(), { day: 'numeric', month: 'long' });

/** What to send with an invite link: nothing is emailed by the server. */
function inviteMessage(made: InviteCreated, server: string) {
  const { invite, url } = made;
  const hi = invite.name ? t('Hi {name},', { name: invite.name.split(' ')[0] as string }) : t('Hi,');
  const host = server.replace(/^https?:\/\//, '');
  const body =
    invite.role === 'reviewer'
      ? t('you’re invited to review videos on {host}. Open this link and choose your password:', { host })
      : t('you’re invited as {role} on {host}. Open this link and choose your password:', { role: roleWord(invite.role), host });
  return `${hi}\n\n${body}\n${url}\n\n${t('The link works once, until {until}.', { until: until(invite.expires) })}`;
}

function InviteSent({ made, server, onDone }: { made: InviteCreated; server: string; onDone: () => void }) {
  // Emailed: the link is there to copy too, should they want to send it another way as well.
  if (made.sent && made.invite.email)
    return (
      <Modal
        title={t('Invite sent')}
        onClose={onDone}
        width={560}
        foot={
          <>
            <span className="grow" />
            <button type="button" className="btn primary" onClick={onDone}>
              {t('Done')}
            </button>
          </>
        }
      >
        <div className="muted" style={{ fontSize: 12.5 }} data-testid="invite-emailed">
          <T
            k="An email with the link went to <0>{email}</0>. It works once, until {until}; whoever opens it first chooses a name and password and is in as {x}."
            values={{ email: made.invite.email, until: until(made.invite.expires), x: roleWord(made.invite.role) }}
            tags={[(c) => <b>{c}</b>]}
          />
        </div>
        <Code label={t('Link')}>{made.url}</Code>
      </Modal>
    );
  return (
    <Modal
      title={t('Invite link ready')}
      onClose={onDone}
      width={560}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onDone}>
            {t('Done')}
          </button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5 }}>
        {t(
          "Send it however you like. Whoever opens it first chooses a name, email and password and is signed in as {x}. You can copy it again from the list until it's used.",
          { x: roleWord(made.invite.role) },
        )}
      </div>
      <Code label={t('Link')}>{made.url}</Code>
      <Code label={t('Message')}>{inviteMessage(made, server)}</Code>
    </Modal>
  );
}

function InviteForm({ me, onCreated, many }: { me: Role; onCreated: (made: InviteCreated) => void; many?: boolean }) {
  const act = useInviteActions();
  const workspace = useAuthStatus().data?.workspace?.name;
  const info = useInfo();
  const [f, setF] = useState({ role: 'reviewer' as Role, name: '', email: '', days: '7', send: true });
  // An address and a server that can email: the invite goes out by email (the link can be copied either way).
  const emailing = !!info?.mail && !!f.email.trim() && f.send;
  // the plan has no room for them (a card on file): the form says what brings them in, and its button switches first
  const beyond = useBeyond(f.email, f.name);
  const switchPlan = useSwitchPlan();
  const [switching, setSwitching] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const ask = {
      role: f.role,
      name: f.name.trim() || undefined,
      email: f.email.trim() || undefined,
      days: Number(f.days),
      ...(emailing ? { send: true } : {}),
    };
    const invite = async () => {
      const made = await act.create.mutateAsync(ask);
      onCreated(made);
      setF({ ...f, name: '', email: '' });
    };
    try {
      if (beyond) {
        setSwitching(true);
        await switchPlan(beyond);
        await invite();
        toast(
          beyond.name
            ? t('{workspace} is on {plan}. {name}’s invite is on its way.', { workspace: workspace ?? '', plan: beyond.plan.name, name: beyond.name })
            : t('{workspace} is on {plan}. The invite is on its way.', { workspace: workspace ?? '', plan: beyond.plan.name }),
          'ok',
        );
      } else await invite();
    } catch (err) {
      // no room on the plan: its sheet says what fits, and the invite goes out once it's paid
      const who = ask.name?.split(/\s+/)[0] || (ask.email ? nameFromAddress(ask.email) : null) || ask.email;
      toastFailed(err, { needed: ask.email, ...(who ? { name: who } : {}), retry: () => invite().catch(toastError) });
    } finally {
      setSwitching(false);
    }
  };
  return (
    <form className="set-form" onSubmit={submit}>
      <div className="set-pair">
        <div className="set-field">
          <span>{t('Role')}</span>
          <Select label={t('Role')} value={f.role} onChange={(r) => setF({ ...f, role: r as Role })} options={roleOptions(me)} />
        </div>
        <div className="set-field">
          <span>{t('Link works for')}</span>
          <Select label={t('Link works for')} value={f.days} onChange={(d) => setF({ ...f, days: d })} options={DAYS()} />
        </div>
      </div>
      <div className="set-pair">
        <label className="set-field">
          <span>{t('Name (optional)')}</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder={t('Mia Keller')} />
        </label>
        <label className="set-field">
          <span>{t('Email (optional)')}</span>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="mia@example.com" />
        </label>
      </div>
      <p className="set-sub set-hint">
        {roleLine(f.role)}
        {f.role === 'reviewer' && (
          <span data-testid="reviewer-hint">
            {' '}
            {many
              ? t('An account sees every project in this workspace. For anyone else, share a review link from the player or a folder instead.')
              : t('An account sees every project on this server. For anyone else, share a review link from the player or a folder instead.')}
          </span>
        )}
      </p>
      {info?.mail && (
        <div className="set-check">
          <Checkbox id="invite-send" checked={f.send} disabled={!f.email.trim()} onCheckedChange={(send) => setF({ ...f, send })} />
          <label htmlFor="invite-send">
            <b>{t('Email the invite')}</b>
            <span className="set-sub">
              {f.email.trim() ? t('It goes to {email}, in the language you use here.', { email: f.email.trim() }) : t('Add an email address above to send it.')}
            </span>
          </label>
        </div>
      )}
      {info?.mail_transport === 'log' && (
        <p className="set-sub set-note" data-testid="mail-outbox">
          <T
            k={'This server has no mail relay (<0>VR_SMTP_URL</0>): emails wait in its outbox instead of going out. Copy the link and send it yourself.'}
            tags={[(c) => <code>{c}</code>]}
          />
        </p>
      )}
      {beyond && <BeyondLine x={beyond} />}
      {beyond && <p className="lim-beyond-fine">{t('People on review links and agents never count as members.')}</p>}
      <div className="set-actions">
        <span className="grow set-sub">{t('They choose their own password. Name and email only fill in the form for them.')}</span>
        <button type="submit" className="btn primary" disabled={act.create.isPending || switching} data-testid="invite-submit">
          {act.create.isPending || switching ? <Spinner /> : <I name={beyond ? 'users' : emailing ? 'send' : 'link'} size={15} />}{' '}
          {beyond ? beyondAction(beyond) : emailing ? t('Send invite') : t('Create invite link')}
        </button>
      </div>
    </form>
  );
}

/** `manage`: the viewer may copy, send and revoke it (an owner's invite is for owners only). */
function InviteRow({ invite, manage, onRevoke }: { invite: PublicInvite; manage: boolean; onRevoke: (i: PublicInvite) => void }) {
  const [copied, setCopied] = useState(false);
  const act = useInviteActions();
  const mail = !!useInfo()?.mail;
  const sendAgain = async () => {
    try {
      await act.send.mutateAsync(invite.id);
      toast(t('Sent again to {email}', { email: invite.email ?? '' }), 'ok');
    } catch (err) {
      toastError(err);
    }
  };
  const pending = invite.status === 'pending';
  const copy = async () => {
    try {
      if (!(await copyText(await inviteLink(invite.id)))) return toast(t('Could not copy'), 'error');
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch (err) {
      toastError(err);
    }
  };
  const who = invite.name || invite.email || t('Anyone with the link');
  const state = pending
    ? expiry(invite.expires)
    : invite.status === 'accepted'
      ? t('joined as {name}', { name: invite.accepted_by ?? '' })
      : invite.status === 'revoked'
        ? t('revoked')
        : t('expired');
  return (
    <div className={`set-row ${pending ? '' : 'off'}`}>
      <span className="invite-mark" aria-hidden="true">
        <I name={pending ? 'link' : invite.status === 'accepted' ? 'check' : 'x'} size={14} />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          <b>{who}</b> {invite.name && invite.email && <span className="set-sub">{invite.email}</span>}
        </div>
        <div className="set-sub ellipsis">
          {t('invited by {by} {when} · {state}', { by: invite.by, when: when(invite.created), state })}
          {invite.sent && pending ? t(' · emailed {when}', { when: when(invite.sent) }) : ''}
        </div>
      </div>
      <span className={`badge role-${invite.role}`}>{roleLabel(invite.role).toUpperCase()}</span>
      {pending && manage ? (
        <>
          {mail && invite.email && (
            <IconButton
              className="btn sm ghost icon-only"
              label={t('Email the invite to {who} again', { who })}
              tip={t('Send again')}
              icon="send"
              size={14}
              onClick={sendAgain}
              disabled={act.send.isPending}
            />
          )}
          <button type="button" className="btn sm ghost" onClick={copy} aria-label={t('Copy the invite link for {who}', { who })}>
            <I name={copied ? 'check' : 'copy'} size={14} /> {copied ? t('Copied') : t('Copy link')}
          </button>
          <IconButton
            className="btn sm ghost icon-only"
            label={t('Revoke the invite for {who}', { who })}
            tip={t('Revoke')}
            icon="trash"
            size={14}
            onClick={() => onRevoke(invite)}
          />
        </>
      ) : (
        <span style={{ width: 30 }} />
      )}
    </div>
  );
}

// The message to send a user made with a temporary password (or whose password was reset).
function Handover({ url, email, password, onDone }: { url: string; email: string; password: string; onDone: () => void }) {
  return (
    <Modal
      title={t('Send them this')}
      onClose={onDone}
      width={520}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn primary" onClick={onDone}>
            {t('Done')}
          </button>
        </>
      }
    >
      <div className="muted" style={{ fontSize: 12.5 }}>
        {t('The password is shown only now. They can change it under Settings › Profile after signing in.')}
      </div>
      <Code>{`${url}\n${t('Email')}: ${email}\n${t('Temporary password')}: ${password}`}</Code>
    </Modal>
  );
}

function CreateWithPassword({ me, url, onCreated }: { me: Role; url: string; onCreated: (email: string, password: string) => void }) {
  const act = useUserActions();
  const [f, setF] = useState({ name: '', email: '', role: 'member' as Role, password: tempPassword() });
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const made = await act.create.mutateAsync({ ...f, name: f.name.trim(), email: f.email.trim() });
      // A server with workspaces makes no account for someone else: their address got an invite instead.
      if (made.invite) toast(t('An invite went to {email}: they choose their own password.', { email: f.email.trim() }), 'ok');
      else onCreated(f.email.trim(), f.password);
      setF({ name: '', email: '', role: 'member', password: tempPassword() });
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <form className="set-form" onSubmit={submit}>
      <div className="set-pair">
        <label className="set-field">
          <span>{t('Name')}</span>
          <input className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} maxLength={80} placeholder={t('Mia Keller')} />
        </label>
        <label className="set-field">
          <span>{t('Email')}</span>
          <input className="input" type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} placeholder="mia@example.com" />
        </label>
      </div>
      <div className="set-pair">
        <div className="set-field">
          <span>{t('Role')}</span>
          <Select label={t('Role')} value={f.role} onChange={(r) => setF({ ...f, role: r as Role })} options={roleOptions(me)} />
        </div>
        <label className="set-field">
          <span>{t('Temporary password')}</span>
          <span className="set-inline">
            <input className="input mono grow" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} spellCheck={false} />
            <IconButton
              className="btn sm ghost icon-only"
              label={t('New password')}
              icon="refresh"
              size={14}
              onClick={() => setF({ ...f, password: tempPassword() })}
            />
          </span>
        </label>
      </div>
      <p className="set-sub set-hint">{roleLine(f.role)}</p>
      <div className="set-actions">
        <span className="grow set-sub">{t('Nothing is emailed: you get a message to send them. {url}', { url })}</span>
        <button type="submit" className="btn" disabled={!f.name.trim() || !f.email.trim() || f.password.length < 10 || act.create.isPending}>
          {act.create.isPending ? <Spinner /> : <I name="plus" size={15} />} {t('Add user')}
        </button>
      </div>
    </form>
  );
}

type Pending = { kind: 'delete' | 'reset' | 'disable'; user: AdminUser } | { kind: 'revoke'; invite: PublicInvite } | null;

export function Users() {
  const status = useAuthStatus().data;
  const me = status?.user;
  // A hosted server has workspaces: disabling someone shuts them out of this one only (their account goes on).
  const here = status?.mode === 'server';
  const url = serverUrl(useInfo()?.public_url);
  const admin = useCan()('admin');
  const { data } = useUsers(admin);
  const invites = useInvites(admin).data?.invites;
  const act = useUserActions();
  const inviteAct = useInviteActions();
  const [pending, setPending] = useState<Pending>(null);
  const [handover, setHandover] = useState<{ email: string; password: string } | null>(null);
  const [made, setMade] = useState<InviteCreated | null>(null);
  const [withPassword, setWithPassword] = useState(false);
  // With more than one workspace these are the current one's members, and the page says whose.
  const { current, many } = useWorkspaces();
  if (!me || !admin) return null;
  const may = (u: AdminUser) => u.id !== me.id && (me.role === 'owner' || u.role !== 'owner');
  const setRole = async (u: AdminUser, role: Role) => {
    try {
      await act.update.mutateAsync({ id: u.id, patch: { role } });
      toast(t('{name} is now {x}', { name: u.name, x: roleWord(role) }), 'ok');
    } catch (err) {
      toastError(err);
    }
  };
  const confirm = async () => {
    if (!pending) return;
    try {
      if (pending.kind === 'revoke') {
        await inviteAct.revoke.mutateAsync(pending.invite.id);
        toast(t('Invite revoked: the link no longer works'), 'ok');
      } else if (pending.kind === 'delete') {
        await act.remove.mutateAsync(pending.user.id);
        toast(t('Removed {name}', { name: pending.user.name }), 'ok');
      } else if (pending.kind === 'disable') {
        const { user } = pending;
        await act.update.mutateAsync({ id: user.id, patch: { disabled: !user.disabled } });
        toast(
          user.disabled
            ? here
              ? t('{name} can work here again', { name: user.name })
              : t('{name} can sign in again', { name: user.name })
            : here
              ? t('{name} is disabled in this workspace', { name: user.name })
              : t('{name} is disabled and signed out', { name: user.name }),
          'ok',
        );
      } else {
        const password = tempPassword();
        await act.update.mutateAsync({ id: pending.user.id, patch: { password } });
        setHandover({ email: pending.user.email, password });
      }
    } catch (err) {
      toastError(err);
    }
    setPending(null);
  };
  const open = invites?.filter((i) => i.status === 'pending') || [];
  const past = invites?.filter((i) => i.status !== 'pending').slice(0, 5) || [];
  return (
    <>
      <header className="set-head">
        <h1>{many && current ? t('Members of {name}', { name: current.name }) : t('Users')}</h1>
        <p>
          {many ? (
            <T
              k={
                'Everyone in this workspace sees its whole library; other workspaces see none of it. <0>Reviewers</0> watch, write notes, check fixes and approve; <1>members</1> also upload, organize, share and assign agents. Everyone else reviews without an account: share a link from the player instead.'
              }
              tags={[(c) => <b>{c}</b>, (c) => <b>{c}</b>]}
            />
          ) : (
            <T
              k={
                'Everyone on this server sees the whole library. <0>Reviewers</0> watch, write notes, check fixes and approve; <1>members</1> also upload, organize, share and assign agents. Everyone else reviews without an account: share a link from the player instead.'
              }
              tags={[(c) => <b>{c}</b>, (c) => <b>{c}</b>]}
            />
          )}
        </p>
      </header>

      <Card title={t('Invite someone')} lede={t('A one-time link: they choose their own name, email and password.')}>
        <InviteForm me={me.role} onCreated={setMade} many={many} />
      </Card>

      {(open.length > 0 || past.length > 0) && (
        <Card title={open.length ? t('{n} open invite|{n} open invites', { n: open.length }) : t('Recent invites')}>
          <div className="set-rows">
            {[...open, ...past].map((i) => (
              <InviteRow
                key={i.id}
                invite={i}
                manage={me?.role === 'owner' || i.role !== 'owner'}
                onRevoke={(invite) => setPending({ kind: 'revoke', invite })}
              />
            ))}
          </div>
        </Card>
      )}

      <Card title={data ? t('{n} user|{n} users', { n: data.users.length }) : t('Users')}>
        {!data ? (
          <SkeletonRegion label={t('Loading the users')}>
            <RowsSkeleton n={3} thumb={28} />
          </SkeletonRegion>
        ) : (
          <div className="set-rows">
            {data.users.map((u) => (
              <div key={u.id} className={`set-row ${u.disabled ? 'off' : ''}`}>
                <Avatar name={u.name} size={30} kind="person" src={avatarSrc(u.avatar)} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">
                    <b>{u.name}</b> {u.id === me.id && <span className="badge">{t('YOU')}</span>}{' '}
                    {u.disabled && <span className="badge danger">{t('DISABLED')}</span>}
                  </div>
                  <div className="set-sub ellipsis">
                    {t('{email} · since {when} · {n} token|{email} · since {when} · {n} tokens', { email: u.email, when: when(u.created), n: u.tokens })}
                    {u.apps ? t(' · {n} app| · {n} apps', { n: u.apps }) : ''}
                  </div>
                </div>
                {may(u) ? (
                  <Select
                    label={t('Role of {name}', { name: u.name })}
                    value={u.role}
                    onChange={(r) => setRole(u, r as Role)}
                    options={rolesFor(me.role).map((r) => ({ value: r, label: roleLabel(r) }))}
                  />
                ) : (
                  <span className={`badge role-${u.role}`}>{roleLabel(u.role).toUpperCase()}</span>
                )}
                {may(u) ? (
                  <Menu
                    trigger={<IconButton className="btn sm ghost icon-only" label={t('Actions for {name}', { name: u.name })} icon="more" />}
                    items={[
                      { label: t('Reset password…'), icon: 'key', onClick: () => setPending({ kind: 'reset', user: u }) },
                      { label: u.disabled ? t('Enable') : t('Disable…'), icon: 'shield', onClick: () => setPending({ kind: 'disable', user: u }) },
                      'sep',
                      { label: t('Remove…'), icon: 'trash', danger: true, onClick: () => setPending({ kind: 'delete', user: u }) },
                    ]}
                  />
                ) : (
                  <span style={{ width: 30 }} />
                )}
              </div>
            ))}
          </div>
        )}
        {/* a command on the server's own machine: only for whoever runs it (the machine's owner, a hosted server's operator) */}
        {(!here || status?.operator) && (
          <div className="set-sub" data-testid="locked-out">
            <T k={'Locked out yourself? On the server: <0>vr admin reset-password --email you@example.com</0>'} tags={[(c) => <code>{c}</code>]} />
          </div>
        )}
      </Card>

      {withPassword ? (
        <Card title={t('Add a user with a temporary password')} lede={t("For someone you'll hand the password to yourself.")}>
          <CreateWithPassword me={me.role} url={url} onCreated={(email, password) => setHandover({ email, password })} />
        </Card>
      ) : (
        <button type="button" className="btn ghost sm set-more" onClick={() => setWithPassword(true)}>
          <I name="key" size={14} /> {t('Add a user with a temporary password instead')}
        </button>
      )}

      {pending && (
        <Confirm
          title={
            pending.kind === 'revoke'
              ? pending.invite.email || pending.invite.name
                ? t('Revoke the invite for {who}?', { who: pending.invite.email || pending.invite.name || '' })
                : t('Revoke this invite?')
              : pending.kind === 'delete'
                ? t('Remove {name}?', { name: pending.user.name })
                : pending.kind === 'reset'
                  ? t('New password for {name}?', { name: pending.user.name })
                  : pending.user.disabled
                    ? t('Enable {name}?', { name: pending.user.name })
                    : t('Disable {name}?', { name: pending.user.name })
          }
          action={
            pending.kind === 'revoke'
              ? t('Revoke')
              : pending.kind === 'delete'
                ? t('Remove')
                : pending.kind === 'reset'
                  ? t('Set a new password')
                  : pending.user.disabled
                    ? t('Enable')
                    : t('Disable')
          }
          danger={pending.kind === 'revoke' || pending.kind === 'delete' || (pending.kind === 'disable' && !pending.user.disabled)}
          busy={act.update.isPending || act.remove.isPending || inviteAct.revoke.isPending}
          onClose={() => setPending(null)}
          onConfirm={confirm}
        >
          {pending.kind === 'revoke'
            ? t('The link stops working right away; you can always make a new one.')
            : pending.kind === 'delete'
              ? t('Their account and API tokens are deleted; the notes they wrote stay, signed with their name.')
              : pending.kind === 'reset'
                ? t('They are signed out everywhere and get a temporary password from you.')
                : pending.user.disabled
                  ? here
                    ? t('They can work in this workspace again.')
                    : t('They can sign in again with their password.')
                  : here
                    ? t('They can’t work in this workspace until you enable them again: its tokens and apps of theirs stop. Their account stays theirs.')
                    : t('They are signed out everywhere and their tokens stop working until you enable them again.')}
        </Confirm>
      )}
      {handover && <Handover url={url} email={handover.email} password={handover.password} onDone={() => setHandover(null)} />}
      {made && <InviteSent made={made} server={url} onDone={() => setMade(null)} />}
    </>
  );
}
