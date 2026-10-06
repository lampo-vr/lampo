// What agents read, beside the playbook as it is written: the merged markdown the server hands out (get_playbook,
// `vr playbook`, lib/playbooks.ts agentMarkdown), with what is being typed put where saving it would put it — so the
// pane shows what an agent will read once you save, before you do. And each line said whose it is: this playbook's
// own parts lit, what it inherits quieter. Pure text work, no DOM; test/unit/playbook-agent-text.test.ts holds the
// result to the server's own text after a real save, so the two can't drift apart.
import { cleanText, scopeLabel } from '../../../lib/playbookText.ts';

export type DraftSection = 'brief' | 'rules';

/** A section being written that isn't saved yet. */
export interface Draft {
  section: DraftSection;
  text: string;
}

/** The page the drafts belong to. */
export interface Own {
  scope: string;
  /** Its revision now (0: never written). */
  rev: number;
  /** Whether it holds anything the drafts don't replace (the other text, skills, references): then it stays a layer. */
  other: boolean;
}

/** `Own` for a playbook and the sections being drafted. */
export function ownOf(p: { scope: string; rev: number; brief: string; rules: string; refs: unknown[]; skills: unknown[] }, drafts: Draft[]): Own {
  const drafted = (s: DraftSection) => drafts.some((d) => d.section === s);
  const other = !!p.refs.length || !!p.skills.length || (!drafted('brief') && !!p.brief) || (!drafted('rules') && !!p.rules);
  return { scope: p.scope, rev: p.rev, other };
}

const TITLE: Record<DraftSection, string> = { brief: '## Brief', rules: '## Rules' };
// The sections in the order agentMarkdown writes them: a new one goes in before the first that follows it.
const ORDER = ['## Brief', '## Rules', '## Skills', '## References', '## Changing it'];
const LAYERS = /^Layers, deepest first: (.*)\. Where two layers disagree, the deeper one \(listed first\) wins\.$/;
const NONE = /^No playbook applies to /;
const heading = (label: string, rev: number) => `### From ${label} (revision ${rev})`;

// agentMarkdown's fixed sentences, for a playbook that had nothing before the draft (the test compares them with it)
const INTRO = 'What the team decided before anyone watched your render. Read it before you render, follow it, and cite it when a note seems to contradict it.';
const CHANGING =
  'You can suggest a change (propose_playbook_change / `vr playbook propose`) with the reason and the notes behind it; a person accepts or rejects it. Never edit around a rule silently.';
const layersLine = (list: string[]) => `Layers, deepest first: ${list.join(' · ')}. Where two layers disagree, the deeper one (listed first) wins.`;

/** Where a section's lines are: from its `## ` heading to the next one (or the end), or null. */
function sectionAt(lines: string[], title: string): { from: number; to: number } | null {
  const from = lines.indexOf(title);
  if (from < 0) return null;
  let to = from + 1;
  while (to < lines.length && !lines[to].startsWith('## ')) to++;
  return { from, to };
}

/** One draft into the lines (already renumbered): its block replaced, added first in its section, or taken out. */
function place(lines: string[], d: Draft, label: string, rev: number): string[] {
  const body = cleanText(d.text).trim();
  const title = TITLE[d.section];
  const sec = sectionAt(lines, title);
  const own = heading(label, rev);
  if (sec) {
    const at = lines.indexOf(own, sec.from);
    if (at >= 0 && at < sec.to) {
      // the block runs to the next layer's heading or the section's end; the blank line before that stays
      let end = at + 1;
      while (end < sec.to && !lines[end].startsWith('### ')) end++;
      const block = body ? [own, '', ...body.split('\n'), ''] : [];
      const out = [...lines.slice(0, at), ...block, ...lines.slice(end)];
      // nothing left in the section: its heading goes too
      const left = sectionAt(out, title);
      if (left && !out.slice(left.from + 1, left.to).some((l) => l.startsWith('### '))) out.splice(left.from, left.to - left.from);
      return out;
    }
    if (!body) return lines;
    // the deepest layer comes first: right under the section's heading and its blank line
    return [...lines.slice(0, sec.from + 2), own, '', ...body.split('\n'), '', ...lines.slice(sec.from + 2)];
  }
  if (!body) return lines;
  const after = ORDER.slice(ORDER.indexOf(title) + 1);
  let at = lines.findIndex((l) => after.includes(l));
  if (at < 0) at = lines.length;
  return [...lines.slice(0, at), title, '', own, '', ...body.split('\n'), '', ...lines.slice(at)];
}

