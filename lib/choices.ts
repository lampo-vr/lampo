// Answers an agent offers with a question ("Yes, correct" · "No, it's …"): the person picks one with a click, or types.
// Browser-safe (no Node imports): the store keeps them clean, the route and MCP check them with these limits, the UI
// shows them. A picked choice is sent as an ordinary answer (its text), so agents read it like a typed one.

/** At least two to choose from, at most four buttons. */
export const CHOICES_MIN = 2;
export const CHOICES_MAX = 4;
/** One short line each. */
export const CHOICE_MAX = 80;

/**
 * Choices as kept: each trimmed to one line (line breaks and runs of spaces become one space) and at most CHOICE_MAX
 * characters, empty ones and repeats (ignoring case) dropped, at most CHOICES_MAX. Null when fewer than CHOICES_MIN are
 * left — one button is no choice.
 */
export function cleanChoices(input: unknown): string[] | null {
  if (!Array.isArray(input)) return null;
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of input) {
    if (typeof raw !== 'string') continue;
    const s = raw
      .replace(/[\p{Cc}\u2028\u2029\u0085]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, CHOICE_MAX)
      .trim();
    const key = s.toLocaleLowerCase();
    if (!s || seen.has(key)) continue;
    seen.add(key);
    out.push(s);
    if (out.length === CHOICES_MAX) break;
  }
  return out.length >= CHOICES_MIN ? out : null;
}
