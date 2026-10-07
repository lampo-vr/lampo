// Connect an agent, one page per agent: pick it (Claude Code, Codex, Cursor, ChatGPT, Claude, any other MCP client),
// copy the one snippet or connector address it needs, then tell it one sentence — "Use Lampo for <project>" is the
// whole loop (the server's instructions: it finds the project, puts up V1, works the notes and keeps waiting for the
// next ones until the person approves) — and see it work, live (the connected-agents registry: every client over /mcp
// and every `vr watch` announces itself). Copy-only: nothing here writes an agent's configuration (`vr mcp config
// <client>` prints the same). At the machine the app runs on, clients reach the running app without signing in; they
// may also start the MCP server themselves (then they don't show up in the registry).
import { useState } from 'react';
import { WAKE_DEFAULT } from '../../../lib/agentRun.ts';
import { BRAND_NAME } from '../../../lib/brand.ts';
import { lampoFor, MCP_NAME, type McpClient, type McpTarget, mcpSnippet } from '../../../lib/mcpConfig.ts';
import { compareTime } from '../../../lib/time.ts';
import type { AgentKind, AgentListenState, WakePref } from '../../../lib/types.ts';
import { useAgents, useAuthStatus, useUpdateMe } from '../api/auth.ts';
import { useInfo, useLibrary } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { projectsOf } from '../lib/projects.ts';
import { toastError } from '../lib/toast.ts';
import { WATCH_COMMAND } from '../sessions/listening.tsx';
import { Badge } from '../ui/Badge.tsx';
import { AgentMark } from '../ui/icons.tsx';
import { Segmented } from '../ui/primitives.tsx';
import { AGENT_TILES, type AgentPick, AgentTiles, clientOf, OtherClients } from './AgentChoice.tsx';
import { Card, Code, when } from './parts.tsx';

const KNOWN: AgentKind[] = ['claude-code', 'codex', 'cursor', 'chatgpt', 'claude'];
/** The domain of an origin (what a client's list of allowed domains takes), or null. */
const hostOf = (origin: string | undefined): string | null => {
  try {
    return origin ? new URL(origin).hostname : null;
  } catch {
    return null;
  }
};
const isAgent = (pick: AgentPick, kind: AgentKind | undefined) => (pick === 'other' ? !KNOWN.includes(kind ?? 'cli') : kind === pick);

/** What step 2 shows: a snippet with where it goes, or what is missing. */
interface Setup {
  code?: { label: string; text: string };
  /** A line before the snippet (the chat apps' menu path). */
  how?: string;
  /** Lines after it: the client's own note, how it signs in. */
  notes: string[];
  /** Reaches the running app over HTTP: it shows up in step 3 and gets updates pushed. */
  live: boolean;
  /** No way from here (a chat app without a public https address). */
  blocked?: string;
  /** A domain the client's sandbox must be allowed to reach: the media host its one-time upload URLs point at. */
  allow?: string;
}

function setup(
  pick: AgentPick,
  other: McpClient,
  target: McpTarget,
  ctx: { atMachine: boolean; https: string | null; root: string; mediaHost: string | null },
): Setup {
  if (pick === 'chatgpt' || pick === 'claude') {
    const app = pick === 'chatgpt' ? 'ChatGPT' : 'Claude';
    if (ctx.https)
      return {
        how:
          pick === 'chatgpt'
            ? t(
                'In ChatGPT: turn on developer mode in Settings → Security and login, then select + at chatgpt.com/plugins and create an app with this address.',
              )
            : t('In Claude: Customize → Connectors → + Add → Add custom connector, with this address.'),
        code: { label: t('Connector address'), text: `${ctx.https}/mcp` },
        notes: [t('It opens the app’s sign-in the first time: allow it there.')],
        live: true,
        // Claude uploads from a sandbox whose proxy lets it reach only the domains it allows: without the media host
        // there, its PUT is refused before it reaches this server.
        ...(pick === 'claude' && ctx.mediaHost ? { allow: ctx.mediaHost } : {}),
      };
    // Claude's desktop app can start the server itself at the machine; everything else needs the app on the internet.
    if (pick === 'claude' && ctx.atMachine)
      return {
        code: {
          label: t('Claude desktop app · Settings → Developer → Edit Config'),
          text: mcpSnippet('json', { kind: 'stdio', command: `${ctx.root}/bin/vr-mcp` }).text,
        },
        notes: [t('Restart Claude afterwards. Claude on the web connects once the app runs on a server with an https address.')],
        live: false,
      };
    return {
      notes: [],
      live: false,
      blocked: t('{app} connects over the internet: it needs this app on a server with an https address.', { app }),
    };
  }
  const client = clientOf(pick, other);
  const s = mcpSnippet(client, target);
  const notes = s.note ? [s.note] : [];
  if (target.kind === 'stdio') notes.push(t('It works while the app is closed, but gets no updates pushed.'));
  else if (ctx.atMachine) notes.push(t('No sign-in: it reaches the app on this computer.'));
  else
    notes.push(
      client === 'claude'
        ? t('The first time, run /mcp in Claude Code and sign in.')
        : client === 'codex'
          ? t('Then sign in once: codex mcp login {name}', { name: MCP_NAME })
          : client === 'cursor'
            ? t('Cursor offers to connect: sign in when it asks.')
            : t('It signs in the first time, or takes an API token from Settings → API tokens.'),
    );
  return { code: { label: `${s.label} · ${s.where}`, text: s.text }, notes, live: target.kind === 'http' };
}

