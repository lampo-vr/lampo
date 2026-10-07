// Playbooks for agents (lib/playbooks.ts, docs/playbooks.md): what the team decided before anyone watched a render —
// read it before rendering, load a skill when the work calls for it, and suggest a change when the notes keep
// asking for something the playbook doesn't say. Agents never edit a playbook: a person accepts or rejects.
import { z } from 'zod';
import { folderName, proposalContent, proposalEvidence, proposalReason } from '../../lib/inputs.ts';
import { scopeLabel } from '../../lib/playbookText.ts';
import { oneLine } from '../../lib/time.ts';
import type { PlaybookProposal, PlaybookStamp } from '../../lib/types.ts';
import { ok, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

const where = {
  video: z.string().optional().describe('its folder’s playbook'),
  folder: folderName.optional().describe('e.g. "Acme/Reels"; neither: the House'),
};

// a scope is a folder's name: one line, whatever it holds
export const stampLine = (stamp: PlaybookStamp[]): string => oneLine(stamp.map((s) => `${scopeLabel(s.scope)} r${s.rev}`).join(' · '));

/** The revisions an agent says it has read, as get_playbook or a note header printed them (in any order). */
const sameRevisions = (known: string, revisions: string): boolean => {
  const norm = (s: string) =>
    s
      .split(/[·,;]/)
      .map((x) => x.trim().toLowerCase().replace(/\s+/g, ' '))
      .filter(Boolean)
      .sort()
      .join('|');
  return norm(known) === norm(revisions);
};

const statusLine = (p: PlaybookProposal): string =>
  oneLine(
    `- ${p.id} · ${p.section} · ${p.status}${p.status === 'rejected' && p.reject_reason ? `: “${p.reject_reason}”` : ''}${p.status === 'accepted' ? ` (revision ${p.rev})` : ''} · by ${p.by}`,
  );

export function registerPlaybookTools({ b, o, tool, author, byArg, openReview }: ToolKit): void {
  /** A video → its slug (the backend's playbook lookups take slugs), else the folder as given. */
  const whereOf = async (w: { video?: string; folder?: string }) => (w.video ? { video: (await openReview(w.video)).slug } : { folder: w.folder || '' });

  tool(
    'get_playbook',
    {
      title: 'The playbook for a video or folder',
      description:
        'What the team decided before your render: brief, rules, references and skills, from the House down to the folder (deeper wins). Read it before rendering and follow it; get_skill loads a skill; propose_playbook_change suggests a change (a person decides). known: the revisions you have read (e.g. "House r2 · Acme r1") → only whether they changed.',
      inputSchema: z.object({ ...where, known: z.string().optional() }),
    },
    async ({ known, ...args }) => {
      const view = await b.playbook(await whereOf(args));
      const mine = view.playbook.proposals.slice(-10);
      const suggestions = mine.length ? `\n${oneLine(`Suggestions for ${view.label} (newest last):`)}\n${mine.map(statusLine).join('\n')}` : '';
      const revisions = stampLine(view.stamp);
      if (known !== undefined && sameRevisions(known, revisions))
        return ok(text(`Unchanged since ${revisions || 'no playbook'}: what you read still applies.${suggestions ? `\n${suggestions}` : ''}`));
      const tail = [view.stamp.length ? `Revisions in force: ${revisions} (a render made now is stamped with them).` : '', suggestions]
        .filter(Boolean)
        .join('\n');
      return ok(text(`${view.markdown}${tail ? `\n${tail}\n` : ''}`));
    },
  );

  tool(
    'get_skill',
    {
      title: 'Load a playbook skill',
      description: 'One playbook skill (its SKILL.md) and its files: presets, LUTs, scripts to use on your side.',
      inputSchema: z.object({ name: z.string(), ...where }),
    },
    async ({ name, ...w }) => {
      const s = await b.skill(await whereOf(w), name);
      const lines = [s.markdown.trimEnd(), '', oneLine(`(from ${scopeLabel(s.from)}, updated ${s.updated} by ${s.by})`)];
      if (s.files.length) {
        lines.push('', 'Files:');
        for (const f of s.files) {
          // On the machine the files can be handed over as paths; anyone else gets them through the API or `vr`.
          const local = o.principal.via === 'local' ? await b.skillFile(s.from, s.name, f.name) : null;
          const url = o.appUrl
            ? `${o.appUrl}/api/playbook/skill/files?folder=${encodeURIComponent(s.from)}&skill=${encodeURIComponent(s.name)}&name=${encodeURIComponent(f.name)}`
            : null;
          lines.push(oneLine(`- ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)${local ? ` → ${local}` : url ? ` → ${url}` : ''}`));
        }
        // a coding agent's shell has `vr` (mcp/loop.ts); everyone else is told the MCP way only
        if (o.principal.via !== 'local' && o.way === 'coding') lines.push('(`vr playbook export` writes the skill with its files to a folder on your machine)');
      }
      return ok(text(lines.join('\n')));
    },
  );

  tool(
    'propose_playbook_change',
    {
      title: 'Suggest a change to a playbook',
      description:
        'Suggest a new brief, rules or skill (e.g. the reviewer asked for the same thing on three videos). A person accepts or rejects it with a reason; get_playbook shows where it stands. content: the WHOLE new section (a skill: its full SKILL.md, name and description in the frontmatter; a new name adds one).',
      inputSchema: z.object({
        ...where,
        section: z.enum(['brief', 'rules', 'skill']),
        content: proposalContent,
        reason: proposalReason.describe('one or two sentences, read first'),
        evidence: proposalEvidence.optional().describe('note ids behind it'),
        by: byArg,
      }),
    },
    async ({ section, content, reason, evidence, by, ...w }, ctx) => {
      const p = await b.proposePlaybook(await whereOf(w), { section, content, reason, evidence, by: author(by, ctx) });
      return ok(
        text(
          `Suggested ${p.section} for ${scopeLabel(p.scope)} as ${p.id} (pending). A person accepts or rejects it; get_playbook shows where it stands. Until then the playbook says what it said.`,
        ),
      );
    },
  );
}
