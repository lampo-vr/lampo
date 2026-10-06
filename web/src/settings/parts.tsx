// Building blocks of the settings screen.
import { Fragment, type ReactNode, useState } from 'react';
import { locale, t } from '../i18n/index.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { copyText, toast } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { Panel } from '../ui/system.tsx';
import '../styles/code.css';

/** A settings card: a base Panel with the page cards' padding (24 all round, 16 on phones), a section title and a lede;
 * `step` numbers it as a step of a flow (Connect an agent). */
export function Card({
  title,
  lede,
  children,
  danger,
  step,
  testid,
}: {
  title: string;
  lede?: ReactNode;
  children: ReactNode;
  danger?: boolean;
  /** A numbered step of a flow (Connect an agent). */
  step?: number;
  testid?: string;
}) {
  return (
    <Panel pad="lg" className={`set-card ${danger ? 'danger' : ''}`} data-testid={testid}>
      <header>
        <h2 className="section-title">
          {step != null && <span className="set-step-n">{step}</span>}
          {title}
        </h2>
        {lede && <p>{lede}</p>}
      </header>
      {children}
    </Panel>
  );
}

/** A card that starts folded: the how and why behind a page, for whoever wants it. */
export function Details({ title, hint, children, testid }: { title: string; hint?: string; children: ReactNode; testid?: string }) {
  return (
    <details className="set-card set-details" data-testid={testid}>
      <summary>
        <h2>{title}</h2>
        {hint && <span>{hint}</span>}
      </summary>
      {/* a details element is no grid container in every browser: the body carries the card's rhythm */}
      <div className="set-details-body">{children}</div>
    </details>
  );
}

/** Each run of non-spaces in its own unbreakable span: the browser would otherwise break after a token's `-` or a URL's
 * `/` once the line is full (a token is base64url). The spaces stay plain text, so a selection copies the text as is. */
const words = (s: string) =>
  s.split(/(\s+)/).map((w, i) =>
    i % 2 || !w ? (
      w
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the words of one text, in order
      <span key={i} className="set-code-w">
        {w}
      </span>
    ),
  );

/**
 * A command or snippet to paste somewhere: its label and one Copy on top (beside the text when there is no label).
 * Lines break at spaces only, never inside a token, a URL or a path; a command's `--header "…"` or `--token -` stays
 * together and starts a line of its own when the line is full; `lines` (a JSON or TOML config) keeps its lines as they
 * are. Whatever doesn't fit scrolls sideways with a soft edge. Copy takes the text as it is.
 */
export function Code({
  label,
  children,
  testid,
  lines,
  copy: copies = true,
}: {
  label?: string;
  children: string;
  testid?: string;
  lines?: boolean;
  /** false: no Copy of its own (what it sits in copies it: an embed's line). */
  copy?: boolean;
}) {
  const [done, setDone] = useState(false);
  const [edgeRef, edges] = useScrollEdges<HTMLPreElement>();
  const copy = async () => {
    if (!(await copyText(children))) return toast(t('Could not copy'), 'error');
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  const [command, ...args] = children.split(/ (?=--(?:header|token) )/);
  return (
    <div className={`set-code ${label ? '' : 'bare'} ${lines ? 'lines' : ''}`} data-testid={testid}>
      {label && <div className="set-code-label">{label}</div>}
      {copies && (
        <button type="button" className="btn sm ghost set-copy" onClick={copy} aria-label={label ? t('Copy {label}', { label }) : t('Copy snippet')}>
          <I name={done ? 'check' : 'copy'} size={14} /> {done ? t('Copied') : t('Copy')}
        </button>
      )}
      <pre ref={edgeRef} className={`mono ${edges}`}>
        {words(command)}
        {args.map((a) => (
          <Fragment key={a}>
            {' '}
            <span className="set-code-arg">{words(a)}</span>
          </Fragment>
        ))}
      </pre>
    </div>
  );
}

/** One line of Facts: a label and its value (in the monospaced face for models, paths and versions). */
export interface Fact {
  label: string;
  /** The words, or what stands in for them while they load (SkLine). */
  value: ReactNode;
  mono?: boolean;
}

/** Label → value rows ("Engine · transcribe.cpp on this machine"); falsy rows are left out. */
export function Facts({ rows, testid }: { rows: (Fact | null | false)[]; testid?: string }) {
  return (
    <dl className="set-facts" data-testid={testid}>
      {rows
        .filter((r): r is Fact => !!r)
        .map((r) => (
          <div key={r.label}>
            <dt>{r.label}</dt>
            <dd className={r.mono ? 'mono' : undefined}>{r.value}</dd>
          </div>
        ))}
    </dl>
  );
}

// "Are you sure?" for revoking, removing and resetting: the app-wide alert dialog (ui/primitives.tsx).
export { Confirm } from '../ui/primitives.tsx';

export const when = (iso: string | null | undefined) => {
  if (!iso) return t('never');
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const s = (Date.now() - d.getTime()) / 1000;
  if (s < 60) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  if (s < 86400 * 30) return t('{n} d ago|{n} d ago', { n: Math.round(s / 86400) });
  return d.toLocaleDateString(locale(), { day: '2-digit', month: 'short', year: 'numeric' });
};

/** "expires today" · "expires in 12 days" · "expired" (invites and tokens). */
export const expiry = (iso: string) => {
  const d = Math.ceil((Date.parse(iso) - Date.now()) / 86400000);
  if (Number.isNaN(d)) return iso;
  if (Date.parse(iso) <= Date.now()) return t('expired');
  return d <= 1 ? t('expires today') : t('expires in {n} day|expires in {n} days', { n: d });
};

// Temporary passwords: easy to read out, no look-alike characters.
export function tempPassword(n = 16) {
  const abc = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
  const r = crypto.getRandomValues(new Uint32Array(n));
  return Array.from(r, (x) => abc[x % abc.length]).join('');
}

/** Where agents and share links reach this server. */
export const serverUrl = (publicUrl: string | null | undefined) => (publicUrl || location.origin).replace(/\/+$/, '');
