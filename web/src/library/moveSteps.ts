// The parts of a move that only matter once one is made (library/moving.tsx) or a card is being dragged
// (library/boardDrag.ts): kept out of the library's first paint with them. Pure, like library/moves.ts.
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import type { Move, Step, StepKind } from './moves.ts';

const isVerdict = (s: Step) => s.kind === 'approve' || s.kind === 'changes' || s.kind === 'withdraw';

/**
 * The writes of a move made while an earlier one of the same video still waits behind its Undo toast, together, as
 * they go to the server from where the video stood (`base`): a later verdict replaces an earlier one; a final mark and
 * its reopening cancel out; what leaves the team's word or the final mark as they were sends nothing. A card dragged
 * to the wrong lane and back sends no write at all.
 */
export function compose(base: VideoSummary, steps: Step[]): Step[] {
  const s = base.stage;
  // the final mark: where it ends up
  let final = s.final?.v ?? null;
  for (const x of steps)
    if (x.kind === 'final') final = x.v;
    else if (x.kind === 'reopen') final = null;
  const out: Step[] = [];
  if (s.final && final !== s.final.v) out.push({ kind: 'reopen', v: s.final.v });
  // the team's word on each version: the last one said
  const said = new Map<number, Step>();
  for (const x of steps) if (isVerdict(x)) said.set(x.v, x);
  for (const x of said.values()) {
    const before = x.v === s.v ? s.team : undefined;
    const same =
      before !== undefined &&
      (x.kind === 'withdraw' ? !before : before?.status === (x.kind === 'approve' ? 'approved' : 'changes') && (x.kind === 'approve' || !x.note?.trim()));
    if (!same) out.push(x);
  }
  if (final !== null && final !== (s.final?.v ?? null)) out.push({ kind: 'final', v: final });
  return out;
}

/** What dropping does, said where the card would land ("Drop to approve V9"). */
export function dropWords(m: Move): string {
  const has = (k: StepKind) => m.steps.some((x) => x.kind === k);
  const reopen = m.steps.find((x) => x.kind === 'reopen');
  if (has('final')) return t('Drop to mark V{v} final', { v: m.v });
  if (reopen) {
    if (has('approve')) return t('Drop to reopen and approve V{v}', { v: m.v });
    if (has('changes')) return t('Drop to reopen and request changes');
    if (has('withdraw')) return t('Drop to reopen for review');
    return t('Drop to reopen V{v}', { v: reopen.v });
  }
  if (has('approve')) return t('Drop to approve V{v}', { v: m.v });
  if (has('changes')) return t('Drop to request changes on V{v}', { v: m.v });
  return m.from === 'approved' ? t('Drop to withdraw the approval of V{v}', { v: m.v }) : t('Drop to withdraw the change request on V{v}', { v: m.v });
}
