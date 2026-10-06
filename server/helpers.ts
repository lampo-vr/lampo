// Lookups and shapes several routes share.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';

import { simplifyPoints } from '../lib/drawing.ts';
import { queued } from '../lib/jobs.ts';
import { isOwner } from '../lib/ownership.ts';
import { slugify } from '../lib/paths.ts';
import { can } from '../lib/permissions.ts';
import { renderKey } from '../lib/renderKey.ts';
import { assignedState } from '../lib/sessions.ts';
import { stageForReview } from '../lib/stageContext.ts';
import * as store from '../lib/store.ts';
import { compareTime, oneLine } from '../lib/time.ts';
import type { AssignedSession, ClaudeSession, ConnectedAgent, FrameMeta, Review, Shape, Version, VideoSummary } from '../lib/types.ts';
import type { Started } from './background.ts';
import { fail, sendInternal } from './http.ts';

export function getReview(slug: string): Review {
  const r = store.loadReview(slug);
  if (!r) throw fail(404, 'unknown video');
  return r;
}

/**
 * Version v of a review; the newest when none is named (undefined, null or empty). One it doesn't have is a 404, as on
 * the machine (`no v5`) — never the newest instead: a note, a render source or a transcript lands on the version it
 * names, or nowhere (A12 INV-6).
 */
export function getVersion(review: Review, v: unknown): Version {
  const named = v !== undefined && v !== null && v !== '';
  const ver = named ? review.versions.find((x) => x.v === Number(v)) : review.versions.at(-1);
  if (!ver) throw fail(404, named ? (Number.isSafeInteger(Number(v)) ? `no v${Number(v)}` : 'no such version') : 'no version');
  return ver;
}

/** The bytes of a version as a local file (fetched from remote storage when needed), or 410 when they are gone. */
export async function versionBytes(review: Review, ver: Version, message = 'the bytes of this version are gone'): Promise<string> {
  const file = await store.ensureVersionFile(review, ver.v);
  if (!file) throw fail(410, message);
  return file;
}

/** Sign-off is people's (docs/workflow.md): with an API token — an agent, a script — nothing is approved, carried over,
 * marked final or reopened. `vr` and the MCP tools never offer it; this holds for anything calling the API directly. */
export function signOffByPerson(req: Request): void {
  if (req.auth?.via === 'token') throw fail(403, 'sign-off is done by people in the app: agents never approve, carry over or mark final');
}

/** A final video is locked for agents: with an API token, no note on it is marked fixed or won't fix until it is reopened. */
export function finalLock(req: Request, review: Review): void {
  if (req.auth?.via !== 'token' || !review.final) return;
  const s = stageForReview(review);
  if (s.stage !== 'final' || !s.final) return;
  const since = s.final_superseded ? `, v${s.final_superseded} arrived since` : '';
  // the file's name is someone's (an upload's): one line, whatever it holds (agents read this answer)
  throw fail(409, oneLine(`${path.basename(review.video)} is final (v${s.final.v}, by ${s.final.by})${since}: nothing to fix until the reviewer reopens it`));
}

/**
 * Whether the person asking wrote (or added) a record: by account when the record names one, so a rename keeps it
 * theirs and a new account with a deleted person's name gets none of it; by name for records without one (older ones,
 * local `vr` writes), as before.
 */
export const isOwn = (req: Request, name: string | undefined, id: string | undefined): boolean =>
  isOwner(name, id, { id: req.auth?.user?.id, name: req.auth?.name });

/** The account to record with a write whose author is `who`: the signed-in person's, unless they write as an agent. */
export const accountOf = (req: Request, who: string): string | undefined => (who === req.auth?.name ? req.auth?.user?.id : undefined);

// Agents run on people's own machines: which folder a session works in and on which host is for those who work with
// agents (the `agents` action), not for reviewers. Local mode is the owner.
export const seesAgentDetails = (req: Request): boolean => can(req.auth?.role, 'agents');
const hideCwd = <T extends { session: AssignedSession | null }>(x: T): T => (x.session?.cwd ? { ...x, session: { ...x.session, cwd: null } } : x);
export const agentView = {
  review: (req: Request, r: Review): Review => (seesAgentDetails(req) ? r : hideCwd(r)),
  summary: (req: Request, s: VideoSummary): VideoSummary => (seesAgentDetails(req) ? s : hideCwd(s)),
  session: <T extends ClaudeSession>(req: Request, s: T): T => (seesAgentDetails(req) ? s : { ...s, cwd: null }),
  agent: (req: Request, a: ConnectedAgent): ConnectedAgent => (seesAgentDetails(req) ? a : { ...a, cwd: null, host: null }),
};

