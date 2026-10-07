// A bundle: one store's reviews moved to another (docs/moving.md). `lampo export` writes it on the machine it comes from
// (lib/bundleExport.ts), `lampo admin import` reads it on the server it goes to (lib/bundleImport.ts). It is a tar
// (lib/tar.ts) whose first file is manifest.json — every other file listed there with its size and sha256 — and whose
// names are ours, never a path or a slug of the machine it came from:
//   manifest.json
//   reviews/<key>/review.json               the review as the server will hold it (upload-style video, no paths)
//   reviews/<key>/views.json                the team's watching (lib/views.ts)
//   reviews/<key>/files/<name>              screenshots and voice clips (c_<id>_clean.png, c_<id>.m4a …)
//   reviews/<key>/refs/<file>               references and options' files (r_<id>….png|jpg|webp|mp4|m4a)
//   reviews/<key>/previews/<file>           fix previews (p_<id>.png|jpg|webp|mp4)
//   reviews/<key>/versions/v<N><ext>        each version's bytes as they arrived
//   playbooks/<key>/playbook.json           a playbook, and its files under playbooks/<key>/files/skills|refs/…
//   folders.json                            the folder tree ({ folders: [...] })
//   events.jsonl                            the reviews' history (what the inbox and agents' feeds read)
// People travel as names. An account id becomes `owner` (the account the bundle came from: the machine's owner) or
// `person:<n>` (another account, named in the manifest); the import maps them to accounts of the server.
// Everything here is read as coming from outside: strict schemas (an unknown field refuses the bundle), bounded
// strings and lists, names of files by pattern.
import { z } from 'zod';
import { OPTION_LIMITS } from './options.ts';
import { PLAYBOOK_LIMITS, SKILL_FILE } from './playbookText.ts';
import { PREVIEW_LIMITS } from './previews.ts';
import { REF_LIMITS } from './refs.ts';

export const BUNDLE_FORMAT = 'lampo-bundle';
export const BUNDLE_VERSION = 1;
export const MANIFEST = 'manifest.json';

/** Keys of the bundle's own folders: what a review or playbook is called inside the tar. */
export const REVIEW_KEY = /^r\d{4,6}$/;
export const PLAYBOOK_KEY = /^p\d{3,5}$/;
/** A person an account id became: the account the bundle came from, or another one named in the manifest. */
export const PERSON = /^(owner|person:\d{1,6})$/;

/** Files of a note that live next to its review.json: screenshots and the voice clip. */
export const NOTE_FILE = /^c_[a-f0-9]{4,16}(_clean\.png|_marked\.png|_range\.jpg|\.m4a)$/;
/** A reference's (or an option's) files, as lib/refs.ts names them. */
export const REF_FILE = /^r_[a-f0-9]{10}(\.[tse])?\.(png|jpg|webp|mp4|m4a)$/;
/** A fix preview's file (lib/previews.ts). */
export const PREVIEW_FILE = /^p_[a-f0-9]{10}\.(png|jpg|webp|mp4)$/;
/** A version's bytes: v<N> and the video's extension. */
export const VERSION_FILE = /^v([1-9]\d{0,5})\.(mp4|mov|m4v|webm|mkv)$/i;
const SKILL_ID = /^sk_[a-f0-9]{6,24}$/;

/** The largest of each kind of file a bundle may carry (`versions`: the server's upload limit, given at import). */
export const BUNDLE_LIMITS = {
  manifest: 64 * 1024 * 1024,
  json: 64 * 1024 * 1024,
  // read as one string: below V8's longest (2^29 - 24 characters; 512 MiB was past it, a RangeError, not a refusal)
  events: 500 * 1024 * 1024,
  /** Every record (review.json, views, playbooks, folders, events) of one bundle together: held in memory to be parsed. */
  records: 1024 * 1024 * 1024,
  noteFile: 64 * 1024 * 1024,
  ref: Math.max(REF_LIMITS.clipBytes, REF_LIMITS.imageBytes, REF_LIMITS.audioBytes),
  preview: PREVIEW_LIMITS.uploadBytes,
  playbookFile: Math.max(PLAYBOOK_LIMITS.fileBytes, REF_LIMITS.imageBytes),
  reviews: 100_000,
  files: 1_000_000,
  eventLines: 5_000_000,
  playbooks: 10_000,
  folders: 100_000,
} as const;

