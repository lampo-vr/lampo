// Names other people read (accounts, invites): one normal form, no invisible characters, and no name that only looks
// like someone else's or like an agent. Browser-safe (no Node imports).

// Letters from other scripts that render like Latin ones, and colon look-alikes: enough to catch "аgent:" (Cyrillic а)
// or "Olіvia" (Ukrainian і). Not a full confusables table (Unicode TR39); fullwidth forms are folded by NFKC already.
const LOOKALIKE: Record<string, string> = {
  а: 'a',
  в: 'b',
  е: 'e',
  ё: 'e',
  к: 'k',
  м: 'm',
  н: 'h',
  о: 'o',
  р: 'p',
  с: 'c',
  т: 't',
  у: 'y',
  х: 'x',
  і: 'i',
  ї: 'i',
  ј: 'j',
  ѕ: 's',
  ԁ: 'd',
  ԛ: 'q',
  ԝ: 'w',
  һ: 'h',
  ɡ: 'g',
  ı: 'i',
  α: 'a',
  β: 'b',
  ε: 'e',
  ι: 'i',
  κ: 'k',
  ν: 'v',
  ο: 'o',
  ρ: 'p',
  τ: 't',
  υ: 'u',
  χ: 'x',
  '∶': ':',
  ː: ':',
  '꞉': ':',
  '˸': ':',
  '։': ':',
  '׃': ':',
};

/** NFKC, without control or invisible formatting characters (bidi overrides, zero-width joiners), single spaces. */
export function cleanDisplayName(raw: string): string {
  return raw
    .normalize('NFKC')
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The most an agent's or session's name keeps (the picker, the monitor, a note's author). */
export const AGENT_NAME_MAX = 80;

/**
 * An agent's or session's name as it comes in — an assignment, a heartbeat, an MCP client's own name, `--by` / VR_BY,
 * a Claude Code session —: one line of printable text, at most `max` characters. Never a line break, a control
 * character or a bidi override, which would let it pass for another line or another agent wherever people and agents
 * read it (audit A12-D3).
 */
export function cleanAgentName(raw: string, max = AGENT_NAME_MAX): string {
  return [...cleanDisplayName(raw.replace(/\s+/g, ' '))].slice(0, max).join('').trim();
}

/** A write's author as given on this machine (`--by`, VR_BY, a session): `agent:` stays, the name is cleaned. */
export function cleanAuthor(raw: string): string {
  const m = /^agent:([\s\S]*)$/.exec(raw);
  if (!m) return cleanAgentName(raw);
  const name = cleanAgentName(m[1]);
  return name ? `agent:${name}` : '';
}

// What makes a stored name unfit to show as it is: a control or invisible formatting character (a bidi override, a
// zero-width one), a line or paragraph separator — or more characters than any name takes now.
const UNFIT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SHOWN_MAX = 'agent:'.length + AGENT_NAME_MAX;

/**
 * A name as read from the store (a note's author, a reply's, a session's, an event's `by`). Names are cleaned where they
 * come in now, but a store keeps what older versions took as sent (a line break, a bidi override, 3,000 characters):
 * those read as `cleanAuthor` makes them (`agent:` kept), one line, at most AGENT_NAME_MAX characters. A fit name is
 * returned as it is, so names people chose never change (A12 VA2-5).
 */
export function shownName(name: string): string {
  if (!UNFIT.test(name) && [...name].length <= SHOWN_MAX) return name;
  const agent = name.startsWith('agent:');
  return (agent ? cleanAuthor(name) : cleanAgentName(name)) || (agent ? 'agent:unnamed' : 'unnamed');
}

/** A folder an agent says it works in: its characters as they are (it may be resumed there), minus line breaks and controls. */
export const cleanFolderLine = (raw: string, max = 1000): string => raw.replace(/[\p{Cc}\p{Zl}\p{Zp}]/gu, '').slice(0, max);

/** What a name looks like to a reader: two names with the same skeleton can't be told apart on screen. */
export function nameSkeleton(name: string): string {
  return [...cleanDisplayName(name).toLowerCase()].map((c) => LOOKALIKE[c] ?? c).join('');
}

/** Authors starting with agent:/guest: mean something else throughout the store; so does anything that looks like it. */
export const looksReserved = (name: string): boolean => /^(agent|guest)\s*:/.test(nameSkeleton(name));
