// Connecting an agent, one block for every place that offers it (the setup's agent step on Cloud, at the machine and on
// a self-hosted server, and Get started's agent step): the tiles to pick it, the one snippet it needs for this app
// (lib/mcpConfig.ts, the same Settings → Connect an agent and `lampo mcp config` hand out) with Copy, the one sentence
// that sets it to work ("Use Lampo for <project>": the whole loop), and its live status from the connected-agents
// registry (GET /api/agents, refetched when the `sessions` event says one arrived: every client over /mcp and every
// `lampo watch` announces itself). Copy-only: nothing here writes an agent's configuration.
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { BRAND_NAME } from '../../../lib/brand.ts';
import { lampoFor, MCP_NAME, type McpTarget, mcpSnippet, stdioCommand } from '../../../lib/mcpConfig.ts';
import { compareTime } from '../../../lib/time.ts';
import type { AgentKind, ConnectedAgent, SetupAgent } from '../../../lib/types.ts';
import { useAgents, useAuthStatus, useTokenActions } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import { perLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { ago } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { AgentMark } from '../ui/icons.tsx';
import { Cmd, KG, Live, OIcon, Said } from './parts.tsx';

/** The agents the setup offers, each with its mark and a line about where it runs. */
export const AGENTS = perLang((): { id: SetupAgent; label: string; mark: AgentKind | null; sub: string }[] => [
  { id: 'claude-code', label: 'Claude Code', mark: 'claude-code', sub: t('Terminal') },
  { id: 'codex', label: 'Codex', mark: 'codex', sub: t('Terminal or app') },
  { id: 'cursor', label: 'Cursor', mark: 'cursor', sub: t('Editor') },
  { id: 'chatgpt', label: 'ChatGPT', mark: 'chatgpt', sub: t('Chat app') },
  { id: 'claude', label: 'Claude', mark: 'claude', sub: t('Chat app') },
  { id: 'other', label: t('Other client'), mark: 'mcp', sub: 'VS Code, Gemini CLI, Zed' },
  { id: 'none', label: t('None yet'), mark: null, sub: t('Review with people first; add one any time') },
]);

export const agentLabel = (id: SetupAgent | null | undefined): string | null =>
  id && id !== 'none' ? (AGENTS().find((a) => a.id === id)?.label ?? null) : null;

/** The agent's mark (the dashed ring for "none yet"). */
export function Mark({ id, size = 18 }: { id: SetupAgent; size?: number }) {
  const a = AGENTS().find((x) => x.id === id);
  if (!a?.mark) return <span className="ob-none-ring" aria-hidden="true" />;
  return <AgentMark kind={a.mark} size={size} />;
}

const KNOWN: AgentKind[] = ['claude-code', 'codex', 'cursor', 'chatgpt', 'claude'];
/** A registry entry is the picked agent (by the kind its client name says; "other" is anything else). */
export const isPick = (pick: SetupAgent, kind: AgentKind | undefined) => (pick === 'other' ? !KNOWN.includes(kind ?? 'cli') : kind === pick);

/** Where this app answers agents, and what that allows. */
export interface Where {
  /** The MCP endpoint (`…/mcp`). */
  url: string;
  /** The app runs on this computer and this browser is at it: nothing to sign in, Claude's desktop app starts the server. */
  atMachine: boolean;
  /** The public https address, when there is one (chat apps connect over the internet only). */
  https: string | null;
  /** The app's folder at the machine (Claude's desktop config names its lampo-mcp). */
  root: string;
  /** The host people see (app.lampo.video, localhost:4747). */
  host: string;
}

export function useWhere(): Where | null {
  const info = useInfo();
  const atMachine = useAuthStatus().data?.via === 'local' && !!info?.root;
  if (!info) return null;
  const base = (info.public_url || location.origin).replace(/\/+$/, '');
  const https = info.public_url?.startsWith('https://') ? info.public_url.replace(/\/+$/, '') : null;
  let host = location.host;
  try {
    host = new URL(base).host;
  } catch {}
  return { url: `${base}/mcp`, atMachine, https, root: info.root, host };
}

/** What the block shows for one agent: a snippet with where it goes, a chat app's steps, or what's missing. */
export interface Setup {
  head?: string;
  steps?: string[];
  label?: string;
  code?: string;
  notes: string[];
  /** Reaches the running app over HTTP: it shows up in the registry, so the status is live. */
  live: boolean;
  /** Offers "Use an API token instead" (a hosted server; the client signs in otherwise). */
  tokenable?: boolean;
  /** Cursor's "Add to Cursor". */
  deeplink?: boolean;
  /** Said instead of a live status when it starts a server of its own. */
  offline?: string;
  /** No way from here: what it needs. */
  blocked?: string;
}

export function setupOf(pick: SetupAgent, w: Where, token: string | null): Setup | null {
  const hosted = !w.atMachine;
  const target: McpTarget = { kind: 'http', url: w.url, ...(token ? { tokenEnv: 'LAMPO_TOKEN' } : {}) };
  const env = t('Set LAMPO_TOKEN to your API token (Settings → API tokens) before starting the client.');
  const local = t('No sign-in: it reaches the app on this computer.');
  switch (pick) {
    case 'claude-code':
      return {
        label: t('Claude Code · in a terminal'),
        code: mcpSnippet('claude', target).text,
        notes: [
          token
            ? t('Your shell fills in $LAMPO_TOKEN when you run it.')
            : hosted
              ? t('No token to copy: the first time, run /mcp in Claude Code and sign in.')
              : local,
        ],
        live: true,
        tokenable: hosted,
      };
    case 'codex': {
      const s = mcpSnippet('codex', target);
      return {
        label: `Codex · ${s.where}`,
        code: s.text,
        notes: [token ? env : hosted ? t('Then sign in once: codex mcp login {name}', { name: MCP_NAME }) : local],
        live: true,
        tokenable: hosted,
      };
    }
    case 'cursor': {
      const s = mcpSnippet('cursor', target);
      return {
        label: `Cursor · ${s.where}`,
        code: s.text,
        notes: [token ? env : hosted ? t('Cursor offers to connect: sign in when it asks.') : local],
        deeplink: true,
        live: true,
        tokenable: hosted,
      };
    }
    case 'chatgpt':
    case 'claude': {
      const app = pick === 'chatgpt' ? 'ChatGPT' : 'Claude';
      if (w.https)
        return {
          head: t('Add a connector in {app}', { app }),
          steps:
            pick === 'chatgpt'
              ? [
                  t('In ChatGPT, turn on developer mode: Settings → Security and login.'),
                  t('At chatgpt.com/plugins, select + and create an app.'),
                  t('Paste this address, then allow {name} when it asks.', { name: BRAND_NAME }),
                ]
              : [
                  t('In Claude: Customize → Connectors → + Add.'),
                  t('Choose Add custom connector.'),
                  t('Paste this address, then allow {name} when it asks.', { name: BRAND_NAME }),
                ],
          label: t('Connector address'),
          code: `${w.https}/mcp`,
          notes: [],
          live: true,
        };
      if (pick === 'claude' && w.atMachine)
        return {
          label: t('Claude desktop app · Settings → Developer → Edit Config'),
          code: mcpSnippet('json', { kind: 'stdio', command: stdioCommand(w.root) }).text,
          notes: [t('Restart Claude afterwards. Claude on the web connects once the app runs on a server with an https address.')],
          live: false,
          offline: t('It starts its own server, so it doesn’t show up here. To check, ask it: “What’s waiting for me in {name}?”', { name: BRAND_NAME }),
        };
      return { notes: [], live: false, blocked: t('{app} connects over the internet: it needs this app on a server with an https address.', { app }) };
    }
    case 'other':
      if (token)
        return {
          label: t('Any MCP client · its MCP config'),
          code: mcpSnippet('json', { kind: 'http', url: w.url, token }).text,
          notes: [t('The token is written in: keep this file to yourself.')],
          live: true,
          tokenable: true,
        };
      return {
        label: t('Address, for any MCP client'),
        code: w.url,
        notes: [hosted ? t('It signs in the first time, or takes an API token.') : local, 'lampo mcp config'],
        live: true,
        tokenable: hosted,
      };
  }
  return null;
}

/**
 * The picked agent, if it has connected: the newest registry entry of its kind. Live without a polling storm: the
 * registry is asked again when the `sessions` event says an agent arrived (api/live.ts), and calmly once in a while
 * besides (an agent that stayed connected while the page was away).
 */
export function useConnected(pick: SetupAgent | null, enabled = true): ConnectedAgent | null {
  const agents = useAgents(pick && pick !== 'none' && enabled ? 20_000 : 120_000).data?.agents;
  if (!pick || pick === 'none' || !agents) return null;
  return agents.filter((a) => isPick(pick, a.kind)).sort((a, b) => compareTime(b.last_seen, a.last_seen))[0] ?? null;
}

/** "from Mia’s MacBook Pro · just now", "a session in ~/Projects/northwind · just now": where and when it was seen. */
export function seenLine(a: ConnectedAgent, atMachine: boolean): string {
  const where = a.host ? t('from {device}', { device: a.host }) : atMachine && a.cwd ? t('a session in {folder}', { folder: a.cwd }) : null;
  return [where, ago(a.last_seen)].filter(Boolean).join(' · ');
}

/** Says so once when the picked agent connects (it can happen while the person looks elsewhere on the page). */
export function useConnectToast(pick: SetupAgent | null, connected: ConnectedAgent | null) {
  const was = useRef<string | null>(connected ? `${pick}` : null);
  useEffect(() => {
    if (!pick || pick === 'none') return;
    if (connected && was.current !== pick) toast(t('{name} connected', { name: agentLabel(pick) ?? '' }), 'ok');
    was.current = connected ? pick : null;
  }, [pick, connected]);
}

/** Cursor's own link that offers to add a server (its MCP install deeplink: the config as base64 JSON). */
const cursorLink = (url: string) => {
  const config = btoa(JSON.stringify({ url }));
  return `cursor://anysphere.cursor-deeplink/mcp/install?name=${MCP_NAME}&config=${encodeURIComponent(config)}`;
};

/** The block: how to connect the picked agent here, with Copy, and its live status first (it is what changes).
 * `headless`: Get started's compact form — its pane's headline is the head, a JSON config stands on one line, and
 * "Add to Cursor" joins the last row; `more` goes into that row too. */
export function ConnectBlock({
  pick,
  where,
  connected,
  testid = 'ob-connect',
  headless,
  more,
  project = null,
}: {
  pick: SetupAgent;
  where: Where;
  connected: ConnectedAgent | null;
  testid?: string;
  headless?: boolean;
  more?: ReactNode;
  /** The project the agent is told to use Lampo for (null: "this project", the one it works in). */
  project?: string | null;
}) {
  const [token, setToken] = useState<string | null>(null);
  const [useToken, setUseToken] = useState(false);
  const tokens = useTokenActions();
  const user = useAuthStatus().data?.user;
  if (pick === 'none')
    return (
      <div className="ob-connect ob-none" data-testid={testid}>
        <Said shape="outline" first={<b>{t('No agent for now.')}</b>} second={t('Review with people first. Get started keeps “Connect an agent” for later.')} />
      </div>
    );
  const s = setupOf(pick, where, useToken ? token : null);
  if (!s) return null;
  const label = pick === 'other' ? t('any MCP client') : (agentLabel(pick) ?? '');
  const statusName = pick === 'other' ? t('your MCP client') : (agentLabel(pick) ?? '');
  const head = headless ? null : (
    <header className="ob-connect-h">
      <span className="ob-mk">
        <Mark id={pick} size={18} />
      </span>
      <span>
        <b>{s.head ?? t('Connect {name}', { name: label })}</b>
        <small>{t('to {host}', { host: where.host })}</small>
      </span>
    </header>
  );
  if (s.blocked)
    return (
      <section className="ob-connect" data-testid={testid} data-connect-id={pick}>
        {head}
        <Said shape="half" tone="should" first={s.blocked} />
        {more && <div className="ob-connect-acts">{more}</div>}
      </section>
    );
  const addToCursor = (
    <a className="ob-btn ob-raised" href={cursorLink(where.url)} data-testid="ob-cursor-link">
      <AgentMark kind="cursor" size={14} />
      {t('Add to Cursor')}
    </a>
  );
  const turnOn = async () => {
    setUseToken(true);
    if (token) return;
    try {
      const r = await tokens.create.mutateAsync({ name: t('{agent} (setup)', { agent: agentLabel(pick) ?? t('MCP client') }) });
      setToken(r.token);
    } catch (e) {
      setUseToken(false);
      toastError(e);
    }
  };
  return (
    <section className="ob-connect" data-testid={testid} data-connect-id={pick} aria-label={t('Connect {name}', { name: label })}>
      {head}
      {s.live ? (
        <Live compact on={!!connected} label={statusName} sub={connected ? seenLine(connected, where.atMachine) : t('changes by itself once it calls')} />
      ) : (
        <Said shape="outline" first={s.offline ?? ''} />
      )}
      {s.steps && (
        <ol className="ob-steps">
          {s.steps.map((x) => (
            <li key={x}>{x}</li>
          ))}
        </ol>
      )}
      {s.deeplink && !headless && addToCursor}
      {useToken && token && s.tokenable && (
        <div className="ob-token" data-testid="ob-token">
          <div className="ob-block-h">
            <span>{t('API token · {agent} for {name}', { agent: label, name: user?.name ?? '' })}</span>
            <span className="ob-fine">{t('shown once')}</span>
          </div>
          <Cmd text={token} />
        </div>
      )}
      {s.code && (
        <div className="ob-block">
          <div className="ob-block-h">
            <span>{s.label}</span>
          </div>
          <Cmd text={headless && s.code.startsWith('{') ? s.code.replace(/\n\s*/g, ' ') : s.code} testid="ob-snippet" />
        </div>
      )}
      {(s.code || s.steps) && (
        <div className="ob-block" data-testid="ob-start">
          <div className="ob-block-h">
            <span>{t('Then tell it')}</span>
          </div>
          <Cmd text={lampoFor(project)} testid="ob-start-cmd" />
          {!headless && (
            <p className="ob-fine">
              {t(
                'That one sentence is the whole loop: it finds the project, puts up V1 itself, works your notes and keeps waiting for the next ones until you approve.',
              )}
            </p>
          )}
        </div>
      )}
      {s.notes.length > 0 && (
        <p className="ob-fine">
          {s.notes.map((n) =>
            n === 'lampo mcp config' ? (
              <span key={n}>
                {' '}
                <T k="<0>lampo mcp config vscode</0> prints a ready setup; also antigravity, windsurf, gemini, zed." tags={[(c) => <code>{c}</code>]} />
              </span>
            ) : (
              <span key={n}>{n} </span>
            ),
          )}
        </p>
      )}
      {(s.tokenable || more || (s.deeplink && headless)) && (
        <div className="ob-connect-acts">
          {s.deeplink && headless && addToCursor}
          {s.tokenable && (
            <button type="button" className="ob-lk ob-u" onClick={() => (useToken ? setUseToken(false) : void turnOn())} data-testid="ob-token-toggle">
              {useToken ? t('Sign in instead') : t('Use an API token instead')}
            </button>
          )}
          {more}
        </div>
      )}
    </section>
  );
}

/** The agents as tiles (one picked): found on this machine, connected, or the line about where each runs. */
export function AgentTiles({
  value,
  onPick,
  found,
  connectedKinds,
  atMachine,
}: {
  value: SetupAgent | null;
  onPick: (id: SetupAgent) => void;
  /** The machine: the agents found installed, with their versions. */
  found?: Partial<Record<SetupAgent, string | null>>;
  connectedKinds: Set<SetupAgent>;
  atMachine: boolean;
}) {
  return (
    <fieldset className="ob-tiles ob-agents ob-two" aria-label={t('Your agent')} data-testid="ob-agent-tiles">
      {AGENTS().map((a) => {
        const hasFound = !!found && a.id in found;
        const absent = atMachine && !!found && !hasFound && !['other', 'none', 'claude', 'chatgpt'].includes(a.id);
        const on = connectedKinds.has(a.id);
        const version = found?.[a.id];
        return (
          <label key={a.id} className={`ob-tile ${a.id === 'none' ? 'ob-none-yet' : ''} ${absent ? 'ob-absent' : ''}`} data-agent={a.id}>
            <input type="radio" name="ob-agent" value={a.id} checked={value === a.id} onChange={() => onPick(a.id)} />
            <span className="ob-tile-ico">
              <Mark id={a.id} size={18} />
            </span>
            <b>{a.label}</b>
            {on ? (
              <span className="ob-sub ob-state ob-ok">
                <KG />
                {t('Connected')}
              </span>
            ) : hasFound ? (
              <span className="ob-sub ob-state ob-ok">
                <KG />
                {version ? t('Found · {version}', { version }) : t('Found')}
              </span>
            ) : (
              <span className="ob-sub">{absent ? t('Not found on this computer') : a.sub}</span>
            )}
          </label>
        );
      })}
    </fieldset>
  );
}

/** The agent icon in a tile-less place (Get started's quick picks). */
export const PickIcon = ({ id }: { id: SetupAgent }) => (id === 'other' ? <OIcon name="plug" size={13} /> : <Mark id={id} size={13} />);
