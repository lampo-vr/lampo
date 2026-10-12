// How the MCP tools say things: tool results, the text an agent reads about a video and its notes, downscaled frames
// for the model to look at, and the small parsers the tools share.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { CallToolResult, McpServer, ServerContext } from '@modelcontextprotocol/server';
import { cacheRoot } from '../lib/backend/credentials.ts';
import type { Backend } from '../lib/backend/types.ts';
import { describeShape } from '../lib/drawing.ts';
import { onWords } from '../lib/elements.ts';
import { cursorAt, nothingWaitingLine, putUpNextLine, riding, stillOpenLine, waitNowLine, workLeft } from '../lib/handoff.ts';
import { fixWaits, ridingFlag } from '../lib/handover.ts';
import { SAMPLE_FOR_AGENTS } from '../lib/onboarding.ts';
import { optionLines } from '../lib/options.ts';
import { partLine, partOk, partOkWords } from '../lib/part.ts';
import { cacheDir } from '../lib/paths.ts';
import { describePreview, projectPosition } from '../lib/previews.ts';
import { FFMPEG, run } from '../lib/probe.ts';
import { FRAME_CACHE_BYTES, pruneDir } from '../lib/prune.ts';
import { describeRange, stripFrames } from '../lib/range.ts';
import { describeRef } from '../lib/refLine.ts';
import { type GrabCount, renderMarked, TooManyGrabsError } from '../lib/shots.ts';
import { counts, describeSource } from '../lib/store.ts';
import { CLIENT_NOTE_FLAG, instant, isAgent, isClient, keepLines, noteLabel, oneLine, parseFramePosition, timeToFrame } from '../lib/time.ts';
import { textEditLine } from '../lib/transcript.ts';
import type { AskView, Comment, NotePointer, Rect, Review, Shape, StageInfo, Version } from '../lib/types.ts';

type Content = CallToolResult['content'][number];
/** A tool's text: its lines are ours, and nothing that came in with a name or a note starts one (`keepLines`). */
export const text = (t: string): Content => ({ type: 'text', text: keepLines(t) });
export const ok = (...content: (Content | Content[])[]): CallToolResult => ({ content: content.flat() });
export const fail = (msg: string): CallToolResult => ({ content: [text(`Error: ${msg}`)], isError: true });

/** The agents' inbox (INBOX.md) and one video's review (review.md), as MCP resources. */
export const INBOX_URI = 'lampo://inbox';
export const reviewUri = (slug: string): string => `lampo://review/${encodeURIComponent(slug)}`;
/** The same under the scheme they had before the command was `lampo`: still read, still told about, not listed. */
export const OLD_INBOX_URI = 'vr://inbox';
export const oldReviewUri = (slug: string): string => `vr://review/${encodeURIComponent(slug)}`;
/** Every address a change is announced under (a client hears only those it subscribed to): the inbox, the video. */
export const changedUris = (slug?: string | null): string[] => [INBOX_URI, OLD_INBOX_URI, ...(slug ? [reviewUri(slug), oldReviewUri(slug)] : [])];

/**
 * The last line of an answer that hands something to the person (a render put up): wait now, with a cursor from this
 * moment (lib/handoff.ts). The log is read before the clock: an event of this second that lands meanwhile is heard.
 */
export async function handOff(b: Backend): Promise<string> {
  return waitNowLine(await cursorNow(b));
}

/** A cursor for this moment: the log is read before the clock, so an event of this second that lands meanwhile is heard. */
async function cursorNow(b: Backend): Promise<string> {
  const events = await b.events(200, { since: new Date(Date.now() - 2000).toISOString() });
  return cursorAt(events, Date.now());
}

// Answers that leave the agent with nothing to do: the toolkit ends them with the next step (mcp/toolkit.ts), unless a
// line about its run says more (the person stopped it, or sent notes meanwhile).
const idleAnswers = new WeakSet<CallToolResult>();
/** Marks an answer as leaving nothing to do (a list with nothing open, a video with no note open). */
export const idle = (r: CallToolResult): CallToolResult => {
  idleAnswers.add(r);
  return r;
};
export const isIdle = (r: CallToolResult): boolean => idleAnswers.has(r);
/** The next step after such an answer: put up any version, then wait, from this moment (lib/handoff.ts). */
export const nextStep = async (b: Backend): Promise<string> => nothingWaitingLine(await cursorNow(b));