/** What kind of file a name in the tar is, and whose. */
export type BundlePart =
  | { kind: 'manifest' }
  | { kind: 'folders' }
  | { kind: 'events' }
  | { kind: 'review'; key: string }
  | { kind: 'views'; key: string }
  | { kind: 'file'; key: string; name: string }
  | { kind: 'ref'; key: string; name: string }
  | { kind: 'preview'; key: string; name: string }
  | { kind: 'version'; key: string; name: string; v: number }
  | { kind: 'playbook'; key: string }
  | { kind: 'skillFile'; key: string; skill: string; name: string }
  | { kind: 'playbookRef'; key: string; name: string };

/** The part a tar name is, or null for a name no bundle holds. */
export function bundlePart(name: string): BundlePart | null {
  if (name === MANIFEST) return { kind: 'manifest' };
  if (name === 'folders.json') return { kind: 'folders' };
  if (name === 'events.jsonl') return { kind: 'events' };
  const p = name.split('/');
  if (p[0] === 'reviews' && REVIEW_KEY.test(p[1] ?? '')) {
    const key = p[1] as string;
    if (p.length === 3 && p[2] === 'review.json') return { kind: 'review', key };
    if (p.length === 3 && p[2] === 'views.json') return { kind: 'views', key };
    if (p.length === 4) {
      const n = p[3] as string;
      if (p[2] === 'files' && NOTE_FILE.test(n)) return { kind: 'file', key, name: n };
      if (p[2] === 'refs' && REF_FILE.test(n)) return { kind: 'ref', key, name: n };
      if (p[2] === 'previews' && PREVIEW_FILE.test(n)) return { kind: 'preview', key, name: n };
      const v = VERSION_FILE.exec(n);
      if (p[2] === 'versions' && v) return { kind: 'version', key, name: n, v: Number(v[1]) };
    }
    return null;
  }
  if (p[0] === 'playbooks' && PLAYBOOK_KEY.test(p[1] ?? '')) {
    const key = p[1] as string;
    if (p.length === 3 && p[2] === 'playbook.json') return { kind: 'playbook', key };
    if (p.length === 6 && p[2] === 'files' && p[3] === 'skills' && SKILL_ID.test(p[4] ?? '') && SKILL_FILE.test(p[5] ?? ''))
      return { kind: 'skillFile', key, skill: p[4] as string, name: p[5] as string };
    if (p.length === 5 && p[2] === 'files' && p[3] === 'refs' && REF_FILE.test(p[4] ?? '')) return { kind: 'playbookRef', key, name: p[4] as string };
  }
  return null;
}

/** The most bytes a file of this name may have; `versionBytes`: the server's upload limit. */
export function partLimit(part: BundlePart | null, versionBytes: number): number {
  switch (part?.kind) {
    case 'manifest':
      return BUNDLE_LIMITS.manifest;
    case 'events':
      return BUNDLE_LIMITS.events;
    case 'folders':
    case 'review':
    case 'views':
    case 'playbook':
      return BUNDLE_LIMITS.json;
    case 'file':
      return BUNDLE_LIMITS.noteFile;
    case 'ref':
      return BUNDLE_LIMITS.ref;
    case 'preview':
      return BUNDLE_LIMITS.preview;
    case 'version':
      return versionBytes;
    case 'skillFile':
    case 'playbookRef':
      return BUNDLE_LIMITS.playbookFile;
    default:
      return 0;
  }
}

/** Where things go in the tar. */
export const bundlePath = {
  review: (key: string) => `reviews/${key}/review.json`,
  views: (key: string) => `reviews/${key}/views.json`,
  file: (key: string, name: string) => `reviews/${key}/files/${name}`,
  ref: (key: string, name: string) => `reviews/${key}/refs/${name}`,
  preview: (key: string, name: string) => `reviews/${key}/previews/${name}`,
  version: (key: string, name: string) => `reviews/${key}/versions/${name}`,
  playbook: (key: string) => `playbooks/${key}/playbook.json`,
  skillFile: (key: string, skill: string, name: string) => `playbooks/${key}/files/skills/${skill}/${name}`,
  playbookRef: (key: string, name: string) => `playbooks/${key}/files/refs/${name}`,
};

// ---------------------------------------------------------------- schemas

/** How far a bundle's times may run past the moment it was made, or past the import's own clock: clocks drift a little. */
export const BUNDLE_CLOCK_SKEW_MS = 10 * 60_000;
// The latest time a bundle being read may hold (ms since the epoch): set by the import while it checks one, none else.
let latest = Number.POSITIVE_INFINITY;
/**
 * Runs `fn` (a bundle's parse) refusing every time later than `ms`. History can't have happened after its bundle was
 * made, nor after now: a future time would park every agent's cursor there and keep For you's "recent" open for good.
 */
