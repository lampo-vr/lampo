// The first run's small parts, shared by the setup (Setup.tsx) and Get started (GetStarted.tsx): the steps on their
// keyframe track, a short note with its marker hanging in the margin, a command to copy, an agent's live status, a
// person's initials, and the few glyphs the app's icon set has no name for. Styles: styles/ob-parts.css.
import { type CSSProperties, type ReactNode, useState } from 'react';
import { t } from '../i18n/index.ts';
import { copyText, toast } from '../lib/toast.ts';
import type { Shape } from '../ui/glyphs.ts';
import { I, type IconName, strokeFor } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import '../styles/ob-parts.css';

/**
 * Glyphs only the first run needs, drawn from the same set (Lucide's paths, ISC) with the same stroke rule as
 * ui/icons.tsx, but kept here: the first paint's icon map (and its budget) stays as it is.
 */
const EXTRA: Record<string, ReactNode> = {
  mail: (
    <>
      <path d="m22 7-8.991 5.727a2 2 0 0 1-2.009 0L2 7" />
      <rect x="2" y="4" width="20" height="16" rx="2" />
    </>
  ),
  disk: (
    <>
      <path d="M10 16h.01" />
      <path d="M2.212 11.577a2 2 0 0 0-.212.896V18a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-5.527a2 2 0 0 0-.212-.896L18.55 5.11A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" />
      <path d="M21.946 12.013H2.054" />
      <path d="M6 16h.01" />
    </>
  ),
  file: (
    <>
      <path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z" />
      <path d="M14 2v5a1 1 0 0 0 1 1h5" />
    </>
  ),
  package: (
    <>
      <path d="M11 21.73a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73z" />
      <path d="M12 22V12" />
      <polyline points="3.29 7 12 12 20.71 7" />
      <path d="m7.5 4.27 9 5.15" />
    </>
  ),
};
export type ObIconName = IconName | 'mail' | 'disk' | 'file' | 'package';

export function OIcon({ name, size = 16, className = '' }: { name: ObIconName; size?: number; className?: string }) {
  const extra = EXTRA[name];
  if (!extra) return <I name={name as IconName} size={size} className={className} />;
  return (
    <svg
      className={`icon i-${name} ${className}`}
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeFor(size)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {extra}
    </svg>
  );
}

/** A status colour for a keyframe glyph (the colour rides on the glyph's class). */
export type Tone = 'ok' | 'must' | 'should' | 'idea' | 'ask';

export function KG({ shape = 'diamond', tone, size, pop, className = '' }: { shape?: Shape; tone?: Tone; size?: number; pop?: boolean; className?: string }) {
  return <KeyGlyph shape={shape} size={size} pop={pop} className={`${tone ? `ob-t-${tone}` : ''} ${className}`} />;
}

/** Initials of a name or an address ("mia.lang@…" → ML). */
export function initialsOf(s: string): string {
  const v = String(s || '').trim();
  if (!v) return '?';
  if (v.includes('@')) {
    const local = v.split('@')[0];
    const parts = local.split(/[._-]+/).filter(Boolean);
    return (parts.length > 1 ? parts[0][0] + parts[1][0] : local.slice(0, 2)).toUpperCase();
  }
  const w = v.split(/\s+/).filter(Boolean);
  return (w.length > 1 ? w[0][0] + w[1][0] : w[0].slice(0, 2)).toUpperCase();
}

/** A name read off an address ("lea.berg@…" → Lea Berg), for the team picture. */
export const nameOf = (email: string): string =>
  email
    .split('@')[0]
    .split(/[._-]+/)
    .filter(Boolean)
    .map((x) => x[0].toUpperCase() + x.slice(1))
    .join(' ');

export const isEmail = (s: string): boolean => /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]{2,}$/.test(s);

/** A person's initials in a disc. */
export function OAv({ text, size, className = '' }: { text: string; size?: number; className?: string }) {
  return (
    <span className={`ob-av ${className}`} style={size ? ({ '--av': `${size}px` } as CSSProperties) : undefined} aria-hidden="true">
      {text}
    </span>
  );
}

/** The steps on a keyframe track: done filled, the one you're on lit in the brand's colour, the rest hollow. */
export function Track({ items }: { items: { done: boolean; now: boolean }[] }) {
  return (
    <span className="ob-track" aria-hidden="true">
      {items.map((it, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: the track's places are its order
        <span key={i} style={{ display: 'contents' }}>
          {i > 0 && <span className={`ob-track-seg ${it.done ? 'ob-done' : ''}`} />}
          <span className={`ob-track-i ${it.done ? 'ob-done' : it.now ? 'ob-now' : ''}`}>
            <KeyGlyph shape={it.done || it.now ? 'diamond' : 'outline'} />
          </span>
        </span>
      ))}
    </span>
  );
}