/**
 * After an agent hands something to the person (a note fixed or left as it is, a reply, a question, options to pick, a
 * fix's preview): how many notes it still has to work on the video, or — none, or no video — wait now. A note it
 * answered waits for the person, so it isn't work left (lib/handoff.ts workLeft): after its last answer it waits,
 * rather than ending its turn with the person's answer coming in where nobody listens.
 */
export async function afterHandBack(b: Backend, slug: string | null): Promise<string> {
  const comments = slug ? (await b.review(slug)).comments : [];
  const left = workLeft(comments);
  if (left) return stillOpenLine(left);
  // fixes marked before their version: the version comes first, and its answer says to wait
  const ride = riding(comments);
  return ride ? putUpNextLine(ride) : handOff(b);
}

/** The MCP client's name: per request on 2026-07-28 (`_meta` envelope), from the initialize handshake on 2025. */
export function clientName(server: McpServer, ctx: ServerContext): string {
  const envelope = ctx.mcpReq.envelope as Record<string, unknown> | undefined;
  const info = envelope?.['io.modelcontextprotocol/clientInfo'] as { name?: string } | undefined;
  return info?.name || server.server.getClientVersion()?.name || 'mcp';
}

export function pickVersion(review: Review, v: number | undefined): Version {
  const ver = v ? review.versions.find((x) => x.v === v) : review.versions.at(-1);
  if (!ver) throw new Error(`no v${v}`);
  return ver;
}

/**
 * A position given as frame, timecode (mm:ss:ff, ;ff drop-frame) or seconds, as a frame number; null when none was
 * given. A timecode that isn't one is refused by name, never read as the frame its first numbers happen to name.
 */
export function framePosition(args: { frame?: number; timecode?: string; seconds?: number }, fps: number): number | null {
  if (Number.isInteger(args.frame)) return args.frame as number;
  if (args.timecode) {
    const frame = parseFramePosition(String(args.timecode), fps);
    if (frame === null)
      throw new Error(`bad position "${oneLine(String(args.timecode)).slice(0, 40)}": timecode mm:ss:ff or h:mm:ss:ff (;ff drop-frame at 29.97/59.94 fps)`);
    return frame;
  }
  if (args.seconds !== undefined && Number.isFinite(args.seconds)) return timeToFrame(args.seconds, fps);
  return null;
}

// Downscaled JPEG for the model to look at (the full-res PNGs stay on disk; coordinates are always video px). Without
// ffmpeg on this machine (a remote setup), the PNG goes as it is. `crop` (in the picture's pixels) cuts a part out
// first, and the long edge is then at most `width`.
export async function preview(b: Backend, src: string, width: number, crop?: Rect): Promise<{ type: 'image'; data: string; mimeType: string }> {
  const st = fs.statSync(src);
  const cut = crop ? `${crop.w}:${crop.h}:${crop.x}:${crop.y}` : '';
  const key = crypto.createHash('sha1').update(`${src}|${st.size}|${st.mtimeMs}|${width}|${cut}`).digest('hex').slice(0, 20);
  const out = path.join(b.kind === 'remote' ? cacheRoot() : cacheDir(), 'mcp', `${key}.jpg`);
  const scale = crop && crop.h > crop.w ? `scale=-2:'min(${width},ih)'` : `scale='min(${width},iw)':-2`;
  try {
    if (!fs.existsSync(out)) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // an agent waits for it: an on-demand place (when the server is busy, the picture as it is, below)
      await run(FFMPEG, ['-v', 'error', '-i', src, '-vf', crop ? `crop=${cut},${scale}` : scale, '-q:v', '4', '-y', `${out}.tmp.jpg`], {
        onDemand: true,
        timeout: 60_000,
      });
      fs.renameSync(`${out}.tmp.jpg`, out);
    }
    return { type: 'image', data: fs.readFileSync(out).toString('base64'), mimeType: 'image/jpeg' };
  } catch {
    return { type: 'image', data: fs.readFileSync(src).toString('base64'), mimeType: 'image/png' };
  }
}
export const previewWidth = (v: { width?: number; height?: number }): number => ((v.width || 1080) > (v.height || 1920) ? 960 : 540);

