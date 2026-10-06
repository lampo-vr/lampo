// How a reference on a note reads for agents (vr, MCP, INBOX.md, `vr watch`): one line each. Browser-safe.
import { timecode } from './time.ts';
import type { NoteRef } from './types.ts';

/** "r_1a2b3c4d5e image 1920×1080 — "caption" (by tester)". */
export function describeRef(r: NoteRef): string {
  const cap = r.caption ? ` — "${r.caption}"` : '';
  switch (r.kind) {
    case 'image':
      return `${r.id} image ${r.width}×${r.height}${cap} (by ${r.by})`;
    case 'clip':
      return `${r.id} clip ${r.duration?.toFixed(1)} s ${r.width}×${r.height}${cap} (by ${r.by})`;
    case 'link':
      return `${r.id} link ${r.url}${cap} (by ${r.by})`;
    case 'audio':
      return `${r.id} sound ${r.duration?.toFixed(1)} s${r.loudness ? ` ${r.loudness.i} LUFS` : ''}${cap} (by ${r.by})`;
    default: {
      const span =
        r.to_frame !== undefined && r.fps ? `${r.timecode} (f${r.frame}) to ${timecode(r.to_frame, r.fps)} (f${r.to_frame})` : `${r.timecode} (f${r.frame})`;
      return `${r.id} frame of ${r.name} v${r.v} at ${span}${cap} (by ${r.by})`;
    }
  }
}
