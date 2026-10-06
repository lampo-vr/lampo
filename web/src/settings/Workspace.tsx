// Settings → Workspace (a hosted server only): the workspace this session works in — its name (owners and admins
// rename it), its people (Users), the person's other workspaces to switch to, and making a new one. On a person's own
// machine there is one workspace and this page doesn't exist. Last, for its owner, deleting it (A13 PEOPLE-1): what it
// takes with it is counted first, and its name is typed to confirm.
import { type FormEvent, useEffect, useState } from 'react';
import type { MyWorkspace } from '../../../lib/types.ts';
import { useDeleteWorkspace, useWorkspaceDeletion } from '../api/account.ts';
import { useCan } from '../api/auth.ts';
import { useRenameWorkspace, useSwitchWorkspace, useWorkspaceList } from '../api/workspaces.ts';
import { askedNewWorkspace, useWorkspaces, WorkspaceMark } from '../auth/Workspaces.tsx';
import { size } from '../billing/words.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { roleLabel } from '../i18n/terms.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { toast, toastError } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Card, Confirm, Facts } from './parts.tsx';

const newWorkspaceCode = loader(() => import('../auth/NewWorkspace.tsx'));

/**
 * Deleting the workspace (its owner): what it holds is counted when the card shows, its name typed to confirm. Your own
 * account goes with it when you work in no other workspace (the card says so). A suspended workspace stays: only
 * whoever runs the server decides about it then.
 */
