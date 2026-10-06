// draft_post and get_posts: an agent writes the post of a final video for a platform (title, text, tags, cover frame,
// when) and reads where posts stand. Publishing is a person's, in the app: there is no tool for it, the HTTP route is
// PERSON_ONLY, and no scope grants it (docs/publishing.md). Neither is in the lean set: they come after the review loop.
import { z } from 'zod';
import { postCategory, postFrame, postTags, postText, postTime, postTitle } from '../../lib/inputs.ts';
import { PLATFORM_NAMES, platformOf } from '../../lib/publish/platforms.ts';
import { postLines } from '../../lib/publish/posts.ts';
import { oneLine } from '../../lib/time.ts';
import type { PostFields } from '../../lib/types.ts';
import { ok, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

export function registerPostTools({ b, o, tool, author, accountOf, byArg }: ToolKit): void {
  tool(
    'draft_post',
    {
      title: 'Draft a post',
      description: "Draft a final video's post for one platform; a person publishes it, you can't. Fields left out stay. Says what is missing.",
      inputSchema: z.object({
        video: z.string(),
        platform: z.enum(['youtube', 'instagram', 'facebook']),
        // the API's caps, checked and not announced (lib/inputs.ts; A12 PUB-13)
        title: postTitle.optional(),
        text: postText.optional().describe('caption'),
        tags: postTags.optional(),
        cover_frame: postFrame.optional(),
        at: postTime.optional().describe('go-live time, ISO'),
        ai: z.boolean().optional().describe('realistic AI-made people, places or events'),
        kids: z.boolean().optional().describe('YouTube: made for kids'),
        // accepted, not announced (the defaults are right for most posts; docs/agents.md names them)
        visibility: z.enum(['public', 'unlisted', 'private']).optional().meta({ hidden: true }),
        category: postCategory.optional().meta({ hidden: true }),
        reel: z.boolean().optional().meta({ hidden: true }),
        share_to_feed: z.boolean().optional().meta({ hidden: true }),
        by: byArg,
      }),
    },
    async (args, ctx) => {
      const platform = platformOf(args.platform);
      if (!platform) throw new Error(`${args.platform} isn't a platform Lampo posts to`);
      const who = author(args.by, ctx);
      const { slug } = await b.resolve(args.video);
      const fields: PostFields = {
        ...(args.title !== undefined ? { title: args.title } : {}),
        ...(args.text !== undefined ? { description: args.text } : {}),
        ...(args.tags !== undefined ? { tags: args.tags } : {}),
        ...(args.cover_frame !== undefined ? { cover_frame: args.cover_frame } : {}),
        ...(args.visibility !== undefined ? { visibility: args.visibility } : {}),
        ...(args.at !== undefined ? { schedule_at: args.at || null } : {}),
        ...(args.ai !== undefined ? { ai_generated: args.ai } : {}),
        ...(platform === 'youtube' && (args.kids !== undefined || args.category !== undefined)
          ? { youtube: { ...(args.kids !== undefined ? { made_for_kids: args.kids } : {}), ...(args.category ? { category: args.category } : {}) } }
          : {}),
        ...(platform === 'instagram' && (args.reel !== undefined || args.share_to_feed !== undefined)
          ? {
              instagram: {
                ...(args.reel !== undefined ? { kind: args.reel ? ('reel' as const) : ('feed' as const) } : {}),
                ...(args.share_to_feed !== undefined ? { share_to_feed: args.share_to_feed } : {}),
              },
            }
          : {}),
      };
      const { post, created } = await b.draftPost({ slug, platform, fields, by: who, by_id: accountOf(who) });
      return ok(text(`${created ? 'drafted' : 'updated'} ${PLATFORM_NAMES[platform]}: ${postLines(post, o.appUrl)}`));
    },
  );

  tool(
    'get_posts',
    {
      title: 'Where posts stand',
      description: 'A video’s posts (or all): drafted, scheduled, posted with its link, or failed and why.',
      inputSchema: z.object({ video: z.string().optional() }),
    },
    async ({ video }) => {
      const slug = video ? (await b.resolve(video)).slug : undefined;
      const posts = await b.posts(slug);
      if (!posts.length) return ok(text(video ? 'no posts yet (draft_post writes one for a final video)' : 'no posts yet'));
      // a video's name is someone's (an upload's): one line, whatever it holds (A12 PUB-13)
      return ok(text(posts.map((p) => `${slug ? '' : `${oneLine(p.video)} · `}${postLines(p, o.appUrl)}`).join('\n')));
    },
  );
}
