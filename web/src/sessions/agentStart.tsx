// The way into agent work, one way wherever it is offered (an empty library, project or folder; Get started, in the
// card and the sidebar's panel; Settings → Connect an agent): one prompt copied — lib/mcpConfig.ts setupPrompt: the
// agent connects itself to this app, says what only the person can do (signing in, a restart), asks how the work
// starts and puts up V1 — and right under it one line that follows it live: which agents it is for, then waiting for
// the agent, then the agent connected and what it does (the connected-agents registry, useAgents: the state Connect an
// agent shows, refetched when the `sessions` event says one arrived). Its V1 arriving ends the empty page by itself.
// Light: the library's first paint draws it. The prompt's builder (mcpConfig, with every client's setup) is a chunk
// of its own, asked for right after the first paint (or as soon as the pointer or the focus reaches the button).
import { useEffect, useRef, useState } from 'react';
import { AGENT_KIND_LABELS } from '../../../lib/agentKind.ts';
import { compareTime } from '../../../lib/time.ts';
import type { AgentKind, ConnectedAgent } from '../../../lib/types.ts';
import { useAgents, useAuthStatus } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { loader, useLoaded, usePainted } from '../lib/lazy.ts';
import { copyText, toast } from '../lib/toast.ts';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import '../styles/agentstart.css';

const builder = loader(() => import('../../../lib/mcpConfig.ts'));

/** A connected agent by what it is ("Claude Code"), its name as listed when its client is no known one. */
export const agentWord = (a: { name: string; kind?: AgentKind }) =>
  a.kind && !['mcp', 'cli', 'api'].includes(a.kind) ? AGENT_KIND_LABELS[a.kind] : a.name.split(' · ')[0] || a.name;

/** The agents the prompt names (its tooltip), and their makers' marks on the line before it is copied — each once:
 * Claude Code and Claude share Anthropic's, Codex and ChatGPT OpenAI's. */
const FOR: AgentKind[] = ['claude-code', 'codex', 'cursor', 'chatgpt', 'claude'];
const MARKS: AgentKind[] = ['claude', 'chatgpt', 'cursor'];

/** Where the prompt points the agent: this app's /mcp (its public address, else this one), and at the machine itself
 * the app's folder (nothing to sign in; Claude's desktop app starts the server itself). Null until /api/info answers. */
export const placeOf = (info: { public_url: string | null; root: string } | null, via: string | null | undefined) =>
  info ? { url: `${(info.public_url || location.origin).replace(/\/+$/, '')}/mcp`, root: via === 'local' && info.root ? info.root : null } : null;

/** The person's own newest connected agent (at the machine every agent is its owner's), or null. */
export function useMyAgent(want = true, poll = 30_000): ConnectedAgent | null {
  const me = useAuthStatus().data?.user?.name;
  const agents = useAgents(poll, want).data?.agents;
  return (agents ?? []).filter((a) => !a.user || a.user === me).sort((a, b) => compareTime(b.last_seen, a.last_seen))[0] ?? null;
}

export interface AgentStartState {
  /** Copies the prompt (its builder is usually here already: the click's own moment, for Safari's clipboard). */
  copy: () => Promise<void>;
  /** Copied once on this page: the line follows the agent from then on. */
  copied: boolean;
  /** "Copied" on the button, for a moment. */
  flash: boolean;
  /** The person's newest connected agent. */
  agent: ConnectedAgent | null;
  /** The agent to ask by name ("Ask Claude Code to make one"): one connected before the copy. One that connects after it
   * is the one the line follows, and the button keeps the words it was copied with. */
  named: ConnectedAgent | null;
}

/**
 * The prompt for this app (`project`: the one the page is about; else the agent asks how the work starts and names it)
 * and the agent it sets going. Where the agent connects: this app's /mcp (its public address, else this one); at the
 * machine with nothing to sign in, Claude's desktop app starting the server itself.
 */
