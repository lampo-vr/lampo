// What an agent's work needs from the person when it was refused something or failed, said the same way in the inbox's
// preview and the player's Agent view: the permission it lacks — what for, the exact rule to copy and where it goes
// (Lampo never allows anything itself) — and why it failed: its error in words, then the last lines the tool printed,
// in the code face. Rides with the chunks that show it (the inbox, the Agent view), never the first paint.
import { useState } from 'react';
import type { ActivityWords, Run, RunStepLine } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { copyText, toast } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { phrase } from './activityWords.ts';
import '../styles/runneeds.css';

/** The lines a tool printed last, as the server keeps them (one line, its breaks as ↵). */
export const printedLines = (w: ActivityWords | null | undefined): string[] =>
  (w?.quote ?? '')
    .split(' ↵ ')
    .map((l) => l.trim())
    .filter(Boolean);

/**
 * The rule that allows it, to copy (a card has room for no more): Settings' snippet box in look (settings/parts.tsx
 * Code), the rule on one line, never broken inside, sideways when it doesn't fit. Its own, not Code itself: Code rides
 * with Settings and the review links' card, and sharing it with the inbox and the player would split it into a chunk of
 * its own, which every start would list (the first paint's budget).
 */
export function RuleToCopy({ allow }: { allow: string }) {
  const [done, setDone] = useState(false);
  const label = t('Permission rule');
  const copy = async () => {
    if (!(await copyText(allow))) return toast(t('Could not copy'), 'error');
    setDone(true);
    setTimeout(() => setDone(false), 1400);
  };
  return (
    <div className="rn-code" data-testid="run-allow">
      <div className="rn-code-label">{label}</div>
      <button type="button" className="btn sm ghost rn-copy" onClick={copy} aria-label={t('Copy {label}', { label })} data-testid="run-allow-copy">
        <I name={done ? 'check' : 'copy'} size={14} /> {done ? t('Copied') : t('Copy')}
      </button>
      <pre className="mono">{allow}</pre>
    </div>
  );
}

/** A permission it lacks: what for (unless the line above says it: `bare`), and the rule that allows it, with where
 * it goes. */
export function PermissionNeeds({ run, bare = false }: { run: { needs?: Run['needs'] }; bare?: boolean }) {
  const needs = run.needs;
  return (
    <div className="rn-perm" data-testid="run-permission">
      {!bare && <p className="rn-what">{needs?.text ? phrase(needs.text) : t('Needs a permission it doesn’t have')}</p>}
      {needs?.allow ? (
        <>
          <p className="rn-how">
            {t(
              'Lampo never allows anything itself. Add this rule to "allow" under "permissions" in the project’s .claude/settings.json (or with /permissions in Claude Code), then send it again.',
            )}
          </p>
          <RuleToCopy allow={needs.allow} />
        </>
      ) : (
        <p className="rn-how">{t('Allow it in the agent’s own settings, then send it again.')}</p>
      )}
    </div>
  );
}

/** The tool's last lines, in the code face (none when it printed nothing Lampo kept). */
export function PrintedLines({ words }: { words: ActivityWords | null | undefined }) {
  const lines = printedLines(words).slice(-8);
  if (!lines.length) return null;
  return (
    <pre className="rn-log mono" data-testid="run-log-lines">
      {lines.join('\n')}
    </pre>
  );
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

/** Why it failed: the error in words, the tool's last lines, and (when given) the steps before it, newest first. */
export function FailureLines({ run, steps }: { run: { error?: ActivityWords }; steps?: RunStepLine[] }) {
  const err = run.error;
  const before = (steps ?? []).filter((s) => s.type !== 'error').slice(0, 4);
  return (
    <div className="rn-fail" data-testid="run-failure">
      <p className="rn-what err">{err ? phrase(err) : t('It stopped with an error')}</p>
      <PrintedLines words={err} />
      {before.length > 0 && (
        <ol className="rn-steps" aria-label={t('Before it stopped')} data-testid="run-steps">
          {before.map((s) => (
            <li key={`${s.at}-${s.text}`}>
              <time dateTime={s.at}>{timeOf(s.at)}</time>
              <span>{phrase(s)}</span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

/** What it did before it went quiet, newest first. */
export function LastSteps({ steps }: { steps?: RunStepLine[] }) {
  const shown = (steps ?? []).slice(0, 4);
  if (!shown.length) return null;
  return (
    <ol className="rn-steps" aria-label={t('Its last steps')} data-testid="run-steps">
      {shown.map((s) => (
        <li key={`${s.at}-${s.text}`}>
          <time dateTime={s.at}>{timeOf(s.at)}</time>
          <span>{phrase(s)}</span>
        </li>
      ))}
    </ol>
  );
}
