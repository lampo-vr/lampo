// Active Claude Code sessions, so a video can be handed to the session that should act on its feedback.
// Source: `claude agents --json` (supported, ~4 s). Fallback / fast path for "who am I": ~/.claude/sessions/<pid>.json.
import fs from 'node:fs';
import path from 'node:path';
import { HOME } from './paths.ts';
import { run } from './probe.ts';
import type { AssignedSession, ClaudeSession, RankedSession, Review } from './types.ts';

/** The `claude` binary: VR_CLAUDE_BIN (tests point it at a stand-in), else the first one found; 'claude' when none is. */
export function findClaude(): string {
  if (process.env.VR_CLAUDE_BIN) return process.env.VR_CLAUDE_BIN;
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, 'claude');
    if (dir && fs.existsSync(p)) return p;
  }
  const nvm = path.join(HOME, '.nvm/versions/node');
  try {
    for (const v of fs.readdirSync(nvm).sort().reverse()) {
      const p = path.join(nvm, v, 'bin/claude');
      if (fs.existsSync(p)) return p;
    }
  } catch {}
  for (const p of [path.join(HOME, '.local/bin/claude'), path.join(HOME, '.claude/local/claude'), '/opt/homebrew/bin/claude', '/usr/local/bin/claude'])
    if (fs.existsSync(p)) return p;
  return 'claude';
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

/** A session as Claude Code reports it (`claude agents --json` or ~/.claude/sessions/<pid>.json). */
interface RawSession {
  name?: string;
  sessionId?: string;
  pid?: number;
  cwd?: string;
  kind?: string;
  status?: string;
  state?: string;
  startedAt?: number;
}

const norm = (x: RawSession): ClaudeSession => ({
  name: x.name || null,
  sessionId: x.sessionId || null,
  pid: x.pid || null,
  cwd: x.cwd || null,
  kind: x.kind || null,
  status: x.status || x.state || null,
  startedAt: x.startedAt || null,
  agent: 'claude-code',
});

function fromRegistry(): ClaudeSession[] {
  const dir = path.join(HOME, '.claude/sessions');
  const out: ClaudeSession[] = [];
  let files: string[] = [];
  try {
    files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
  } catch {
    return out;
  }
  for (const f of files) {
    try {
      const x: RawSession = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      if (x.name && x.pid && alive(x.pid)) out.push(norm(x));
    } catch {}
  }
  return out;
}

/**
 * The sessions `claude agents --json` lists (it takes a few seconds), else the session files. A CLI that doesn't answer
 * within `timeoutMs` counts as not answering: nothing waits on it for the media tools' hour (A12 INV-7).
 */
export async function listSessions({ timeoutMs = 10_000 }: { timeoutMs?: number } = {}): Promise<ClaudeSession[]> {
  try {
    const { stdout } = await run(findClaude(), ['agents', '--json'], { timeout: timeoutMs });
    const arr: unknown = JSON.parse(stdout.toString());
    if (Array.isArray(arr)) return (arr as RawSession[]).filter((x) => x.name).map(norm);
  } catch {}
  return fromRegistry();
}

// The session this process runs in (vr called from a Claude Code Bash tool), or null.
export function currentSession(): ClaudeSession | null {
  const pid = process.env.CLAUDE_PID;
  const id = process.env.CLAUDE_CODE_SESSION_ID;
  if (!pid && !id) return null;
  if (pid) {
    try {
      const x: RawSession = JSON.parse(fs.readFileSync(path.join(HOME, '.claude/sessions', `${pid}.json`), 'utf8'));
      if (x.name && (!id || x.sessionId === id)) return norm(x);
    } catch {}
  }
  const hit = fromRegistry().find((s) => s.sessionId === id || String(s.pid) === String(pid));
  return hit || (id ? { name: null, sessionId: id, pid: pid ? Number(pid) : null, cwd: process.cwd() } : null);
}

/** Something that names a session: an assignment on a review, or the session fields of an event. */
type SessionLike = Partial<Pick<AssignedSession, 'id'>> & { name?: string | null };

export const matchesSession = (assigned: SessionLike | null | undefined, s: { name?: string | null; sessionId?: string | null } | null | undefined): boolean =>
  !!assigned && !!s && ((!!assigned.id && !!s.sessionId && assigned.id === s.sessionId) || (!!assigned.name && assigned.name === s.name));

/** An agent that connected over /mcp (server/routes/mcp.ts names it `mcp-<hash>`): it acts only when someone prompts it. */
export const isMcpConnection = (assigned: SessionLike | null | undefined): boolean => !!assigned?.id?.startsWith('mcp-');

/**
 * Where a video's assigned agent stands, from the agents running or connected now: `active` — it runs (a connected
 * agent: listens or works its notes, server/agents.ts); `listening` — it hears new notes by itself (null: no agent, or
 * one Lampo can't tell about, like a Claude Code session on this machine). An agent connected over MCP that isn't
 * listed now isn't listening: nothing would make it look.
 */
export function assignedState(assigned: SessionLike | null | undefined, sessions: ClaudeSession[]): { active: boolean | null; listening: boolean | null } {
  if (!assigned) return { active: null, listening: null };
  const s = sessions.find((x) => matchesSession(assigned, x));
  if (!s) return { active: false, listening: isMcpConnection(assigned) ? false : null };
  if (s.kind !== 'connected') return { active: true, listening: null };
  // "watching" is what an older registry said of every connected agent
  return { active: s.status !== 'idle', listening: s.status === 'listening' || s.status === 'watching' };
}

// Rank sessions for a video: 1) already handles videos from the same project folder, 2) its cwd contains the
// video (deeper = better), 3) interactive over background. Returns sessions with {score, reason}.
export function rankSessions(sessions: ClaudeSession[], videoPath: string, reviews: Review[] = []): RankedSession[] {
  const projectDir = (p: string) => {
    const i = p.lastIndexOf('/export/');
    return i >= 0 ? p.slice(0, i) : path.dirname(p);
  };
  const mine = projectDir(videoPath);
  return sessions
    .map((s) => {
      let score = 0;
      const reasons: string[] = [];
      const siblings = reviews.filter((r) => r.session && r.video !== videoPath && projectDir(r.video) === mine && matchesSession(r.session, s));
      if (siblings.length) {
        score += 10000;
        reasons.push(`already has ${siblings.length} video${siblings.length > 1 ? 's' : ''} from this project`);
      }
      if (s.cwd && (videoPath === s.cwd || videoPath.startsWith(s.cwd.endsWith('/') ? s.cwd : `${s.cwd}/`))) {
        score += s.cwd.split('/').length * 100;
        reasons.push(`works in ${s.cwd.replace(HOME, '~')}`);
      }
      if (s.kind === 'interactive') score += 10;
      return { ...s, score, reason: reasons.join(' · ') };
    })
    .sort((a, b) => b.score - a.score || (b.startedAt || 0) - (a.startedAt || 0));
}