/** The long edge of a marked frame cropped to its drawing: the area meant at about the scale of a whole downscaled frame. */
export const CROP_EDGE = 512;
/** The width of a range's strip and of a reference's picture: as wide as a landscape frame (previewWidth). */
const PICTURE_EDGE = 960;

/**
 * The part of a w×h frame a drawing is about, in video px: the drawing's bounds with as much room again around them,
 * at least 40 % of the frame's short side and never thinner than half as wide as tall (or the reverse); null when
 * that is most of the frame anyway (then the whole frame is the picture).
 */
export function cropAround(drawing: Shape[] | null | undefined, w: number, h: number): Rect | null {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const s of drawing || []) {
    const pts: number[][] =
      s.type === 'box'
        ? [
            [s.x, s.y],
            [s.x + s.w, s.y + s.h],
          ]
        : s.type === 'arrow'
          ? [
              [s.x1, s.y1],
              [s.x2, s.y2],
            ]
          : s.points;
    for (const [x, y] of pts) {
      xs.push(x);
      ys.push(y);
    }
  }
  if (!xs.length || !(w > 0 && h > 0)) return null;
  const x0 = Math.max(0, Math.min(...xs));
  const x1 = Math.min(w, Math.max(...xs));
  const y0 = Math.max(0, Math.min(...ys));
  const y1 = Math.min(h, Math.max(...ys));
  const least = 0.4 * Math.min(w, h);
  let cw = Math.max(2 * (x1 - x0), least);
  let ch = Math.max(2 * (y1 - y0), least);
  cw = Math.min(w, Math.max(cw, ch / 2));
  ch = Math.min(h, Math.max(ch, cw / 2));
  if (cw * ch > 0.7 * w * h) return null;
  const at = (mid: number, size: number, max: number) => Math.round(Math.min(Math.max(0, mid - size / 2), max - size));
  return { x: at((x0 + x1) / 2, cw, w), y: at((y0 + y1) / 2, ch, h), w: Math.round(cw), h: Math.round(ch) };
}

// Width and height of a PNG from its header (the marked frames are PNGs at the render's size); null for anything else.
function pngSize(file: string): { w: number; h: number } | null {
  const buf = Buffer.alloc(24);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, buf, 0, 24, 0);
  } finally {
    fs.closeSync(fd);
  }
  return buf.subarray(1, 4).toString('latin1') === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) } : null;
}

/**
 * A screenshot a note should have and hasn't (not made yet, or gone), said rather than left out: the agent knows to
 * look at the frame itself. Nothing for a note about the whole video (it has no moment, so no screenshot).
 */
export function missingShot(c: Comment, kind: 'marked' | 'clean' = 'marked'): Content[] {
  if (c.scope === 'video') return [];
  return [text(oneLine(`${c.id} f${c.frame} v${c.v} ${kind} frame: missing (not made yet, or gone); get_frame v ${c.v} frame ${c.frame} shows the frame`))];
}

/** A note's moment on version `ver`: the same time (by its own version's fps); null without a moment, or past the end. */
export function momentOn(review: Review, c: Comment, ver: Version): number | null {
  if (c.scope === 'video') return null;
  const own = review.versions.find((x) => x.v === c.v);
  const frame = !own || own.fps === ver.fps ? c.frame : timeToFrame(c.t, ver.fps);
  return frame >= 0 && frame < ver.frames ? frame : null;
}

/** A drawing made on a `from`-sized version, where it lies on a `to`-sized one (the same place in the picture). */
export function scaledDrawing(drawing: Shape[] | null | undefined, from: { w: number; h: number }, to: { w: number; h: number }): Shape[] {
  const kx = from.w > 0 ? to.w / from.w : 1;
  const ky = from.h > 0 ? to.h / from.h : 1;
  if (kx === 1 && ky === 1) return [...(drawing || [])];
  const r = (n: number) => Math.round(n * 10) / 10;
  return (drawing || []).map((s): Shape => {
    if (s.type === 'box') return { ...s, x: r(s.x * kx), y: r(s.y * ky), w: r(s.w * kx), h: r(s.h * ky) };
    if (s.type === 'arrow') return { ...s, x1: r(s.x1 * kx), y1: r(s.y1 * ky), x2: r(s.x2 * kx), y2: r(s.y2 * ky) };
    return { ...s, points: s.points.map(([x, y]) => [r(x * kx), r(y * ky)] as [number, number]) };
  });
}

