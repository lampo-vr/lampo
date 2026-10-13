// A question that offers its answers (Comment.choices) or options to audition (Comment.options), open in the notes
// list instead of a row: who asks, the question in the reading size, its answers as rows a tap sends (1–9 send them
// while the card has the focus), and a field for anything else, quieter, under them — so answering takes no Answer
// first. In the agent's tone, the list's one highlighted place while it waits; answered, it is a row again
// ("Answered", CommentCard.tsx). Its other actions (reply, close without an answer, copy) are under its ⋯.
import { type KeyboardEvent, type ReactNode, useId, useState } from 'react';
import { agentKindOf } from '../../../lib/agentKind.ts';
import { optionsSeen } from '../../../lib/options.ts';
import { isAgent } from '../../../lib/time.ts';
import { enc } from '../api/client.ts';
import type { PlacedComment } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { cardClick } from '../lib/a11y.ts';
import { OptionsAsk } from '../options/OptionsAsk.tsx';
import { GOTO_FRAME, type GotoFrame } from '../refs/model.ts';
import { AutoTextarea, Avatar } from '../ui/controls.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { AgentMark } from '../ui/icons.tsx';
import { ContextMenu, IconButton, Menu, type MenuEntry } from '../ui/primitives.tsx';
import { TimecodeText } from '../ui/TimecodeText.tsx';
import '../styles/ask.css';

export interface AskCardProps {
  c: PlacedComment;
  slug: string;
  /** Who asks, as people read it (CommentCard.tsx displayName). */
  name: string;
  avatar?: string | null;
  here: boolean;
  selected: boolean;
  fps?: number;
  busy: boolean;
  /** The note's ⋯ (CommentCard.tsx), with Close without answer. */
  items: MenuEntry[];
  onSelect: (c: PlacedComment) => void;
  /** Sends `answer` as the answer (a pick or what was written), as typing it would. */
  onAnswer: (answer: string) => Promise<boolean>;
  /** Its replies so far (CommentCard.tsx Thread), under the field. */
  children?: ReactNode;
}

/** Whether a note asks with answers or options to pick from: it stands open as an AskCard while it waits. */
export const asksWithPicks = (c: Pick<PlacedComment, 'status' | 'choices' | 'options'>) => c.status === 'open' && (!!c.choices?.length || !!c.options?.length);

export function AskCard({ c, slug, name, avatar, here, selected, fps, busy, items, onSelect, onAnswer, children }: AskCardProps) {
  const qid = useId();
  const [words, setWords] = useState('');
  const choices = c.choices ?? [];
  const send = async () => {
    if (words.trim() && (await onAnswer(words.trim()))) setWords('');
  };
  // 1–9 send that answer while the card has the focus (not while writing): the player's own keys have no digits but 0
  const keys = (e: KeyboardEvent<HTMLElement>) => {
    const n = Number(e.key);
    if (!choices.length || !Number.isInteger(n) || n < 1 || n > choices.length || e.metaKey || e.ctrlKey || e.altKey) return;
    if ((e.target as HTMLElement).closest('textarea, input, [contenteditable="true"]')) return;
    e.preventDefault();
    if (!busy) void onAnswer(choices[n - 1]);
  };
  return (
    <ContextMenu items={items}>
      <article
        className={`note ask-card${selected ? ' active' : ''}${here ? ' here' : ''}`}
        data-note={c.id}
        data-kind="question"
        aria-labelledby={qid}
        data-testid="ask-card"
        onClick={cardClick(() => onSelect(c), '.ask-picks, .ask-write, .opt-ask, .ask-tools, .ask-thread, .tc-link')}
        onKeyDown={keys}
      >
        <header className="ask-head">
          {isAgent(c.author) ? (
            <span className="ask-mark" aria-hidden="true">
              <AgentMark kind={agentKindOf(c.author.replace(/^agent:/, ''))} size={14} />
            </span>
          ) : (
            <Avatar name={c.author} size={20} src={avatar} />
          )}
          <b className="ask-who">{t('{name} asks', { name })}</b>
          <button
            type="button"
            className={`ask-tc${c.scope === 'video' ? ' overall' : ''}`}
            onClick={() => onSelect(c)}
            aria-label={t('Go to {timecodeHere}', { timecodeHere: c.timecodeHere })}
          >
            {c.scope === 'video' ? t('Whole video') : c.timecodeHere}
          </button>
          <span className="ask-tools">
            <span className="c-id" hidden>
              {c.id}
            </span>
            <Menu trigger={<IconButton className="btn sm ghost icon-only" label={t('More')} icon="more" size={14} />} items={items} />
          </span>
        </header>
        <p className="ask-q" id={qid}>
          <TimecodeText
            text={c.text}
            fps={c.ownGrid?.fps ?? fps}
            frames={c.ownGrid?.frames}
            href={(frame) => `#/v/${enc(slug)}?v=${c.v}&f=${frame}`}
            onSeek={(frame) => window.dispatchEvent(new CustomEvent<GotoFrame>(GOTO_FRAME, { detail: { slug, v: c.v, frame } }))}
          />
        </p>
        {c.options?.length ? (
          // options to audition: what they are, and the way into the audition (its picks are the answer)
          <div className="ask-options">
            <OptionsAsk id={c.id} text={c.text} by={c.author} groups={optionsSeen(c.options)} size="md" quiet />
          </div>
        ) : (
          <>
            <fieldset className="ask-picks" aria-labelledby={qid} data-testid="choices">
              {choices.map((choice, i) => (
                <button key={choice} type="button" className="ask-pick" onClick={() => onAnswer(choice)} disabled={busy} data-testid="ask-pick">
                  {choices.length > 1 && i < 9 && <kbd className="ask-key">{i + 1}</kbd>}
                  <span className="ask-pick-words">{choice}</span>
                </button>
              ))}
            </fieldset>
            <div className="ask-write">
              <AutoTextarea
                aria-label={t('Answer {displayName}', { displayName: name })}
                placeholder={t('Or write an answer…')}
                value={words}
                onChange={(e) => setWords(e.target.value)}
                onSubmit={send}
              />
              {words.trim() && (
                <button type="button" className="btn sm" onClick={send} disabled={busy} data-keys="⌘↵">
                  {busy && <Spinner />}
                  {t('Answer')}
                </button>
              )}
            </div>
          </>
        )}
        {children && <div className="ask-thread">{children}</div>}
      </article>
    </ContextMenu>
  );
}