/** A connected agent's state, as the page says it after its name. */
const STATE: Record<AgentListenState, () => string> = {
  idle: () => t('connected'),
  listening: () => t('waiting for your notes'),
  working: () => t('working'),
};

/** The last step: waiting for it to connect, or who connected, when, and what it does now (newest first). */
function ConnectState({ pick, live }: { pick: AgentPick; live: boolean }) {
  const agents = useAgents(live ? 3000 : 30_000).data?.agents;
  const mine = (agents ?? []).filter((a) => isAgent(pick, a.kind)).sort((a, b) => compareTime(b.last_seen, a.last_seen));
  const name = AGENT_TILES().find((x) => x.id === pick)?.label ?? '';
  if (!live)
    return (
      <p className="set-sub" data-testid="agent-state">
        {t('It starts its own server, so it doesn’t show up here. To check, ask it: “What’s waiting for me in {name}?”', { name: BRAND_NAME })}
      </p>
    );
  const first = mine[0];
  return (
    <div className="set-voice" data-testid="agent-state" data-state={first?.state ?? 'none'} aria-live="polite">
      {first ? (
        <>
          <AgentMark kind={first.kind ?? 'cli'} size={16} />
          <Badge tone="ok">{t('Connected: {name}', { name: first.name })}</Badge>
          <span className="set-sub">
            {t('seen {when}', { when: when(first.last_seen) })}
            {first.state && ` · ${STATE[first.state]()}`}
            {mine.length > 1 && ` · ${t('{n} more', { n: mine.length - 1 })}`}
          </span>
        </>
      ) : (
        <>
          <Badge tone="neutral" className="set-waiting">
            {t('Waiting for it to connect…')}
          </Badge>
          <span className="set-sub">
            {pick === 'other'
              ? t('Add it, then tell it the sentence above: it shows up here.')
              : t('Add it, then tell {name} the sentence above: it shows up here.', { name })}
          </span>
        </>
      )}
    </div>
  );
}

/**
 * The sentence that sets it to work, for the project it is about: one of the person's projects (picked when there are
 * several), else "this project" — the agent names one from the work it is in.
 */
function TellIt({ pick }: { pick: AgentPick }) {
  const projects = projectsOf(useLibrary().data);
  const [chosen, setChosen] = useState<string | null>(null);
  const project = chosen && projects.includes(chosen) ? chosen : (projects[0] ?? null);
  const name = AGENT_TILES().find((x) => x.id === pick)?.label ?? '';
  return (
    <>
      {projects.length > 1 && (
        <fieldset className="set-chips" data-testid="agent-projects">
          <legend className="sr-only">{t('Project')}</legend>
          {projects.slice(0, 8).map((p) => (
            <label key={p} className="set-chip">
              <input type="radio" name="agent-project" value={p} className="sr-only" checked={p === project} onChange={() => setChosen(p)} />
              {p}
            </label>
          ))}
        </fieldset>
      )}
      <Code label={pick === 'other' ? t('Tell your agent') : t('Tell {name}', { name })} testid="agent-tell-it">
        {lampoFor(project)}
      </Code>
      {pick === 'claude-code' && (
        <p className="set-hint set-sub" data-testid="agent-shortcut">
          <T k="In Claude Code, <0>{command}</0> does the same." values={{ command: WATCH_COMMAND }} tags={[(c) => <code>{c}</code>]} />
        </p>
      )}
    </>
  );
}

