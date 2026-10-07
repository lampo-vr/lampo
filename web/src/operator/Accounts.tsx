// Every account on the server (#/operator/accounts) and one opened (#/operator/accounts/<id>). The list: name and
// email, the workspaces and roles, when it was made, when it was last active and whether it is disabled — searched by
// name or email. An account: its facts, its workspaces, and Disable (signed out everywhere, its tokens and apps stopped
// at once; nothing deleted) or Enable. Never one's own, never a password, a token or anything the person made.
import { useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import type { OperatorAccount, OperatorAccounts } from '../../../lib/types.ts';
import { ApiError } from '../api/client.ts';
import { WorkspaceMark } from '../auth/Workspaces.tsx';
import { locale, t } from '../i18n/index.ts';
import { roleLabel } from '../i18n/terms.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { toast, toastError } from '../lib/toast.ts';
import { Card, Confirm, Facts } from '../settings/parts.tsx';
import { Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Segmented } from '../ui/primitives.tsx';
import { Skeleton, SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { opKeys, refused, useAccess, useOpAccount, useOpAccounts } from './api.ts';
import { Crumb, day, dayTime, Gone, SearchField, shortDay, since } from './parts.tsx';

type Sort = 'active' | 'created';
type Group = 'all' | 'active' | 'disabled';

/** What the list was showing, kept while an account is open: back is where you were. */
const view: { q: string; group: Group; sort: Sort } = { q: '', group: 'all', sort: 'active' };

const time = (iso: string | null) => (iso ? Date.parse(iso) || 0 : 0);
/** When it was last active, for the order: your own account now (you are using it). */
const activeAt = (a: OperatorAccount) => (a.you ? Date.now() : time(a.lastActive));
/** For nothing recorded: "never" for an account that never signed in, else "not recorded" (one from before it was kept). */
const noActivity = (a: OperatorAccount): string => (a.neverSignedIn ? t('never') : t('not recorded'));

function matches(a: OperatorAccount, q: string): boolean {
  if (!q) return true;
  const hay = `${a.name}\n${a.email}\n${a.id}`.toLocaleLowerCase(locale());
  return q
    .toLocaleLowerCase(locale())
    .split(/\s+/)
    .every((word) => hay.includes(word));
}

/** The account's marks beside its name: you, the server's operator, disabled, waiting for its address. */
function Marks({ a }: { a: OperatorAccount }) {
  return (
    <>
      {a.you && <span className="badge">{t('YOU')}</span>} {a.operator && <span className="badge">{t('OPERATOR')}</span>}{' '}
      {a.disabled && <span className="badge danger">{t('DISABLED')}</span>} {a.unverified && <span className="badge">{t('UNCONFIRMED')}</span>}
    </>
  );
}

/** Its workspaces in a few words: the first one and its role, and how many more — the name gives way, the rest never. */
function WorkspacesCell({ a }: { a: OperatorAccount }) {
  const first = a.workspaces[0];
  if (!first) return <span className="op-dim">{t('in no workspace')}</span>;
  return (
    <>
      <span className="ellipsis">{first.name}</span>
      <span className="op-role">· {roleLabel(first.role)}</span>
      {a.workspaces.length > 1 && <span className="op-role">{t('+ {n} more', { n: a.workspaces.length - 1 })}</span>}
    </>
  );
}

function Head() {
  return (
    <div className="set-row op-row op-acc op-head" aria-hidden="true">
      <span className="op-c-mark" />
      <span className="op-c-main">{t('Account')}</span>
      <span className="op-c-spaces">{t('Workspaces')}</span>
      <span className="op-c-created op-num">{t('Created')}</span>
      <span className="op-c-active op-num">{t('Last active')}</span>
    </div>
  );
}

function Row({ a }: { a: OperatorAccount }) {
  return (
    <a className={`set-row op-row op-acc ${a.disabled ? 'off' : ''}`} href={`#/operator/accounts/${a.id}`} data-testid="op-acc-row" data-id={a.id}>
      <span className="op-c-mark">
        <Avatar name={a.name} size={28} kind="person" />
      </span>
      <span className="op-c-main">
        <span className="ellipsis">
          <b>{a.name}</b> <Marks a={a} />
        </span>
        <span className="set-sub ellipsis">{a.email}</span>
      </span>
      <span className="op-c-spaces set-sub" title={a.workspaces.map((w) => `${w.name} · ${roleLabel(w.role)}`).join('\n')}>
        <span className="sr-only">{t('Workspaces')}: </span>
        <WorkspacesCell a={a} />
      </span>
      <span className="op-c-created op-num" title={dayTime(a.created)}>
        <span className="sr-only">{t('Created')}: </span>
        {shortDay(a.created)}
      </span>
      <span className="op-c-active op-num" title={!a.you && a.lastActive ? dayTime(a.lastActive) : undefined} data-testid="op-acc-active">
        <span className="sr-only">{t('Last active')}: </span>
        {a.you ? t('now') : since(a.lastActive, noActivity(a))}
      </span>
    </a>
  );
}

function RowPending({ i }: { i: number }) {
  return (
    <div className="set-row op-row op-acc" aria-hidden="true">
      <span className="op-c-mark">
        <Skeleton w={28} h={28} r={14} />
      </span>
      <span className="op-c-main">
        <b>
          <SkLine w={`${7 + ((i * 3) % 5)}em`} />
        </b>
        <span className="set-sub">
          <SkLine w={`${11 + ((i * 5) % 6)}em`} />
        </span>
      </span>
      <span className="op-c-spaces set-sub">
        <SkLine w="10em" />
      </span>
      <span className="op-c-created op-num">
        <SkLine w="4em" />
      </span>
      <span className="op-c-active op-num">
        <SkLine w="4em" />
      </span>
    </div>
  );
}

export function AccountsPage() {
  const q = useOpAccounts();
  const [search, setSearchState] = useState(view.q);
  const [group, setGroupState] = useState<Group>(view.group);
  const [sort, setSortState] = useState<Sort>(view.sort);
  const setSearch = (v: string) => {
    view.q = v;
    setSearchState(v);
  };
  const setGroup = (v: Group) => {
    view.group = v;
    setGroupState(v);
  };
  const setSort = (v: Sort) => {
    view.sort = v;
    setSortState(v);
  };
  const field = useRef<HTMLInputElement | null>(null);
  // the chips scroll sideways in what the row leaves them, a soft edge where there are more
  const [chipsRef, chipsEdges] = useScrollEdges<HTMLDivElement>();
  if (refused(q.error) || (q.error instanceof ApiError && q.error.status === 404)) return <Gone />;
  const all = q.data?.accounts ?? [];
  const disabled = all.filter((a) => a.disabled).length;
  const counts: Record<Group, number> = { all: all.length, active: all.length - disabled, disabled };
  const term = search.trim();
  const shown = all
    .filter((a) => matches(a, term) && (group === 'all' || (group === 'disabled') === !!a.disabled))
    .sort((a, b) => (sort === 'active' ? activeAt(b) - activeAt(a) : 0) || time(b.created) - time(a.created) || a.name.localeCompare(b.name));
  return (
    <>
      <header className="set-head">
        <h1>{t('Accounts')}</h1>
        <p>{t('Everyone with an account on this server, and the workspaces they are in. Disabling one signs it out everywhere; nothing of it is deleted.')}</p>
      </header>
      <div className="op-toolbar" role="toolbar" aria-label={t('Accounts')}>
        <SearchField
          value={search}
          onChange={setSearch}
          inputRef={field}
          placeholder={t('Search by name or email')}
          label={t('Search the accounts by name or email')}
          disabled={!q.data}
        />
        <div className={`op-chips ${chipsEdges}`} ref={chipsRef}>
          <Segmented
            label={t('Which accounts')}
            className="chips"
            value={group}
            onChange={(g) => g && setGroup(g as Group)}
            options={[
              { value: 'all', label: t('All'), count: q.data ? counts.all : null },
              { value: 'active', label: t('Active'), count: q.data ? counts.active : null },
              { value: 'disabled', label: t('Disabled'), count: q.data ? counts.disabled : null },
            ]}
          />
        </div>
        <span className="grow" />
        <Segmented
          label={t('Order')}
          className="op-sort"
          value={sort}
          onChange={(s) => s && setSort(s as Sort)}
          options={[
            { value: 'active', label: t('Last active') },
            { value: 'created', label: t('Newest') },
          ]}
        />
      </div>
      {q.error && !q.data ? (
        <EmptyState art="error" titleAs="h2" title={t('The accounts didn’t load')} action={<Button onClick={() => void q.refetch()}>{t('Try again')}</Button>}>
          {(q.error as Error).message}
        </EmptyState>
      ) : !q.data ? (
        <SkeletonRegion label={t('Loading the accounts')}>
          <div className="set-rows op-rows">
            <Head />
            {Array.from({ length: 8 }, (_, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
              <RowPending key={i} i={i} />
            ))}
          </div>
        </SkeletonRegion>
      ) : (
        <div className="set-rows op-rows" data-testid="op-accounts">
          <Head />
          {shown.map((a) => (
            <Row key={a.id} a={a} />
          ))}
          {!shown.length && (
            <div className="op-rows-empty">
              {term ? (
                <EmptyState
                  art="search"
                  size="sm"
                  title={t('No account matches “{q}”', { q: term })}
                  testId="op-acc-none"
                  action={
                    <Button
                      onClick={() => {
                        setSearch('');
                        field.current?.focus();
                      }}
                    >
                      {t('Clear the search')}
                    </Button>
                  }
                >
                  {t('Search finds an account by its name or its email.')}
                </EmptyState>
              ) : (
                <EmptyState
                  art="filter"
                  size="sm"
                  title={group === 'disabled' ? t('No disabled account') : t('No active account')}
                  testId="op-acc-none"
                  action={<Button onClick={() => setGroup('all')}>{t('Show all')}</Button>}
                >
                  {group === 'disabled' ? t('Every account here can sign in.') : t('Every account here is disabled.')}
                </EmptyState>
              )}
            </div>
          )}
        </div>
      )}
      {q.data && shown.length > 0 && (
        <p className="op-foot set-sub">
          {shown.length === all.length ? t('{n} account|{n} accounts', { n: all.length }) : t('{n} of {of} accounts', { n: shown.length, of: all.length })}
        </p>
      )}
    </>
  );
}

// ---------------------------------------------------------------- one account

/** When it was last active, as its facts say it: "now" for your own, else how long ago and when. */
function activeFact(a: OperatorAccount): string {
  if (a.you) return t('now');
  return a.lastActive ? `${since(a.lastActive)} · ${dayTime(a.lastActive)}` : noActivity(a);
}

/** Its last sign-in: how long ago and when; "never", or none recorded yet (an account from before it was kept). */
function signInFact(a: OperatorAccount): string {
  if (a.signedIn) return `${since(a.signedIn)} · ${dayTime(a.signedIn)}`;
  return a.neverSignedIn ? t('never') : t('none recorded yet');
}

/** Disable or Enable: what each ends or gives back, said before it happens. */
function AccessCard({ a }: { a: OperatorAccount }) {
  const access = useAccess(a.id);
  const [asking, setAsking] = useState(false);
  const flip = async (disable: boolean) => {
    try {
      await access.mutateAsync(disable);
      toast(disable ? t('{name} is disabled and signed out everywhere', { name: a.name }) : t('{name} can sign in again', { name: a.name }), 'ok');
    } catch (err) {
      toastError(err);
    }
    setAsking(false);
  };
  return (
    <Card
      title={t('Access')}
      danger={!a.disabled && !a.you}
      testid="op-access"
      lede={
        a.you
          ? t('This is your own account: disabling it here would lock you out.')
          : a.disabled
            ? t('Disabled since {day}: it can’t sign in, and its tokens and connected apps are stopped. Its notes and memberships are as they were.', {
                day: dayTime(a.disabled),
              })
            : t(
                'Disabling signs {name} out everywhere and stops their API tokens and connected apps at once. Their account, notes and memberships stay; Enable lets them sign in again.',
                {
                  name: a.name,
                },
              )
      }
    >
      {!a.you && (
        <div className="set-actions">
          <span className="grow" />
          {a.disabled ? (
            <button type="button" className="btn" onClick={() => void flip(false)} disabled={access.isPending} data-testid="op-enable">
              {access.isPending ? <Spinner /> : <I name="check" size={15} />} {t('Enable')}
            </button>
          ) : (
            <button type="button" className="btn danger-outline" onClick={() => setAsking(true)} disabled={access.isPending} data-testid="op-disable">
              <I name="shield" size={15} /> {t('Disable…')}
            </button>
          )}
        </div>
      )}
      {asking && (
        <Confirm
          title={t('Disable {name}?', { name: a.name })}
          action={t('Disable')}
          danger
          busy={access.isPending}
          onClose={() => setAsking(false)}
          onConfirm={() => void flip(true)}
        >
          {t('They are signed out everywhere and their tokens and apps stop at once, in every workspace they are in. You can enable them again any time.')}
        </Confirm>
      )}
    </Card>
  );
}

export function AccountPage({ id }: { id: string }) {
  const q = useOpAccount(id);
  const listed = useQueryClient()
    .getQueryData<OperatorAccounts>(opKeys.accounts)
    ?.accounts.find((x) => x.id === id);
  if (refused(q.error)) return <Gone />;
  const a = q.data ?? listed;
  if (q.error instanceof ApiError && (q.error.status === 404 || q.error.status === 400))
    return (
      <>
        <Crumb href="#/operator/accounts" list={t('Accounts')} />
        <EmptyState
          art="search"
          titleAs="h1"
          title={t('No account with this address')}
          testId="op-acc-missing"
          action={
            <Button variant="primary" onClick={() => (location.hash = '#/operator/accounts')}>
              {t('All accounts')}
            </Button>
          }
        >
          {t('It may have been removed, or the address is mistyped.')}
        </EmptyState>
      </>
    );
  return (
    <>
      <Crumb href="#/operator/accounts" list={t('Accounts')} />
      <header className="set-head op-title" data-testid="op-account">
        <h1>
          {a ? (
            <>
              <Avatar name={a.name} size={32} kind="person" />
              <span>{a.name}</span>
            </>
          ) : (
            <SkLine w="10ch" />
          )}
        </h1>
        <p>
          {a ? (
            <>
              {a.email} <Marks a={a} />
            </>
          ) : (
            <SkLine w="16em" />
          )}
        </p>
      </header>
      {q.error && !a ? (
        <EmptyState art="error" titleAs="h2" title={t('The account didn’t load')} action={<Button onClick={() => void q.refetch()}>{t('Try again')}</Button>}>
          {(q.error as Error).message}
        </EmptyState>
      ) : (
        <>
          <Card title={t('At a glance')} testid="op-facts">
            <Facts
              rows={[
                {
                  label: t('Email'),
                  value: a ? `${a.email} · ${a.unverified ? t('waiting for its confirmation link') : t('confirmed')}` : <SkLine w="14em" />,
                },
                { label: t('Created'), value: a ? dayTime(a.created) : <SkLine w="10em" /> },
                { label: t('Last active'), value: a ? activeFact(a) : <SkLine w="10em" /> },
                { label: t('Last sign-in'), value: a ? signInFact(a) : <SkLine w="10em" /> },
                { label: t('State'), value: a ? a.disabled ? t('disabled since {day}', { day: day(a.disabled) }) : t('active') : <SkLine w="5em" /> },
                { label: t('Account id'), value: id, mono: true },
              ]}
            />
          </Card>
          <Card
            title={a?.workspaces.length ? t('In {n} workspace|In {n} workspaces', { n: a.workspaces.length }) : t('Workspaces')}
            lede={a && !a.workspaces.length ? undefined : t('Its role in each. Open one for its plan and people.')}
            testid="op-acc-workspaces"
          >
            {!a ? (
              <SkeletonRegion label={t('Loading the workspaces')}>
                <div className="set-rows">
                  {[0, 1].map((i) => (
                    <div key={i} className="set-row">
                      <Skeleton w={24} h={24} r={6} />
                      <span className="grow">
                        <SkLine w={`${9 + i * 3}em`} />
                      </span>
                      <SkLine w="5em" />
                    </div>
                  ))}
                </div>
              </SkeletonRegion>
            ) : a.workspaces.length ? (
              <div className="set-rows">
                {a.workspaces.map((w) => (
                  <a key={w.id} className={`set-row op-link-row ${w.suspended ? 'off' : ''}`} href={`#/operator/workspaces/${w.id}`} data-testid="op-acc-ws">
                    <WorkspaceMark name={w.name} size="md" />
                    <span className="grow op-col">
                      <span className="ellipsis">
                        <b>{w.name}</b> {w.suspended && <span className="badge">{t('SUSPENDED HERE')}</span>}
                      </span>
                      {w.suspended && <span className="set-sub">{t('Its admins disabled them there on {day}.', { day: day(w.suspended) })}</span>}
                    </span>
                    <span className={`badge role-${w.role}`}>{roleLabel(w.role).toUpperCase()}</span>
                    <I name="right" size={14} className="op-chevron" />
                  </a>
                ))}
              </div>
            ) : (
              <EmptyState art="list" size="sm" title={t('In no workspace')} testId="op-acc-no-ws">
                {t('A sign-up still waiting for its link, or an account that left every workspace.')}
              </EmptyState>
            )}
          </Card>
          {a ? (
            <AccessCard a={a} />
          ) : (
            <Card title={t('Access')} lede={<SkLine w="24em" />}>
              <span />
            </Card>
          )}
        </>
      )}
    </>
  );
}