/** A short note under a control: a marker hanging on the first line's caps, a strong first line, a muted second. */
export function Said({
  shape = 'diamond',
  tone,
  first,
  second,
  on,
  className = '',
  testid,
}: {
  shape?: Shape;
  tone?: Tone;
  first: ReactNode;
  second?: ReactNode;
  on?: boolean;
  className?: string;
  testid?: string;
}) {
  return (
    <p className={`ob-said ${on ? 'ob-on' : ''} ${className}`} data-testid={testid}>
      <KG shape={shape} tone={tone} />
      <span>
        <span className="ob-said-1">{first}</span>
        {second && <span className="ob-said-2">{second}</span>}
      </span>
    </p>
  );
}

/** Copy, with its own column: "Copied" for a moment once the text is on the clipboard. */
export function CopyButton({ text, label, onCopied, testid }: { text: string; label?: string; onCopied?: () => void; testid?: string }) {
  const [done, setDone] = useState(false);
  const copy = async () => {
    if (!(await copyText(text))) return toast(t('Could not copy'), 'error');
    setDone(true);
    onCopied?.();
    setTimeout(() => setDone(false), 1600);
  };
  return (
    <button type="button" className={`ob-copy ${done ? 'ob-done' : ''}`} onClick={copy} aria-label={label} data-testid={testid}>
      <I name={done ? 'check' : 'copy'} size={13} />
      <span>{done ? t('Copied') : t('Copy')}</span>
    </button>
  );
}

/** Runs of non-spaces kept whole (a token, a URL, a path never breaks after its - or /), spaces where lines may break. */
const words = (s: string) =>
  s.split(/( +)/).map((w, i) =>
    w.trim() ? (
      // biome-ignore lint/suspicious/noArrayIndexKey: a command's words in their order
      <span key={i} className="ob-w">
        {w}
      </span>
    ) : (
      w
    ),
  );

/** A command or a config to copy: one line wraps at its spaces inside its box; several lines, or one token without
 * spaces (a link, a key), scroll inside it with a fade at the edge — a token never breaks. Copy keeps a column of its
 * own. */
export function Cmd({ text, onCopied, testid }: { text: string; onCopied?: () => void; testid?: string }) {
  const multi = text.includes('\n');
  const token = !multi && !/\s/.test(text);
  const [more, setMore] = useState(false);
  const prompt = /^(claude|lampo|vr|docker|codex) /.test(text);
  return (
    <div className={`ob-cmd ${multi ? 'ob-multi' : ''} ${more ? 'ob-more' : ''}`} data-testid={testid}>
      {multi || token ? (
        <pre
          ref={(el) => {
            if (el) setMore(el.scrollWidth > el.clientWidth + 1);
          }}
        >
          {text}
        </pre>
      ) : (
        <code>
          {prompt && <span className="ob-p">$ </span>}
          {words(text)}
        </code>
      )}
      <CopyButton text={text} onCopied={onCopied} testid={testid ? `${testid}-copy` : undefined} />
    </div>
  );
}

/** An agent's live status, one line: its glyph, "Waiting for X…" or "Connected · X", and the meta muted beside it. */
export function Live({ on, label, sub, compact, testid = 'ob-live' }: { on: boolean; label: string; sub: ReactNode; compact?: boolean; testid?: string }) {
  return (
    <div className={`ob-live ${compact ? 'ob-compact' : ''}`} data-state={on ? 'connected' : 'waiting'} role="status" aria-live="polite" data-testid={testid}>
      <KeyGlyph shape={on ? 'diamond' : 'outline'} />
      <b>{on ? t('Connected · {name}', { name: label }) : t('Waiting for {name}…', { name: label })}</b>
      <span className="ob-live-sub">{sub}</span>
    </div>
  );
}

/** A spinner in the current colour. */
export const Spin = () => <span className="ob-spin" aria-hidden="true" />;

/** What is in the sample, as keyframes: a fix to check, the agent's question, an idea. */
export function SampleKeys({ big }: { big?: boolean }) {
  return (
    <ul className={`ob-smp-keys ${big ? 'ob-big' : ''}`}>
      <li>
        <KG shape="half" tone="ok" />
        {t('A fix to check, before and after')}
      </li>
      <li>
        <KG shape="ease" tone="ask" />
        {big ? t('A question from the agent, with answers to pick') : t('A question from the agent')}
      </li>
      <li>
        <KG shape="circle" tone="idea" />
        {t('An idea, and the agent’s answer')}
      </li>
    </ul>
  );
}
