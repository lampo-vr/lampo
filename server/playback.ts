// What the browser plays: a version's own bytes, or a proxy. Playback proxies are H.264 with a keyframe every
// 10 frames and no B-frames, so every seek and frame step decodes at most 9 frames (renders often have 100+ frames
// between keyframes: 100–170 ms per step). Frame-exact: every frame keeps its timestamp. Screenshots and analysis
// always use the original bytes.
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { heavy, jobRoom, PRIORITY, QueueFullError } from '../lib/jobs.ts';
import { cacheDir, slugify } from '../lib/paths.ts';
import { FFMPEG, FFPROBE, MEDIA_TIMEOUT_MS, run } from '../lib/probe.ts';
import { pruneDir } from '../lib/prune.ts';
import { renderKey } from '../lib/renderKey.ts';
import { boundToWorkspace, wsKey } from '../lib/scope.ts';
import { ensureSplice, spliceKey } from '../lib/splice.ts';
import { SIGNED_URL_SECONDS, storage } from '../lib/storage/index.ts';
import * as store from '../lib/store.ts';
import type { MediaInfo, MediaMeta, Review, Version } from '../lib/types.ts';
import type { Broadcast } from './events.ts';
import { GUEST_PATH, queryOr } from './http.ts';

/** How soon a copy the full job queue had no room for is asked for again, and how long the wait may grow (tests lower it). */
export const COPY_RETRY = { firstMs: 5000, maxMs: 60_000 };

const BROWSER_CODECS = new Set(['h264', 'hevc', 'vp8', 'vp9', 'av1']);
const SCRUB_GOP = 10;
const AUDIO_COPY = new Set(['aac', 'mp3', 'opus', 'alac', 'ac3', 'eac3']);

