// What the stage card says (StageCard.tsx): the stage and its version once, in the head, then where the video stands as
// short facts, one a line, and what comes next. Built from the same fields lib/stage.ts writes its one-line `detail`
// from — the counts, the verdicts, the link — so the card and that line never disagree; the line itself stays what the
// library card, the board and the inbox say (stageText.ts stageDetail). A module of its own: only the player's card
// needs it, never the library's first paint.
import { isApprovedStage } from '../../../lib/stage.ts';
import type { NextStep, StageInfo } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { ago, pct } from '../lib/format.ts';

const person = (by: string) => by.replace(/^(guest|agent):/, '');

/** The version the stage is about, as the head says it: the final one, else the newest ("V8 (part)" for a part). */
export function stageVersion(s: StageInfo): string {
  const v = s.stage === 'final' ? (s.final?.v ?? s.v) : s.v;
  return `V${s.part && v === s.v ? t('{v} (part)', { v }) : v}`;
}

// While an agent says what it is doing, lib/stage.ts (`working`) puts its words in the stage's line instead of the
// counts, which always start with a number or with "Changes requested on": those words are a fact of their own.
const COUNTED = /^(\d+ (notes?|fix(es)?) |Changes requested on )/;
const agentWords = (s: StageInfo): string | null => (s.stage === 'in_progress' && !COUNTED.test(s.detail) ? s.detail : null);

/** "Opened by Mia · 2 h ago", "Opened before this version", "Link not opened". */
function opened(s: StageInfo): string | null {
  const sh = s.share;
  if (!sh) return null;
  if (sh.opened) {
    const who = sh.by ? t('Opened by {name}', { name: sh.by }) : t('Opened');
    return sh.last_opened ? `${who} · ${ago(sh.last_opened)}` : who;
  }
  return sh.seen_v !== null || sh.opens ? t('Opened before this version') : t('Link not opened');
}

/** How far a visitor got through the newest version, through which link: "Mia watched 80 % of V4 through “Spring”". */
function watched(s: StageInfo): string | null {
  const sh = s.share;
  if (!sh || sh.watched == null) return null;
  return sh.watched_by
    ? t('{name} watched {pct} of V{v} through “{label}”', { name: sh.watched_by, pct: pct(sh.watched), v: s.v, label: sh.label })
    : t('A visitor watched {pct} of V{v} through “{label}”', { pct: pct(sh.watched), v: s.v, label: sh.label });
}

/** Where the video stands, one short fact a line: who decided, the link, then the work still in it. */
export function stageFacts(s: StageInfo): string[] {
  const out: (string | null | undefined)[] = [];
  const seen = watched(s);
  switch (s.stage) {
    case 'final':
      out.push(s.final_superseded ? t('V{v} arrived since', { v: s.final_superseded }) : s.final && t('Marked final by {name}', { name: person(s.final.by) }));
      break;
    case 'client_approved':
      out.push(s.client && t('Approved by {name} via review link', { name: person(s.client.by) }));
      break;
    case 'with_client':
    case 'team_approved':
      out.push(s.team && t('Approved by {name}', { name: person(s.team.by) }));
      // the link by its name, unless the line of who watched it names it
      if (s.share && !seen) out.push(t('Review link “{label}”', { label: s.share.label }));
      out.push(opened(s));
      break;
    case 'changes':
    case 'in_progress': {
      const verdict = s.client ?? s.team;
      if (verdict?.status === 'changes') {
        const name = person(verdict.by);
        out.push(verdict.party === 'client' ? t('Changes requested by {name} via review link', { name }) : t('Changes requested by {name}', { name }));
        if (verdict.note) out.push(`“${verdict.note}”`);
      }
      out.push(agentWords(s));
      break;
    }
    case 'to_review':
      if (s.approval_stale)
        out.push(s.identical_to_approved ? t('Identical to approved V{v}', { v: s.approval_stale.v }) : t('V{v} approved', { v: s.approval_stale.v }));
      break;
  }
  out.push(seen);
  // The work still in it, the person's own first: fixes to check, notes open, fixes the next version brings.
  if (s.to_verify) out.push(t('{n} fix to check|{n} fixes to check', { n: s.to_verify }));
  if (s.open)
    out.push(isApprovedStage(s.stage) ? t('{n} note still open|{n} notes still open', { n: s.open }) : t('{n} note open|{n} notes open', { n: s.open }));
  if (s.waiting) out.push(t('{n} fix coming in V{v}|{n} fixes coming in V{v}', { n: s.waiting, v: s.v + 1 }));
  if (s.on_preview) out.push(t('{n} fix checked on a preview, not rendered yet|{n} fixes checked on a preview, not rendered yet', { n: s.on_preview }));
  return out.filter((x): x is string => !!x);
}

/**
 * The card's last line, from the next step's words: something to do reads "Next: Assign an agent", something waited on
 * ("Waiting for their decision", "An agent is on it") and the end ("Nothing left: …") read as they are.
 */
export function nextWords(next: NextStep, words: string): string {
  const waits = next.kind === 'wait_agent' || next.kind === 'wait_client' || next.kind === 'none' || /^Waiting /.test(next.label);
  return waits ? words : t('Next: {step}', { step: words });
}
