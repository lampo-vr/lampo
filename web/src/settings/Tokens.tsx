// API tokens: how `vr`, the MCP server and scripts act as you. Shown once when created, stored hashed on the server.
// Below them the apps connected through OAuth (ChatGPT, Claude, Cursor, …): each one allowed on a consent screen,
// disconnectable here; admins also see everyone's.
import { type FormEvent, useState } from 'react';
import { type McpClient, mcpSnippet } from '../../../lib/mcpConfig.ts';
import { isScope } from '../../../lib/scopes.ts';
import { useAdminApps, useAppActions, useApps, useCan, useTokenActions, useTokens, useUsers } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import type { PublicApp, PublicToken } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { scopeWord } from '../i18n/scopeTerms.ts';
import { T } from '../i18n/T.tsx';
import { toast, toastError } from '../lib/toast.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { RowsSkeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { Select } from '../ui/select.tsx';
import { EmptyState } from '../ui/system.tsx';
import { type AgentPick, AgentTiles, clientOf, OtherClients } from './AgentChoice.tsx';
import { Card, Code, Confirm, expiry, serverUrl, when } from './parts.tsx';

/**
 * A token that was just made, shown this once: copy it, then connect an agent with it — the same choice as Connect an
 * agent (the chat apps sign in instead, so they aren't offered), its setup with this server's /mcp, the key lampo and
 * the token filled in. `vr` takes the token at its prompt: on the command line the process list and the shell's history
 * would keep it.
 */
function Fresh({ token, name, url, onDone }: { token: string; name: string; url: string; onDone: () => void }) {
  const [pick, setPick] = useState<AgentPick>('claude-code');
  const [other, setOther] = useState<McpClient>('vscode');
  const s = mcpSnippet(clientOf(pick, other), { kind: 'http', url: `${url}/mcp`, token });
  return (
    <section className="set-fresh" role="status" data-testid="token-fresh" aria-labelledby="token-fresh-title">
      <div className="set-fresh-head">
        <span className="set-fresh-mark">
          <I name="check" size={14} />
        </span>
        <b id="token-fresh-title" className="grow">
          {t('“{name}” is ready', { name })}
        </b>
        <button type="button" className="btn sm" onClick={onDone}>
          {t('Done')}
        </button>
      </div>
      <div className="set-fresh-step">
        <h3>
          <span className="set-step-n">1</span>
          {t('Copy your token')}
        </h3>
        <p className="set-sub">{t('It is shown only this once: keep it somewhere safe, like a password manager.')}</p>
        <Code label={t('Token')} testid="token-value">
          {token}
        </Code>
      </div>
      <div className="set-fresh-step">
        <h3>
          <span className="set-step-n">2</span>
          {t('Connect your agent')}
        </h3>
        <p className="set-sub">{t('Its setup already holds the token.')}</p>
        <AgentTiles value={pick} onChange={setPick} only={['claude-code', 'codex', 'cursor', 'other']} name="token-agent" label={t('Your agent')} />
        {pick === 'other' && <OtherClients value={other} onChange={setOther} name="token-agent-other" />}
        <Code label={`${s.label} · ${s.where}`} lines={s.language !== 'shell'} testid="token-snippet">
          {s.text}
        </Code>
        {s.note && <p className="set-sub">{s.note}</p>}
        <p className="set-sub">{t('Agents that use vr instead: sign in on their machine and paste the token when it asks.')}</p>
        <Code label={t('vr on the agent’s machine')} testid="token-login">{`vr login ${url} --token -`}</Code>
      </div>
    </section>
  );
}

// How long a new token works. A token for a machine you own can live until revoked; one for a contractor or a
// short-lived agent should end by itself.
const LIFETIMES = perLang(() => [
  { value: '0', label: t('No expiry') },
  { value: '30', label: t('30 days') },
  { value: '90', label: t('90 days') },
  { value: '365', label: t('1 year') },
]);