function proxyArgs(src: string, out: string, meta: MediaMeta = {}): string[] {
  const color = meta.color_space ? ['-colorspace', meta.color_space, ...(meta.color_range ? ['-color_range', meta.color_range] : [])] : [];
  const audio = meta.audio?.codec && AUDIO_COPY.has(meta.audio.codec) ? ['-c:a', 'copy'] : ['-c:a', 'aac', '-b:a', '256k'];
  return [
    ...['-v', 'error', '-i', src, '-map', '0:v:0', '-map', '0:a:0?'],
    ...['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '14', '-g', String(SCRUB_GOP), '-keyint_min', String(SCRUB_GOP), '-sc_threshold', '0', '-bf', '0'],
    ...['-pix_fmt', 'yuv420p', ...color, '-fps_mode', 'passthrough', ...audio, '-movflags', '+faststart', '-y', out],
  ];
}

// Keep the proxy cache bounded: oldest first until under the cap.
const pruneProxies = (dir: string) => pruneDir(dir, 8e9, (f) => f.endsWith('.mp4'));

/** Bytes the player may be served: a storage key, and the local file when there is one on this disk. */
export interface Source {
  key: string;
  file: string | null;
}

/** Where a version plays from right now. `orig` is set when `main` is the scrub copy. */
export interface Playable {
  main: Source | null;
  orig?: Source;
  ready: boolean;
  preparing?: boolean;
  /** Its copy waits for room in the workspace's full job queue (lib/jobs.ts): asked for again by the server itself. */
  busy?: boolean;
  proxy?: boolean;
  scrub?: MediaInfo['scrub'];
  error?: string;
}

export interface Playback {
  playable(review: Review, ver: Version, opts?: { build?: boolean }): Playable;
  /**
   * A copy to hand out instead of the version's own bytes (review links that don't offer the original, "Preview"
   * downloads): the scrub copy, or the proxy of a codec browsers can't play. Made on demand whatever the render's
   * keyframe gaps; `preparing` until it exists. Never the original.
   */
  preview(review: Review, ver: Version): Playable;
  /** One URL, one set of bytes (the browser caches ranges per URL): the scrub proxy only behind ?s=1. */
  served(p: Playable, req: Request): Source;
  mediaQuery(ver: Version, p: Playable): string;
  mediaInfo(slug: string, ver: Version, p: Playable): MediaInfo;
}

// The longest keyframe gap is a property of the bytes, so it is kept on disk by hash: after a restart a render with
// short keyframe gaps plays natively right away, instead of being downloaded from remote storage to be probed again.
const gopFile = (hash: string) => path.join(cacheDir(), 'gop', `${hash}.json`);

export function createPlayback(broadcast: Broadcast): Playback {
  // Longest run of frames between keyframes, from packet flags only (no decoding).
  const gopMemo = new Map<string, number>();
  function knownGop(hash: string): number | undefined {
    const memo = gopMemo.get(wsKey(hash));
    if (memo !== undefined) return memo;
    try {
      const { gop } = JSON.parse(fs.readFileSync(gopFile(hash), 'utf8')) as { gop?: unknown };
      if (typeof gop === 'number' && Number.isInteger(gop) && gop > 0) {
        gopMemo.set(wsKey(hash), gop);
        return gop;
      }
    } catch {}
    return undefined;
  }
  async function maxGop(file: string, hash: string): Promise<number> {
    const memo = knownGop(hash);
    if (memo !== undefined) return memo;
    const { stdout } = await run(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'packet=flags', '-of', 'csv=p=0', file], {
      maxBuffer: 1 << 28,
    });
    let gap = 0;
    let worst = 0;
    for (const line of stdout.toString().split('\n')) {
      if (!line) continue;
      if (line.includes('K')) gap = 0;
      else worst = Math.max(worst, ++gap);
    }
    gopMemo.set(wsKey(hash), worst + 1);
    fs.mkdirSync(path.dirname(gopFile(hash)), { recursive: true });
    fs.writeFileSync(gopFile(hash), JSON.stringify({ gop: worst + 1 }));
    return worst + 1;
  }

  const proxyJobs = new Set<string>();
  const proxyFailed = new Set<string>();
  // Copies a full job queue had no room for, by key: asked for again by the server itself, after 5 s and then twice as
  // long each time up to a minute, and announced once when queued — never by every request that finds them missing
  // (each announcement made every open player ask again, and ask again: a refetch loop for as long as the queue was full).
  const waitingRoom = new Map<string, { delay: number; timer: NodeJS.Timeout }>();
  /** Whether there is room for the copy (a place kept for what a player waits on); if not, it waits for some. */
  function roomFor(key: string, build: () => void, slug: string): boolean {
    const k = wsKey(key);
    if (waitingRoom.has(k)) return false;
    if (jobRoom(undefined, { reserved: true })) return true;
    const later = (delay: number) => {
      const timer = setTimeout(
        boundToWorkspace(() => {
          if (!jobRoom(undefined, { reserved: true })) return later(Math.min(delay * 2, COPY_RETRY.maxMs));
          waitingRoom.delete(k);
          build();
          broadcast('review', { slug });
        }),
        delay,
      );
      timer.unref();
      waitingRoom.set(k, { delay, timer });
    };
    later(COPY_RETRY.firstMs);
    return false;
  }
  const waitsForRoom = (key: string): boolean => waitingRoom.has(wsKey(key));

  // Built on this disk, then handed to storage (remote stores upload it; locally it simply stays in cache/).
  function buildProxy(review: Review, ver: Version, key: string, { onlyIfLongGop }: { onlyIfLongGop: boolean }): boolean {
    if (proxyJobs.has(wsKey(key))) return true;
    if (proxyFailed.has(wsKey(key))) return false;
    if (!roomFor(key, () => buildProxy(review, ver, key, { onlyIfLongGop }), slugify(review.video))) return false;
    proxyJobs.add(wsKey(key));
    const out = storage().localPath(key);
    heavy(
      async () => {
        const file = await store.ensureVersionFile(review, ver.v);
        if (!file) throw new Error(`the bytes of v${ver.v} are gone`);
        if (onlyIfLongGop && (await maxGop(file, renderKey(ver))) <= 15) return;
        fs.mkdirSync(path.dirname(out), { recursive: true });
        // A scrub copy of a long render legitimately takes a while: 3 s of wall clock per second of video at least.
        await run(FFMPEG, proxyArgs(file, `${out}.tmp.mp4`, review.meta), { nice: 5, timeout: Math.max(MEDIA_TIMEOUT_MS, review.duration * 3000) });
        fs.renameSync(`${out}.tmp.mp4`, out);
        await storage().commit(key, 'video/mp4');
        pruneProxies(path.dirname(out));
      },
      PRIORITY.scrub,
      { reserved: true },
    )
      .then(
        () => true,
        (e: Error) => {
          if (e instanceof QueueFullError) return false; // not reached: room was asked for first
          proxyFailed.add(wsKey(key));
          fs.rmSync(`${out}.tmp.mp4`, { force: true });
          // the video removed while its scrub copy waited or ran (the sample during its warm-up): nothing to say
          if (store.loadReview(slugify(review.video))) console.error('proxy failed', e.message);
          return true;
        },
      )
      .then((ended) => {
        proxyJobs.delete(wsKey(key));
        if (ended) broadcast('review', { slug: slugify(review.video) });
      });
    return true;
  }

  // A partial render plays as the whole video it makes (lib/splice.ts), put together in the scrub copy's place.
  function buildSplice(review: Review, ver: Version, key: string): boolean {
    if (proxyJobs.has(wsKey(key))) return true;
    if (proxyFailed.has(wsKey(key))) return false;
    if (!roomFor(key, () => buildSplice(review, ver, key), slugify(review.video))) return false;
    proxyJobs.add(wsKey(key));
    heavy(() => ensureSplice(review, ver), PRIORITY.scrub, { reserved: true })
      .then(
        () => true,
        (e: Error) => {
          if (e instanceof QueueFullError) return false; // not reached: room was asked for first
          proxyFailed.add(wsKey(key));
          console.error('splice failed', e.message);
          return true;
        },
      )
      .then((ended) => {
        proxyJobs.delete(wsKey(key));
        if (ended) broadcast('review', { slug: slugify(review.video) });
      });
    return true;
  }
  /** A copy a player needs and doesn't have yet: being made, or waiting for room in the job queue. */
  const notYet = (key: string): Playable => ({ main: null, ready: false, preparing: true, ...(waitsForRoom(key) ? { busy: true } : {}) });
  function partPlayable(review: Review, ver: Version): Playable {
    const key = spliceKey(ver);
    if (storage().has(key)) return { main: copy(key), ready: true, scrub: 'ready' };
    if (proxyFailed.has(wsKey(key))) return { main: null, ready: false, error: 'this part could not be put together with the version it patches' };
    buildSplice(review, ver, key);
    return notYet(key);
  }

  const copy = (key: string): Source => {
    const file = storage().localPath(key);
    return { key, file: fs.existsSync(file) ? file : null };
  };
  const GONE: Playable = { main: null, ready: false, error: 'the bytes of this version are gone' };

  // A scrub proxy when ready, the version's own bytes meanwhile; ProRes & co. only play through their proxy.
  // Scrub copies are made for the latest render, and for older ones once they're played.
  function playable(review: Review, ver: Version, { build = ver.v === review.versions.at(-1)?.v } = {}): Playable {
    if (!store.versionAvailable(review, ver.v)) return GONE;
    if (ver.part) return partPlayable(review, ver);
    const s = storage();
    const src: Source = { key: store.versionKey(slugify(review.video), ver.v, path.extname(review.video)), file: store.versionFile(review, ver.v) };
    if (!BROWSER_CODECS.has(review.meta?.codec || 'h264')) {
      const key = `proxies/${renderKey(ver)}.mp4`;
      if (s.has(key)) return { main: copy(key), ready: true, proxy: true, scrub: 'ready' };
      buildProxy(review, ver, key, { onlyIfLongGop: false });
      return notYet(key);
    }
    const key = `scrub/${renderKey(ver)}.mp4`;
    if (s.has(key)) return { main: copy(key), orig: src, ready: true, scrub: 'ready' };
    const gop = knownGop(renderKey(ver));
    if (gop !== undefined && gop <= 15) return { main: src, ready: true, scrub: 'native' };
    if (!build || proxyFailed.has(wsKey(key))) return { main: src, ready: true, scrub: null };
    // the version's own bytes play meanwhile; only scrubbing waits for the copy
    if (!buildProxy(review, ver, key, { onlyIfLongGop: true })) return { main: src, ready: true, scrub: null, ...(waitsForRoom(key) ? { busy: true } : {}) };
    return { main: src, ready: true, scrub: 'building' };
  }

  // The scrub copy doubles as the preview: H.264 with every frame at its own time, so a client's player stays
  // frame-exact on it. A render with short keyframe gaps gets one too, just for handing out. Keyed like the player's
  // (renderKey: two renders can share a hash), so a render played and shared is transcoded and stored once.
  function preview(review: Review, ver: Version): Playable {
    if (ver.part || !BROWSER_CODECS.has(review.meta?.codec || 'h264')) return playable(review, ver, { build: true });
    if (!store.versionAvailable(review, ver.v)) return GONE;
    const key = `scrub/${renderKey(ver)}.mp4`;
    if (storage().has(key)) return { main: copy(key), ready: true, scrub: 'ready' };
    if (proxyFailed.has(wsKey(key))) return { main: null, ready: false, error: 'no preview of this version could be made' };
    buildProxy(review, ver, key, { onlyIfLongGop: false });
    return notYet(key);
  }

  // `?s=1`: the player asks for the scrub copy (mediaQuery below); anything else, the original when there is one
  const ScrubQuery = z.object({ s: z.string().max(4).optional() });
  const served = (p: Playable, req: Request): Source => (p.orig && queryOr(ScrubQuery, req)?.s !== '1' ? p.orig : (p.main as Source));
  const mediaQuery = (ver: Version, p: Playable): string => `?h=${renderKey(ver).slice(0, 10)}${p.scrub === 'ready' ? '&s=1' : ''}`;

  return {
    playable,
    preview,
    served,
    mediaQuery,
    mediaInfo: (slug, ver, p) => ({
      url: p.ready ? `/media/${encodeURIComponent(slug)}/v${ver.v}${mediaQuery(ver, p)}` : null,
      ready: p.ready,
      preparing: !!p.preparing,
      ...(p.busy ? { busy: true } : {}),
      proxy: !!p.proxy,
      scrub: p.scrub || null,
      error: p.error || null,
    }),
  };
}

