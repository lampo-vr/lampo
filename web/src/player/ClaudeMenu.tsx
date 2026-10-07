// The player's one agent control: the assigned agent (its mark, name and whether it runs), or "Agent" when there is
// none. Its popover says where the agent stands, sends it a request, copies the notes for any agent, and assigns
// another one — the picker opens in the same popover. Never a dead end: without an agent it offers exactly that.
import { useState } from 'react';
import { agentKindOfRef, agentShown } from '../../../lib/agentKind.ts';
import { partWhere } from '../../../lib/part.ts';
import { timecode } from '../../../lib/time.ts';
import { api, enc } from '../api/client.ts';
import { useRequest, useVideoActions } from '../api/mutations.ts';
import { usePartSuggestion } from '../api/queries.ts';
import type { PartRequest, SessionPick, SessionRef } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { usePainted } from '../lib/lazy.ts';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { type NoteAt, say } from '../sessions/activityWords.ts';
import { activityShort, LiveSection, stepLine, useAgentNow } from '../sessions/Live.tsx';
import { listenLine, StartListening, useListening, waitsForStart } from '../sessions/listening.tsx';
import { fullWords, LOOK, phaseOf, type RunLike, tightOf } from '../sessions/runState.ts';
import { SessionPicker } from '../sessions/Sessions.tsx';
import { useAgentRuns, useWakeChoice, WakeAsk } from '../sessions/Wake.tsx';
import { AgentMark, I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Popover } from '../ui/primitives.tsx';

// Requests in the agent's own words (agent-facing, so in English): what to do, never which command — it knows its way
// (the server's instructions: MCP, or `lampo render` for a coding agent's renders).
const QUICK = (v: number): [string, string][] => [
  [
    'Look this render over before I watch it: check what changed from the version before, and ask me on the frame about anything that looks off.',
    t('Look it over before I watch'),
  ],
  ['Work through all open notes, put up the next version, then mark each one fixed.', t('Fix all open notes')],
  [`Tell me in one reply what you changed in v${v} and why.`, t('Summarise what changed in V{v}', { v })],
];

/** Whether the agent runs, as the sidebar says it: a turning keyframe while it does, an outline while it doesn't. */
export const AgentState = ({ active }: { active: boolean | null }) => (
  <KeyGlyph shape={active ? 'ease' : 'outline'} className={`nav-kg ${active ? 'live' : ''}`} />
);

interface AgentMenuProps {
  slug: string;
  /** The video's path or upload name (the picker ranks agents by where they work). */
  video: string;
  session: SessionRef | null;
  sessionActive: boolean | null;
  /** Whether it hears new notes by itself (an agent connected over MCP only while it waits for them). */
  sessionListening?: boolean | null;
  latestV: number;
  home?: string | null;
  /** May send requests and copy the notes for an agent (`agents`). */
  canAsk: boolean;
  /** May assign an agent (`organize`). */
  canAssign: boolean;
  /** Phones: the button is the agent's mark and state only; the name is in the popover. */
  compact?: boolean;
  /** The frame on screen: "Quick check: render only this part" asks for the shots around it (lib/part.ts). */
  frameNow?: () => number;
  /** The newest version's frame rate (the quick check's times). */
  fps?: number;
  /** A note's moment by its id: what the agent did is said without the agent's note ids. */
  noteAt?: NoteAt;
  /** What the run strip speaks of (RunStrip.tsx): the button's glyph and words follow it. */
  run?: RunLike | null;
}

/** What a request says to the agent; a partial render's opt-in rides along (the server adds its PART RENDER OK line). */
interface Ask {
  text: string;
  part?: PartRequest;
}

