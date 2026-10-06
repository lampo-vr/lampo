// Playbook text that the server and the browser both read: the SKILL.md format (the open Agent Skills format: YAML
// frontmatter with name and description, then markdown), the naming rule for skills, the limits, and a line diff for
// proposals and history, and which change a suggestion would replace. Browser-safe: no Node imports.
import { compareTime } from './time.ts';
import type { PlaybookProposal, PlaybookRevision } from './types.ts';

export const PLAYBOOK_LIMITS = {
  /** Characters of a brief or of the rules. */
  text: 20_000,
  /** Characters of a skill's instructions. */
  skillBody: 40_000,
  skillDescription: 1024,
  skillName: 64,
  skills: 30,
  filesPerSkill: 10,
  /** Bytes of one skill file (presets, LUTs, scripts: small things). */
  fileBytes: 2 * 1024 * 1024,
  refs: 24,
  message: 200,
  reason: 1000,
  evidence: 20,
  /** Pending proposals per playbook (an agent stuck in a loop can't flood it). */
  pending: 50,
  /** Revisions kept per playbook; the oldest go first. */
  history: 200,
  /** Decided proposals kept per playbook. */
  decided: 50,
} as const;

/** The Agent Skills naming rule: lowercase letters, digits and single hyphens, not at either end. */
export const SKILL_NAME = /^[a-z0-9](?:[a-z0-9]|-(?=[a-z0-9])){0,63}$/;

/** A skill file's name: letters, digits, dots, dashes and underscores, not starting with a dot. */
export const SKILL_FILE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,99}$/;

/** "House" or the folder path. */
export const scopeLabel = (scope: string): string => scope || 'House';

/** Line breaks as \n, no NULs or other control characters than tabs and line breaks, no trailing blank lines. */
export function cleanText(s: string): string {
  return (
    String(s || '')
      .replace(/\r\n?/g, '\n')
      // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what this removes
      .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
      .replace(/\s+$/, '')
  );
}

export interface SkillText {
  name: string;
  description: string;
  body: string;
  /** Frontmatter lines other than name and description, as they were. */
  extra?: string;
}

const unquote = (v: string) => {
  const t = v.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    const inner = t.slice(1, -1);
    return t.startsWith('"') ? inner.replace(/\\"/g, '"').replace(/\\\\/g, '\\') : inner.replace(/''/g, "'");
  }
  return t;
};