/** A sprite from Background.startSprite: the image once it exists, 202 + Retry-After while it is being made. */
export function sendSprite(res: Response, started: Started<'sprite', string>): void {
  if ('sprite' in started && started.sprite) {
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    sendInternal(res, started.sprite);
    return;
  }
  if ('none' in started && started.none) throw fail(404, started.error || 'no sprite for this render');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Retry-After', String(Math.min(60, 5 + 5 * queued())));
  res.status(202).json({ preparing: true });
}

export const metaOf = (review: Review, ver: Version): FrameMeta => ({
  ...(review.meta || {}),
  fps: ver.fps,
  width: ver.width,
  height: ver.height,
  frames: ver.frames,
});

export function summary(review: Review, sessions: ClaudeSession[]): VideoSummary {
  const slug = slugify(review.video);
  const latest = review.versions.at(-1);
  const upload = store.isUpload(review);
  // Whether its agent runs, and whether it hears new notes by itself (an MCP client only while it waits for them).
  const agent = assignedState(review.session, sessions);
  // Uploads have no file on disk to look at: the newest upload is "the file".
  let mtime: string | null = upload ? latest?.mtime || null : null;
  if (!upload)
    try {
      mtime = fs.statSync(review.video).mtime.toISOString();
    } catch {}
  return {
    slug,
    video: review.video,
    name: path.basename(review.video),
    project: review.project,
    fps: review.fps,
    width: review.width,
    height: review.height,
    duration: review.duration,
    frames: review.frames,
    v: latest?.v,
    hash: latest && renderKey(latest),
    versions: review.versions.length,
    counts: store.counts(review),
    session: review.session,
    folder: review.folder || null,
    approval: review.approval || null,
    stage: stageForReview(review, { sessionActive: !!agent.active }),
    agent_status: review.agent_status || null,
    sessionActive: agent.active,
    sessionListening: agent.listening,
    mtime,
    missing: !!review.missing || !mtime,
    archived: review.archived || null,
    added: review.added,
    updated: review.updated,
    lastComment: review.comments.reduce((a, c) => (compareTime(c.created, a) > 0 ? c.created : a), ''),
    ...(review.onboarding_sample ? { sample: true as const } : {}),
  };
}

// Drawings from a browser: keep valid shapes, clamp them near the frame, thin out freehand strokes.
export function sanitizeDrawing(drawing: unknown, ver: Pick<Version, 'width' | 'height'>): Shape[] {
  if (!Array.isArray(drawing)) return [];
  const num = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n);
  const cx = (x: number) => Math.round(Math.max(-ver.width, Math.min(2 * ver.width, x)));
  const cy = (y: number) => Math.round(Math.max(-ver.height, Math.min(2 * ver.height, y)));
  const out: Shape[] = [];
  for (const s of drawing.slice(0, 50)) {
    if (s?.type === 'box' && num(s.x) && num(s.y) && num(s.w) && num(s.h)) {
      const x = Math.min(s.x, s.x + s.w);
      const y = Math.min(s.y, s.y + s.h);
      out.push({ type: 'box', x: cx(x), y: cy(y), w: Math.round(Math.abs(s.w)), h: Math.round(Math.abs(s.h)) });
    } else if (s?.type === 'arrow' && num(s.x1) && num(s.y1) && num(s.x2) && num(s.y2)) {
      out.push({ type: 'arrow', x1: cx(s.x1), y1: cy(s.y1), x2: cx(s.x2), y2: cy(s.y2) });
    } else if (s?.type === 'freehand' && Array.isArray(s.points)) {
      const valid = (s.points as unknown[]).filter((p): p is [number, number] => Array.isArray(p) && num(p[0]) && num(p[1])).slice(0, 4000);
      const pts = simplifyPoints(valid, 3).map(([x, y]): [number, number] => [cx(x), cy(y)]);
      if (pts.length > 1) out.push({ type: 'freehand', points: pts });
    }
  }
  return out;
}