export function timesUpTo<T>(ms: number, fn: () => T): T {
  const was = latest;
  latest = ms;
  try {
    return fn();
  } finally {
    latest = was;
  }
}

/** A time as the store writes them (ISO 8601), or '' where the store keeps none; while an import checks: not later than it may be. */
const time = z
  .string()
  .max(40)
  .refine((s) => s === '' || !Number.isNaN(Date.parse(s)), 'not a time')
  .refine((s) => s === '' || !(Date.parse(s) > latest), 'a time later than the bundle was made (is the clock of the machine it came from right?)');
const name = z.string().max(400);
const text = z.string().max(200_000);
const shortText = z.string().max(2000);
const frame = z.number().int().min(0).max(100_000_000);
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const fps = z.number().min(0).max(1000);
const px = z.number().int().min(0).max(100_000);
const coord = z.number().min(-1_000_000).max(1_000_000);
const color = z.string().max(40).optional();
const commentId = z.string().regex(/^c_[a-f0-9]{4,16}$/);
const refId = z.string().regex(/^r_[a-f0-9]{10}$/);
const previewId = z.string().regex(/^p_[a-f0-9]{10}$/);
const person = z.string().regex(PERSON);
const hash = z.string().regex(/^[a-f0-9]{40}$/);
const severity = z.enum(['must', 'should', 'nice', 'idea']);
const status = z.enum(['open', 'fixed', 'verified', 'wontfix']);
const agentKind = z.enum(['claude-code', 'codex', 'cursor', 'claude', 'chatgpt', 'gemini', 'vscode', 'antigravity', 'windsurf', 'zed', 'mcp', 'api', 'cli']);