/** A YAML scalar that reads back as the same text (quoted when it would otherwise mean something else). */
const yamlString = (s: string) => (/^[\w .,()/+–—-]*$/.test(s) && !/^[-?:,[\]{}#&*!|>'"%@`]/.test(s) && s.trim() === s ? s : JSON.stringify(s));

/**
 * Reads a SKILL.md: frontmatter between `---` lines with `name:` and `description:` (one line each, as the format
 * asks), then the instructions. Throws with a message for people when it isn't one.
 */
export function parseSkill(md: string): SkillText {
  const text = cleanText(md);
  const m = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/.exec(text);
  if (!m) throw new Error('a SKILL.md starts with frontmatter between two --- lines (name and description)');
  let name = '';
  let description = '';
  const extra: string[] = [];
  for (const line of m[1].split('\n')) {
    const kv = /^([A-Za-z_][\w-]*):\s*(.*)$/.exec(line);
    if (kv && kv[1] === 'name') name = unquote(kv[2]);
    else if (kv && kv[1] === 'description') description = unquote(kv[2]);
    else if (line.trim()) extra.push(line);
  }
  const body = m[2].replace(/^\n+/, '');
  return { name, description, body, ...(extra.length ? { extra: extra.join('\n') } : {}) };
}

/** A skill as the SKILL.md an agent reads (and `vr playbook export` writes). */
export function skillMarkdown(s: SkillText): string {
  return `---\nname: ${s.name}\ndescription: ${yamlString(s.description)}\n${s.extra ? `${s.extra}\n` : ''}---\n\n${s.body}\n`;
}

/** Why a skill can't be saved as it is, or null. */
export function skillProblem(s: SkillText): string | null {
  if (!SKILL_NAME.test(s.name)) return 'a skill’s name is lowercase letters, digits and hyphens (e.g. export-reels), at most 64 characters';
  if (!s.description.trim()) return 'a skill needs a description: what it does and when an agent should use it';
  if (s.description.length > PLAYBOOK_LIMITS.skillDescription) return `a description may be at most ${PLAYBOOK_LIMITS.skillDescription} characters`;
  if (/\n/.test(s.description)) return 'a description is one line';
  if (s.body.length > PLAYBOOK_LIMITS.skillBody) return `a skill’s instructions may be at most ${PLAYBOOK_LIMITS.skillBody} characters`;
  return null;
}

export type DiffLine = { op: 'same' | 'add' | 'del'; text: string };

/**
 * A line diff (longest common subsequence), for proposals and history: what a change adds and removes. Texts over a
 * few thousand lines fall back to "all removed, all added" rather than a slow table.
 */
export function lineDiff(before: string | null, after: string | null): DiffLine[] {
  const a = before ? before.split('\n') : [];
  const b = after ? after.split('\n') : [];
  if (a.length * b.length > 4_000_000) return [...a.map((text) => ({ op: 'del' as const, text })), ...b.map((text) => ({ op: 'add' as const, text }))];
  const n = a.length;
  const m = b.length;
  // lcs[i][j] = length of the common subsequence of a[i..] and b[j..], one flat array.
  const lcs = new Uint32Array((n + 1) * (m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      lcs[i * (m + 1) + j] = a[i] === b[j] ? lcs[(i + 1) * (m + 1) + j + 1] + 1 : Math.max(lcs[(i + 1) * (m + 1) + j], lcs[i * (m + 1) + j + 1]);
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      out.push({ op: 'same', text: a[i] });
      i++;
      j++;
    } else if (lcs[(i + 1) * (m + 1) + j] >= lcs[i * (m + 1) + j + 1]) out.push({ op: 'del', text: a[i++] });
    else out.push({ op: 'add', text: b[j++] });
  }
  while (i < n) out.push({ op: 'del', text: a[i++] });
  while (j < m) out.push({ op: 'add', text: b[j++] });
  return out;
}

/**
 * What accepting a suggestion now would replace: the last change to its section after the revision it was made on —
 * or, once someone deciding has looked at its diff against a newer revision (`seen`), after that one. A person's edit
 * or another suggestion accepted for the same section; revisions that left the text as it was (a skill's file) don't
 * count. null: nothing to replace. The server refuses an accept on it (lib/playbooks.ts), the card says it first.
 */
export function changedSince(
  p: { rev: number; history: PlaybookRevision[] },
  prop: Pick<PlaybookProposal, 'base_rev' | 'section'>,
  seen?: number,
): PlaybookRevision | null {
  const base = Math.max(typeof prop.base_rev === 'number' ? prop.base_rev : p.rev, Math.min(seen ?? -1, p.rev));
  if (base >= p.rev) return null;
  return p.history.filter((h) => h.rev > base && h.section === prop.section && h.before !== h.after).at(-1) ?? null;
}

/**
 * Suggestions newest first. Times are whole seconds and an agent suggests several in a row: within one second, the one
 * made later (further down a playbook's list) is the newer.
 */
export function newestFirst(proposals: PlaybookProposal[]): PlaybookProposal[] {
  return proposals
    .map((p, i) => ({ p, i }))
    .sort((a, b) => compareTime(b.p.at, a.p.at) || b.i - a.i)
    .map((x) => x.p);
}

/** The suggestions waiting for one section of a playbook (a skill: the same name), the newest first. */
export function waitingFor(proposals: PlaybookProposal[], section: string): PlaybookProposal[] {
  return newestFirst(proposals.filter((x) => x.status === 'pending' && x.section === section));
}

/** How much a change adds and removes, in lines ("+3 −1"). */
export function diffStat(d: DiffLine[]): { add: number; del: number } {
  let add = 0;
  let del = 0;
  for (const l of d) {
    if (l.op === 'add') add++;
    else if (l.op === 'del') del++;
  }
  return { add, del };
}
