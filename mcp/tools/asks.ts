// ask_options: before an agent spends a render, the person auditions what it offers (voices, music, takes, looks) and
// picks — on a video, or on a project or folder before any render exists. Not in the lean set: it is a step before the
// review loop, and its schema costs every turn of every agent that never offers options (mcp/lean.ts).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import type { AskItemRequest } from '../../lib/backend/types.ts';
import { askPrompt, askText, folderName, localPath, optionId, optionLabel, refData, refUrl, refVideo } from '../../lib/inputs.ts';
import { OPTION_LIMITS, optionsSummary } from '../../lib/options.ts';
import { REF_LIMITS } from '../../lib/refs.ts';
import { oneLine } from '../../lib/time.ts';
import { allowed } from '../access.ts';
import { ok, pickVersion, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

export function registerAskTools({ b, o, tool, author, accountOf, byArg }: ToolKit): void {
  const onThisMachine = o.principal.via === 'local';
  const requestUpload = o.requestOptionUpload;
  // Over HTTP (where upload URLs exist) /mcp takes 1 MB a request, base64 and all; stdio takes a file's 8 MB (A12 OPT-8).
  const inlineSays = requestUpload ? 'base64 data ≤ 700 KB; bigger, or none: upload: true for a URL to PUT it to' : 'base64 data ≤ 8 MB';
  // The API's bounds (lib/inputs.ts, shared with POST /api/asks), checked on every call and not announced: a question of
  // 900,000 characters was stored once (A12 OPT-3b).
  const Item = z.object({
    id: optionId,
    label: optionLabel.optional(),
    path: localPath.optional(),
    data: refData.optional(),
    url: refUrl.optional(),
    video: refVideo.optional(),
    v: z.number().int().min(1).optional(),
    frame: z.number().int().min(0).optional(),
    upload: z.boolean().optional(),
  });
  const Group = z.object({
    id: optionId,
    label: optionLabel.optional(),
    pick: z.enum(['one', 'many']).optional(),
    items: z.array(Item).min(2).max(OPTION_LIMITS.items),
  });

  tool(
    'ask_options',
    {
      title: 'Let the person pick before you render',
      description: `Before you spend a render, offer options to audition and pick (voices, music, takes, looks): on a video, or a project or folder before the first render. One pick per group (pick: many for several). Item: a sound, image or clip (${onThisMachine ? 'path or ' : ''}${inlineSays}), a link (url), a moment (video + frame) or its label alone. Sounds play level. The answer comes as PICKED group=item … · note: "…" (wait_for_feedback).`,
      inputSchema: z.object({
        video: refVideo.optional(),
        folder: folderName.optional(),
        text: askText,
        groups: z
          .array(Group)
          .min(1)
          .max(OPTION_LIMITS.groups)
          .meta({ brief: true })
          .describe(`[{id, label, pick?, items: [{id, label, path|data|upload|url|video+frame}]}], ≤ ${OPTION_LIMITS.items} items each`),
        prompt: askPrompt.optional().describe('what the free-text field asks'),
        by: byArg,
      }),
    },
    async (args, ctx) => {
      if (!args.video === !args.folder) throw new Error('give video, or folder (a project or folder) before any render');
      const who = author(args.by, ctx);
      const slug = args.video ? (await b.resolve(args.video)).slug : undefined;
      // Sent data becomes a scratch file for as long as the question is made (the only files a caller elsewhere names).
      const scratch: string[] = [];
      try {
        const groups = await Promise.all(
          args.groups.map(async (g) => ({
            id: g.id,
            label: g.label,
            pick: g.pick,
            items: await Promise.all(
              g.items.map(async (it): Promise<AskItemRequest> => {
                const base = { id: it.id, label: it.label };
                if (it.path) {
                  // A path means a file where this server runs: only the machine's own agent may name one.
                  if (!onThisMachine) throw new Error('this server cannot read files on your machine: send data, or upload: true for an upload URL');
                  return { ...base, path: path.resolve(it.path) };
                }
                if (it.data) {
                  const bytes = Buffer.from(it.data, 'base64');
                  if (!bytes.length || bytes.length > REF_LIMITS.inlineBytes)
                    throw new Error(`${g.id}/${it.id}: data must be base64 of at most ${REF_LIMITS.inlineBytes / 1024 / 1024} MB`);
                  // A team file: the plan's upload gate first, as POST /api/asks asks it (an upload URL's file is asked
                  // when it arrives); a read-only workspace refuses it with its sentence (A12 AGENT-6).
                  await o.checkUpload?.(bytes.length);
                  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-mcp-ref-'));
                  scratch.push(dir);
                  fs.writeFileSync(path.join(dir, 'ref'), bytes);
                  return { ...base, path: path.join(dir, 'ref') };
                }
                if (it.url) return { ...base, url: it.url };
                if (it.video !== undefined) {
                  if (it.frame === undefined) throw new Error(`${g.id}/${it.id}: a moment needs video and frame`);
                  const res = await b.resolve(it.video);
                  const ver = pickVersion(await b.review(res.slug), it.v);
                  return { ...base, video: res.slug, v: ver.v, frame: it.frame };
                }
                // Its file comes later through a URL only when asked for: an item of words alone is its label.
                return it.upload ? { ...base, upload: true } : base;
              }),
            ),
          })),
        );
        // Items whose file comes later: one URL each, handed out before the question is written (this server's); a remote
        // backend's server hands out its own.
        const minted: string[] = [];
        const mintUploads = requestUpload
          ? (id: string, offered: Parameters<NonNullable<typeof requestUpload>>[2]) => {
              const out: Record<string, { url: string; expires: string }> = {};
              for (const g of groups)
                for (const it of g.items)
                  if (it.upload) {
                    const t = requestUpload({ ask: id, group: g.id, item: it.id, request: { by_id: accountOf(who) } }, who, offered);
                    minted.push(t.url);
                    out[`${g.id}/${it.id}`] = t;
                  }
              return out;
            }
          : undefined;
        let made: Awaited<ReturnType<typeof b.ask>>;
        try {
          made = await b.ask({
            ...(slug ? { slug } : { folder: args.folder }),
            text: args.text,
            groups,
            answer_prompt: args.prompt,
            by: who,
            by_id: accountOf(who),
            makeFolder: allowed(o.principal, 'organize'),
            ...(mintUploads ? { mintUploads } : {}),
          });
        } catch (e) {
          for (const url of minted) o.dropUpload?.(url);
          throw e;
        }
        const urls = Object.entries(made.uploads);
        const where = made.slug ? `on ${args.video}` : `on folder ${made.folder} (no video yet)`;
        const lines = [
          oneLine(`${made.id} asked ${where}: ${optionsSummary(groups)}`),
          'The person auditions and picks in Lampo; wait_for_feedback brings: ANSWERED … PICKED <group>=<item> … · note: "…"',
        ];
        // a command to run for agents with a shell; a chat client is told what the URL takes (mcp/loop.ts)
        for (const [key, t] of urls) lines.push(`${key}: PUT its file once (until ${t.expires}): ${o.way === 'chat' ? t.url : `curl -fT <file> '${t.url}'`}`);
        return ok(text(lines.join('\n')));
      } finally {
        for (const d of scratch) fs.rmSync(d, { recursive: true, force: true });
      }
    },
  );
}