const range = z.strictObject({ in: frame, out: frame });
const shape = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('box'), x: coord, y: coord, w: coord, h: coord, color }),
  z.strictObject({ type: z.literal('arrow'), x1: coord, y1: coord, x2: coord, y2: coord, color }),
  z.strictObject({ type: z.literal('freehand'), points: z.array(z.tuple([coord, coord])).max(100_000), color }),
]);
const audio = z.strictObject({ codec: name, sample_rate: count, channels: count });
const meta = z.strictObject({
  codec: name.optional(),
  pix_fmt: name.optional(),
  color_space: name.nullish(),
  color_range: name.nullish(),
  audio: audio.nullish(),
});
const partCheck = z.strictObject({ v: count, diff: z.number().min(0).max(1000), at: time });
const versionPart = z.strictObject({
  of: count,
  at: frame,
  frames: frame,
  handles: frame,
  seam: z.union([z.literal('clean'), z.strictObject({ jump: frame, diff: z.number().min(0).max(1000).optional() })]).optional(),
  confirmed: partCheck.optional(),
  mismatch: z.strictObject({ ...partCheck.shape, frame }).optional(),
});
const renderSource = z.strictObject({
  app: name,
  project: name.optional(),
  comp: name.optional(),
  start_frame: frame.optional(),
  fps: fps.optional(),
});
const version = z.strictObject({
  v: z.number().int().min(1).max(999_999),
  hash,
  sample: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .optional(),
  mtime: time,
  size: count,
  frames: frame,
  fps,
  width: px,
  height: px,
  duration: z.number().min(0).max(1_000_000),
  registered: time,
  stored: z.enum(['bunny', 's3']).optional(),
  by: name.optional(),
  source: renderSource.optional(),
  playbook: z
    .array(z.strictObject({ scope: z.string().max(1000), rev: count }))
    .max(100)
    .optional(),
  part: versionPart.optional(),
});
const loudness = z.strictObject({ i: z.number().min(-1000).max(1000), tp: z.number().min(-1000).max(1000).optional() });
const noteRef = z.strictObject({
  id: refId,
  kind: z.enum(['image', 'clip', 'link', 'frame', 'audio']),
  caption: shortText.optional(),
  by: name,
  by_id: person.optional(),
  at: time,
  file: z.string().regex(REF_FILE).optional(),
  still: z.string().regex(REF_FILE).optional(),
  strip: z.string().regex(REF_FILE).optional(),
  end: z.string().regex(REF_FILE).optional(),
  width: px.optional(),
  height: px.optional(),
  duration: z.number().min(0).max(1_000_000).optional(),
  bytes: count.optional(),
  loudness: loudness.optional(),
  url: z.string().max(REF_LIMITS.url).optional(),
  site: name.optional(),
  video: z.string().max(600).optional(),
  name: name.optional(),
  v: count.optional(),
  frame: frame.optional(),
  to_frame: frame.optional(),
  timecode: name.optional(),
  fps: fps.optional(),
});
const optionAnswer = z.strictObject({
  picks: z.record(z.string().max(OPTION_LIMITS.id * 2), z.array(z.string().max(OPTION_LIMITS.id * 2)).max(100)),
  note: shortText.optional(),
});
const reply = z.strictObject({
  by: name,
  text,
  status: status.optional(),
  fixed_in_v: count.optional(),
  preview: previewId.optional(),
  refs: z.array(refId).max(100).optional(),
  answer: optionAnswer.optional(),
  at: time,
  by_id: person.optional(),
  edited: time.optional(),
});
const optionGroup = z.strictObject({
  id: z.string().max(OPTION_LIMITS.id * 2),
  label: shortText,
  pick: z.enum(['one', 'many']),
  items: z.array(z.strictObject({ id: z.string().max(OPTION_LIMITS.id * 2), label: shortText, ref: noteRef.optional() })).max(100),
});
const previewCheck = z.strictObject({ v: count, diff: z.number().min(0).max(1000), at: time });
const fixPreview = z.strictObject({
  id: previewId,
  kind: z.enum(['still', 'clip']),
  frame,
  frames: frame.optional(),
  v: count,
  by: name,
  at: time,
  width: px,
  height: px,
  fps: fps.optional(),
  file: z.string().regex(PREVIEW_FILE),
  bytes: count,
  source: z.strictObject({ app: name, project: name.optional(), comp: name.optional(), time: z.number().min(0).max(1_000_000).optional() }).optional(),
  confirmed: previewCheck.optional(),
  mismatch: z.strictObject({ ...previewCheck.shape, reason: shortText }).optional(),
});
const partRequest = z.strictObject({ in: frame, out: frame, shot: count.optional(), to_shot: count.optional(), handles: frame.optional() });
const comment = z.strictObject({
  id: commentId,
  v: count,
  frame,
  timecode: name,
  t: z.number().min(0).max(10_000_000),
  range: range.nullable(),
  text,
  tags: z.array(name).max(200),
  severity,
  kind: z.enum(['feedback', 'question', 'info']).optional(),
  drawing: z.array(shape).max(1000),
  shots: z.strictObject({ clean: z.string().regex(NOTE_FILE), marked: z.string().regex(NOTE_FILE), range: z.string().regex(NOTE_FILE).optional() }).nullable(),
  voice: z.strictObject({ file: z.string().regex(NOTE_FILE), transcript: text.nullable() }).nullable(),
  status,
  author: name,
  author_id: person.optional(),
  created: time,
  replies: z.array(reply).max(10_000),
  check_again: z.boolean().optional(),
  carried_to: count.optional(),
  fixed_in_v: count.optional(),
  edited: time.optional(),
  previews: z.array(fixPreview).max(1000).optional(),
  refs: z.array(noteRef).max(100).optional(),
  scope: z.literal('video').optional(),
  verified_on: z.strictObject({ preview: previewId, v: count }).optional(),
  text_edit: z.strictObject({ from: text, to: text }).optional(),
  choices: z.array(shortText).max(20).optional(),
  options: z.array(optionGroup).max(50).optional(),
  answer_prompt: shortText.optional(),
  source: z.literal('recording').optional(),
  recording: z.strictObject({ id: z.string().regex(/^rec_[a-f0-9]{12}$/), t0: z.number().min(0), t1: z.number().min(0) }).optional(),
  part: partRequest.optional(),
});
const verdict = z.strictObject({ status: z.enum(['approved', 'changes']), v: count, by: name, at: time, note: text.nullable() });
const approvalEntry = z.strictObject({
  party: z.enum(['team', 'client']),
  status: z.enum(['approved', 'changes', 'withdrawn']),
  v: count,
  by: name,
  at: time,
  note: text.nullable(),
  carried_from: count.optional(),
});
const finalMark = z.strictObject({ v: count, by: name, at: time, note: text.nullable() });

