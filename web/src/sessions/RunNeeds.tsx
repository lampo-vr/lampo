// What an agent's work needs from the person when it was refused something or failed, said the same way in the inbox's
// preview and the player's Agent view: the permission it lacks — what for, the exact rule to copy and where it goes
// (Lampo never allows anything itself) — and why it failed: its error in words, then the last lines the tool printed,
// in the code face. Rides with the chunks that show it (the inbox, the Agent view), never the first paint.
import type { ActivityWords, Run, RunStepLine } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { Code } from '../settings/parts.tsx';
import { phrase } from './activityWords.ts';
import '../styles/runneeds.css';

/** The lines a tool printed last, as the server keeps them (one line, its breaks as ↵). */
export const printedLines = (w: ActivityWords | null | undefined): string[] =>
  (w?.quote ?? '')
    .split(' ↵ ')
    .map((l) => l.trim())
    .filter(Boolean);

/** The last line of it: where a tool says what went wrong. */
export const lastPrinted = (w: ActivityWords | null | undefined): string => printedLines(w).at(-1) ?? '';

/** A permission it lacks: what for, and the rule that allows it, with where it goes. */
export function PermissionNeeds({ run }: { run: { needs?: Run['needs'] } }) {
  const needs = run.needs;
  return (
    <div className="rn-perm" data-testid="run-permission">
      <p className="rn-what">{needs?.text ? phrase(needs.text) : t('Needs a permission it doesn’t have')}</p>
      {needs?.allow ? (
        <>
          <p className="rn-how">
            {t(
              'Lampo never allows anything itself. Add this rule to "allow" under "permissions" in the project’s .claude/settings.json (or with /permissions in Claude Code), then send it again.',
            )}
          </p>
          <Code label={t('Permission rule')} testid="run-allow">
            {needs.allow}
          </Code>
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