function DeleteWorkspace({ current, alone }: { current: MyWorkspace; alone: boolean }) {
  const plan = useWorkspaceDeletion(true).data;
  const del = useDeleteWorkspace();
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState('');
  const named = typed.trim() === current.name.trim();
  const go = async () => {
    try {
      await del.mutateAsync(typed.trim());
      toast(t('{name} is deleted', { name: current.name }), 'ok');
    } catch (err) {
      setAsking(false);
      toastError(err);
    }
  };
  return (
    <Card
      title={t('Delete workspace')}
      danger
      testid="delete-workspace"
      lede={t(
        '{name} goes for good with everything in it: its videos and every version of them, notes, review links, playbooks and files. Everyone in it is told by email.',
        { name: current.name },
      )}
    >
      <Facts
        testid="delete-workspace-plan"
        rows={[
          { label: t('Videos'), value: plan ? `${plan.videos} · ${size(plan.bytes)}` : <SkLine w="6em" /> },
          { label: t('Review links'), value: plan ? String(plan.links) : <SkLine w="2em" /> },
          {
            label: t('Members'),
            value: plan ? t('{n} · {gone} work nowhere else', { n: plan.members.total, gone: plan.members.accountsGone }) : <SkLine w="8em" />,
          },
        ]}
      />
      {current.suspended ? (
        <p className="set-note set-sub" data-testid="delete-workspace-suspended">
          {t('It is suspended by whoever runs this server: they decide about it now.')}
        </p>
      ) : (
        alone && <p className="set-warn">{t('You work in no other workspace here, so your account goes with it.')}</p>
      )}
      <div className="set-actions">
        <button
          type="button"
          className="btn danger-outline"
          disabled={!plan || !!current.suspended}
          onClick={() => {
            setTyped('');
            setAsking(true);
          }}
          data-testid="delete-workspace-open"
        >
          <I name="trash" size={15} /> {t('Delete workspace…')}
        </button>
      </div>
      {asking && (
        <Confirm
          title={t('Delete {name}?', { name: current.name })}
          action={t('Delete workspace')}
          danger
          busy={del.isPending}
          ready={named}
          onClose={() => setAsking(false)}
          onConfirm={() => void go()}
        >
          <div className="set-del-ask">
            <p>
              {alone
                ? t('It can’t be undone. Everyone who works only here loses their account with it — you too.')
                : t('It can’t be undone. Everyone who works only here loses their account with it; your account stays.')}
            </p>
            <label className="set-field">
              <span>
                <T k={'Type <0>{name}</0> to delete it'} values={{ name: current.name }} tags={[(c) => <b className="set-typed">{c}</b>]} />
              </span>
              <input
                className={`input ${typed && !named ? 'invalid' : ''}`}
                value={typed}
                maxLength={200}
                onChange={(e) => setTyped(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                aria-label={t('The workspace’s name')}
                data-testid="delete-workspace-name"
                data-autofocus=""
              />
            </label>
          </div>
        </Confirm>
      )}
    </Card>
  );
}

export function Workspace() {
  const { current, list, many } = useWorkspaces();
  // the dialog: from this page's button, or "New workspace…" in the account menu (which brings you here)
  const [making, setMaking] = useState(() => askedNewWorkspace());
  useEffect(() => {
    const asked = () => setMaking(askedNewWorkspace());
    addEventListener('vr:new-workspace', asked);
    return () => removeEventListener('vr:new-workspace', asked);
  }, []);
  const Dialog = useLoaded(newWorkspaceCode, making);
  useEffect(() => {
    if (making && Dialog) askedNewWorkspace(true);
  }, [making, Dialog]);
  const allowed = useCan();
  const details = useWorkspaceList();
  const rename = useRenameWorkspace();
  const go = useSwitchWorkspace();
  const [name, setName] = useState(current?.name ?? '');
  useEffect(() => setName(current?.name ?? ''), [current?.name]);
  if (!current) return null;
  const admin = allowed('admin');
  const changed = name.trim() !== current.name && name.trim().length > 0;
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!changed || rename.isPending) return;
    try {
      await rename.mutateAsync(name.trim());
      toast(t('Workspace renamed'));
    } catch (err) {
      toastError(err);
    }
  };
  return (
    <>
      <header className="set-head">
        <h1>{t('Workspace')}</h1>
        <p>
          {t('{name} holds your team’s videos, notes, review links, playbooks and people. Other workspaces on this server see none of it.', {
            name: current.name,
          })}
        </p>
      </header>

      <Card title={t('Name')} lede={admin ? t('People see it in the workspace switcher and in invites.') : t('Owners and admins can rename it.')}>
        {admin ? (
          <form className="set-form" onSubmit={save}>
            <div className="set-actions">
              <input
                className="input grow"
                value={name}
                maxLength={80}
                aria-label={t('Workspace name')}
                onChange={(e) => setName(e.target.value)}
                data-testid="workspace-rename"
              />
              <button type="submit" className="btn primary" disabled={!changed || rename.isPending}>
                {rename.isPending && <Spinner />} {t('Save')}
              </button>
            </div>
          </form>
        ) : (
          <div className="set-row">
            <WorkspaceMark name={current.name} size="md" />
            <b className="grow ellipsis">{current.name}</b>
          </div>
        )}
      </Card>

      <Card
        title={t('{n} member|{n} members', { n: current.members })}
        lede={t('Everyone with an account here, in a role of this workspace. People on review links never count.')}
      >
        <div className="set-actions">
          <span className="grow set-sub">{t('Your role here: {role}', { role: roleLabel(current.role) })}</span>
          {admin && (
            <a className="btn" href="#/settings/users">
              <I name="shield" size={15} /> {t('Members and invites')}
            </a>
          )}
        </div>
      </Card>

      {many && (
        <Card title={t('Your workspaces')} lede={t('Switching takes every tab of this browser along.')}>
          <div className="set-rows" data-testid="workspace-list">
            {list.map((w) => (
              <div key={w.id} className="set-row">
                <WorkspaceMark name={w.name} size="md" />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="ellipsis">
                    <b>{w.name}</b> {w.current && <span className="badge">{t('HERE')}</span>}
                  </div>
                  <div className="set-sub ellipsis">{t('{role} · {n} member|{role} · {n} members', { role: roleLabel(w.role), n: w.members })}</div>
                </div>
                {!w.current && (
                  <button type="button" className="btn sm" disabled={go.isPending} onClick={() => go.mutateAsync(w.id).catch(toastError)}>
                    {t('Switch')}
                  </button>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {details.data?.create && (
        <Card title={t('New workspace')} lede={t('For another team or brand: its own videos, people and review links. You’ll be its owner.')}>
          <div className="set-actions">
            <span className="grow" />
            <button type="button" className="btn" onClick={() => setMaking(true)} data-testid="workspace-new">
              <I name="plus" size={15} /> {t('New workspace…')}
            </button>
          </div>
        </Card>
      )}
      {making && Dialog && <Dialog.NewWorkspaceDialog onClose={() => setMaking(false)} />}
      {/* the server's own workspace is never deleted from here (the server refuses it): its operator runs it */}
      {current.role === 'owner' && current.id !== 'w1' && <DeleteWorkspace current={current} alone={list.length <= 1} />}
    </>
  );
}
