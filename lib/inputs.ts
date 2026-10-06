// What people and agents write, capped the same on every way in: the HTTP API (server/routes/*, server/uploadTickets.ts)
// and the MCP tools (mcp/tools/*) parse it with these schemas, so a cap can't be skipped by asking the other way — a
// 1 MB note over MCP went into review.json and every agent's next read (A12 AGENT-6). `vr` goes through one or the
// other. MCP doesn't announce the length caps in its tool list (mcp/lean.ts); every call is checked all the same.
import { z } from 'zod';
import { OPTION_LIMITS } from './options.ts';
import { PLAYBOOK_LIMITS } from './playbookText.ts';
import { PREVIEW_LIMITS } from './previews.ts';
import { REF_LIMITS } from './refs.ts';

export const INPUT_LIMITS = {
  /** A note's words, a reply, what a fix changed, why something won't be fixed. */
  noteText: 20_000,
  tag: 60,
  /** Who an agent says it is (`by`; lib/names.ts cleans it to 80 characters after). */
  by: 100,
  /** An agent's status on a video card. */
  status: 200,
  /** The app, project file and comp a render or a fix preview came from. */
  sourceName: 200,
  /** The video a reference shows a moment of: a slug, or the id a review link gave it. */
  video: 600,
  fileName: 255,
  folder: 400,
  slug: 400,
  /** A post's fields as they come in (each platform's own, smaller limits are the post's problems; A12 PUB-13). */
  postTitle: 2000,
  postText: 80_000,
  postTag: 200,
  postTags: 100,
  postTime: 60,
  postCategory: 4,
} as const;

export const commentId = z.string().regex(/^c_[0-9a-f]{6}$/, 'expected a comment id like c_1a2b3c');
export const previewId = z.string().regex(/^p_[a-f0-9]{10}$/, 'expected a fix preview id like p_1a2b3c4d5e');

/** Checked on every call, not announced in MCP's tool list (`quiet`, mcp/lean.ts trimSchema): only the type is. */
export const quiet = <S extends z.ZodType>(schema: S): S => schema.meta({ quiet: true });

export const noteText = quiet(z.string().max(INPUT_LIMITS.noteText));
export const tagList = quiet(z.array(z.string().max(INPUT_LIMITS.tag)));
export const byName = quiet(z.string().max(INPUT_LIMITS.by));
export const statusText = quiet(z.string().max(INPUT_LIMITS.status));
export const sourceName = quiet(z.string().trim().min(1).max(INPUT_LIMITS.sourceName));
/** Seconds on the project's timeline, a frame number in it, its frame rate. */
export const projectTime = quiet(z.number().min(0).max(86_400));
export const startFrame = quiet(z.number().int().min(0).max(10_000_000));
export const projectFps = quiet(z.number().positive().max(1000));

export const refCaption = quiet(z.string().max(REF_LIMITS.caption));
export const refUrl = quiet(z.string().min(1).max(REF_LIMITS.url));
export const refVideo = quiet(z.string().min(1).max(INPUT_LIMITS.video));
/** A file sent inline, base64: no longer than what decodes to `bytes`. */
const base64Of = (bytes: number) => quiet(z.string().max(Math.ceil(bytes / 3) * 4 + 4));
export const refData = base64Of(REF_LIMITS.inlineBytes);
export const previewData = base64Of(PREVIEW_LIMITS.inlineBytes);

export const fileName = quiet(z.string().min(1).max(INPUT_LIMITS.fileName));
export const folderName = quiet(z.string().max(INPUT_LIMITS.folder));
export const slugName = quiet(z.string().max(INPUT_LIMITS.slug));

/** A suggested playbook change: the whole new section, why, and the notes behind it. */
export const proposalContent = quiet(z.string().max(PLAYBOOK_LIMITS.skillBody + 6000));
export const proposalReason = quiet(z.string().max(PLAYBOOK_LIMITS.reason + 100));
export const proposalEvidence = quiet(z.array(commentId).max(PLAYBOOK_LIMITS.evidence));

/** A question with options (lib/options.ts): what it asks, its free-text prompt, its groups' and items' ids and labels. */
export const askText = quiet(z.string().min(1).max(OPTION_LIMITS.text));
export const askPrompt = quiet(z.string().max(OPTION_LIMITS.prompt * 2));
export const optionId = quiet(z.string().min(1).max(OPTION_LIMITS.id));
export const optionLabel = quiet(z.string().max(OPTION_LIMITS.label * 2));
/** A file on the machine running the server (the machine's own agent only). */
export const localPath = quiet(z.string().min(1).max(4096));

// A post's draft (server/routes/publish.ts, MCP draft_post)
export const postTitle = quiet(z.string().max(INPUT_LIMITS.postTitle));
export const postText = quiet(z.string().max(INPUT_LIMITS.postText));
export const postTags = quiet(z.array(z.string().max(INPUT_LIMITS.postTag)).max(INPUT_LIMITS.postTags));
export const postTime = quiet(z.string().max(INPUT_LIMITS.postTime));
export const postCategory = quiet(z.string().max(INPUT_LIMITS.postCategory));
export const postFrame = quiet(z.number().int().min(0).max(10_000_000));
