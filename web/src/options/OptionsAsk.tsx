// A question's options where the question is shown — a note card, the inbox: what it offers in one quiet line
// (each group, how many, what kind) and the way into the audition, its own view (Audition.tsx), whose code arrives when
// it is first pointed at or opened. A reply that picked shows the picks in words, not the line agents read.
import { useState } from 'react';
import type { OptionAnswer, OptionGroup, OptionSeen } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { useLoaded } from '../lib/lazy.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { auditionCode } from './code.ts';
import '../styles/options.css';

const KIND_ICON: Record<OptionSeen['kind'], IconName> = {
  audio: 'volume',
  image: 'image',
  clip: 'film',
  frame: 'film',
  link: 'link',
  text: 'notes',
  mixed: 'layers',
};

export interface OptionsAskProps {
  id: string;
  /** The question's words and who asks (the audition shows them while the rest loads). */
  text: string;
  by: string;
  groups: OptionSeen[];
  /** Answered already: the way in says so (the picks can still change). */
  answered?: boolean;
  /** The picks went out. */
  onSent?: () => void;
  size?: 'sm' | 'md';
  /** Say what is offered (the groups' line); without, the way in alone (a folder's tabs line). */
  chips?: boolean;
}

export function OptionsAsk({ id, text, by, groups, answered = false, onSent, size = 'sm', chips = true }: OptionsAskProps) {
  const [open, setOpen] = useState(false);
  const code = useLoaded(auditionCode, open);
  return (
    <div className={`opt-ask ${size}`} data-testid="options-ask">
      {chips && (
        <ul className="opt-groups" aria-label={t('What is offered')}>
          {groups.map((g, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: groups keep their order; two may share a label
            <li key={i} className="opt-group-chip">
              <I name={KIND_ICON[g.kind]} size={13} />
              <span className="ellipsis">{g.label}</span>
              <span className="num opt-n">{g.n}</span>
            </li>
          ))}
        </ul>
      )}
      <button
        type="button"
        className={`btn ${size === 'sm' ? 'sm' : ''} ${answered ? '' : 'primary'} opt-open`}
        onClick={() => setOpen(true)}
        onPointerEnter={() => void auditionCode.load().catch(() => {})}
        onFocus={() => void auditionCode.load().catch(() => {})}
        data-testid="options-open"
      >
        <I name="play" size={14} /> {answered ? t('See the picks') : t('Compare and pick')}
      </button>
      {open && code && <code.AuditionDialog id={id} text={text} by={by} groups={groups} onClose={() => setOpen(false)} onSent={onSent} />}
    </div>
  );
}

/** What a reply picked, in the question's own words: "Narrator: Warm · Look: Test pattern", and what was written. */
export function Picked({ options, answer }: { options: OptionGroup[]; answer: OptionAnswer }) {
  const parts = options
    .map((g) => {
      const ids = answer.picks[g.id] ?? [];
      const labels = g.items.filter((it) => ids.includes(it.id)).map((it) => it.label);
      return labels.length ? { group: g.label, items: labels.join(', ') } : null;
    })
    .filter((x): x is { group: string; items: string } => !!x);
  return (
    <span className="opt-picked" data-testid="options-picked">
      {parts.map((p, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: in the question's order
        <span key={i} className="opt-pick">
          <span className="opt-pick-g">{p.group}</span> {p.items}
        </span>
      ))}
      {answer.note && <span className="opt-pick-note">“{answer.note}”</span>}
    </span>
  );
}
