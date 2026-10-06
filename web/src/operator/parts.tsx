// What the operator's pages share: the search field (the library's, `/` to focus), the crumb back to a list, a plan as
// one badge, and the words for sizes and days.
import { type RefObject, useEffect } from 'react';
import type { OperatorPlan } from '../../../lib/types.ts';
import { locale, t } from '../i18n/index.ts';
import { backToLibrary } from '../lib/nav.ts';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { Button, EmptyState } from '../ui/system.tsx';

/** The library's search field: filters as you type, `/` focuses it, Esc clears it. */
export function SearchField({
  value,
  onChange,
  placeholder,
  label,
  inputRef,
  disabled,
}: {
  value: string;
  onChange: (q: string) => void;
  placeholder: string;
  label: string;
  inputRef: RefObject<HTMLInputElement | null>;
  disabled?: boolean;
}) {
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      const el = document.activeElement as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      inputRef.current?.focus();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [inputRef]);
  return (
    <label className="lib-filter op-search">
      <I name="search" size={15} />
      <input
        ref={inputRef}
        className="input"
        placeholder={placeholder}
        aria-label={label}
        value={value}
        disabled={disabled}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape' && value) {
            e.stopPropagation();
            onChange('');
          }
        }}
      />
      {value ? (
        <IconButton className="lib-filter-clear" label={t('Clear the search')} shortcut="Esc" icon="x" size={13} onClick={() => onChange('')} />
      ) : (
        <kbd className="kbd">/</kbd>
      )}
    </label>
  );
}

/** Back to the list a page was opened from (the page's title says where you are). */
export function Crumb({ href, list }: { href: string; list: string }) {
  return (
    <nav className="op-crumb" aria-label={t('Where you are')}>
      <a className="btn-link" href={href}>
        <I name="back" size={14} />
        {list}
      </a>
    </nav>
  );
}

/** "12 Oct 2026" / "12. Okt. 2026". */
export const day = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', year: 'numeric' });
};

/** "12 Oct" this year, else with the year. */
export const shortDay = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleDateString(locale(), { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }) });
};

/** "12 Oct 2026, 14:03". */
export const dayTime = (iso: string | null | undefined): string => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString(locale(), { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

/** How long ago, in a few characters: "just now", "12 min ago", "3 h ago", "5 d ago", else the day. */
export const since = (iso: string | null | undefined, never = t('never')): string => {
  const at = iso ? Date.parse(iso) : Number.NaN;
  if (!Number.isFinite(at)) return never;
  const s = (Date.now() - at) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  if (s < 86400 * 30) return t('{n} d ago|{n} d ago', { n: Math.round(s / 86400) });
  return shortDay(iso);
};

const num = (n: number, digits: number) => n.toLocaleString(locale(), { maximumFractionDigits: digits });
/** Decimal units, the way plans count them: "340 GB", "1.5 TB", "12 MB". */
export const size = (bytes: number): string =>
  bytes >= 1e12
    ? `${num(bytes / 1e12, bytes >= 1e13 ? 0 : 1)} TB`
    : bytes >= 1e9
      ? `${num(bytes / 1e9, bytes >= 1e10 ? 0 : 1)} GB`
      : bytes >= 1e6
        ? `${num(bytes / 1e6, 0)} MB`
        : bytes > 0
          ? `${num(Math.max(1, bytes / 1e3), 0)} kB`
          : '0 GB';

/** "340 GB of 1 TB", "340 GB" without a limit. */
export const storageOf = (bytes: number, limit: number | null | undefined): string =>
  limit === null || limit === undefined ? size(bytes) : t('{used} of {limit}', { used: size(bytes), limit: size(limit) });

/** A plan's state as a filter and a tone: what the list's chips count. */
export type PlanGroup = 'trial' | 'paid' | 'free' | 'attention' | 'complimentary';
export const groupOf = (p: OperatorPlan): PlanGroup =>
  p.state === 'complimentary'
    ? 'complimentary'
    : p.state === 'trial'
      ? 'trial'
      : p.state === 'grace' || p.state === 'read-only'
        ? 'attention'
        : p.plan === 'free'
          ? 'free'
          : 'paid';

const TONE: Record<OperatorPlan['state'], Tone> = { active: 'ok', trial: 'nice', grace: 'should', 'read-only': 'must', complimentary: 'idea' };

/** What a plan's state adds to its name: "trial to 12 Oct", "grace to 19 Oct", "read-only", "complimentary". */
export function stateNote(p: OperatorPlan): string | null {
  if (p.state === 'trial') return t('trial to {day}', { day: shortDay(p.trialEndsAt) });
  if (p.state === 'grace') return p.graceUntil ? t('grace to {day}', { day: shortDay(p.graceUntil) }) : t('grace');
  if (p.state === 'read-only') return t('read-only');
  if (p.state === 'complimentary') return t('complimentary');
  return null;
}

/** A plan in one badge: its name, and its state when it has one. Free is the quiet outline; paid the settled diamond. */
export function PlanBadge({ plan, size: s = 'md' }: { plan: OperatorPlan; size?: 'sm' | 'md' }) {
  const note = stateNote(plan);
  const tone: Tone = plan.state === 'active' && plan.plan === 'free' ? 'neutral' : TONE[plan.state];
  return (
    <Badge tone={tone} size={s} note={note ?? undefined} testId="op-plan">
      {plan.name}
    </Badge>
  );
}

/** Inside the frame, a page the server no longer answers for this person (the operator list changed meanwhile). */
export function Gone() {
  return (
    <EmptyState
      art="error"
      titleAs="h2"
      title={t('There’s no page here')}
      testId="op-gone"
      action={
        <Button variant="primary" onClick={backToLibrary}>
          {t('Back to the library')}
        </Button>
      }
    >
      {t('The address may be mistyped, or this page is for someone else.')}
    </EmptyState>
  );
}
