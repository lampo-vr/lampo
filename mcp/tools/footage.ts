// Footage search for agents (docs/footage.md): B-roll from the workspace's videos as a compact list of shots — id,
// video, in–out, length, aspect, camera move, score — and, when asked, one labelled contact sheet of them. A few hundred
// tokens instead of looking through footage frame by frame (bench/footage/RESULTS.md: ~760 vs 54–68k per request).
import fs from 'node:fs';
import { z } from 'zod';
import { compactList } from '../../lib/footage/lines.ts';
import { MOTION_WORDS } from '../../lib/footage/types.ts';
import { quiet } from '../../lib/inputs.ts';
import { ok, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

export function registerFootageTools({ b, tool }: ToolKit): void {
  tool(
    'find_footage',
    {
      title: 'Find B-roll in the footage',
      description:
        "B-roll: shots of the workspace's videos, best first, one line each (id, video, in–out, length, aspect, move). query: what the picture shows (filters in words work too); sheet: one labelled contact sheet.",
      // the caps are checked, not announced (mcp/lean.ts `quiet`): only the types, the aspect and the moves are
      inputSchema: z.object({
        query: quiet(z.string().max(500)),
        aspect: z.enum(['16:9', '9:16', '1:1']).optional(),
        min_s: quiet(z.number().min(0).max(86400)).optional(),
        max_s: quiet(z.number().min(0).max(86400)).optional(),
        motion: z.enum(MOTION_WORDS).optional().meta({ brief: true }).describe('push-in, pull-out, pan(-left/-right), tilt(-up/-down), static, handheld'),
        text: quiet(z.string().max(200)).optional().describe('"none", or words on screen'),
        said: quiet(z.string().max(200)).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        sheet: z.boolean().optional(),
      }),
    },
    async ({ sheet, ...req }) => {
      const a = await b.findFootage(req);
      const list = text(compactList(a));
      if (!sheet || !a.shots.length) return ok(list);
      const { file } = await b.footageSheet(a.shots.slice(0, 9).map((s) => s.id));
      return ok(list, { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: 'image/jpeg' });
    },
  );
}