/** A note's spot on a version as a file (spotFile): the frame, the drawing laid over it, or why there is none. */
export type Spot = { file: string; frame: number; drawing: Shape[]; laid: boolean } | { why: string; frame: number | null };

/**
 * A note's spot on version `ver`: its moment there (or `frame`) with a drawing laid over it — the note's own, scaled to
 * that version ("same spot"), or one a person made on that version (`drawing`: a Still wrong's). Made on demand: the
 * frame through the caller's frame budget (counted like get_frame's, cached), the drawing laid over in the cache
 * (ffmpeg on demand), nothing in versions/.
 */
export async function spotFile(
  b: Backend,
  review: Review,
  c: Comment,
  ver: Version,
  o: { drawing?: Shape[]; frame?: number; count?: GrabCount | null } = {},
): Promise<Spot> {
  const frame = o.frame !== undefined && o.frame >= 0 && o.frame < ver.frames ? o.frame : momentOn(review, c, ver);
  if (frame === null) return { why: c.scope === 'video' ? 'the note is about the whole video' : `past the end of v${ver.v}`, frame };
  let png: string;
  try {
    png = await b.frame(review, ver, frame, { count: o.count });
  } catch (e) {
    return { why: e instanceof TooManyGrabsError ? e.message : 'its frame could not be grabbed', frame };
  }
  const own = review.versions.find((x) => x.v === c.v) ?? ver;
  const drawing = o.drawing ? [...o.drawing] : scaledDrawing(c.drawing, { w: own.width, h: own.height }, { w: ver.width, h: ver.height });
  if (!drawing.length) return { file: png, frame, drawing, laid: true };
  const key = crypto
    .createHash('sha1')
    .update(`${png}|${ver.width}x${ver.height}|${JSON.stringify(drawing)}`)
    .digest('hex')
    .slice(0, 20);
  const out = path.join(b.kind === 'remote' ? cacheRoot() : cacheDir(), 'mcp', 'spots', `${key}.png`);
  try {
    if (!fs.existsSync(out)) {
      fs.mkdirSync(path.dirname(out), { recursive: true });
      await renderMarked(png, drawing, ver.width, ver.height, out);
      pruneDir(path.dirname(out), FRAME_CACHE_BYTES / 4, (f) => f.endsWith('.png') && f !== path.basename(out));
    }
    return { file: out, frame, drawing, laid: true };
  } catch {
    return { file: png, frame, drawing, laid: false };
  }
}

/**
 * A note's spot on version `ver` for the model (spotFile), cropped as the marked frame is, so the two sit side by side
 * at one scale: "c_… f20 v3 same spot, cropped: …". When it can't be made, a line says why: never left out silently.
 */
export async function spotPicture(
  b: Backend,
  review: Review,
  c: Comment,
  ver: Version,
  o: { what: string; drawing?: Shape[]; frame?: number; count?: GrabCount | null } = { what: 'same spot' },
): Promise<Content[]> {
  const spot = await spotFile(b, review, c, ver, o);
  if ('why' in spot) {
    if (spot.frame === null) return [text(oneLine(`${c.id} v${ver.v} ${o.what}: none (${spot.why})`))];
    return [text(oneLine(`${c.id} f${spot.frame} v${ver.v} ${o.what}: not made now (${spot.why}); get_frame v ${ver.v} frame ${spot.frame} later`))];
  }
  const at = `${c.id} f${spot.frame} v${ver.v} ${o.what}${spot.laid ? '' : ' (the drawing could not be laid over: its place is in the note)'}`;
  const px = pngSize(spot.file);
  const area = cropAround(spot.drawing, ver.width, ver.height);
  if (!area)
    return [
      text(`${at}, whole frame (downscaled; coordinates stay in video px)`),
      await preview(b, spot.file, Math.round(CROP_EDGE * 1.25), px ? { x: 0, y: 0, ...px } : undefined),
    ];
  const k = px && ver.width ? px.w / ver.width : 1;
  const crop = { x: Math.round(area.x * k), y: Math.round(area.y * k), w: Math.round(area.w * k), h: Math.round(area.h * k) };
  return [
    text(`${at}, cropped: x${area.x}–${area.x + area.w} y${area.y}–${area.y + area.h} of ${ver.width}×${ver.height}`),
    await preview(b, spot.file, CROP_EDGE, crop),
  ];
}