/**
 * The markdown agents will read once the drafts are saved (only drafts that change something: each save is a revision,
 * and its own parts carry the number it will have); a playbook left with nothing drops out of the layers, and with no
 * layers at all the text says that nothing applies.
 */
export function withDrafts(markdown: string, own: Own, drafts: Draft[]): string {
  if (!drafts.length) return markdown;
  const label = scopeLabel(own.scope);
  // each draft is saved on its own: one revision each
  const next = own.rev + drafts.length;
  let lines = markdown.replace(/\n$/, '').split('\n');
  const hasText = drafts.some((d) => cleanText(d.text).trim());
  if (NONE.test(lines[2] ?? '')) {
    if (!hasText) return markdown;
    lines = [`# Playbook: ${label}`, '', INTRO, layersLine([`${label} r${next}`]), '', '## Changing it', '', CHANGING];
  } else {
    const li = lines.findIndex((l) => LAYERS.test(l));
    const list = li >= 0 ? (LAYERS.exec(lines[li])?.[1] ?? '').split(' · ') : [];
    const mine = `${label} r${own.rev}`;
    // a layer this page already is: every heading of it says the next revision
    if (list.includes(mine)) lines = lines.map((l) => (l === heading(label, own.rev) ? heading(label, next) : l));
    // once saved it is a layer when it holds anything at all
    const stays = own.other || hasText;
    const others = list.filter((x) => x !== mine);
    const updated = stays ? [`${label} r${next}`, ...others] : others;
    if (!updated.length)
      return `# Playbook: ${label}\n\nNo playbook applies to ${own.scope ? `"${own.scope}"` : 'the House'} yet. Follow the notes and the taste file.\n\nKnow a rule the team keeps asking for? Suggest it with propose_playbook_change (MCP) or \`vr playbook propose\`; a person decides.\n`;
    if (li >= 0) lines[li] = layersLine(updated);
  }
  for (const d of drafts) lines = place(lines, d, label, next);
  return `${lines.join('\n')}\n`;
}

/** One line of what agents read, with whose it is. */
export interface AgentLine {
  text: string;
  /** 1–3: a heading of that level; 0: text. */
  level: 0 | 1 | 2 | 3;
  /** Written in this playbook (not inherited, not the text every playbook has). */
  own: boolean;
  /** From a playbook above this one. */
  inherited: boolean;
  /** Part of a draft that isn't saved yet. */
  draft: boolean;
}

/**
 * The lines with whose they are: a layer's block (### From X (revision N)) and its lines belong to X; a skill or a
 * reference names where it comes from at its end or after its name. Lines of a drafted section that differ from the
 * saved text are drafts.
 */
export function agentLines(markdown: string, scope: string, saved?: string): AgentLine[] {
  const label = scopeLabel(scope);
  const before = new Set(saved === undefined ? [] : saved.split('\n'));
  let section = '';
  let layer: string | null = null;
  const from = /^### From (.+) \(revision \d+\)$/;
  const tail = / \(from ([^)]+)\)$/;
  const skill = /^- \*\*[^*]+\*\* \(from ([^)]+)\):/;
  return markdown
    .replace(/\n$/, '')
    .split('\n')
    .map((text) => {
      const level = (/^(#{1,3}) /.exec(text)?.[1].length ?? 0) as AgentLine['level'];
      if (level === 2) {
        section = text;
        layer = null;
      }
      const m = from.exec(text);
      if (m) layer = m[1];
      let who: string | null = level === 3 || (level === 0 && (section === TITLE.brief || section === TITLE.rules)) ? layer : null;
      if (section === '## Skills') who = skill.exec(text)?.[1] ?? null;
      if (section === '## References') who = tail.exec(text)?.[1] ?? null;
      const own = who === label;
      const changed = saved !== undefined && own && !!text && !before.has(text);
      return { text, level, own, inherited: who !== null && !own, draft: changed };
    });
}