export const BundleReview = z.strictObject({
  id: z.string().regex(/^r_[a-f0-9]{8,32}$/),
  video: z.string().min(1).max(1000),
  source: z.strictObject({ kind: z.literal('upload'), name: z.string().min(1).max(255) }),
  project: name,
  fps,
  width: px,
  height: px,
  duration: z.number().min(0).max(1_000_000),
  frames: frame,
  versions: z.array(version).min(1).max(10_000),
  comments: z.array(comment).max(100_000),
  session: z.strictObject({ name, id: z.null(), cwd: z.null(), assigned: time, by: name, agent: agentKind.optional() }).nullable(),
  folder: z.string().max(1000).nullable(),
  added: time,
  added_by: name,
  added_by_id: person.optional(),
  updated: time.optional(),
  meta: meta.optional(),
  archived: time.optional(),
  approval: verdict.nullish(),
  approvals: z.array(approvalEntry).max(10_000).optional(),
  final: finalMark.nullish(),
  finals: z
    .array(z.strictObject({ ...finalMark.shape, action: z.enum(['final', 'reopen']) }))
    .max(10_000)
    .optional(),
  qa_dismissed: z.array(z.string().max(400)).max(10_000).optional(),
  qa_stretches: z.record(z.string().max(400), range).optional(),
});
export type BundleReview = z.infer<typeof BundleReview>;

const teamWatch = z.strictObject({
  v: count,
  seen: z.string().max(2000),
  plays: z.array(count).max(1000).optional(),
  secs: z.number().min(0),
  sessions: count.optional(),
  total_secs: z.number().min(0).optional(),
  total_sessions: count.optional(),
  first: time.optional(),
  last: time,
  name: name,
});
/** views.json in a bundle: the team's watching, by person (`owner`, `person:<n>`) or `viewer:<n>` (an account not named). */
export const BundleViews = z.strictObject({ viewers: z.record(z.string().regex(/^(owner|person:\d{1,6}|viewer:\d{1,6})$/), teamWatch) });

const EVENT_TYPES = [
  'added',
  'comment',
  'reply',
  'status',
  'edit',
  'delete',
  'version',
  'assigned',
  'moved',
  'removed',
  'approval',
  'request',
  'preview',
  'ref',
] as const;
/** The event types a bundle carries: a review's history. Downloads, agent runs and posts belong to links, the machine
 * and publishing, which don't come along. */
export const BUNDLE_EVENT_TYPES: readonly string[] = EVENT_TYPES;
export const BundleEvent = z.strictObject({
  at: time,
  type: z.enum(EVENT_TYPES),
  by: name,
  video: z.string().max(1000),
  slug: z.string().min(1).max(400),
  session: name.nullable(),
  id: commentId.optional(),
  v: count.optional(),
  frame: frame.optional(),
  timecode: name.optional(),
  range: range.nullish(),
  range_at: name.optional(),
  text_edit: z.strictObject({ from: text, to: text }).optional(),
  part: partRequest.optional(),
  severity: severity.optional(),
  kind: z.enum(['feedback', 'question', 'info']).optional(),
  tags: z.array(name).max(200).optional(),
  status: status.optional(),
  text: text.optional(),
  party: z.enum(['team', 'client']).optional(),
  shots: z
    .strictObject({
      clean: z.string().regex(NOTE_FILE).nullable(),
      marked: z.string().regex(NOTE_FILE).nullable(),
      range: z.string().regex(NOTE_FILE).nullish(),
    })
    .optional(),
  reply: z.strictObject({ ...reply.omit({ by_id: true }).shape }).optional(),
  options: z
    .array(z.string().max(OPTION_LIMITS.id * 2))
    .max(100)
    .optional(),
  ref: z.strictObject({ ...noteRef.omit({ by_id: true }).shape }).optional(),
  refs: count.optional(),
  scope: z.literal('video').optional(),
});
export type BundleEvent = z.infer<typeof BundleEvent>;