/**
 * A note's marked frame for the model, cropped to its drawing (the whole frame when the drawing covers most of it),
 * with a line saying which part of the frame it is in video px. A line instead when the screenshot is missing.
 */
export async function markedPicture(b: Backend, review: Review, c: Comment): Promise<Content[]> {
  const f = b.shotFile(review, c.shots?.marked);
  if (!f || !fs.existsSync(f)) return missingShot(c);
  const ver = review.versions.find((x) => x.v === c.v);
  const W = ver?.width || review.width;
  const H = ver?.height || review.height;
  const area = cropAround(c.drawing, W, H);
  const at = `${c.id} f${c.frame} v${c.v} marked`;
  const px = pngSize(f);
  if (!area) {
    // The whole frame, a little larger than a crop so text in it stays readable.
    const whole = px ? { x: 0, y: 0, w: px.w, h: px.h } : undefined;
    return [text(`${at}, whole frame (downscaled; coordinates stay in video px)`), await preview(b, f, Math.round(CROP_EDGE * 1.25), whole)];
  }
  const k = px && W ? px.w / W : 1;
  const crop = { x: Math.round(area.x * k), y: Math.round(area.y * k), w: Math.round(area.w * k), h: Math.round(area.h * k) };
  return [text(`${at}, cropped: x${area.x}–${area.x + area.w} y${area.y}–${area.y + area.h} of ${W}×${H}`), await preview(b, f, CROP_EDGE, crop)];
}

/** When a note last changed (ms): written, edited, answered or given a reference or a fix preview. */
export function changedAt(c: Comment): number {
  const times = [c.created, c.edited, ...(c.replies || []).map((r) => r.at), ...(c.refs || []).map((r) => r.at), ...(c.previews || []).map((p) => p.at)];
  return Math.max(...times.map(instant));
}

/** A note whose screenshots carry the usual names (<id>_marked.png, …): lists name them once, in screenshotsLine. */
const usualShots = (c: Comment): boolean =>
  (!c.shots?.marked || c.shots.marked === `${c.id}_marked.png`) &&
  (!c.shots?.clean || c.shots.clean === `${c.id}_clean.png`) &&
  (!c.shots?.range || c.shots.range === `${c.id}_range.jpg`);

/** Where a list's screenshots are, said once instead of on every note ('' when the backend keeps none). */
export function screenshotsLine(b: Backend, review: Review): string {
  const any = b.shotFile(review, '-');
  return any ? `\nscreenshots: ${path.dirname(any)}/<id>_marked.png, <id>_clean.png, <id>_range.jpg (a range)` : '';
}

/**
 * One note as an agent reads it. `full` (get_note): every reply, each screenshot's path, where each reference file is.
 * A list keeps the last two replies and leaves the paths to screenshotsLine (and get_note). `files: false` names no
 * file at all: a client elsewhere can't open paths on this server's disk (and must not learn them).
 */