function Row({ tok, onRevoke }: { tok: PublicToken; onRevoke: () => void }) {
  const expired = !!tok.expires && Date.parse(tok.expires) <= Date.now();
  return (
    <div className={`set-row ${expired ? 'off' : ''}`} data-testid="token-row">
      <I name="key" size={15} className="faint" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          <b>{tok.name}</b> <span className="mono muted set-prefix">{tok.prefix}…</span>
        </div>
        <div className="set-sub">
          {tok.last_used
            ? t('created {when} · last used {used}', { when: when(tok.created), used: when(tok.last_used) })
            : t('created {when} · never used', { when: when(tok.created) })}
          {' · '}
          <span className={expired ? 'set-expired' : undefined} data-testid="token-expiry">
            {tok.expires ? expiry(tok.expires) : t('no expiry')}
          </span>
        </div>
      </div>
      <button type="button" className="btn sm ghost danger" onClick={onRevoke}>
        {t('Revoke')}
      </button>
    </div>
  );
}

function AppRow({ a, owner, onRevoke }: { a: PublicApp; owner?: string; onRevoke: () => void }) {
  const scopes = a.scopes.filter(isScope).map((s) => scopeWord(s));
  return (
    <div className="set-row">
      <I name="link" size={15} className="faint" />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="ellipsis">
          <b>{a.client_name}</b>{' '}
          <span className="mono muted set-prefix">{a.client_host ? `${a.client_host}${a.verified ? '' : ' · self-named'}` : 'self-named'}</span>
        </div>
        <div className="set-sub">
          {owner ? `${owner} · ` : ''}
          {t('{x} · connected {when} ·', { x: scopes.join(', '), when: when(a.created) })}{' '}
          {a.last_used ? t('last used {when}', { when: when(a.last_used) }) : t('not used yet')}
        </div>
      </div>
      <button type="button" className="btn sm ghost danger" onClick={onRevoke}>
        {t('Disconnect')}
      </button>
    </div>
  );
}

