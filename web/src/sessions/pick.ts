// The agent picker's rules, without React: which rows it lists, what it preselects, when Assign changes anything.
// The assigned agent is always the first row — also while it isn't running, when no list reports it — so assigning
// never removes it by accident (test/unit/session-pick.test.ts).
import { agentKindOfRef } from '../../../lib/agentKind.ts';
import type { Session, SessionPick, SessionRef } from '../api/types.ts';

/** A row of the picker: a session from the list, or the assigned agent while it isn't running. */
export type PickerRow = Session & { notRunning?: boolean };

export const suggested = (sessions: Session[] | null) => (sessions?.[0] && (sessions[0].score ?? 0) >= 100 ? sessions[0] : null);
export const sameSession = (a: SessionRef | null | undefined, b: Session | null | undefined) =>
  !!a && !!b && ((!!a.id && !!b.sessionId && a.id === b.sessionId) || a.name === b.name);
export const pickOf = (s: Session | null): SessionPick | null =>
  s ? { name: s.name, sessionId: s.sessionId, cwd: s.cwd, agent: s.agent ?? 'claude-code' } : null;

/** The assigned agent first (from the list when it runs, else a row of its own marked not running), then the rest. */
export function pickerRows(sessions: Session[], current: SessionRef | null): PickerRow[] {
  if (!current) return sessions;
  const i = sessions.findIndex((s) => sameSession(current, s));
  if (i >= 0) return [sessions[i], ...sessions.slice(0, i), ...sessions.slice(i + 1)];
  const away: PickerRow = {
    name: current.name,
    sessionId: current.id,
    pid: null,
    cwd: current.cwd,
    kind: null,
    status: null,
    startedAt: null,
    agent: agentKindOfRef(current),
    notRunning: true,
  };
  return [away, ...sessions];
}

/** What the picker opens with: the assigned agent when there is one, running or not; else the suggestion. */
export const initialPick = (rows: PickerRow[], current: SessionRef | null, suggestion: Session | null): PickerRow | null =>
  current ? (rows[0] ?? null) : suggestion;

/** Whether Assign would change anything: another agent, or "No agent" while one is assigned. */
export const changes = (sel: Session | null, current: SessionRef | null): boolean => (sel ? !current || !sameSession(current, sel) : !!current);
