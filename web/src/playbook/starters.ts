// The rules as people add them one at a time, and ways not to start from a blank page: rules a motion-design studio
// often writes down (one click adds one — it is saved, and shows in what agents read at once), the notes' recurring
// asks (a click starts the line; a person writes the rule) and an outline for the brief. Pure text work, unit-tested
// in test/unit/playbook-rules.test.ts.
import type { TasteSuggestion } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';

/** Starter rules: one line each, in the language of the app. */
export const starterRules = (): { id: string; line: string }[] => [
  { id: 'safe', line: t('Safe zones (9:16): no text or logo in the top 14 % or the bottom 20 %') },
  { id: 'loud', line: t('Loudness: −14 LUFS integrated, true peak at most −1 dBTP') },
  { id: 'captions', line: t('Captions burned in, two lines at most, never over faces') },
  { id: 'logo', line: t('Logo at most 8 % of the frame height') },
  { id: 'open', line: t('Something moves in the first half second: no black first frame') },
  { id: 'end', line: t('Hold the end card at least 2 s') },
  { id: 'deliver', line: t('Deliver H.264 MP4, 1080 × 1920, 30 fps, named project_v01.mp4') },
];

/** A brief's outline: the questions a brief answers, left for the team to fill in. */
export const briefOutline = (): string => [t('**Who it’s for:** '), t('**What it should feel like:** '), t('**Where it runs:** '), t('**Never:** ')].join('\n');

/** A recurring ask from the notes as the start of a rule: the topic, then the newest way someone asked for it. */
export const ruleFromNotes = (s: TasteSuggestion): string => {
  const example = s.examples[0]?.text || '';
  return `${s.tag[0]?.toUpperCase() || ''}${s.tag.slice(1)}: ${example}`;
};

/** Lines added under what is already written (a list item each). */
export const withLines = (text: string, lines: string[]): string => {
  const add = lines
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => (/^[-*+]\s/.test(l) ? `- ${l.replace(/^[-*+]\s+/, '')}` : `- ${l}`));
  if (!add.length) return text;
  return text.trim() ? `${text.replace(/\s+$/, '')}\n${add.join('\n')}` : add.join('\n');
};

const BULLET = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/;

/** One rule of a list: its text and the lines of the source it spans (a wrapped line continues the rule before it). */
export interface RuleItem {
  text: string;
  from: number;
  to: number;
}

/**
 * The rules one per item when the text is a plain list (what nearly every rules section is), so each can be read,
 * added and taken out on its own; null when it is more than a list (a heading, a paragraph): then it is edited as text.
 */
export function ruleItems(text: string): RuleItem[] | null {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const out: RuleItem[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim()) continue;
    const m = BULLET.exec(line);
    if (m) out.push({ text: m[1].trim(), from: i, to: i });
    else if (/^\s+\S/.test(line) && out.length && out[out.length - 1].to === i - 1) {
      const last = out[out.length - 1];
      last.text = `${last.text} ${line.trim()}`;
      last.to = i;
    } else return null;
  }
  return out;
}

/** The text without one rule (its lines, wrapped ones included). */
export function withoutRule(text: string, item: Pick<RuleItem, 'from' | 'to'>): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  lines.splice(item.from, item.to - item.from + 1);
  return lines
    .join('\n')
    .replace(/^\n+/, '')
    .replace(/\n{3,}/g, '\n\n');
}

/** How many rules a text holds: its list items (a text that is no list counts its lines). */
export function ruleCount(text: string): number {
  const items = ruleItems(text);
  if (items) return items.length;
  return text.split('\n').filter((l) => BULLET.test(l)).length || (text.trim() ? 1 : 0);
}

/** Squashed for comparing: case, spaces and the punctuation people vary don't make two rules different. */
const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/[\s.,;:!–—-]+/g, ' ')
    .trim();

/** The starter rules a text doesn't say yet (by their words, not their exact punctuation). */
export function unusedStarters(...texts: string[]): { id: string; line: string }[] {
  const said = new Set(texts.flatMap((x) => (ruleItems(x) ?? x.split('\n').map((l) => ({ text: l.replace(BULLET, '$1') }))).map((r) => norm(r.text))));
  return starterRules().filter((s) => !said.has(norm(s.line)));
}