export function useAgentStart(project: string | null, want = true): AgentStartState {
  const info = useInfo();
  const status = useAuthStatus().data;
  const painted = usePainted(want);
  useLoaded(builder, painted);
  const [copied, setCopied] = useState(false);
  const [flash, setFlash] = useState(false);
  const [withAgent, setWithAgent] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);
  // asked more often while it waits for the agent the person just set going
  const agent = useMyAgent(want && painted, copied ? 3000 : 30_000);
  const copy = async () => {
    const place = placeOf(info, status?.via);
    if (!place) return;
    const m = builder.ready ?? (await builder.load().catch(() => null));
    if (!m || !(await copyText(m.setupPrompt({ ...place, project })))) return void toast(t('Could not copy'), 'error');
    setCopied(true);
    setWithAgent((was) => was || !!agent);
    setFlash(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setFlash(false), 1600);
  };
  return { copy, copied, flash, agent, named: agent && (!copied || withAgent) ? agent : null };
}

/** The builder asked for when the pointer or the focus reaches the button too (not only once the page was idle): the
 * click then writes the clipboard in its own moment, which Safari requires. */
const warm = () => void builder.load().catch(() => {});

/** The button that copies it: its words stay, its glyph says Copied for a moment (the line under it says the rest). */
export function StartButton({
  start,
  label,
  icon = 'copy',
  className = 'btn primary',
  testid = 'make-with-agent',
}: {
  start: AgentStartState;
  label: string;
  icon?: 'copy' | 'spark';
  className?: string;
  testid?: string;
}) {
  return (
    <button
      type="button"
      className={`${className} agent-start-copy`}
      onClick={() => void start.copy()}
      onPointerEnter={warm}
      onFocus={warm}
      data-testid={testid}
      data-agent={start.agent ? (start.agent.kind ?? 'mcp') : undefined}
      data-copied={start.flash ? '' : undefined}
    >
      <I name={start.flash ? 'check' : icon} size={14} />
      {label}
    </button>
  );
}

/** What a connected agent is doing, after its name. */
const doing = (a: ConnectedAgent, copied: boolean) =>
  a.state === 'listening'
    ? t('waiting for your notes')
    : a.state === 'working'
      ? t('working')
      : copied
        ? t('it asks how you want to start')
        : t('ready for the prompt');

/**
 * The line under the button, one line's room in every state: before the copy the agents it is for; then waiting for
 * one; then the person's agent, connected, and what it does now.
 */
export function AgentLine({ start, testid = 'agent-line' }: { start: AgentStartState; testid?: string }) {
  const { agent, copied } = start;
  const state = agent ? (agent.state ?? 'idle') : copied ? 'waiting' : 'ready';
  return (
    <p className="agent-line" data-state={state} role="status" aria-live="polite" data-testid={testid}>
      {agent ? (
        <>
          <KeyGlyph shape="diamond" />
          <span>
            <b>{t('{agent} connected', { agent: agentWord(agent) })}</b>
            <span className="agent-line-sub"> · {doing(agent, copied)}</span>
          </span>
        </>
      ) : copied ? (
        <>
          <KeyGlyph shape="outline" />
          <span>
            <b>{t('Waiting for your agent…')}</b>
            <span className="agent-line-sub"> · {t('paste the prompt into it')}</span>
          </span>
        </>
      ) : (
        <>
          <span className="agent-line-marks" aria-hidden="true" title={FOR.map((k) => AGENT_KIND_LABELS[k]).join(' · ')}>
            {MARKS.map((k) => (
              <AgentMark key={k} kind={k} size={13} />
            ))}
          </span>
          <span className="sr-only">{t('For Claude Code, Codex, Cursor, ChatGPT, Claude and other agents')}</span>
          <span className="agent-line-sub" aria-hidden="true">
            {t('and other agents')}
          </span>
        </>
      )}
    </p>
  );
}