export function noteLines(
  b: Backend,
  review: Review,
  c: Comment,
  { full = false, files = true, pointer }: { full?: boolean; files?: boolean; pointer?: NotePointer } = {},
): string {
  const L: string[] = [];
  const flags: string[] = [];
  if (c.check_again) flags.push(`CHECK AGAIN in v${c.carried_to}`);
  if (c.status === 'fixed') flags.push(`fixed in v${c.fixed_in_v}`);
  if (c.verified_on) flags.push(`verified on preview ${c.verified_on.preview}: the next render must contain it`);
  if (c.scope === 'video') flags.push('OVERALL: about the whole video, not frame 0');
  if (isAgent(c.author)) flags.push(`by ${c.author}`);
  if (isClient(c.author)) flags.push(CLIENT_NOTE_FLAG);
  // newer flags after the ones agents know (append, never reword: .claude/rules/agent-text.md)
  if (fixWaits(c)) flags.push(ridingFlag(review.versions));
  L.push(
    `${c.id} ${c.status.toUpperCase()} ${noteLabel(c)} ${c.timecode} f${c.frame}${c.range ? ` range ${c.range.in}-${c.range.out}` : ''} v${c.v} [${(c.tags || []).join(',') || '-'}]${flags.length ? ` · ${flags.join(' · ')}` : ''}${onWords(pointer)}${partOkWords(partOk(review.versions, c))}`,
  );
  L.push(`  ${c.text || (c.text_edit ? '(a change to the words, below)' : '(no text, see marked frame)')}`);
  const fps = review.versions.find((x) => x.v === c.v)?.fps || review.fps;
  if (c.text_edit) L.push(`  ${textEditLine(c.text_edit, c, fps)}`);
  if (c.part && c.status === 'open') L.push(`  ${partLine(c.part)}`);
  // A change to the words names its stretch already.
  if (c.range && !(c.text_edit && !full)) L.push(`  range: ${describeRange(c.range, fps)}`);
  const project = projectPosition(review, c);
  if (project) L.push(`  project: ${project}`);
  for (const s of c.drawing || []) L.push(`  drawing: ${describeShape(s)} (video px)`);
  if (c.voice?.transcript && c.voice.transcript !== c.text) L.push(`  voice: ${c.voice.transcript}`);
  if (c.source === 'recording')
    L.push(`  recorded: said while watching${full && files && c.voice?.file ? ` · voice clip: ${b.shotFile(review, c.voice.file)}` : ''}`);
  if (c.choices?.length) L.push(`  choices offered: ${c.choices.join(' | ')}`);
  for (const l of optionLines(c.options || [])) L.push(`  ${l}`);
  if (c.options?.length && c.status === 'open') L.push(`  the reviewer auditions and picks in Lampo: the answer comes as PICKED <group>=<item> …`);
  if (files && (full || !usualShots(c))) {
    if (c.shots?.marked) L.push(`  marked: ${b.shotFile(review, c.shots.marked)}`);
    if (c.shots?.clean) L.push(`  clean:  ${b.shotFile(review, c.shots.clean)}`);
    if (c.shots?.range) L.push(`  range frames (first … last): ${b.shotFile(review, c.shots.range)}`);
  }
  const replies = c.replies || [];
  if (!full && replies.length > 2) L.push(`  ↳ (${replies.length - 2} earlier repl${replies.length === 3 ? 'y' : 'ies'}: get_note)`);
  for (const r of full ? replies : replies.slice(-2))
    L.push(
      `  ↳ ${r.by}${r.status ? ` [${r.status}${r.fixed_in_v ? ` v${r.fixed_in_v}` : ''}]` : ''}: ${r.text || '-'}${r.edited ? ' (edited)' : ''}${r.on_v ? ` · still wrong in v${r.on_v}${r.drawing?.length ? ', drawn on it' : ''}` : ''}`,
    );
  for (const p of c.previews || []) L.push(`  preview ${describePreview(p)}`);
  for (const r of c.refs || []) {
    const where = full && files ? r.file || r.still : null;
    L.push(`  ref ${describeRef(r)}${where ? ` · ${b.refLocation(review, where)}` : ''}`);
  }
  // One line per entry: what people wrote can't start a note of its own.
  return L.map(oneLine).join('\n');
}

/** A question asked on a folder before any render (lib/asks.ts), as get_note says it: its options and its answers. */
export function askLines(a: AskView): string {
  const L = [
    `${a.id} ${a.status.toUpperCase()} QUESTION · folder ${a.folder ?? '-'} (no video yet)${isAgent(a.author) ? ` · by ${a.author}` : ''}`,
    `  ${a.text}`,
    ...optionLines(a.options).map((l) => `  ${l}`),
  ];
  if (a.status === 'open') L.push('  the reviewer auditions and picks in Lampo: the answer comes as PICKED <group>=<item> …');
  for (const r of a.replies) L.push(`  ↳ ${r.by}${r.status ? ` [${r.status}]` : ''}: ${r.text || '-'}`);
  return L.map(oneLine).join('\n');
}

/**
 * A range note's frames across its range (first … last) as one picture with its label, so a model sees the motion
 * the note is about; nothing for a note without a range (or when the picture is gone).
 */