export function Mcp() {
  const info = useInfo();
  const atMachine = useAuthStatus().data?.via === 'local' && !!info?.root;
  const [pick, setPick] = useState<AgentPick>('claude-code');
  const [other, setOther] = useState<McpClient>('vscode');
  // Through the running app by default: it pushes updates and the agent shows up in step 3.
  const [own, setOwn] = useState(false);
  const base = (info?.public_url || location.origin).replace(/\/+$/, '');
  const https = info?.public_url?.startsWith('https://') ? info.public_url.replace(/\/+$/, '') : null;
  const stdio = atMachine && own && pick !== 'chatgpt' && pick !== 'claude';
  const target: McpTarget = stdio ? { kind: 'stdio', command: `${info?.root}/bin/vr-mcp` } : { kind: 'http', url: `${base}/mcp` };
  const s = info ? setup(pick, other, target, { atMachine, https, root: info.root, mediaHost: hostOf(info.media_origin) }) : null;
  const chat = pick === 'chatgpt' || pick === 'claude';
  return (
    <>
      <header className="set-head">
        <h1>{t('Connect an agent')}</h1>
        <p>
          {t(
            'Add Lampo to your agent, then tell it to use Lampo: it puts up V1, fixes the notes on the frames and puts up the next version until you approve. Nothing here changes its settings: you copy what it needs.',
          )}
        </p>
      </header>

      <Card step={1} title={t('Pick your agent')}>
        <AgentTiles value={pick} onChange={setPick} name="agent" label={t('Pick your agent')} />
      </Card>

      <Card step={2} title={chat ? t('Add the connector') : t('Add {name} to it', { name: BRAND_NAME })} lede={s?.how} testid="agent-snippet">
        {pick === 'other' && <OtherClients value={other} onChange={setOther} name="agent-other" />}
        {s?.blocked && <p className="set-warn">{s.blocked}</p>}
        {s?.code && (
          <Code label={s.code.label} lines={s.code.text.includes('\n')}>
            {s.code.text}
          </Code>
        )}
        {s?.notes.map((n) => (
          <p key={n} className="set-hint set-sub">
            {n}
          </p>
        ))}
        {s?.allow && (
          <>
            <Code label={t('Allowed domain')} testid="agent-allow">
              {s.allow}
            </Code>
            <p className="set-hint set-sub">
              {t(
                'Claude’s sandbox uploads videos here: add it to Claude’s allowed domains in Settings → Capabilities. On Team and Enterprise plans, the organization’s owner adds it.',
              )}
            </p>
          </>
        )}
        {atMachine && !chat && (
          <button type="button" className="btn sm ghost set-more" onClick={() => setOwn(!own)}>
            {own ? t('Connect through the running app instead') : t('Or let it start its own server')}
          </button>
        )}
      </Card>

      {s && !s.blocked && (
        <Card
          step={3}
          title={t('Now tell it')}
          lede={t(
            'That one sentence is the whole loop: it finds the project, puts up V1 itself, works your notes and keeps waiting for the next ones until you approve.',
          )}
          testid="agent-tell"
        >
          <TellIt pick={pick} />
        </Card>
      )}

      {s && !s.blocked && (
        <Card step={4} title={t('See it work')}>
          <ConnectState pick={pick} live={s.live} />
        </Card>
      )}

      {atMachine && info?.capabilities?.wakeAgents && <WakeSetting />}
    </>
  );
}

/**
 * On the machine: what sending a request, a nudge or an answer to a Claude Code session that isn't running does —
 * ask each time (the default), start it, or only send (it gets it when it starts). Kept on the account.
 */
function WakeSetting() {
  const user = useAuthStatus().data?.user;
  const update = useUpdateMe();
  const value: WakePref = user?.prefs?.wake ?? WAKE_DEFAULT;
  return (
    <Card
      title={t('When an agent isn’t running')}
      lede={t('Sending a request or an answer to a Claude Code session that isn’t running can start it in its own folder, with your Claude Code settings.')}
      testid="wake-setting"
    >
      <Segmented
        label={t('When an agent isn’t running')}
        value={value}
        onChange={(v) => update.mutateAsync({ prefs: { wake: v as WakePref } }).catch(toastError)}
        options={[
          { value: 'ask', label: t('Ask each time') },
          { value: 'start', label: t('Start it') },
          { value: 'send', label: t('Only send') },
        ]}
      />
    </Card>
  );
}
