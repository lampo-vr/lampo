// How a partial render (lib/part.ts) reads in the player: the stretch it patches, whether its seams fit, and what the
// next full render said about it. Words only — the rules are lib/part.ts's.
import { partSpan, partWhere } from '../../../lib/part.ts';
import { timecode } from '../../../lib/time.ts';
import type { FrameRange, VersionPart } from '../../../lib/types.ts';
import type { Version } from '../api/types.ts';
import { t } from '../i18n/index.ts';

/** "part (00:04–00:07)": the version picker's word for a part. */
export const partTag = (p: Pick<VersionPart, 'at' | 'frames'>, fps: number): string => t('part ({stretch})', { stretch: partWhere(p, fps) });

/** One thing said about a version: `ok` sentences are quiet, the others ask for something. */
export interface PartSaid {
  ok: boolean;
  text: string;
  /** The frame it is about, when there is one (a seam that jumps, where a full render differs). */
  frame?: number;
}

/** The seam, said plainly. Null without handles (nothing was compared). */
export function seamSaid(p: VersionPart, fps: number): PartSaid | null {
  if (!p.seam) return null;
  if (p.seam === 'clean') return { ok: true, text: t('The seams match the version before') };
  return {
    ok: false,
    frame: p.seam.jump,
    text: t('The motion doesn’t match at {tc} — render the next shot too, or the whole video', { tc: timecode(p.seam.jump, fps) }),
  };
}

/** What a full render said about a part: it matches what was approved, or where it differs. */
export function checkSaid(p: VersionPart, fps: number): PartSaid | null {
  if (p.confirmed) return { ok: true, text: t('V{v} matches what you approved here', { v: p.confirmed.v }) };
  if (p.mismatch)
    return {
      ok: false,
      frame: p.mismatch.frame,
      text: t('V{v} differs from what you approved here at {tc}', { v: p.mismatch.v, tc: timecode(p.mismatch.frame, fps) }),
    };
  return null;
}

/** Said on a full render about the approved parts before it: "The full version matches what you approved in V8". */
export function fullSaid(versions: Version[], v: number): PartSaid[] {
  const out: PartSaid[] = [];
  for (const x of versions) {
    const p = x.part;
    if (p?.confirmed?.v === v) out.push({ ok: true, text: t('The full version matches what you approved in V{v}', { v: x.v }) });
    else if (p?.mismatch?.v === v)
      out.push({
        ok: false,
        frame: p.mismatch.frame,
        text: t('It differs from what you approved in V{v} at {tc}', { v: x.v, tc: timecode(p.mismatch.frame, x.fps) }),
      });
  }
  return out;
}

/** What the timeline marks on a part version: the stretch it patches, and the frame its seam jumps at. */
export function patchOf(ver: Version | undefined): (FrameRange & { jump: number | null }) | null {
  const p = ver?.part;
  if (!p) return null;
  return { ...partSpan(p), jump: p.seam && p.seam !== 'clean' ? p.seam.jump : null };
}