export function AgentMenu({
  slug,
  video,
  session,
  sessionActive,
  sessionListening,
  latestV,
  home,
  canAsk,
  canAssign,
  compact = false,
  frameNow,
  fps = 25,
  noteAt,
  run: work = null,
}: AgentMenuProps) {
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<'menu' | 'assign'>('menu');
  const [text, setText] = useState('');
  // A request waiting for "Send and start" or "Only send" (when the person chose to be asked each time).
  const [asking, setAsking] = useState<Ask | null>(null);
  // The frame on screen when the menu opened: a quick check renders only the shots around it.
  const [partAt, setPartAt] = useState<number | null>(null);
  const request = useRequest(slug);
  const { assign } = useVideoActions();
  const active = !!sessionActive;
  const wake = useWakeChoice(session, sessionActive, home);
  // An agent connected over MCP: whether it listens (null for a Claude Code session on this machine).
  const listen = useListening(session, { active: sessionActive, listening: sessionListening });
  // What it is doing now: in the button (after the first paint) and, with its last actions, in the popover.
  const idle = usePainted();
  const run = useAgentRuns(slug, wake.here && open)[0] ?? null;
  const now = useAgentNow(slug, session?.name ?? null, canAsk && idle && !!session);
  const working = (listen ? !waitsForStart(listen) : active) || !!now || run?.state === 'running';
  const openChange = (o: boolean) => {
    setOpen(o);
    if (o) setPartAt(frameNow ? frameNow() : null);
    if (!o) {
      setMode('menu');
      setAsking(null);
    }
  };
  const quick = usePartSuggestion(slug, latestV, partAt ?? 0, partAt ?? 0, open && partAt !== null && canAsk && !!session).data;
  const stretch = quick && 'part' in quick ? quick : null;
  const send = async (req: string | Ask, how?: 'start' | 'send') => {
    if (!session) return;
    const ask: Ask = typeof req === 'string' ? { text: req } : req;
    const way = how ?? (!wake.possible || wake.pref === 'send' ? 'send' : wake.pref === 'start' ? 'start' : 'ask');
    if (way === 'ask') return setAsking(ask);
    try {
      const r = await request.mutateAsync({ text: ask.text, ...(way === 'start' ? { start: true } : {}), ...(ask.part ? { part: ask.part } : {}) });
      toast(
        r.run
          ? t('Started {name} with your request', { name: session.name })
          : waitsForStart(listen)
            ? t('Sent to {name}. It isn’t listening: it gets this once you start it.', { name: session.name })
            : active || way === 'start' || listen
              ? t('Sent to {name}', { name: session.name })
              : t('Sent to {name}. It isn’t running: it gets this when it starts.', { name: session.name }),
        'ok',
      );
      setText('');
      openChange(false);
    } catch (e) {
      toastError(e);
    }
  };
  const copy = async () => {
    if (await copyText(await api<string>(`/api/review/${enc(slug)}/prompt`)))
      toast(session ? t('Copied: paste it into {name}', { name: session.name }) : t('Copied for an agent'), 'ok');
    openChange(false);
  };
  const onAssign = async (pick: SessionPick | null) => {
    try {
      await assign.mutateAsync({ slug, session: pick });
      openChange(false);
      toast(pick ? t('Assigned to {name}', { name: pick.name }) : t('No agent on this video now'), 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  // The strip's state in its glyph, and in a word or two where the name stands, with how far ("fixing 3 of 6",
  // "rendering V4" · "42%"): a tight place, so never the step it is on or its own sentence ("rendering v4 (…)") — the
  // strip right below says those, and the button's title and accessible name say it all. With no work open on the
  // video, what it does now in a word ("working"); while it only waits for notes, its name.
  const look = work ? LOOK[phaseOf(work)] : null;
  const tight = work ? tightOf(work) : now && now.kind !== 'wait' ? activityShort(now) : null;
  const full = work ? fullWords(work, (w) => say(w, noteAt)) : now ? stepLine(now, noteAt) : null;
  const label = session
    ? full
      ? t('Agent {name}: {step}', { name: session.name, step: full })
      : listen
        ? waitsForStart(listen)
          ? t('Agent {name}, not listening', { name: session.name })
          : t('Agent {name}, listening', { name: session.name })
        : active
          ? t('Agent {name}, running', { name: session.name })
          : t('Agent {name}, not running', { name: session.name })
    : t('Agent');
  const trigger = (
    <button
      type="button"
      className={`btn sm ghost agent-btn${session ? '' : ' none'}${tight && !compact ? ' now' : ''}`}
      aria-label={label}
      title={session && full ? label : undefined}
      data-testid="agent-button"
    >
      {session ? (
        <>
          {look ? <KeyGlyph shape={look.shape} className={`nav-kg run-kg ${look.tone}`} /> : <AgentState active={working} />}
          <AgentMark kind={agentKindOfRef(session)} size={14} />
          {/* While it works, where it stands takes the name's place (the name is in the popover and the label). */}
          {!compact &&
            (tight ? (
              <>
                <span className="agent-name agent-step ellipsis" data-testid="agent-step">
                  {tight.words}
                </span>
                {tight.figure && (
                  <span className="agent-fig" data-testid="agent-fig">
                    {tight.figure}
                  </span>
                )}
              </>
            ) : (
              <span className="agent-name ellipsis">{agentShown(session.name, agentKindOfRef(session))}</span>
            ))}
        </>
      ) : (
        <>
          <I name="spark" size={14} className="spark" />
          {!compact && <span className="p-tool-word">{t('Agent')}</span>}
        </>
      )}
      <I name="down" size={12} className="faint" />
    </button>
  );

  // Without an agent, assigning one is the point: rows that say what each does. With one, they are the quiet foot.
  const assignRow = canAssign && (
    <button type="button" className="cm-row" onClick={() => setMode('assign')} data-testid="assign-agent-open">
      <I name="terminal" size={15} />
      <span className="grow">
        <b>{t('Assign agent…')}</b>
        <span>{t('It gets this video’s notes and fixes them.')}</span>
      </span>
    </button>
  );
  const copyRow = canAsk && (
    <button type="button" className="cm-row" onClick={copy}>
      <I name="copy" size={15} />
      <span className="grow">
        <b>{t('Copy for an agent')}</b>
        <span>{t('The open notes with their frames and pictures, to paste into any agent')}</span>
      </span>
    </button>
  );
  const foot = (canAsk || canAssign) && (
    <div className="am-foot">
      {canAsk && (
        <button type="button" className="btn sm ghost" onClick={copy} title={t('The open notes with their frames and pictures, to paste into any agent')}>
          <I name="copy" size={14} /> {t('Copy for an agent')}
        </button>
      )}
      {canAssign && (
        <button type="button" className="btn sm ghost" onClick={() => setMode('assign')} data-testid="assign-agent-open">
          <I name="terminal" size={14} /> {t('Assign agent…')}
        </button>
      )}
    </div>
  );

  return (
    <div style={{ position: 'relative' }}>
      <Popover open={open} onOpenChange={openChange} className="claude-pop" sideOffset={8} trigger={trigger}>
        {mode === 'assign' ? (
          <div className="am" data-testid="agent-picker">
            <div className="am-back">
              <IconButton className="btn ghost sm icon-only" label={t('Back')} icon="back" size={15} onClick={() => setMode('menu')} />
              <span className="label">{t('Agent for this video')}</span>
            </div>
            <SessionPicker video={video} current={session} onAssign={onAssign} home={home} />
          </div>
        ) : (
          <div className="am" data-testid="agent-menu">
            <div className="am-status">
              {session ? (
                <>
                  <span className="am-who">
                    <AgentState active={working} />
                    <AgentMark kind={agentKindOfRef(session)} size={15} />
                    <b className="ellipsis">{agentShown(session.name, agentKindOfRef(session))}</b>
                  </span>
                  <span className="am-sub" data-testid="agent-listen">
                    {listen ? listenLine(listen) : active ? t('Running: new notes reach it right away') : t('Not running: it gets the notes when it starts')}
                  </span>
                  {canAsk && waitsForStart(listen) && <StartListening session={session} />}
                </>
              ) : (
                <>
                  <b>{t('No agent on this video')}</b>
                  <span className="am-sub">{t('Assign one, or copy the notes for any agent.')}</span>
                </>
              )}
            </div>
            {session && canAsk && <LiveSection slug={slug} agent={session.name} run={run} enabled={open} noteAt={noteAt} />}
            {session && canAsk && asking !== null && (
              <WakeAsk
                name={session.name}
                folder={wake.folder}
                busy={request.isPending}
                onStart={() => send(asking, 'start')}
                onSend={() => send(asking, 'send')}
              />
            )}
            {session && canAsk && asking === null && (
              <section className="am-ask" aria-label={t('Ask {name}', { name: session.name })}>
                <div className="label">{t('Ask {name}', { name: session.name })}</div>
                {/* What people ask most, as quiet answers to pick (the notes panel's Choices), then anything else. */}
                <div className="choices">
                  {QUICK(latestV).map(([req, label]) => (
                    <button type="button" key={label} className="btn sm choice" onClick={() => send(req)} data-testid="agent-ask">
                      {label}
                    </button>
                  ))}
                </div>
                <div className="row">
                  <input
                    className="input grow"
                    placeholder={t('Or ask something else…')}
                    aria-label={t('Ask {name}', { name: session.name })}
                    value={text}
                    onChange={(e) => setText(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && text.trim() && send(text)}
                  />
                  <button type="button" className="btn sm" onClick={() => text.trim() && send(text)} disabled={!text.trim()}>
                    {t('Send')}
                  </button>
                </div>
                {frameNow && !(quick && 'none' in quick) && (
                  <button
                    type="button"
                    className="cm-row am-quick"
                    disabled={!stretch || stretch.whole}
                    onClick={() =>
                      stretch && send({ text: 'Quick check: render only this part, not the whole video, and send it as a part.', part: stretch.part })
                    }
                    data-testid="quick-part"
                  >
                    <I name="layers" size={14} />
                    <span className="grow">
                      <b>{t('Quick check: render only this part')}</b>
                      <span>
                        {!stretch
                          ? t('Finding the shots around {tc}…', { tc: timecode(partAt ?? 0, fps) })
                          : stretch.whole
                            ? t('The whole video is one shot: ask for a full version')
                            : t('{stretch} · the shot around {tc}, the rest stays as V{v}', {
                                stretch: partWhere({ at: stretch.part.in, frames: stretch.part.out - stretch.part.in + 1 }, fps),
                                tc: timecode(partAt ?? 0, fps),
                                v: latestV,
                              })}
                      </span>
                    </span>
                  </button>
                )}
              </section>
            )}
            {session && asking === null && foot}
            {!session && (
              <>
                {assignRow}
                {copyRow}
              </>
            )}
          </div>
        )}
      </Popover>
    </div>
  );
}