export async function rangePicture(b: Backend, review: Review, c: Comment): Promise<Content[]> {
  if (!c.range || !c.shots?.range) return [];
  const f = b.shotFile(review, c.shots.range);
  if (!f || !fs.existsSync(f)) return [];
  const fps = review.versions.find((x) => x.v === c.v)?.fps || review.fps;
  const frames = stripFrames(c.range).map((x) => `f${x}`);
  return [
    text(`${c.id} · range ${describeRange(c.range, fps)} · frames across it, left to right, row by row: ${frames.join(', ')}`),
    await preview(b, f, PICTURE_EDGE),
  ];
}

/**
 * What a note's references look like, for the model: an image or a moment as its still (a range: first and last
 * frame), a clip as six moments in one picture; links stay text (in noteLines). At most `max` pictures.
 */
export async function refPictures(b: Backend, review: Review, c: Comment, max = 8): Promise<Content[]> {
  const out: Content[] = [];
  let n = 0;
  for (const r of c.refs || []) {
    if (r.kind === 'link' || n >= max) continue;
    const files = r.kind === 'clip' ? [r.strip] : r.kind === 'frame' ? [r.still, r.end] : [r.still];
    const label =
      r.kind === 'clip'
        ? `${r.id}: six moments of the ${r.duration?.toFixed(1)} s clip (play it: ${r.file ? b.refLocation(review, r.file) : '-'})`
        : r.kind === 'frame'
          ? `${r.id}: ${r.name} v${r.v} at ${r.timecode} (f${r.frame})${r.to_frame !== undefined ? `, then its last frame f${r.to_frame}` : ''}`
          : `${r.id}: reference image${r.caption ? ` — "${r.caption}"` : ''}`;
    // A caption is a person's words (a client's, on a review link): on its line only.
    out.push(text(oneLine(label)));
    for (const f of files) {
      if (!f || n >= max) continue;
      const local = await b.refFile(review, f);
      if (!local) continue;
      out.push(await preview(b, local, PICTURE_EDGE));
      n++;
    }
  }
  return out;
}

/** `legend`: the elements the listed notes point at, with their names (one line, lib/elements.ts legendLine). */
export function header(review: Review, stage?: StageInfo, legend = ''): string {
  const n = counts(review);
  const latest = review.versions.at(-1);
  return [
    ...(review.onboarding_sample ? [SAMPLE_FOR_AGENTS] : []),
    `${review.video}${review.missing ? '  (FILE MISSING)' : ''}`,
    `${review.folder ? `folder ${review.folder} · ` : ''}project ${review.project} · v${latest?.v} · ${review.width}×${review.height} · ${review.fps} fps · ${review.frames} frames · ${review.duration}s`,
    `session ${review.session?.name || '-'} · open ${n.open} (must ${n.must}) · fixed ${n.fixed} · verified ${n.verified} · wontfix ${n.wontfix}${n.ideas ? ` · ideas ${n.ideas}` : ''}${n.questions ? ` · questions ${n.questions}` : ''}`,
    ...(stage ? [`stage ${stage.stage} · ${stage.detail}${stage.stage === 'final' ? ' · final: fix nothing until the reviewer reopens it' : ''}`] : []),
    ...(latest?.source ? [`rendered from ${describeSource(latest.source)}`] : []),
    `Frames are 0-based at the file fps; timecode is mm:ss:ff; drawings are in video pixels.`,
    ...(legend ? [legend] : []),
  ]
    .map(oneLine)
    .join('\n');
}

/** A line telling an agent which playbook applies to a video (and its revisions); '' when none does. */
export async function playbookPointer(b: Backend, review: Review): Promise<string> {
  const stamp = await b.playbookStamp(review.folder || null).catch(() => []);
  if (!stamp.length) return '';
  return `\n${oneLine(`playbook ${stamp.map((s) => `${s.scope || 'House'} r${s.rev}`).join(' · ')} · read it before you render: get_playbook`)}`;
}

/** A final video is done: agents fix nothing on it until someone reopens it (docs/workflow.md). */
export function finalNotice(stage: StageInfo, review: Review): string | null {
  if (stage.stage !== 'final' || !stage.final) return null;
  return oneLine(
    `${review.video.split('/').pop()} is final (v${stage.final.v}, by ${stage.final.by})${stage.final_superseded ? `, v${stage.final_superseded} arrived since` : ''}`,
  );
}