const skillFile = z.strictObject({ name: z.string().regex(SKILL_FILE), size: count, at: time, by: name });
export const BundlePlaybook = z.strictObject({
  id: z.string().regex(/^pb_[a-f0-9]{6,24}$/),
  scope: z.string().max(1000),
  rev: count,
  updated: time.nullable(),
  by: name.nullable(),
  // the limits the app holds a playbook to when it is written (lib/playbooks.ts, lib/playbookText.ts), no more
  brief: z.string().max(PLAYBOOK_LIMITS.text),
  rules: z.string().max(PLAYBOOK_LIMITS.text),
  refs: z.array(noteRef).max(PLAYBOOK_LIMITS.refs),
  skills: z
    .array(
      z.strictObject({
        id: z.string().regex(SKILL_ID),
        name: z.string().max(PLAYBOOK_LIMITS.skillName),
        description: z.string().max(PLAYBOOK_LIMITS.skillDescription),
        body: z.string().max(PLAYBOOK_LIMITS.skillBody),
        extra: z.string().max(PLAYBOOK_LIMITS.skillBody).optional(),
        files: z.array(skillFile).max(PLAYBOOK_LIMITS.filesPerSkill),
        updated: time,
        by: name,
      }),
    )
    .max(PLAYBOOK_LIMITS.skills),
  history: z
    .array(
      z.strictObject({
        rev: count,
        at: time,
        by: name,
        accepted_by: name.optional(),
        proposal: z.string().max(100).optional(),
        message: z.string().max(PLAYBOOK_LIMITS.message),
        section: z.string().max(200),
        // a section's text as it stood: a skill's whole SKILL.md, its other lines and files listed, passes the body's limit
        before: z
          .string()
          .max(PLAYBOOK_LIMITS.skillBody * 4)
          .nullable(),
        after: z
          .string()
          .max(PLAYBOOK_LIMITS.skillBody * 4)
          .nullable(),
      }),
    )
    .max(PLAYBOOK_LIMITS.history),
  proposals: z
    .array(
      z.strictObject({
        id: z.string().regex(/^pp_[a-f0-9]{6,24}$/),
        scope: z.string().max(1000),
        at: time,
        by: name,
        section: z.string().max(200),
        content: z.string().max(PLAYBOOK_LIMITS.skillBody + 6000),
        reason: z.string().max(PLAYBOOK_LIMITS.reason),
        evidence: z.array(commentId).max(PLAYBOOK_LIMITS.evidence),
        base_rev: count,
        status: z.enum(['pending', 'accepted', 'rejected']),
        decided_by: name.optional(),
        decided_at: time.optional(),
        reject_reason: z.string().max(PLAYBOOK_LIMITS.reason).optional(),
        rev: count.optional(),
      }),
    )
    .max(PLAYBOOK_LIMITS.pending + PLAYBOOK_LIMITS.decided),
});
export type BundlePlaybook = z.infer<typeof BundlePlaybook>;

export const BundleFolders = z.strictObject({ folders: z.array(z.string().min(1).max(1000)).max(BUNDLE_LIMITS.folders) });

const fileEntry = z.strictObject({
  path: z.string().min(1).max(200),
  size: count,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
const counts = z.strictObject({
  reviews: count,
  versions: count,
  version_bytes: count,
  notes: count,
  replies: count,
  drawings: count,
  approvals: count,
  files: count,
  events: count,
  folders: count,
  playbooks: count,
  views: count,
});
export const BundleManifest = z.strictObject({
  format: z.literal(BUNDLE_FORMAT),
  version: z.literal(BUNDLE_VERSION),
  id: z.string().regex(/^b_[a-f0-9]{16}$/),
  created: time,
  // printed on the import's report: a version's characters only, never a terminal's escape sequence (SW-5)
  app: z.strictObject({ version: z.string().regex(/^[\w.+-]{0,40}$/, 'not a version (letters, digits, . + - _)') }),
  /** The names the account the bundle came from wrote under (its account's name, the machine's user name). */
  owner: z.strictObject({ names: z.array(name).max(100) }),
  /** Other accounts the reviews name by id, by the name they had there. */
  people: z.array(z.strictObject({ key: person, name })).max(10_000),
  counts,
  files: z.array(fileEntry).max(BUNDLE_LIMITS.files),
  /** Taste scopes the store had (lib/taste.ts): written again from the notes on the server. */
  taste: z.array(z.string().max(1000)).max(10_000),
  /** What stayed behind, by kind: counts only (versions whose bytes were gone are named by review and number). */
  left_out: z.strictObject({
    missing_versions: z.array(z.strictObject({ key: z.string().regex(REVIEW_KEY), v: count })).max(1_000_000),
    samples: count,
    drafts: count,
    recordings: count,
    links: count,
    asks: count,
    events: count,
    missing_files: count,
  }),
});
export type BundleManifest = z.infer<typeof BundleManifest>;

/** What a bundle holds, read and checked (lib/bundleImport.ts). */
export interface ReadBundle {
  manifest: BundleManifest;
  reviews: Map<string, BundleReview>;
  views: Map<string, z.infer<typeof BundleViews>>;
  playbooks: Map<string, BundlePlaybook>;
  folders: string[];
  events: BundleEvent[];
  /** Every file entry by its tar name. */
  files: Map<string, { size: number; sha256: string; part: BundlePart }>;
}