/**
 * How long a signed URL handed out for this request lives: minutes on a review link's paths (renders, preview copies,
 * reference clips — whatever answers there), hours for the team (SIGNED_URL_SECONDS).
 */
const signedSeconds = (req: Request): number => (GUEST_PATH.test(req.baseUrl + req.path) ? SIGNED_URL_SECONDS.guest : SIGNED_URL_SECONDS.team);

/**
 * Answers a media request: a redirect to a signed storage/CDN URL when the store offers one (the video bytes then
 * never pass through this server), else the local file, fetched into the working copies first when needed.
 */
export async function sendMedia(req: Request, res: Response, src: Source, { immutable = false } = {}): Promise<void> {
  const url = storage().url(src.key, signedSeconds(req));
  if (url) {
    res.setHeader('Cache-Control', 'no-store');
    return res.redirect(302, url);
  }
  const file = src.file || (await storage().ensureLocal(src.key));
  if (!file) {
    res.status(410).json({ error: 'the bytes of this version are gone' });
    return;
  }
  streamFile(req, res, file, { immutable });
}

// HTTP range streaming with bounded chunks: the browser asks for the rest when it needs it, so a paused video never
// pins one of the 6 HTTP/1.1 connections per host (the SSE stream already takes one per tab).
// `cache`: the Cache-Control to send instead (a signed URL is good until it ends).
export function streamFile(req: Request, res: Response, file: string, { immutable = false, cache }: { immutable?: boolean; cache?: string } = {}): void {
  const st = fs.statSync(file);
  const ext = path.extname(file).toLowerCase();
  res.setHeader('Content-Type', ext === '.webm' ? 'video/webm' : ext === '.mkv' ? 'video/x-matroska' : ext === '.m4a' ? 'audio/mp4' : 'video/mp4');
  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Cache-Control', cache ?? (immutable ? 'private, max-age=31536000, immutable' : 'no-cache'));
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (!range) {
    res.setHeader('Content-Length', st.size);
    fs.createReadStream(file).pipe(res);
    return;
  }
  let start = range[1] === '' ? st.size - Number(range[2]) : Number(range[1]);
  let end = range[1] !== '' && range[2] !== '' ? Number(range[2]) : st.size - 1;
  start = Math.max(0, start);
  end = Math.min(end, st.size - 1, start + 8 * 1024 * 1024 - 1);
  if (start > end || start >= st.size) {
    res.status(416).setHeader('Content-Range', `bytes */${st.size}`);
    res.end();
    return;
  }
  res.status(206);
  res.setHeader('Content-Range', `bytes ${start}-${end}/${st.size}`);
  res.setHeader('Content-Length', end - start + 1);
  fs.createReadStream(file, { start, end }).pipe(res);
}