// Apps allowed through the OAuth sign-in: yours, and for admins everyone's.
function ConnectedApps() {
  const admin = useCan()('admin');
  const mine = useApps().data;
  const all = useAdminApps(admin).data;
  const users = useUsers(admin).data;
  const act = useAppActions();
  const [revoking, setRevoking] = useState<{ app: PublicApp; admin: boolean } | null>(null);
  const nameOf = (id: string) => users?.users.find((u) => u.id === id)?.name || 'someone';
  const others = all?.apps.filter((a) => !mine?.apps.some((m) => m.id === a.id)) ?? [];
  const revoke = async () => {
    if (!revoking) return;
    try {
      await act.revoke.mutateAsync({ id: revoking.app.id, admin: revoking.admin });
      toast(t('Disconnected “{client_name}”', { client_name: revoking.app.client_name }), 'ok');
    } catch (err) {
      toastError(err);
    }
    setRevoking(null);
  };
  return (
    <>
      <Card
        title={t('Connected apps')}
        lede={t('Apps you allowed to work with your reviews by signing in (ChatGPT, Claude, Cursor, …). They never see your password.')}
      >
        {!mine ? (
          <SkeletonRegion label={t('Loading the connected apps')}>
            <RowsSkeleton n={2} thumb={false} />
          </SkeletonRegion>
        ) : !mine.apps.length ? (
          <EmptyState size="sm" art="agents" title={t('No apps connected')}>
            {t('Apps like ChatGPT or Claude connect by adding this server’s /mcp URL; you allow them on a sign-in screen.')}
          </EmptyState>
        ) : (
          <div className="set-rows">
            {mine.apps.map((a) => (
              <AppRow key={a.id} a={a} onRevoke={() => setRevoking({ app: a, admin: false })} />
            ))}
          </div>
        )}
      </Card>
      {admin && others.length > 0 && (
        <Card title={t('Everyone’s connected apps')} lede={t('Apps other people on this server connected. Disconnecting one stops it at once.')}>
          <div className="set-rows">
            {others.map((a) => (
              <AppRow key={a.id} a={a} owner={nameOf(a.user)} onRevoke={() => setRevoking({ app: a, admin: true })} />
            ))}
          </div>
        </Card>
      )}
      {revoking && (
        <Confirm
          title={t('Disconnect “{client_name}”?', { client_name: revoking.app.client_name })}
          action={t('Disconnect')}
          danger
          busy={act.revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={revoke}
        >
          {t('It loses access at once; to use it again, connect it again from the app.')}
        </Confirm>
      )}
    </>
  );
}

export function Tokens() {
  const info = useInfo();
  const url = serverUrl(info?.public_url);
  const { data } = useTokens();
  const act = useTokenActions();
  const [name, setName] = useState('');
  const [days, setDays] = useState('0');
  const [fresh, setFresh] = useState<{ token: string; name: string } | null>(null);
  const [revoking, setRevoking] = useState<PublicToken | null>(null);
  const create = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const n = name.trim() || 'token';
      const r = await act.create.mutateAsync({ name: n, days: Number(days) || undefined });
      setFresh({ token: r.token, name: r.info.name });
      setName('');
    } catch (err) {
      toastError(err);
    }
  };
  const revoke = async () => {
    if (!revoking) return;
    try {
      await act.revoke.mutateAsync(revoking.id);
      toast(t('Revoked “{name}”', { name: revoking.name }), 'ok');
    } catch (err) {
      toastError(err);
    }
    setRevoking(null);
  };
  return (
    <>
      <header className="set-head">
        <h1>{t('API tokens')}</h1>
        <p>
          <T
            k={
              'Tokens let <0>vr</0>, the MCP server and scripts work as you from another machine. One per machine or agent makes it easy to revoke just that one.'
            }
            tags={[(c) => <code>{c}</code>]}
          />
        </p>
      </header>

      <Card title={t('New token')}>
        <form className="set-inline" onSubmit={create}>
          <input
            className="input grow"
            placeholder={t('Where it’s used, e.g. “Studio Mac · Claude Code”')}
            value={name}
            onChange={(e) => setName(e.target.value)}
            maxLength={80}
          />
          <Select label={t('How long it works')} value={days} onChange={setDays} options={LIFETIMES()} />
          <button type="submit" className="btn primary" disabled={act.create.isPending}>
            {act.create.isPending ? <Spinner /> : <I name="plus" size={15} />} {t('Create token')}
          </button>
        </form>
        {fresh && <Fresh token={fresh.token} name={fresh.name} url={url} onDone={() => setFresh(null)} />}
      </Card>

      <Card title={t('Your tokens')}>
        {!data ? (
          <SkeletonRegion label={t('Loading your tokens')}>
            <RowsSkeleton n={2} thumb={false} />
          </SkeletonRegion>
        ) : !data.tokens.length ? (
          <EmptyState size="sm" art="token" title={t('No tokens yet')}>
            {t('Create one above for a script, a CI job or an agent on another machine.')}
          </EmptyState>
        ) : (
          <div className="set-rows">
            {data.tokens.map((tok) => (
              <Row key={tok.id} tok={tok} onRevoke={() => setRevoking(tok)} />
            ))}
          </div>
        )}
      </Card>

      <ConnectedApps />

      {revoking && (
        <Confirm
          title={t('Revoke the token “{name}”?', { name: revoking.name })}
          action={t('Revoke')}
          danger
          busy={act.revoke.isPending}
          onClose={() => setRevoking(null)}
          onConfirm={revoke}
        >
          <T
            k={'Anything using it ({prefix}…) stops working at once; agents on that machine need <0>vr login</0> again.'}
            values={{ prefix: revoking.prefix }}
            tags={[(c) => <code>{c}</code>]}
          />
        </Confirm>
      )}
    </>
  );
}
