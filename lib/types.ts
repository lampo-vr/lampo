// The data contract as types: what lives in data/ (review.json, events.jsonl, folders.json, shares.json, taste/),
// what the analysers cache in cache/, and what the HTTP API returns. Server, CLI, MCP and the web UI import these,
// so a change here is a change to the contract other sessions read — keep it backwards compatible.

// ---------------------------------------------------------------- vocabulary

/** A reviewer's priority. `idea` is optional inspiration: it never counts as work that has to be done. */
export type Severity = 'must' | 'should' | 'nice' | 'idea';
/**
 * What a note is. Absent means `feedback` (every note written before kinds existed). Agents write `question`s for the
 * reviewer and `info` notes about what they changed; those carry no priority (their `severity` is stored as `nice`
 * so older readers keep working, and is ignored).
 */
export type NoteKind = 'feedback' | 'question' | 'info';
export type CommentStatus = 'open' | 'fixed' | 'verified' | 'wontfix';
export type ApprovalStatus = 'approved' | 'changes';
/** Whose sign-off: the team's (people with an account, or the local reviewer) or the client's (through a review link). */
export type ApprovalParty = 'team' | 'client';
/** A verdict in the history. `withdrawn` takes back that party's verdict on that version. */
export type VerdictStatus = ApprovalStatus | 'withdrawn';

export interface FrameRange {
  in: number;
  out: number;
}

/** Axis-aligned rectangle in video pixels. */
export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

// ---------------------------------------------------------------- drawings (video pixel coordinates)

export interface BoxShape extends Rect {
  type: 'box';
  color?: string;
}

export interface ArrowShape {
  type: 'arrow';
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color?: string;
}

export type Point = [number, number];

export interface FreehandShape {
  type: 'freehand';
  points: Point[];
  color?: string;
}

export type Shape = BoxShape | ArrowShape | FreehandShape;

// ---------------------------------------------------------------- media

export interface AudioMeta {
  codec: string;
  sample_rate: number;
  channels: number;
}

/** ffprobe result for one file (lib/probe.ts). */
export interface ProbeResult {
  fps: number;
  width: number;
  height: number;
  duration: number;
  frames: number;
  codec: string;
  pix_fmt: string;
  color_space: string | null;
  color_range: string | null;
  start_time: number;
  rotation: number;
  audio: AudioMeta | null;
  /** Container (ffprobe format_name, e.g. "mov,mp4,m4a,3gp,3g2,mj2"). */
  format?: string;
}

/** Stream properties that matter for colour-exact screenshots and proxies (review.meta). */
export interface MediaMeta {
  codec?: string;
  pix_fmt?: string;
  color_space?: string | null;
  color_range?: string | null;
  audio?: AudioMeta | null;
}

/** What frame grabs and posters need: geometry plus the colour metadata. */
export interface FrameMeta extends MediaMeta {
  fps: number;
  width: number;
  height: number;
  frames?: number;
}

/** One registered render. `hash` = sha1(size + first MiB + last MiB). */
export interface Version {
  v: number;
  /** sha1 of size + first MiB + last MiB (lib/probe.ts quickHash). */
  hash: string;
  /**
   * sha1 of `hash` and 256 slices of 4 KiB spread over the rest of the file (sampleHash). Tells apart re-renders
   * that keep size, head and tail (codecs with a constant frame size: uncompressed, v210, DNxHD/HR); derived files
   * are cached by it (renderKey). Absent on versions registered before it existed.
   */
  sample?: string;
  mtime: string;
  size: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  registered: string;
  /** The bytes live in remote storage (server mode with Bunny/S3) rather than versions/ on this disk. */
  stored?: 'bunny' | 's3';
  /** Who uploaded this render (uploads only). */
  by?: string;
  /** Where the render was made, as its agent reported it: maps render frame N to the project's time. */
  source?: RenderSource;
  /** The playbook revisions in force when the render arrived (House first, down to its folder); absent = none. */
  playbook?: PlaybookStamp[];
  /**
   * A partial render (lib/part.ts): the uploaded file holds only a stretch of the video (plus its handles), spliced
   * into version `of` for playback. `frames`, `fps`, `width`, `height` and `duration` above are the whole video's (the
   * base's); `hash`/`size` are the uploaded file's, and `sample` names the spliced whole (renderKey).
   */
  part?: VersionPart;
}

/**
 * Where a partial render sits in the version it patches. It replaces base frames [at, at + frames) with frames
 * [pre, pre + frames) of its own file, pre = min(handles, at); the frames around them (its handles) are compared with
 * the base's same frames (`seam`). A part never changes the video's length.
 */
export interface VersionPart {
  /** The version it patches (a full render, or another part). */
  of: number;
  /** The first base frame it replaces. */
  at: number;
  /** How many frames it replaces (and brings). */
  frames: number;
  /** Frames rendered beyond each end, as asked (fewer where the video begins or ends). */
  handles: number;
  /** The handles compared with the base's same frames: 'clean', or the seam frame where the motion jumps. Absent while
   * nobody compared them (no handles). */
  seam?: PartSeam;
  /** The next full render matched the approved part (its frames compared, the diff's block measure). */
  confirmed?: PartCheck;
  /** The next full render differs from the approved part here. */
  mismatch?: PartCheck & { frame: number };
}

export type PartSeam = 'clean' | { jump: number; diff?: number };

/** A full render compared with an approved part: `diff` = the worst 16×16 block difference (0–255) over its frames. */
export interface PartCheck {
  v: number;
  diff: number;
  at: string;
}

/**
 * A person's opt-in to a partial render (on a note, or with a request to the agent): only these frames need rendering
 * again, snapped to the render's own shot boundaries. Frames of the note's version (both ends included).
 */
export interface PartRequest {
  in: number;
  out: number;
  /** The shots it covers, counted from 1 (the render's cuts). */
  shot?: number;
  to_shot?: number;
  /** Frames to render beyond each end, for the seam check. */
  handles?: number;
}

/**
 * The project a render came from (After Effects, Premiere, Resolve, Remotion, …). Render frame N shows project time
 * N / fps + start_frame / (source fps): see compTime() in lib/time.ts.
 */
export interface RenderSource {
  /** e.g. "After Effects". */
  app: string;
  /** The project's file name (a name, never a path on the agent's machine). */
  project?: string;
  /** The composition / sequence / timeline that was rendered. */
  comp?: string;
  /** The project frame that render frame 0 shows (the work area's start), counted at the project's frame rate. */
  start_frame?: number;
  /** The project's frame rate, when it differs from the render's. */
  fps?: number;
}

// ---------------------------------------------------------------- review.json

/**
 * Where a review's renders come from. Absent = a file on this machine that is watched for re-renders (local mode);
 * "upload" = renders arrive as uploads, `video` is then a virtual path under /@uploads/.
 */
export interface ReviewSource {
  kind: 'upload';
  /** File name as uploaded. */
  name: string;
}

/** Screenshot file names, relative to the review's folder. */
export interface Shots {
  clean: string;
  marked: string;
  /** A note about a range: up to six frames across it in one JPEG (first … last), for agents. */
  range?: string;
}

export interface VoiceNote {
  /** m4a file name, relative to the review's folder. */
  file: string;
  transcript: string | null;
}

export interface Reply {
  by: string;
  text: string;
  status?: CommentStatus;
  fixed_in_v?: number;
  /** The fix preview this fix or verdict refers to (FixPreview.id). */
  preview?: string;
  /** References that came with this reply (NoteRef.id; the refs themselves live on the note). */
  refs?: string[];
  /**
   * An answer to a question's options (Comment.options): what was picked in each group and what the person wrote with
   * it. `text` is then the answer line agents read, `PICKED voice=v3 music=m1 · note: "…"` (lib/options.ts picksLine).
   */
  answer?: OptionAnswer;
  at: string;
  /** The account of `by` when a signed-in person wrote it (see Comment.author_id): who may change or delete it. */
  by_id?: string;
  /** When its author last changed its words. Only plain replies change (lib/ownership.ts changeableReply); `at` stays. */
  edited?: string;
}

/** What a person picked from a question's options: item ids per group id (none = left open), and their own words. */
export interface OptionAnswer {
  picks: Record<string, string[]>;
  note?: string;
}

/**
 * A group of things an agent offers before it renders (lib/options.ts): six narrator voices, three closing lines, the
 * takes of a whoosh. The person auditions them side by side and picks one (`pick: 'one'`) or several (`many`).
 */
export interface OptionGroup {
  /** What the answer names it by (`voice=v3`): letters, digits, `-` and `_`, at most 24. */
  id: string;
  label: string;
  pick: 'one' | 'many';
  items: OptionItem[];
}

export interface OptionItem {
  /** Unique in its group, the same shape as a group's id. */
  id: string;
  label: string;
  /** What to audition: an image, a clip, a sound (`audio`), a link or a moment of a render. */
  ref?: NoteRef;
}

/**
 * Integrated loudness (EBU R128, LUFS) and true peak (dBTP) of a sound, measured once when it is stored. No `tp`: the
 * peak couldn't be read, so the sound is never raised (lib/options.ts levelGains).
 */
export interface RefLoudness {
  i: number;
  tp?: number;
}

/**
 * A reference on a note: what "like this" means. An image or a clip (stored with the review, served at
 * /api/refs/<slug>/<file>), a link, or a moment of a render in this library. Agents get the pictures with the note.
 */
export interface NoteRef {
  /** r_ + hex. */
  id: string;
  /** `audio`: a sound an agent offers with its options (re-encoded to AAC in m4a), never a note's own reference. */
  kind: 'image' | 'clip' | 'link' | 'frame' | 'audio';
  caption?: string;
  by: string;
  /** The account of `by` when a signed-in person added it (see Comment.author_id). */
  by_id?: string;
  at: string;
  /** Client refs: the public id of the review link it came through (see Share.id). */
  share?: string;
  /** image, clip: the stored file (an image as sent, a clip re-encoded to H.264 mp4). */
  file?: string;
  /** image, clip, frame: a JPEG of at most 1280 px on the long side, for thumbnails and agents (a clip: its poster). */
  still?: string;
  /** clip: six moments of it in one JPEG, for agents. */
  strip?: string;
  /** frame with to_frame: a JPEG of the last frame. */
  end?: string;
  width?: number;
  height?: number;
  /** clip, audio: seconds. */
  duration?: number;
  bytes?: number;
  /** audio, a clip with sound: how loud it is, so a group of them plays level (lib/options.ts levelGains). */
  loudness?: RefLoudness;
  /** link: http(s) only, credentials stripped; `site` = its host. Never fetched by the server. */
  url?: string;
  site?: string;
  /** frame: the video (slug), its file name when referenced, the render and the frame (and an optional last frame). */
  video?: string;
  name?: string;
  v?: number;
  frame?: number;
  to_frame?: number;
  timecode?: string;
  fps?: number;
}

/**
 * A still or a short clip of a fix, made in the project (e.g. After Effects) before anything is rendered: the reviewer
 * can check the fix on it, and the next render is compared with it automatically (lib/previews.ts).
 */
export interface FixPreview {
  /** p_ + hex. */
  id: string;
  kind: 'still' | 'clip';
  /** The frame of render `v` it shows; a clip: its first frame. */
  frame: number;
  /** Clips: how many render frames they cover. */
  frames?: number;
  /** The render the fix was made against: until a newer render arrives, the fix exists only in the project. */
  v: number;
  by: string;
  at: string;
  width: number;
  height: number;
  /** Clips: their frame rate. */
  fps?: number;
  /** File name in the review's previews (served at /api/previews/<slug>/<file>). */
  file: string;
  bytes: number;
  /** Where it was made; `time` = seconds on that project's timeline. */
  source?: { app: string; project?: string; comp?: string; time?: number };
  /** A later render matched it. */
  confirmed?: PreviewCheck;
  /** A later render did not match it (the note went back to "check fixes"). */
  mismatch?: PreviewCheck & { reason: string };
}

/**
 * A render compared with a fix preview: `diff` = the worst 16×16 block's mean difference (0–255) of both frames at
 * 160 px grey, the measure the version diff uses; a render matches below 7.
 */
export interface PreviewCheck {
  v: number;
  diff: number;
  at: string;
}

export interface Comment {
  id: string;
  v: number;
  frame: number;
  timecode: string;
  /** Start of the frame in seconds, rounded to the millisecond. */
  t: number;
  range: FrameRange | null;
  text: string;
  tags: string[];
  severity: Severity;
  /** Absent = feedback. */
  kind?: NoteKind;
  drawing: Shape[];
  /** Null when no screenshots were made (e.g. notes written straight into the store). */
  shots: Shots | null;
  voice: VoiceNote | null;
  status: CommentStatus;
  author: string;
  /**
   * The account that wrote it, when a signed-in person did (through the server). Who may edit or delete a note is
   * decided by it when present — a rename keeps the note theirs, a new account with an old name doesn't get it — and by
   * `author` for notes without one (older notes, agents', clients', local `vr` writes).
   */
  author_id?: string;
  created: string;
  replies: Reply[];
  /** Open note carried to a newer render: look again. */
  check_again?: boolean;
  carried_to?: number;
  fixed_in_v?: number;
  edited?: string;
  /** Client notes: the public id of the review link it came through (see Share.id). */
  share?: string;
  /** Stills and clips of the fix, made before it was rendered (newest last). */
  previews?: FixPreview[];
  /** References (images, clips, links, moments of other renders), oldest first; at most 8. */
  refs?: NoteRef[];
  /** About the whole video rather than a moment of it ("overall"): frame 0, no screenshots, listed first. */
  scope?: 'video';
  /** Verified on a fix preview, not on a render yet: `v` = the newest render when it was verified. Cleared once a later
   * render matches the preview. */
  verified_on?: { preview: string; v: number };
  /** A change to what is said (from the transcript): the words as they are and as they should be. The note's range
   * (or frame) is where they are said. */
  text_edit?: TextEdit;
  /** Questions only: answers the agent offers, 2–4 short lines (lib/choices.ts). Picking one sends it as the answer. */
  choices?: string[];
  /**
   * Questions only: groups of options to audition and pick from before the agent renders (lib/options.ts) — voices,
   * music, takes. The picks come back as an ordinary answer whose reply carries `answer`.
   */
  options?: OptionGroup[];
  /** With `options`: what the free-text field asks ("Anything to add?"); absent = the app's own words. */
  answer_prompt?: string;
  /** How the note was made when it wasn't typed: `recording` = said while watching (lib/recording.ts). */
  source?: NoteSource;
  /** A note made from a recording: which one, and the stretch of its audio it was said in (seconds). Its own clip of
   * that stretch is `voice`. */
  recording?: NoteRecording;
  /** The person allows a partial render for this note: only these shots, sent with `vr push --part-at` (lib/part.ts). */
  part?: PartRequest;
  /**
   * Not sent yet: saved by its author, seen by nobody else — never in review.json, events, INBOX.md, `vr`, MCP, review
   * links or any count (lib/drafts.ts keeps it in data/<slug>/drafts/). Sending clears it and logs the note's events.
   */
  draft?: true;
}

/**
 * A question with options asked before any render exists (lib/asks.ts): on a project or folder, answered like a
 * question on a video. Kept per workspace in data/asks.json; its pictures and sounds at asks/<id>/ in storage.
 */
export interface FolderAsk {
  /** c_ + hex, like a note's: the answer, get_note and the inbox name it the same way. */
  id: string;
  /** The project or folder it is about ("Acme/Launch"). */
  folder: string;
  text: string;
  kind: 'question';
  options: OptionGroup[];
  answer_prompt?: string;
  status: CommentStatus;
  author: string;
  author_id?: string;
  created: string;
  replies: Reply[];
}

/** GET /api/asks/:id: a question with options as the audition reads it, on a video (slug) or a folder. */
export interface AskView {
  id: string;
  /** The video it is on; null when it was asked on a folder before any render. */
  slug: string | null;
  /** The video's file name, or the folder's name. */
  name: string;
  folder: string | null;
  v: number | null;
  text: string;
  options: OptionGroup[];
  answer_prompt: string | null;
  status: CommentStatus;
  author: string;
  created: string;
  replies: Reply[];
  /** Where an item's files are served: its ref id → the file (to play or show) and its still. */
  files: Record<string, { src: string | null; still: string | null }>;
  /**
   * How the audition levels sounds: `gain` (the files come from this server: Web Audio may turn them up and down) or
   * `volume` (they come from a bucket's URL: only the element's volume, which turns down).
   */
  level: 'gain' | 'volume';
}

/** A question's group as lists name it before it is opened: what the audition will show, in its shape. */
export interface OptionSeen {
  label: string;
  n: number;
  /** What its items are (`text`: labels only, `mixed`: more than one kind). */
  kind: 'audio' | 'image' | 'clip' | 'link' | 'frame' | 'text' | 'mixed';
}

/** GET /api/asks: questions with options waiting on folders (none of them on a video yet), newest first. */
export interface AsksResponse {
  asks: FolderAsk[];
}

/** POST /api/asks: the question made, and one upload URL per item whose file wasn't sent inline ("voice/v3"). */
export interface AskCreated {
  id: string;
  slug: string | null;
  folder: string | null;
  uploads: Record<string, { url: string; expires: string }>;
}

/** GET /api/review/:slug/drafts: your notes on this video that are not sent yet, in the order you saved them. */
export interface DraftsResponse {
  drafts: Comment[];
}

/** POST /api/review/:slug/drafts/send: the notes it made (one batch), and what stayed behind. */
export interface DraftsSent {
  notes: Comment[];
  /** Drafts from recordings that couldn't be sent this time (they stay, for another try). */
  left: number;
  error?: string;
  /** With `start`: the agent Lampo started for the batch (null when it was running already). */
  run?: AgentRunInfo | null;
}

/** GET /api/drafts: how many of your notes are not sent yet, per video (typed drafts and drafts from recordings). */
export interface UnsentResponse {
  videos: Record<string, number>;
}

export type NoteSource = 'recording';

export interface NoteRecording {
  /** rec_ + hex. */
  id: string;
  t0: number;
  t1: number;
}

/**
 * Recorded feedback (lib/recording.ts, lib/recordings.ts): someone talks, points and draws over a video while it plays;
 * what they said becomes draft notes on the frames that were on screen. What happened, on the recording's own clock
 * (seconds since it started; stretches when the recording itself was paused are not on it):
 *   frame   the frame on screen changed (while playing, at most every 50 ms; paused, every change)
 *   play / pause, seek (a jump to frame f)
 *   pointer the pointer over the picture, 0–1 across and down (sampled ~10×/s while it is over it, also at rest)
 *   click   a click on the picture
 *   stroke  a shape drawn with the drawing tools on frame f (video pixels, lib/drawing.ts)
 */
export type RecordingEvent =
  | { t: number; k: 'frame'; f: number }
  | { t: number; k: 'play' | 'pause' }
  | { t: number; k: 'seek'; f: number }
  | { t: number; k: 'pointer'; x: number; y: number }
  | { t: number; k: 'click'; x: number; y: number }
  | { t: number; k: 'stroke'; f: number; shape: Shape };

/** A note-to-be from a recording: edited by its maker, then sent as an ordinary note. */
export interface RecordingDraft {
  /** d_ + hex, stable across edits. */
  id: string;
  frame: number;
  range: FrameRange | null;
  text: string;
  /** What the speech engine heard (the text before any edit). */
  heard: string;
  /** Always feedback: a person's "can we …?" asks for a change; questions are what agents ask people (the inbox's). */
  severity: Severity;
  tags: string[];
  drawing: Shape[];
  /** Where on the recording it was said (seconds). */
  t0: number;
  t1: number;
  /** The pointer rested (or clicked) here while it was said: 0–1 across and down. Drawn as a ring in `drawing`. */
  spot?: Point;
}

/** uploading: waiting for the audio · hearing: the speech engine works · ready: drafts to review · failed: not heard. */
export type RecordingState = 'uploading' | 'hearing' | 'ready' | 'failed';

/** A recording waiting to be reviewed and sent (kept on the server until then, so a reload loses nothing). */
export interface Recording {
  /** rec_ + hex. */
  id: string;
  /** The video and the version it was made on. */
  slug: string;
  v: number;
  by: string;
  by_id?: string;
  created: string;
  /** Seconds of audio. */
  duration: number;
  state: RecordingState;
  /** Why it couldn't be heard (the audio is kept; drafts from drawings still come). */
  error?: string;
  /** Heard nothing: no drafts from speech. */
  silent?: boolean;
  drafts: RecordingDraft[];
}

export interface RecordingsResponse {
  recordings: Recording[];
}

/** What sending a recording made: the notes, and drafts that couldn't be sent (they stay for another try). */
export interface RecordingSent {
  notes: Comment[];
  left: RecordingDraft[];
  error?: string;
}

/** What a note asks to change in what is said: the words as spoken, and as they should be. */
export interface TextEdit {
  from: string;
  to: string;
}

/** A spoken word of a render: its seconds and the frames it is heard on (f0 ≤ f1). */
export interface TranscriptWord {
  text: string;
  t0: number;
  t1: number;
  f0: number;
  f1: number;
}

/** A line to read (a sentence, or up to a pause): words[w0 … w0 + n − 1]. */
export interface TranscriptLine {
  text: string;
  t0: number;
  t1: number;
  f0: number;
  f1: number;
  w0: number;
  n: number;
}

/** A stretch of a render the engine lost the first time (its window collapsed into an invented line over music) and
 * heard again: seconds, and whose words fill it now — the same engine on a cut that opens on the speech, or a second
 * listener's (lib/stt/collapse.ts). */
export interface TranscriptRepair {
  t0: number;
  t1: number;
  engine: string;
}

/** What is said in a render (voice-over, dialogue), made once per render's bytes (lib/transcripts.ts). */
export interface Transcript {
  transcript_version: number;
  hash: string;
  /** ISO code when the engine detected it, else ''. */
  language: string;
  /** The engine and model that heard it ("local:parakeet-tdt-0.6b-v3", "http:whisper-1"). */
  engine: string;
  /** 'word': the engine timed every word; 'line': it timed sentences only (or only some of the words: a repair filled a
   * stretch with a second listener's timed words), the other words are spread over their lines by length. */
  timing: 'word' | 'line';
  fps: number;
  frames: number;
  words: TranscriptWord[];
  lines: TranscriptLine[];
  created: string;
  /** Stretches heard again because the first pass lost them; absent when none was. */
  repairs?: TranscriptRepair[];
}

/** GET /api/review/:slug/transcript: the transcript, or why there is none yet. */
export type TranscriptAnswer =
  | { state: 'ready'; v: number; transcript: Transcript }
  | { state: 'pending'; v: number }
  | { state: 'off'; v: number; error?: string }
  | { state: 'failed'; v: number; error: string };

/** The Claude Code session a video is handed to. */
export interface AssignedSession {
  name: string;
  id: string | null;
  cwd: string | null;
  assigned: string;
  by: string;
  /** What kind of agent it is, when the assigner knew (absent on older assignments: `agentKindOfRef` in lib/agentKind.ts). */
  agent?: AgentKind;
}

export interface Approval {
  status: ApprovalStatus;
  v: number;
  by: string;
  at: string;
  note: string | null;
}

/** One entry of review.json `approvals`: append-only, newest last. */
export interface ApprovalEntry {
  party: ApprovalParty;
  status: VerdictStatus;
  v: number;
  by: string;
  at: string;
  note: string | null;
  /** Client verdicts: the id of the review link it came through. */
  share?: string;
  /** Carried over from this version because the new render is identical to it. */
  carried_from?: number;
}

/** The video is done: this version is the one that ships. New renders after it don't move it until someone reopens. */
export interface FinalMark {
  v: number;
  by: string;
  at: string;
  note: string | null;
}

/** One entry of review.json `finals`: marking final and reopening, append-only. */
export interface FinalEntry extends FinalMark {
  action: 'final' | 'reopen';
}

/** What an agent is doing with the video right now ("rendering v4"). */
export interface AgentStatus {
  text: string;
  by: string;
  at: string;
  until?: string;
}

export interface Review {
  /** Given when the review is made, never reused (a slug is: a video removed and added again under the same name gets
   * the same slug, and a new id). What a review link was made for (Share.video_id). Absent in reviews from before. */
  id?: string;
  video: string;
  source?: ReviewSource;
  project: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  frames: number;
  versions: Version[];
  comments: Comment[];
  session: AssignedSession | null;
  folder: string | null;
  added: string;
  added_by: string;
  /** The account of `added_by` when a signed-in person added it (see Comment.author_id). */
  added_by_id?: string;
  updated?: string;
  meta?: MediaMeta;
  missing?: boolean;
  archived?: string;
  /** The newest verdict, as before `approvals` existed (kept for older readers; `approvals` is the history). */
  approval?: Approval | null;
  /** Every verdict, team and client, per version. Absent in older stores: read `approval` as its one entry. */
  approvals?: ApprovalEntry[];
  /** Set while the video is final; null after a reopen. */
  final?: FinalMark | null;
  /** Marking final and reopening, append-only. */
  finals?: FinalEntry[];
  agent_status?: AgentStatus;
  /** QA suggestion keys the reviewer dismissed (or turned into notes). */
  qa_dismissed?: string[];
  /**
   * Where each finding marked "That's intended" was, by key, in frames of the version it was dismissed on: a later
   * version's finding of the same kind on the same stretch stays dismissed though its frames moved a little
   * (lib/findings.ts `dismissedBy`).
   */
  qa_stretches?: Record<string, FrameRange>;
  /**
   * The first run's sample (lib/sample.ts): Lampo's brand film in two versions with a few notes, made for a new
   * account's workspace. Never counted in billing or plan limits; its events are never logged (no agent feed, INBOX.md, webhook
   * or push hears of it); left out of Insights; removed for good in one click.
   */
  onboarding_sample?: SampleMark;
}

/** Who made a sample and when (Review.onboarding_sample). */
export interface SampleMark {
  made: string;
  by: string;
  /** The account that asked for it. */
  by_id?: string;
}

export interface Counts {
  /** Open feedback that has to be dealt with: ideas, questions and info notes don't count. */
  open: number;
  fixed: number;
  verified: number;
  wontfix: number;
  must: number;
  check_again: number;
  done: number;
  total: number;
  /** Open ideas (optional). */
  ideas: number;
  /** Open questions from agents, waiting for the reviewer. */
  questions: number;
}

// ---------------------------------------------------------------- events.jsonl

export type EventType =
  | 'added'
  | 'comment'
  | 'reply'
  | 'status'
  | 'edit'
  | 'delete'
  | 'version'
  | 'assigned'
  | 'moved'
  | 'removed'
  | 'approval'
  | 'request'
  | 'download'
  | 'preview'
  | 'ref'
  | 'agent_run'
  /** A post of a final video: drafted, published, scheduled, posted, failed or taken back (`post`). Not feedback. */
  | 'post';

/** One line of data/events.jsonl. Comment fields are present for comment events. */
export interface ReviewEvent {
  at: string;
  type: EventType;
  by: string;
  video: string;
  slug: string;
  session: string | null;
  session_id?: string;
  id?: string;
  v?: number;
  frame?: number;
  timecode?: string;
  range?: FrameRange | null;
  /** A range note, as people and agents read it: "00:12:03 → 00:14:10 (f360–f372, 2.3 s)". */
  range_at?: string;
  /** A note that changes what is said (comment and edit events). */
  text_edit?: TextEdit;
  /** A partial render the person allows (comment and request events). */
  part?: PartRequest;
  severity?: Severity;
  /** Only for questions and info notes (absent = feedback). */
  kind?: NoteKind;
  tags?: string[];
  status?: CommentStatus;
  text?: string;
  /** Approval events: whose verdict it is. */
  party?: ApprovalParty;
  /** Absolute screenshot paths (range: up to six frames across a range note, in one picture). */
  shots?: { clean: string | null; marked: string | null; range?: string | null };
  reply?: Reply;
  /** Download events about a whole folder, and questions asked on a folder before any render (lib/asks.ts): video/slug
   * then name the folder / are empty. */
  folder?: string;
  /** Comment events of a question with options: the ids of its groups (the person picks in Lampo). */
  options?: string[];
  /** Download events: the review link's public id, how many files, how many bytes. */
  share?: string;
  /** ref events: the reference that was added. Comment events: how many references the note carries. */
  ref?: NoteRef;
  refs?: number;
  /** Notes about the whole video (frame 0 is not a moment). */
  scope?: 'video';
  files?: number;
  bytes?: number;
  /** agent_run events: which run, what happened to it, and how the process ended (null while it runs or when killed). */
  run?: string;
  phase?: AgentRunPhase;
  exit?: number | null;
  /** post events: the post and where it stands. */
  post?: PostEventInfo;
  /**
   * History brought over from another store (`vr admin import`): the id of the bundle it came in. Live followers (the
   * server's feed — the live stream, webhooks, push —, `vr watch`, the MCP feed) skip it: it is never news.
   */
  imported?: string;
}

// ---------------------------------------------------------------- agent runs (the machine starts an agent)

/** What to do when you send something to an agent that isn't running: ask each time, start it, or only send. */
export type WakePref = 'ask' | 'start' | 'send';
export type AgentRunPhase = 'started' | 'finished' | 'failed' | 'stopped' | 'timeout';

/** A run Lampo started on this machine (GET /api/agent-runs): a Claude Code session resumed with a request. */
export interface AgentRunInfo {
  id: string;
  slug: string;
  /** The session's name and id, and where it runs. */
  name: string;
  session_id: string;
  cwd: string;
  by: string;
  started: string;
  ended: string | null;
  /** 'running' until the process ends. */
  state: 'running' | AgentRunPhase;
  exit: number | null;
  /** What the run is doing and has used so far, read from its own output (Claude Code's stream-json): no tokens of
   * the agent's are spent on it. Absent until the run has printed something Lampo understands. */
  live?: AgentRunLive;
}

/** A Lampo-started run as its output tells it (lib/runStream.ts). */
export interface AgentRunLive {
  /** The step it is on, in one line ("Editing src/Logo.tsx", "Running npm run render", what it said). */
  step: ActivityWords | null;
  /** Tokens as the run reports them (summed per message; the final result's totals once it has one). */
  tokens: { input: number; output: number; cache_read: number; cache_write: number };
  /** Only when the run itself states it (its result event); never estimated. */
  cost_usd: number | null;
  turns: number | null;
  updated: string;
}

// ---------------------------------------------------------------- what agents are doing (lib/activity*.ts)

export type AgentActivityKind = 'read' | 'note' | 'fix' | 'reply' | 'ask' | 'upload' | 'render' | 'wait' | 'playbook' | 'status' | 'tool' | 'say' | 'run';

/** Words the UI says in its own language: `text` is the English line, `key` its template (`ACTIVITY_KEYS` in
 * lib/activityText.ts, `{name}` placeholders) with `vars` filled in; `quote` is someone's own words after it, as they
 * wrote them. Without a key (what an agent said in its own words) the text is shown as it is. */
export interface ActivityWords {
  text: string;
  key?: string;
  vars?: Record<string, string | number>;
  quote?: string;
}

/** One thing an agent did through Lampo (an MCP tool, a `vr` command, an upload) or that a run Lampo started printed.
 * Kept in memory and a small rolling file in the cache; never in review.json. */
export interface AgentActivity extends ActivityWords {
  at: string;
  /** The agent's name as the UI shows it (a session's name, without "agent:"). */
  agent: string;
  slug: string | null;
  kind: AgentActivityKind;
  /** A note id or version the action was about. */
  target?: string | null;
  /** A wait that kept going (repeated wait_for_feedback calls): when it began. */
  since?: string;
  /** An upload's progress, 0–100. */
  pct?: number;
}

/** What one agent is doing on one video (or anywhere, `slug` null), newest first. */
export interface AgentLive {
  agent: string;
  slug: string | null;
  current: AgentActivity | null;
  recent: AgentActivity[];
  updated: string;
}

export interface AgentActivityResponse {
  agents: AgentLive[];
}

// ---------------------------------------------------------------- folders.json, shares.json

export interface FoldersFile {
  folders: string[];
  /** Ids of the folders review links were made on (lib/folderIds.ts), by path: they move with their folder and end
   * with it, so a folder deleted and made again under the same name is another folder. Absent in older stores. */
  ids?: Record<string, string>;
}

export type ShareNotes = 'own' | 'all';
export type ShareVersions = 'latest' | 'all';
export type ShareDownload = 'off' | 'preview' | 'original';

/** What a review link lets its visitors do. Links made before these settings existed get SHARE_DEFAULTS. */
export interface ShareSettings {
  /** Leave notes, reply and confirm fixes; false = watch only. */
  comment: boolean;
  /** Approve or request changes on the newest version. */
  approve: boolean;
  /** 'own': the client notes made through this link; 'all': every client note on the video, from any link. Internal
   * notes (the team's and the agents') are never shown. */
  notes: ShareNotes;
  /** 'latest': only the newest version; 'all': every version, with a switcher. */
  versions: ShareVersions;
  /** 'preview': the browser-playable file; 'original': the render's own bytes. */
  download: ShareDownload;
  /** ISO time after which the link stops working, or null. */
  expires: string | null;
  /**
   * An embed: the video's player alone at /e/<token>, for an <iframe> on another site (docs/sharing.md, "Embedding a
   * video"). Watch only whatever else is stored (the newest version, no notes, no downloads), one video, never a
   * password. Absent: a review link like any other.
   */
  embed?: boolean;
}

export interface ShareStats {
  opens: number;
  last_opened: string | null;
  /** Names visitors gave, newest last. */
  reviewers: string[];
  /** Downloads started through the link (a resumed download counts once). */
  downloads?: number;
  last_download?: string | null;
  /** The latest downloads, newest last. */
  recent_downloads?: ShareDownloadRecord[];
  /** Per video, by slug: a visitor opened the video's page (never the team previewing its own link). Folder links cover
   * many videos, so only this says which ones the client actually looked at. */
  videos?: Record<string, ShareVideoStats>;
  /** Visitors the link tells apart, by a key derived from a random id their browser keeps (never an address; see
   * visitorKey in lib/shares.ts). */
  visitors?: Record<string, ShareVisitor>;
  /** What happened through the link, newest last (the latest 200). */
  activity?: ShareActivity[];
}

export interface ShareVisitor {
  /** The name they gave, once they gave one. */
  name: string | null;
  first: string;
  last: string;
  /** Visits, once per half hour. */
  opens: number;
  /** Seconds of video they played through the link. */
  secs: number;
}

/**
 * How far one viewer watched one video (lib/watch.ts): the version, and which hundredths of it played. A review link's
 * visitors are kept with the link (ShareVideoStats.watch), the team in `data/<slug>/views.json` (VideoViews).
 */
export interface ShareWatch {
  v: number;
  /** 100 bits as 25 hex digits: bit i = the i-th hundredth of the version played. */
  seen: string;
  /** Seconds played. */
  secs: number;
  last: string;
  name?: string | null;
  /** How often each hundredth of version `v` played (100 whole numbers, capped); records from before have none. */
  plays?: number[];
  /** Sittings on version `v`: a report more than half an hour after the one before starts a new one. */
  sessions?: number;
  /** The first report, any version. */
  first?: string;
  /** Across every version of the video: seconds played and sittings. */
  total_secs?: number;
  total_sessions?: number;
}

/** The team's watching of one video (`data/<slug>/views.json`), by account id. */
export interface VideoViews {
  viewers: Record<string, TeamWatch>;
}

/** One team member's watching: a ShareWatch that always carries their name as it was when they last watched. */
export interface TeamWatch extends ShareWatch {
  name: string;
}

/** One person who watched a video, for its owner (GET /api/review/:slug/audience, Insights). */
export interface AudienceViewer {
  /** Stable within the answer: an account id (people) or a link's visitor key (clients). */
  key: string;
  kind: 'person' | 'client';
  /** The account's name, or what a client typed; null for a client who never said. */
  name: string | null;
  /** The review link a client came through (its label). */
  link: string | null;
  /** The version their record is about (the newest they watched). */
  v: number;
  /** Share of that version they played, 0 … 1. */
  watched: number;
  /** Seconds and sittings on that version. */
  secs: number;
  sessions: number;
  /** Seconds and sittings on every version of the video. */
  total_secs: number;
  total_sessions: number;
  first: string;
  last: string;
}

/** Who watched one video and how (the player's viewers chip, band and list). */
export interface VideoAudience {
  /** The version the curve is about: the newest anyone watched, or the one asked for. */
  v: number;
  viewers: AudienceViewer[];
  /** Per hundredth of `v`, the share of its viewers who played it (0 … 1); empty when nobody watched `v`. */
  retention: number[];
  /** Per hundredth of `v`, how often it played in total. */
  plays: number[];
  /** Stretches of `v` played again and again (hundredths, `to` inclusive). */
  rewatched: { from: number; to: number; plays: number }[];
}

export type ShareActivityKind = 'open' | 'view' | 'note' | 'reply' | 'check' | 'approval' | 'download';

/** One thing a visitor did through a link. */
export interface ShareActivity {
  at: string;
  kind: ShareActivityKind;
  /** The name they gave, when known. */
  name?: string | null;
  /** The video it was about (slug). */
  slug?: string;
  v?: number;
  /** approval: 'approved' | 'changes'; check: 'confirm' | 'reopen'; note: 'idea' for an idea; download: what. */
  detail?: string;
}

export interface ShareVideoStats {
  /** Page views, once per visitor and half hour. */
  views: number;
  last_viewed: string;
  /** The newest version number a visitor had in front of them. */
  seen_v: number;
  /** The name the latest viewer gave on this link, when known. */
  by?: string | null;
  /** How far each visitor watched it, by visitor key (ShareStats.visitors). */
  watch?: Record<string, ShareWatch>;
}

/** What a "Download all" button shows before anyone clicks (GET …/archive/info). */
export interface ArchiveInfo {
  kind: 'preview' | 'original';
  /** Where the zip is (a guest adds &name=). */
  url: string;
  files: number;
  bytes: number;
  /** Previews still being made: the archive can't be built yet. */
  preparing: number;
  /** Videos whose bytes are gone (left out of the archive). */
  missing: number;
  /** Every checksum is ready: the download can resume after an interruption. */
  resumable: boolean;
}

/** One version's own file, before the team downloads it (GET /api/review/:slug/download/info?v=). */
export interface VersionDownload {
  v: number;
  /** The file's name as it lands: "spot V3.mp4". */
  name: string;
  bytes: number;
  /** Where the file is: the app's own route, which streams it or sends the browser on to a signed URL. */
  url: string;
}

export interface ShareDownloadRecord {
  at: string;
  /** The visitor's name, or "client". */
  name: string;
  /** What: "all 6 videos" or a file name. */
  what: string;
  files: number;
  bytes: number;
  kind: 'preview' | 'original';
}

/**
 * An entry of data/shares.json, keyed by `sha256:<hex of its secret token>` (files from before: by the token itself,
 * rewritten in the hashed form on start). Every v2 field is optional: old entries still load.
 */
export interface Share extends Partial<ShareSettings> {
  /** The token, sealed (AES-256-GCM) with a key derived from share-secret.key, so the owner can copy the link again. */
  sealed?: string;
  /** Video links (and every link made before folder links existed): the one video. */
  slug?: string;
  /** Folder links: every video filed in this folder or below it, looked up on each request. */
  folder?: string;
  /** Video links: the id (Review.id) and `added` (Review.added) of the video the link was made for. A video removed and
   * added again under the same slug is another video: the link doesn't cover it. Links from before get them at the
   * next start; reviews from before have no id, and go by `added` alone. */
  video_id?: string;
  video_added?: string;
  /** Folder links: the folder's id (FoldersFile.ids), which follows the folder's renames and ends with it. Links from
   * before get it at the next start. */
  folder_id?: string;
  label: string;
  created: string;
  by: string;
  /** The account of `by` when a signed-in person made the link (the first run's "Share a review link" step). */
  by_id?: string;
  updated?: string;
  revoked?: string;
  /** Public id, stored on the notes made through the link. Not a secret (the token is). */
  id?: string;
  /** scrypt hash of the link's password. */
  password?: string;
  /** Bumped with every password change, so browsers that unlocked the old one have to ask again. */
  password_v?: number;
  stats?: ShareStats;
}

export interface SharesFile {
  shares: Record<string, Share>;
}

export interface ShareWithToken extends Share {
  token: string;
}

/** A review link as its owner sees it. */
export interface ShareInfo extends ShareSettings {
  /**
   * What opens the link (`/g/<token>`): sent to a person's own browser (a session, or the machine itself), which copies,
   * edits and revokes links by it, and with a link just made. A listing for an API token leaves it out: one call would
   * otherwise hand an agent every client link of the workspace.
   */
  token?: string;
  id: string;
  label: string;
  created: string;
  by: string;
  /** Who the link's visitors are told shared it (lib/shares.ts sharerName): null when no name was chosen to show. */
  sharer?: string | null;
  updated: string | null;
  kind: 'video' | 'folder';
  slug: string | null;
  folder: string | null;
  /** The video's file name (video links). */
  name: string | null;
  /** Video links: the newest version's frame size (an embed's code keeps its shape). Optional; older servers leave them out. */
  width?: number;
  height?: number;
  password: boolean;
  expired: boolean;
  /** What the link was made for is gone (its video or folder was deleted outside the app): it opens nothing. Only in
   * the list of every link (GET /api/shares), so it can be revoked. */
  gone?: boolean;
  /** The counts; the per-visitor and per-video records are summed up in `activity` instead. */
  stats: Omit<ShareStats, 'visitors' | 'videos' | 'activity'> & { notes: number };
  activity: ShareActivityInfo;
}

/** A link's activity as its owner sees it (lib/shareActivity.ts). */
export interface ShareActivityInfo {
  /** Visitors told apart, latest first. */
  visitors: ShareVisitor[];
  /** The link's videos that someone opened, latest first. */
  videos: ShareVideoWatch[];
  /** What happened, newest first. */
  events: (ShareActivity & { video: string | null })[];
  /** Seconds of video played through the link, by everyone. */
  secs: number;
}

export interface ShareVideoWatch {
  slug: string;
  name: string;
  /** The newest version. */
  v: number;
  views: number;
  last_viewed: string | null;
  /** The furthest one visitor got through the newest version (0 … 1); null when nobody watched it yet. */
  watched: number | null;
  /** How many visitors played each hundredth of the newest version (100 numbers; empty when nobody did). */
  heat: number[];
  /** Who watched the newest version how far, furthest first. */
  viewers: { name: string | null; watched: number; secs: number; last: string }[];
  secs: number;
}

export interface SharesResponse {
  shares: ShareInfo[];
  tunnel: string | null;
  lan: string[];
  /** Who the visitors of a link this person makes now are told shared it; null when no name was chosen to show. */
  sharer?: string | null;
}

/** Create or change a link; a password of null removes it. */
export interface ShareInput extends Partial<ShareSettings> {
  label?: string;
  password?: string | null;
}

// ---------------------------------------------------------------- webhooks

export type WebhookFormat = 'json' | 'slack' | 'discord';

/** One webhook: config.json "webhooks", VR_WEBHOOK_URL, or managed in the UI (data/webhooks.json). */
export interface WebhookConfig {
  url: string;
  /** 'client' (default): client notes, replies, fix checks and approvals; 'all': every review event; or event types. */
  events?: string[];
  format?: WebhookFormat;
  /** Signs each delivery (X-VR-Signature: t=<unix>,v1=<hex HMAC-SHA256 of "<t>.<body>">). */
  secret?: string;
  label?: string;
}

export interface WebhookDelivery {
  at: string;
  event: string;
  ok: boolean;
  status: number | null;
  error?: string;
  attempts: number;
}

export interface WebhookInfo {
  id: string;
  label: string;
  url: string;
  events: string[];
  format: WebhookFormat;
  secret: boolean;
  /** 'settings' hooks can be changed in the UI; the others come from config.json or the environment. */
  source: 'config' | 'env' | 'settings';
  last: WebhookDelivery | null;
}

export interface FolderSuggestion {
  folder: string | null;
  reason: string;
  exists: boolean;
}

// ---------------------------------------------------------------- Claude sessions

/** A running Claude Code session (`claude agents --json` or ~/.claude/sessions). */
/**
 * What kind of agent: a Claude Code session found on this machine, Codex, Cursor, Claude, ChatGPT, Gemini, VS Code,
 * Windsurf or Zed over MCP, any other MCP client, a script on the HTTP API that announced itself (`api`), or `vr` itself
 * (lib/agentKind.ts has the labels, web/src/ui/agentMarks.ts the marks). Only ever extended: stored assignments keep it.
 */
export type AgentKind =
  | 'claude-code'
  | 'codex'
  | 'cursor'
  | 'claude'
  | 'chatgpt'
  | 'gemini'
  | 'vscode'
  | 'antigravity'
  | 'windsurf'
  | 'zed'
  | 'mcp'
  | 'api'
  | 'cli';

/**
 * An agent a video can be handed to: a Claude Code session running on this machine (`claude agents`), or an agent
 * that connected — any MCP client, or `vr watch` (heartbeats). Named "session" for the stored assignment's sake.
 */
export interface ClaudeSession {
  name: string | null;
  sessionId: string | null;
  pid: number | null;
  cwd: string | null;
  /** Claude Code's own kind for its sessions (interactive …), or "connected" for agents that announced themselves. */
  kind?: string | null;
  /** Claude Code's own status for its sessions; a connected agent's AgentListenState ("watching" from older servers). */
  status?: string | null;
  startedAt?: number | null;
  /** What kind of agent it is; absent on lists from older servers (read it as Claude Code). */
  agent?: AgentKind;
}

export interface RankedSession extends ClaudeSession {
  score: number;
  reason: string;
}

// ---------------------------------------------------------------- derived media (cache/)

export interface Waveform {
  fps: number;
  /** Peak (0–1) per video frame. */
  peaks: number[];
  rms: number[];
  audio: boolean;
}

export interface Loudness {
  lufs: number | null;
  lra: number | null;
  true_peak: number | null;
}

/**
 * How the picture moves at a hold's edges and inside it (lib/media.ts `freezes`), each a step from one frame to the
 * next in multiples of the still limit — below 1 two frames look the same (FREEZE in lib/findings.ts). `before` and
 * `steady`: the fastest and the slowest step in the quarter second before the last step in (`steady` ≥ 1: the picture
 * moved on every frame of it); `lead` the last step into the hold; `inside` the median step within it (about 0 for
 * copies of one frame); `jump` the first step out of it; `after` the fastest step in the quarter second after that.
 * 0 where there is nothing: the video's start or end.
 */
export interface HoldMotion {
  before: number;
  steady: number;
  lead: number;
  inside: number;
  jump: number;
  after: number;
}

export interface FreezeRange extends FrameRange {
  frames: number;
  min_diff: number;
  /** Absent in a scan from before it was measured (`FreezeScan.v` absent). */
  motion?: HoldMotion;
}

export interface FreezeScan {
  ranges: FreezeRange[];
  frames: number;
  threshold: number;
  min_frames: number;
  /** The detector's rules: 2 watches every patch of the picture too and measures each hold's `motion`; absent: 1. */
  v?: number;
  /** v2: the change (0–255) from which a patch moves, whatever the rest of the picture does. */
  patch_threshold?: number;
}

export interface Analysis {
  loudness: Loudness | null;
  freezes: FreezeScan | null;
  at: string;
}

export interface TrackWord {
  w: string;
  in: number;
  out: number;
  /** in/out are seconds (words.json), else frames at the timeline fps. */
  seconds?: boolean;
}

export interface TrackSegment {
  id: string;
  in: number;
  out: number;
  src: number;
  speed: number;
  audio?: unknown;
}

/** Remotion-style project tracks next to a render (timeline.json / words.json). */
export interface ProjectTracks {
  dir: string;
  timeline: string | null;
  words: TrackWord[] | null;
  segments: TrackSegment[] | null;
  fps?: number;
  wordsFile?: string;
}

// ---------------------------------------------------------------- element maps (lib/elements.ts, docs/agents.md)

/** Where an element is from a frame on: [frame, x, y, w, h], its box in the version's pixels. */
export type ElementKey = [number, number, number, number, number];
/** Frames an element is on screen, both ends included. */
export type ElementRun = [number, number];

/** A named thing on screen (a title, a card, a logo) as the renderer that made the version knows it. */
export interface MapElement {
  /** `[A-Za-z0-9_-]{1,40}`, unique in its map: what notes name (`#title`). */
  id: string;
  name: string;
  /** A free word: text, image, group, shape … */
  kind: string;
  /** By frame; between two keys the box moves in a straight line. */
  keys: ElementKey[];
  /** When it is on screen; absent = from its first key to its last. */
  runs?: ElementRun[];
}

/**
 * Where each named element of a render is, frame by frame, as its renderer wrote it (v1). Kept per version under
 * `data/<slug>/elements/<renderKey>.json`, in the version's pixels; notes are read against it (what their drawing points at).
 */
export interface ElementMap {
  v: 1;
  fps: number;
  /** [width, height]: the version's own once stored (a map at another size is scaled to it). */
  size: [number, number];
  elements: MapElement[];
}

/** What a note points at in its version's map: ids under its drawing, the closest match first; `near` = the element
 * nearest a drawing over empty space ("put it here"). */
export interface NotePointer {
  elements: string[];
  near?: string;
}

/** The notes of a video that point at elements, and those elements' names (`GET /api/review/:slug/elements`). */
export interface ReviewPointers {
  notes: Record<string, NotePointer>;
  names: Record<string, string>;
}

/** A map attached to a version (`PUT /api/review/:slug/versions/:v/elements`, `vr elements`, `vr push --elements`). */
export interface ElementsAttached {
  v: number;
  elements: number;
  /** Keys kept once thinned (a straight line between neighbours within 3 px is one key). */
  keys: number;
  /** The size the map was written at, when it was scaled to the version's. */
  scaled_from?: [number, number];
}

/** The stretch a part render for a note may cover, frames of the newest version (both included): its PART RENDER OK. */
export interface PartOk {
  from: number;
  to: number;
}

// ---------------------------------------------------------------- diff (what changed between two renders)

export interface DiffRange extends FrameRange {
  kind: 'video' | 'audio';
  score?: number;
  box?: Rect | null;
  whole?: boolean;
}

export interface Retime {
  frame: number;
  shift_frames: number;
  seconds: number;
}

export interface DiffSummary {
  changes: number;
  changed_seconds: number;
  audio_changes: number;
  retimes: number;
  identical: boolean;
}

export interface DiffReport {
  diff_version: number;
  old: { v: number; hash: string; frames: number };
  new: { v: number; hash: string; frames: number };
  fps: number;
  ranges: DiffRange[];
  retimes: Retime[];
  summary: DiffSummary;
  ms: number;
  incomparable?: undefined;
}

export interface DiffIncomparable {
  diff_version: number;
  incomparable: string;
  old: { v: number };
  new: { v: number };
}

export type DiffResult = DiffReport | DiffIncomparable;

// ---------------------------------------------------------------- QA pre-review

export type QaKind = 'typo' | 'safe-zone' | 'flash-frame' | 'black-frames' | 'loudness' | 'clipping' | 'silence' | 'freeze';

/**
 * What Auto-check's guess about a finding rests on (lib/findings.ts says when each applies). Freezes: `opening` /
 * `end-card` (a hold on the first or last frames), `held-shot` (still from the shot's first frame: a title, a photo),
 * `pause` (the sound pauses too), `many-holds` (motion graphics pausing on purpose), `eased` (the motion slows into it
 * and goes on without a jump: an animation settling), `still-before` (nothing was moving before it) look intended;
 * `sound-continues` (a stall — the motion stops dead or jumps on after it — while the sound goes on), `mid-shot` (a
 * stall, no sound to go by), `repeated` (one frame shown several times: a hitch) look like a problem. Black frames:
 * `black-gap` (a few frames between shots: a hole in the edit) and `black-dip` (a dip to black: a transition).
 */
export type QaWhy =
  | 'opening'
  | 'end-card'
  | 'held-shot'
  | 'pause'
  | 'many-holds'
  | 'eased'
  | 'still-before'
  | 'sound-continues'
  | 'mid-shot'
  | 'repeated'
  | 'black-gap'
  | 'black-dip';

export interface QaItem {
  /** Stable across re-runs, so a dismissal sticks. */
  key: string;
  kind: QaKind;
  severity: Severity;
  tags: string[];
  frame: number;
  range?: FrameRange;
  text: string;
  detail?: string;
  box?: Rect;
  zone?: string;
  /** Auto-check's guess: it looks intended, or like a problem. Absent: it can't tell (or a result from before). */
  likely?: 'intended' | 'problem';
  /** What the guess rests on. */
  why?: QaWhy;
  /** A summary of several holds (`freeze:short`, `freeze:holds`): each one's frames. */
  holds?: FrameRange[];
  /** typo: the word as read and the spelling suggested (absent when there is none). */
  word?: string;
  guess?: string;
  /** typo, safe-zone: the line of on-screen text it is in. */
  line?: string;
  /** loudness: what was measured, in LUFS (`loudness:lufs`) or dBTP (`loudness:peak`). */
  value?: number;
}

export interface QaResult {
  qa_version: number;
  hash: string;
  at: string;
  duration_ms: number;
  samples: number;
  text_language: string | null;
  items: QaItem[];
  notes?: string[];
  /** The spelling of on-screen text: `checked` (`words` distinct words, none on screen = 0), `skipped` (too many words
   * unknown: a language the dictionaries here don't cover), `unavailable` (no text recognition or speller here).
   * `languages`: what the words were checked in, `text_language` first (lib/text/language.ts); absent in results from
   * before, whose `text_language` was an unchecked guess. */
  spelling?: { state: 'checked' | 'skipped' | 'unavailable'; words: number; languages?: string[] };
}

export interface QaProgress {
  step: string;
  done: number;
  total: number;
}

// ---------------------------------------------------------------- taste

export interface TasteStats {
  videos: number;
  notes: number;
  agent_questions: number;
  versions: number;
  round_trips: number;
  notes_per_version: number;
  open: number;
  by_tag: Record<string, number>;
  by_severity: Partial<Record<Severity, number>>;
  last_note: string | null;
}

export interface Taste {
  scope: string;
  markdown: string;
  stats: TasteStats;
  generated: string;
}

/** Which reviews a taste file covers. */
export interface TasteScope {
  folder?: string | null;
  project?: string | null;
  title?: string;
}

/** A recurring ask from the taste file, offered as a rule for a playbook ("You've asked for this 4×"). */
export interface TasteSuggestion {
  /** The tag the notes share (e.g. "logo", "timing"). */
  tag: string;
  count: number;
  /** Newest distinct examples: the note id, its text and the video it is on. */
  examples: { id: string; text: string; video: string }[];
}

// ---------------------------------------------------------------- playbooks (lib/playbooks.ts, docs/playbooks.md)

/**
 * A playbook's scope: '' = the House playbook (the whole studio), else a folder path ("ACME", "ACME/REELS"). A folder
 * inherits every playbook above it; the deeper one wins where they disagree.
 */
export type PlaybookScope = string;

/** The sections people write in markdown. */
export type PlaybookText = 'brief' | 'rules';

/** What a revision or a proposal changes: a text section, one skill (by name), or the references. */
export type PlaybookSection = PlaybookText | 'refs' | `skill:${string}`;

/** A small file that comes with a skill (an export preset, a LUT, a script): stored and served, never run by Lampo. */
export interface PlaybookSkillFile {
  name: string;
  size: number;
  at: string;
  by: string;
}

/** An Agent Skill (the open SKILL.md format): a name, when to use it, and the instructions. */
export interface PlaybookSkill {
  /** sk_ + hex: stays when the skill is renamed (its files are stored under it). */
  id: string;
  /** Lowercase letters, digits and hyphens (the Agent Skills naming rule). */
  name: string;
  description: string;
  body: string;
  /** Other frontmatter lines of an imported SKILL.md (license, metadata …), kept as they were. */
  extra?: string;
  files: PlaybookSkillFile[];
  updated: string;
  by: string;
}

/** One saved change. `before`/`after` hold the section's text (a skill: its SKILL.md; references: a summary). */
export interface PlaybookRevision {
  rev: number;
  at: string;
  /** Who made the change; for an accepted proposal, the agent that suggested it. */
  by: string;
  /** An accepted proposal: the person who accepted it. */
  accepted_by?: string;
  proposal?: string;
  message: string;
  section: PlaybookSection;
  before: string | null;
  after: string | null;
}

/** A change an agent (or a person without the right to edit) suggests; a person accepts or rejects it. */
export interface PlaybookProposal {
  /** pp_ + hex. */
  id: string;
  scope: PlaybookScope;
  at: string;
  by: string;
  section: PlaybookText | `skill:${string}`;
  /** The whole new text of the section (a skill: its SKILL.md). */
  content: string;
  reason: string;
  /** Notes that led to it (comment ids). */
  evidence: string[];
  /** The playbook's revision when it was suggested. */
  base_rev: number;
  status: 'pending' | 'accepted' | 'rejected';
  decided_by?: string;
  decided_at?: string;
  /** Why it was rejected, for the agent to read. */
  reject_reason?: string;
  /** Accepted: the revision it became. */
  rev?: number;
}

/** data/playbooks/<file>.json: one playbook. */
export interface Playbook {
  /** Stable id (the stored files live under playbooks/<id>/), survives renaming the folder. */
  id: string;
  scope: PlaybookScope;
  rev: number;
  updated: string | null;
  by: string | null;
  brief: string;
  rules: string;
  /** Images, links and moments of renders in the library (NoteRef shapes; files under playbooks/<id>/refs/). */
  refs: NoteRef[];
  skills: PlaybookSkill[];
  /** Newest last; the oldest are dropped past a limit. */
  history: PlaybookRevision[];
  /** Pending ones, and the latest decided ones. */
  proposals: PlaybookProposal[];
}

/** Which playbook revisions a render was made with (House first, down to its folder). */
export interface PlaybookStamp {
  scope: PlaybookScope;
  rev: number;
}

/** A skill as a list shows it: without the body. */
export interface PlaybookSkillSummary {
  name: string;
  description: string;
  files: PlaybookSkillFile[];
  updated: string;
  by: string;
}

/** One playbook above the one asked for (House, then each parent folder). */
export interface PlaybookLayer {
  scope: PlaybookScope;
  rev: number;
  brief: string;
  rules: string;
  refs: NoteRef[];
  skills: PlaybookSkillSummary[];
}

/** GET /api/playbook: a playbook with what it inherits, and what an agent reads. */
export interface PlaybookView {
  scope: PlaybookScope;
  /** "House" or the folder path. */
  label: string;
  playbook: Playbook;
  /** The playbooks above it, House first (only the ones with content). */
  layers: PlaybookLayer[];
  /** Every skill that applies here, the deepest of a name winning, with where it comes from. */
  skills: (PlaybookSkillSummary & { from: PlaybookScope })[];
  /** Revisions of the chain, House first: what a render made now is stamped with. */
  stamp: PlaybookStamp[];
  /** The merged playbook as markdown, the way agents read it. */
  markdown: string;
  /** Recurring asks from the taste file that aren't rules yet (people who may edit only). */
  suggestions?: TasteSuggestion[];
}

/** GET /api/playbook/skill: one skill as it applies somewhere, with its SKILL.md. */
export interface PlaybookSkillView extends PlaybookSkillSummary {
  body: string;
  extra?: string;
  /** The playbook it comes from. */
  from: PlaybookScope;
  markdown: string;
}

/** GET /api/playbook/proposals/:id: a suggestion with the text it would replace. */
export interface PlaybookProposalView extends PlaybookProposal {
  current: string;
}

/** GET /api/playbooks: every playbook with content, for badges and the folder list. */
export interface PlaybookSummary {
  scope: PlaybookScope;
  rev: number;
  updated: string | null;
  skills: number;
  pending: number;
}

// ---------------------------------------------------------------- status workflow (lib/stage.ts, docs/workflow.md)

/**
 * Where a video stands. One function decides it (lib/stage.ts), from the notes, the verdicts on the newest version, the
 * final mark and whether a review link covers the video.
 */
export type Stage = 'to_review' | 'changes' | 'in_progress' | 'check_fixes' | 'team_approved' | 'with_client' | 'client_approved' | 'final';

/** What moves the video on. */
export type NextStepKind = 'review' | 'carry' | 'fix' | 'assign' | 'wait_agent' | 'verify' | 'send' | 'wait_client' | 'finalize' | 'reopen' | 'none';
export interface NextStep {
  kind: NextStepKind;
  label: string;
}

export interface StageInfo {
  stage: Stage;
  /** The newest version. */
  v: number;
  /** One line for people: "Approved V6 by the team", "Final V5 · V6 arrived since". */
  detail: string;
  /** The newest team verdict on the newest version (withdrawn = none). */
  team: ApprovalEntry | null;
  /** The newest client verdict on the newest version. */
  client: ApprovalEntry | null;
  final: FinalMark | null;
  /** An approval of an older version while the newest has no verdict yet ("V6 approved · V7 new"). */
  approval_stale: ApprovalEntry | null;
  /** The newest version is identical to the approved one (version diff): the approval can be carried over. */
  identical_to_approved: boolean;
  /** Final, and a newer render arrived since: its version number. */
  final_superseded: number | null;
  /** Required notes still open (ideas, questions and info notes don't count). */
  open: number;
  /** Fixes waiting for verification. */
  to_verify: number;
  /** Questions from agents waiting for an answer. */
  questions: number;
  /** Notes verified on a fix preview whose fix no render contains yet (optional: absent from older servers). */
  on_preview?: number;
  /** An active review link covers the video. */
  linked: boolean;
  /** What the client did with the link that covers the video (absent: no active link, or unknown to this caller). */
  share?: ShareSignal | null;
  /** The newest version is a partial render (lib/part.ts): reviewed like any version, never final. */
  part?: { of: number; at: number; frames: number };
  /** A final video's posts on platforms (lib/publish/posts.ts), absent when there are none. */
  published?: PublishedSignal;
  next: NextStep;
}

/**
 * The review link behind a stage, as far as anyone can tell: shared is not seen. "With the client" (stage with_client)
 * needs a visitor to have had the newest version in front of them; the team previewing its own link doesn't count.
 */
export interface ShareSignal {
  label: string;
  kind: 'video' | 'folder';
  /** A visitor opened the newest version through the link. */
  opened: boolean;
  /** Views of this video through the link (older stats without per-video views: the link's opens). */
  opens: number;
  last_opened: string | null;
  /** The newest version a visitor had in front of them; null when unknown or never. */
  seen_v: number | null;
  /** Who opened it last, when they gave a name. */
  by: string | null;
  /** Names visitors gave on this link, newest last. */
  reviewers: string[];
  /** The furthest a visitor got through the newest version (0 … 1), and who; absent when nobody watched it yet. */
  watched?: number | null;
  watched_by?: string | null;
}

/** One row of the status overview. */
export interface StatusVideo {
  slug: string;
  name: string;
  folder: string | null;
  project: string;
  v: number;
  /** The newest render's key (lib/renderKey.ts; poster URL). */
  hash: string | null;
  width: number;
  height: number;
  updated: string | null;
  stage: StageInfo;
}

export interface StatusFolder {
  /** null = Unsorted. Top-level folders include everything below them. */
  folder: string | null;
  counts: Record<Stage, number>;
  total: number;
}

export interface StatusResponse {
  videos: StatusVideo[];
  folders: StatusFolder[];
  counts: Record<Stage, number>;
}

// ---------------------------------------------------------------- insights

export interface Insights {
  totals: { videos: number; notes: number; renders: number; rendersPerVideo: number | null; approved: number; rendersToApproval: number | null };
  tags: { tag: string; n: number }[];
  severity: Record<Severity, number>;
  status: Record<CommentStatus, number>;
  perRender: { render: number; videos: number; avg: number | null }[];
  turnaround: { fixHours: number | null; verifyHours: number | null; fixed: number; reopenRate: number | null };
  projects: { project: string; videos: number; notes: number; open: number; renders: number; approved: number; rendersPerVideo: number | null }[];
  /** The Insights page, for one period (optional: servers from before it). */
  board?: InsightsBoard;
}

/** The periods the Insights page offers. */
export type InsightsPeriod = '7d' | '30d' | '90d' | 'all';

/** One number of the page's Speed row, in the period, with the period of the same length before it. */
export interface InsightsMetric {
  /** The value in the period; null without data. */
  value: number | null;
  /** Data points behind it (fixes, checks, approvals). */
  n: number;
  /** The period of the same length before; null for all time. */
  before: { value: number | null; n: number } | null;
  /** The period against the one before, relative (-0.4 = 40 % less); null unless both have `minPoints`. */
  change: number | null;
  /** The value per bucket across the period (`bucketDays` each), oldest first; null where a bucket has no data. */
  spark: (number | null)[];
}

export interface InsightsSpeed {
  /** Median hours from a note to its fix (the agent's part), by when the fix came. */
  fix: InsightsMetric;
  /** Median hours from a fix to its check (yours), by when it was checked. */
  check: InsightsMetric;
  /** Average render number a video was approved on, by when it was approved. */
  renders: InsightsMetric;
  /** Share (0–1) of the period's fixes that came back: `count` of `of`. */
  cameBack: InsightsMetric & { count: number; of: number };
}

/** Whom a video waits for: its stage's next step (lib/stage.ts). */
export type InsightsWaitingOn = 'you' | 'agents' | 'client';

/** A video that needs a push now. Approved and final videos never do. */
export interface InsightsAttention {
  slug: string;
  video: string;
  folder: string | null;
  /** The newest render's key (lib/renderKey.ts; poster URL). */
  hash: string | null;
  waitingOn: InsightsWaitingOn;
  /** The one reason it is listed, the most pressing: fixes wait for a check, fixes keep coming back, many renders
   * without approval, nothing happened for a while. */
  reason: 'fixes' | StalledReason;
  /** Fixes waiting (fixes), fixes that came back and aren't settled (reopened), renders (rounds). */
  count: number;
  /** Hours since anything happened on the video (a note, a reply, a render, a verdict). */
  waitingHours: number;
  /** The first fix waiting for a check: verify mode opens at it (reason fixes). */
  verify: string | null;
  /** The agent the video is handed to, if any: it can be nudged. */
  agent: string | null;
}

export interface InsightsExample {
  id: string;
  slug: string;
  video: string;
  v: number;
  frame: number;
  timecode: string;
  text: string;
  created: string;
}

export interface InsightsTopic {
  tag: string;
  /** Feedback notes in the period with this topic. */
  n: number;
  /** Up to three real notes, different videos first; a note appears under its biggest topic only. */
  examples: InsightsExample[];
}

export interface InsightsPatterns {
  /** Feedback notes written in the period. */
  notes: number;
  /** Of them, the ones with a topic (kinds like idea or love-it aren't topics). */
  tagged: number;
  /** Topics are listed only when at least this share of the notes has one. */
  minCoverage: number;
  /** Biggest first; empty when too few notes have a topic to see a pattern. */
  topics: InsightsTopic[];
  /** Feedback notes written in the period, by severity. */
  severity: Record<Severity, number>;
}

export interface InsightsProject {
  project: string;
  videos: number;
  /** Feedback notes written in the period. */
  notes: number;
  /** Required notes open now. */
  open: number;
  /** Renders registered in the period. */
  renders: number;
  /** Videos approved in the period. */
  approved: number;
}

export interface InsightsBoard {
  period: InsightsPeriod;
  /** Days in the period; null = all time. */
  days: number | null;
  /** When the period starts; null = all time without data. */
  from: string | null;
  /** Days per sparkline bucket. */
  bucketDays: number;
  /** Where the last sparkline bucket ends: the viewer's next midnight (`?tz=`), so buckets are whole days. Bucket i of n
   * covers [sparkEnd − (n − i) · bucketDays, sparkEnd − (n − 1 − i) · bucketDays), clipped to the period. */
  sparkEnd?: string;
  /** Data points each period needs before a trend is shown. */
  minPoints: number;
  speed: InsightsSpeed;
  /** Needs attention now (not bound to the period), you first. Deprecated: the Insights page no longer shows it; what
   * it had that the inbox didn't is the inbox's "Stalled" group (For-you kind `stalled`). Kept for API users. */
  attention: InsightsAttention[];
  /** Everything that needs attention (the list stops at a few). Deprecated with `attention`. */
  attentionTotal: number;
  patterns: InsightsPatterns;
  projects: InsightsProject[];
  /** Who watched what in the period, the team and review-link visitors (servers from before have none). */
  watching?: InsightsWatching;
  /** Where the loop's time goes: whom videos waited on in the period, and what waits longest now. */
  flow?: InsightsFlow;
  /** Per agent, over the fixes of the period. */
  agents?: InsightsAgent[];
  /** What keeps coming back across videos, and the playbook it would go into. */
  repeats?: InsightsRepeat[];
  /** Versions to approval in the period: the page's headline (servers from before have only `flow.rounds`). */
  toApproval?: InsightsToApproval;
  /** What caused the period's rounds: each new version that followed notes, by the notes' topics. */
  causes?: InsightsCauses;
  /** Fixes marked "Still wrong" in the period, by topic and by agent. */
  stillWrong?: InsightsStillWrong;
  /** How long a round took (one version to the next), and whom it waited on meanwhile. */
  turnaround?: InsightsTurnaround;
  /** All agents' fixes together: the share that looked right the first time. */
  firstTime?: InsightsFirstTime;
}

/** How many versions videos took to be approved: the mean and median of the approvals in the period, by when they
 * were approved (a partial render isn't a version here: it is a quick check, not a round). */
export interface InsightsToApproval {
  mean: number | null;
  median: number | null;
  /** Videos approved in the period. */
  n: number;
  /** The period of the same length before; null for all time. */
  before: { mean: number | null; median: number | null; n: number } | null;
  /** Versions to approval worth aiming for (the page's target line). */
  target: number;
  /** Approvals the page wants before it speaks of a figure. */
  minApprovals: number;
  /** Per project (a top-level folder; "" = none), the most versions first: approvals in the period, and the videos still
   * open with the version they are on (`openMean`, full versions on average). */
  projects: { project: string; mean: number | null; median: number | null; n: number; open: number; openMean: number | null }[];
  /** Videos not approved yet that moved in the period, and the version they are on, on average. */
  open: { videos: number; mean: number | null };
}

/** One topic behind the period's rounds. */
export interface InsightsCause {
  /** The topic: a note's tag (lib/autotag.ts tags: sfx, timing, text/typo, …), else the one its words suggest. */
  tag: string;
  /** Rounds whose notes raised it; `share` = of the rounds that followed notes (a round with two topics counts for both). */
  rounds: number;
  share: number;
  /** Notes on it behind those rounds; of them must-fix ones, and ones that came back as still wrong. */
  notes: number;
  must: number;
  back: number;
  /** The playbook a rule goes into ('' = the House's, else a project) and whether a rule there says it already. */
  scope: string;
  covered: boolean;
  /** A few of its notes, newest first, one per video first. */
  examples: { id: string; slug: string; video: string; v: number; frame: number; text: string }[];
}

export interface InsightsCauses {
  /** New full versions in the period (a round: one version to the next). */
  rounds: number;
  /** Of them, the ones that followed notes (written, or reopened as still wrong, since the version before). */
  withNotes: number;
  /** Rounds that followed notes without a topic. */
  untagged: number;
  /** Rounds by the most severe note behind them. */
  severity: Record<Severity, number>;
  /** The most rounds first. */
  topics: InsightsCause[];
  /** Rounds that followed notes the page wants before it ranks topics. */
  minRounds: number;
  /** The period of the same length before; null for all time. */
  before: { rounds: number; withNotes: number; top: { tag: string; rounds: number; share: number } | null } | null;
}

/** A note that came back as still wrong. */
export interface InsightsBackNote {
  id: string;
  slug: string;
  video: string;
  v: number;
  frame: number;
  text: string;
  /** What the person said when they reopened it. */
  reason: string | null;
  at: string;
}

export interface InsightsStillWrong {
  /** Fixes reopened as still wrong in the period, and fixes made in it. */
  count: number;
  fixes: number;
  /** By the note's topic ("untagged" for none), the most first: the agents whose fixes came back, and the newest note. */
  topics: { tag: string; n: number; agents: { name: string; kind?: AgentKind; n: number }[]; example: InsightsBackNote | null }[];
  /** By the agent whose fix came back, the most first: its topics and its newest note. */
  agents: { name: string; kind?: AgentKind; n: number; topics: { tag: string; n: number }[]; example: InsightsBackNote | null }[];
  before: { count: number; fixes: number } | null;
}

/** Rounds that ended in the period: from one full version to the next, how long, and whom the video waited on. */
export interface InsightsTurnaround {
  rounds: number;
  /** Median hours per round, all of it and each party's part. */
  median: number | null;
  parties: Record<InsightsWaitingOn, number | null>;
  /** Each party's share of all the rounds' time (0–1). */
  share: Record<InsightsWaitingOn, number>;
  before: { rounds: number; median: number | null } | null;
}

export interface InsightsFirstTime {
  /** First fixes checked in the period, and of them the ones that looked right before any "still wrong". */
  checked: number;
  right: number;
  rate: number | null;
  before: { checked: number; right: number; rate: number | null } | null;
}

/** One viewer of one video, as the Insights list shows them. */
export interface InsightsWatchViewer {
  key: string;
  kind: 'person' | 'client';
  name: string | null;
  /** Sittings and seconds on every version of the video. */
  sessions: number;
  secs: number;
  /** Share of the newest version they watched (0 … 1); null when they only saw an older one. */
  watched: number | null;
  last: string;
  /** The account asking: Insights says "You" for it. */
  you?: boolean;
  /** A client: the version they watched last and the share of it they played, the review link they came through, how
   * often each hundredth of it played for them, and the stretch they watched again and again (servers from before have
   * none). */
  v?: number;
  vWatched?: number;
  link?: string | null;
  plays?: number[];
  again?: { from: number; to: number; plays: number } | null;
}

export interface InsightsWatchedVideo {
  slug: string;
  video: string;
  folder: string | null;
  /** The newest render's key (poster URL). */
  hash: string | null;
  /** The newest version. */
  v: number;
  /** Everyone who watched it in the period, the most recent first. */
  viewers: InsightsWatchViewer[];
  people: number;
  clients: number;
  /** Sittings and seconds, all viewers together. */
  views: number;
  secs: number;
  /** Of the viewers of the newest version, how much of it they watched on average (0 … 1); null when nobody has yet. */
  completion: number | null;
  /** The newest version's retention curve (lib/watch.ts retentionOf); empty when nobody watched it. */
  retention: number[];
  /** How many of the newest version's viewers played each hundredth of it (lib/watch.ts heatOf; `seenBy` is the
   * whole); empty when nobody watched it. Servers from before send only `retention`. */
  heat?: number[];
  /** How often each hundredth of the newest version played, its viewers together (lib/watch.ts playsOf). */
  plays?: number[];
  /** How many viewers watched the newest version: the scale `heat` counts on. */
  seenBy?: number;
  /** Stretches of the newest version watched again and again. */
  rewatched: { from: number; to: number; plays: number }[];
  last: string;
  /** The newest version's length in seconds (a stretch's hundredths as times). */
  duration?: number | null;
  /** The newest version anyone watched in the period: below `v` when the newest isn't watched yet. */
  seenV?: number | null;
}

/** One person across videos: what they watched in the period, how often and how long. */
export interface InsightsWatchPerson {
  key: string;
  kind: 'person' | 'client';
  name: string | null;
  videos: number;
  views: number;
  secs: number;
  last: string;
  /** Their most watched videos first (a few). */
  top: { slug: string; video: string; views: number; secs: number }[];
  /** The account asking: Insights says "You" for it. */
  you?: boolean;
}

/** A review link nobody has opened yet. */
export interface InsightsUnopened {
  label: string;
  /** What it covers: a video (slug + name) or a folder. */
  slug: string | null;
  video: string | null;
  folder: string | null;
  created: string;
}

export interface InsightsWatching {
  videos: InsightsWatchedVideo[];
  people: InsightsWatchPerson[];
  unopened: InsightsUnopened[];
  /** In the period: distinct viewers, sittings, seconds. */
  viewers: number;
  views: number;
  secs: number;
}

/** Whom videos waited on in the period: hours in total, and on average per video that waited on them. */
export interface InsightsFlow {
  hours: Record<InsightsWaitingOn, number>;
  perVideo: Record<InsightsWaitingOn, number | null>;
  videos: Record<InsightsWaitingOn, number>;
  /** The version videos were approved on, on average (the same number as speed.renders). */
  rounds: InsightsMetric;
  /** Waiting longest right now (not bound to the period), the longest first. */
  stuck: InsightsStuck[];
}

export interface InsightsStuck {
  slug: string;
  video: string;
  folder: string | null;
  hash: string | null;
  waitingOn: InsightsWaitingOn;
  /** Hours since the wait began. */
  hours: number;
  /** What it waits for, in the stage's words (lib/stage.ts next.label). */
  label: string;
  /** The next step's kind (lib/stage.ts), so the UI can say it in its own words. */
  kind?: NextStepKind;
  /** The agent the video is assigned to: whom a nudge goes to. */
  agent?: string | null;
}

export interface InsightsAgent {
  /** The agent's name (a session name: "launch-edit"). */
  name: string;
  /** What kind of agent it is (its mark): from a video it is assigned to, else a connected agent of that name; absent
   * when neither says (and from servers before it). */
  kind?: AgentKind;
  /** Fixes it made in the period. */
  fixes: number;
  /** Of them, the ones someone has checked: `right` looked right the first time. */
  checked: number;
  right: number;
  /** right / checked; null before anything was checked. */
  rate: number | null;
  /** Median hours from a note (or its reopening) to the fix. */
  fixHours: number | null;
  /** Questions it asked in the period. */
  questions: number;
  /** Topics of its fixes that came back as still wrong, most first. */
  wrongTopics: { tag: string; n: number }[];
}

export interface InsightsRepeat {
  tag: string;
  /** Notes with the tag, and the videos they are on. */
  count: number;
  videos: number;
  /** The playbook a rule would go into: '' = the House's, else a project (a top-level folder). */
  scope: string;
  /** A rule for this is already written there (or above). */
  covered: boolean;
  examples: { id: string; text: string; video: string }[];
}

// ---------------------------------------------------------------- HTTP API shapes (server/routes → web)

/** A video card in the library. */
export interface VideoSummary {
  slug: string;
  video: string;
  name: string;
  project: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  frames: number;
  v: number | undefined;
  /** The newest render's key (lib/renderKey.ts; poster and sprite URLs). */
  hash: string | undefined;
  versions: number;
  counts: Counts;
  session: AssignedSession | null;
  folder: string | null;
  approval: Approval | null;
  /** Where the video stands (lib/stage.ts). */
  stage: StageInfo;
  agent_status: AgentStatus | null;
  /** null = no session assigned; else whether that session is running (a connected agent: listening or working). */
  sessionActive: boolean | null;
  /**
   * Whether the assigned agent hears new notes by itself: true while it waits for them (`wait_for_feedback`, `vr
   * watch`), false for an agent connected over MCP that doesn't (it acts when a person tells it to), null when Lampo
   * can't tell (no agent, a Claude Code session on this machine). Absent from older servers.
   */
  sessionListening?: boolean | null;
  mtime: string | null;
  missing: boolean;
  archived: string | null;
  added: string;
  updated: string | undefined;
  lastComment: string;
  /** The first run's sample (Review.onboarding_sample): marked as one wherever it shows, removed in one click. */
  sample?: true;
}

export interface LibraryResponse {
  videos: VideoSummary[];
  folders: string[];
  /**
   * What is shown in part only: `folders` — the workspace's folders.json can't be read right now, so `folders` holds only
   * the folders videos are filed in (no empty ones) and folders can't be changed until it can (`vr admin
   * repair-folders`). Absent: everything as it is.
   */
  degraded?: 'folders'[];
}

/** GET /api/search?q=: the ⌘K palette. Best match first in each group, at most `limit` per group. */
export interface SearchResponse {
  q: string;
  /** Without a query: the most recently changed videos, and no folders or notes. */
  videos: SearchVideo[];
  folders: SearchFolder[];
  notes: SearchNote[];
}

export interface SearchVideo {
  slug: string;
  name: string;
  folder: string | null;
  v: number;
  stage: Stage;
  stage_label: string;
  /** Detail line of the stage ("Approved V3 · opened by Mia 2 h ago"). */
  stage_detail: string;
  width: number;
  height: number;
  poster: string;
  updated: string | null;
}

export interface SearchFolder {
  /** The full path ("Acme/Reels"). */
  folder: string;
  /** Its last segment ("Reels"). */
  name: string;
  /** Videos filed in it or below it (archived ones don't count). */
  videos: number;
}

export interface SearchNote {
  id: string;
  slug: string;
  /** The video's file name. */
  video: string;
  v: number;
  frame: number;
  timecode: string;
  text: string;
  author: string;
  status: CommentStatus;
  kind: 'feedback' | 'question' | 'info' | 'agent';
  severity: Severity;
  created: string;
  /** The query matched a reply rather than the note itself: that reply's text. */
  reply: string | null;
}

/** Playback state of one version: `scrub` says whether the short-GOP copy is used. */
export interface MediaInfo {
  url: string | null;
  ready: boolean;
  preparing: boolean;
  /** The copy waits for room in a busy server's job queue (lib/jobs.ts); the server asks for it again by itself and says when it is queued. */
  busy?: boolean;
  proxy: boolean;
  scrub: 'ready' | 'native' | 'building' | null;
  error: string | null;
}

export interface ReviewResponse {
  slug: string;
  review: Review;
  summary: VideoSummary;
  /** Every verdict, oldest first (migrated from `approval` for older stores); final/reopen are in `review.finals`. */
  approvals: ApprovalEntry[];
  media: Record<number, MediaInfo>;
  dataDir: string;
  user: string;
}

export interface BrowseEntry {
  name: string;
  path: string;
  type: 'dir' | 'video';
  size?: number;
  mtime?: string;
  reviewed?: boolean;
}

export interface BrowseResponse {
  dir: string;
  parent: string | null;
  home: string;
  dev: string;
  entries: BrowseEntry[];
}

export interface SessionsResponse {
  sessions: RankedSession[];
  at: number;
  refreshing: boolean;
}

export interface GuestNote {
  id: string;
  v: number;
  frame: number;
  /** The note's frame in the version being shown (renders can change length). */
  frameHere: number;
  /** A note about a stretch of the video: its frames in the note's own version, and in the version being shown. */
  range?: FrameRange;
  rangeHere?: FrameRange | null;
  timecode: string;
  text: string;
  author: string;
  status: CommentStatus;
  /** Marked "just an idea" by the client. */
  idea: boolean;
  fixed_in_v: number | null;
  created: string;
  drawing: Shape[];
  marked: string | null;
  /** Made through this link. */
  mine: boolean;
  replies: { by: string; text: string; status?: CommentStatus; at: string; refs?: string[] }[];
  /** References the link may show: images, clips, links, and moments of videos this link covers. */
  refs?: GuestRef[];
  /** About the whole video. */
  scope?: 'video';
  /** A note that changes the words said in its range. */
  text_edit?: TextEdit;
}

/** A reference on a note as a review link shows it: files by this link's URLs, other videos by this link's ids. */
export interface GuestRef {
  id: string;
  kind: NoteRef['kind'];
  caption: string | null;
  /** Who added it, as the client sees them ("editor" for agents). */
  by: string;
  /** Added through this link (the visitor may remove it). */
  mine: boolean;
  /** image / clip: the file; image / clip / frame: the still. */
  src: string | null;
  still: string | null;
  width: number | null;
  height: number | null;
  duration: number | null;
  url: string | null;
  site: string | null;
  /** frame: the video's id within this link, and where. */
  video: string | null;
  name: string | null;
  v: number | null;
  frame: number | null;
  to_frame: number | null;
  timecode: string | null;
  fps: number | null;
}

/** What a link lets its visitors do (ShareSettings without the expiry). */
export type GuestPerms = Omit<ShareSettings, 'expires'>;

/** A video behind a link: the room view of a folder link lists these. */
export interface GuestVideo {
  /** The video's id within this link (`v_…`, opaque): never the owner's slug, which is a disk path in local mode. */
  slug: string;
  name: string;
  /** Where it sits below the folder a folder link shares (`Reels/Cutdowns`); null right in it, and for a video link. */
  folder: string | null;
  v: number;
  duration: number;
  width: number;
  height: number;
  poster: string;
  /** The newest render's hover-scrub sprite (lib/sprite.ts layout); answers 202 until it is made. */
  sprite?: string;
  approval: Approval | null;
  /** Client notes this link shows for the video. */
  notes: number;
  open: number;
  /** Marked fixed, waiting for the client to confirm. */
  check: number;
  updated: string;
}

/** GET /api/g/<token>: the link itself. Locked links (password) only say so. */
export interface GuestLinkResponse {
  /** The link's own name (lib/shares.ts guestLabel): '' when it was given none — a default isn't shown as a name. */
  label: string;
  /** Who shared the link (their display name); null when they haven't chosen one (a machine's owner named after its OS account). */
  reviewer: string | null;
  /** Their profile picture, when they have one (optional; older servers leave it out). */
  reviewer_avatar?: string | null;
  /** The team's name, when the instance has one (config org_name). */
  org?: string | null;
  kind: 'video' | 'folder';
  /** A folder link's own folder, by its name only (never the folders above it); null for a video link and while locked. */
  folder: string | null;
  locked: boolean;
  expires: string | null;
  perms: GuestPerms;
  videos: GuestVideo[];
  /** Where this instance's source is (config source_url, AGPL-3.0 §13): the page links to it. Optional; older servers
   * leave it out. */
  source?: string | null;
  /**
   * "Powered by Lampo" at the page's foot: shown unless the link's workspace is on a plan that may hide it and its admins
   * did (A13 CLOUD-7). Absent (older servers): shown.
   */
  badge?: boolean;
  /** The operator's imprint and privacy policy (VR_IMPRINT_URL, VR_PRIVACY_URL), linked at the page's foot; null: none. */
  imprint_url?: string | null;
  privacy_url?: string | null;
}

/** What a review link's foot says (guest/PoweredBy.tsx): the source offer, the badge, the operator's legal pages. */
export type GuestFoot = Pick<GuestLinkResponse, 'source' | 'badge' | 'imprint_url' | 'privacy_url'>;

/** GET/PUT /api/workspaces/current/badge: "Powered by Lampo" on the workspace's review links (A13 CLOUD-7). */
export interface BadgeSetting {
  /** The links show it now. */
  shown: boolean;
  /** Its admins chose to hide it (kept while the plan can't: then it shows anyway). */
  hidden: boolean;
  /** The workspace's plan lets it be hidden (a paid plan, where a billing provider runs). */
  may: boolean;
}

/** What a visitor sees of one video behind a link. */
export interface GuestReviewResponse {
  /** As in GuestLinkResponse: '' when the link has no name of its own. */
  label: string;
  /** The video's id within this link, as in GuestVideo. */
  slug: string;
  name: string;
  reviewer: string | null;
  reviewer_avatar?: string | null;
  org?: string | null;
  v: number;
  latest: number;
  fps: number;
  width: number;
  height: number;
  frames: number;
  duration: number;
  /** What the player plays: null while its copy is being made (then `preparing`, and the page asks again soon). */
  media: string | null;
  preparing?: boolean;
  /** The copy waits for room in a busy server's job queue: ask again less often (the server asks for it by itself). */
  busy?: boolean;
  waveform: string;
  approval: Approval | null;
  perms: GuestPerms;
  /** The versions a visitor may switch between (just the shown one for 'latest' links). `width`/`height`: the frame
   * size, which a note's marked frame on that version has (its card keeps the room before the picture arrives).
   * Optional: older servers leave them out. */
  versions: { v: number; registered: string; width?: number; height?: number }[];
  download: { preview: string | null; original: string | null };
  notes: GuestNote[];
}

/**
 * The other side of a compare on a review link (GET /api/g/:token/review/:slug/compare?v=): what a player needs to
 * play that version beside the one on screen, nothing more — no notes, no verdict, no downloads. Only links that show
 * every version answer it.
 */
export interface GuestCompareResponse {
  v: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  /** As in GuestReviewResponse: null while its copy is being made (then `preparing`). */
  media: string | null;
  preparing?: boolean;
  busy?: boolean;
}

/** A chapter of a version: where it starts (a frame) and what the render's own chapter marker calls it. */
export interface Chapter {
  frame: number;
  title: string;
}

/**
 * GET /api/g/:token/embed: what the embed player (/e/<token>) needs to play an Embed link's video, nothing more — the
 * newest version's frame facts, its media, poster and hover frames, its chapters and captions when it has them, and
 * whether the badge shows. Never notes, verdicts, names of people, folders or downloads. Other links answer 404.
 */
export interface EmbedResponse {
  /** The video's file name, as a Watch only visitor sees it. */
  title: string;
  /** The video's id within the link, as in GuestVideo (the watch reports name it). */
  slug: string;
  v: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  duration: number;
  /** As in GuestReviewResponse: null while its copy is being made (then `preparing`, and the page asks again soon). */
  media: string | null;
  preparing?: boolean;
  busy?: boolean;
  poster: string;
  /** The hover frames (lib/sprite.ts layout); answers 202 until made. */
  sprite: string;
  /** The render's own chapter markers, first frame first; empty when it has none. */
  chapters: Chapter[];
  /** WebVTT of what is said, when the version's transcript exists; null otherwise. */
  captions: string | null;
  /** The language the captions were heard in (ISO 639-1), when known. */
  captions_lang?: string | null;
  /** The Lampo mark in the corner, as `badge` in GuestLinkResponse (A13 CLOUD-7). */
  badge: boolean;
}

/** GET /oembed?url=…&format=json for an Embed link (oEmbed 1.0, type video). */
export interface OEmbedResponse {
  version: '1.0';
  type: 'video';
  title: string;
  html: string;
  width: number;
  height: number;
  thumbnail_url: string;
  thumbnail_width: number;
  thumbnail_height: number;
  /** Only while the badge shows (the workspace didn't hide it). */
  provider_name?: string;
  provider_url?: string;
}

export interface InfoResponse {
  lan: boolean;
  urls: string[];
  qr: string | null;
  user: string;
  /** Speech-to-text is available for voice notes (any engine; the name is kept for older clients). */
  whisper: boolean;
  /** Speech engine details (backend, state, model, device). */
  stt?: {
    backend: 'local' | 'http' | 'off';
    available: boolean;
    state: string;
    model: string | null;
    device: string | null;
    error: string | null;
    /** 0–1 while the speech model downloads (first use), null otherwise. */
    progress?: number | null;
    /** Languages the engine listens for (config `stt.languages`), the first one the fallback; empty: any. */
    languages?: string[];
  };
  /** Paths on the machine, for its owner only; empty on a hosted server and for anyone else. */
  dataDir: string;
  home: string;
  root: string;
  /** local: the app runs on the person's own machine; server: a hosted instance. Ask `capabilities` for what works. */
  mode: 'local' | 'server';
  /** What the machine adds to the hosted app (all false on a hosted server). */
  capabilities: Capabilities;
  /** What this server can do, so the UI shows only what works (kept for older clients; see `capabilities`). */
  features: InfoFeatures;
  /** The configured public URL (server mode), for share links and `vr login`. */
  public_url: string | null;
  /**
   * A hosted server's own media host (VR_MEDIA_ORIGIN), to someone signed in: one-time upload URLs point there, so a chat
   * app's sandbox must be allowed to reach it (Settings → Connect an agent). Not a secret: every signed URL and the
   * page's CSP name it.
   */
  media_origin?: string;
  /** Where the source code of this instance is (AGPL-3.0 §13), or null when none is configured. */
  source_url?: string | null;
  version: string;
  /** Email flows work here (a public URL to build links from): forgot password, invites by email, confirming addresses. */
  mail?: boolean;
  /** Admins only: how mail leaves — `log` writes it to the server's outbox instead of sending it (no VR_SMTP_URL). */
  mail_transport?: 'log' | 'smtp';
  /** Who may sign up on their own (VR_SIGNUP): off, invite (addresses with a pending invite), open. */
  signup?: 'off' | 'invite' | 'open';
  /** The operator's terms and privacy policy (VR_TERMS_URL, VR_PRIVACY_URL): the sign-up screen, the checkout, the feet. */
  terms_url?: string | null;
  privacy_url?: string | null;
  /** The operator's imprint, withdrawal information and contract cancellation page (lib/legal.ts); null when not set. */
  imprint_url?: string | null;
  withdrawal_url?: string | null;
  cancel_url?: string | null;
  /** A billing provider runs here (a module, server/extension.ts): Settings → Billing and its routes exist. */
  billing?: boolean;
}

// ---------------------------------------------------------------- conversion: moments and the funnel (hosted, billing)

/**
 * A moment where a plan helps what someone is doing (web/src/conversion/): the trial's popover, the first loop on a real
 * video, the first review link opened, an invite the plan has no room for, the trial's banner, a limit's sheet.
 */
export type MomentId = 'trial_popover' | 'loop' | 'link_open' | 'invite_beyond' | 'banner' | 'limit_sheet';

/**
 * A one-time moment the server noticed for one person (lib/moments.ts), waiting until it was shown: `loop` for whoever
 * checked the workspace's first fix on a video of their own (not the sample), `link_open` for whoever made the
 * workspace's first review link once it was opened (within 24 h). Never anyone else's: a visitor on a link is named by
 * the link's name alone.
 */
export interface PendingMoment {
  id: 'loop' | 'link_open';
  at: string;
  /** The video it happened on (its slug), when there is one. */
  slug?: string;
  /** `link_open`: the link's name as its maker gave it. */
  link?: string;
}

/** `GET /api/moments`: what this person put away (until when) and what waits for them, in the session's workspace. */
export interface MomentsState {
  /** Put away by this person in this workspace: the moment's id → until when (ISO). Past ones are left out. */
  hidden: Partial<Record<MomentId, string>>;
  pending: PendingMoment[];
}

/** What the funnel counts once per workspace, the first time it happens (lib/funnel.ts). */
export type FunnelStep = 'signup' | 'setup_done' | 'video_first' | 'link_first' | 'link_opened_first' | 'fix_checked_first' | 'trial_end' | 'plan_paid';

/** What a conversion moment did, counted per week and moment (never who): `POST /api/moments/event`. */
export type MomentEvent = 'shown' | 'used' | 'dismissed' | 'made_room';

/** `GET /api/operator/funnel?weeks=`: the operator's page (web/src/operator/), from first-party counts only. */
export interface FunnelReport {
  /** Real events have been counted (a billing module runs and a sign-up was seen); false: the page shows its empty state. */
  counting: boolean;
  /** The weeks asked for (4, 8 or 12) and the days they cover (ISO dates, UTC Mondays and the last Sunday). */
  weeks: number;
  from: string;
  to: string;
  /** Sign-up weeks, oldest first: each week's sign-ups and how many of them reached each step. `mature`: their trial has
   * ended, so the later steps can be read; a step not readable yet is null. */
  cohorts: { week: string; signups: number; mature: boolean; reached: Record<FunnelStep, number | null> }[];
  /** The mature weeks together: each step's count and the median days from sign-up (null: none, or the sign-up itself). */
  steps: { step: FunnelStep; count: number; medianDays: number | null }[];
  /** The conversion moments in these weeks: how often each showed, was used, put away, or someone made room instead. */
  moments: { id: MomentId; where?: string; shown: number; used: number; dismissed: number; made_room: number }[];
}

// ---------------------------------------------------------------- the operator's admin (server/routes/operator.ts)

/** A person as the operator's pages name them. */
export interface OperatorPerson {
  id: string;
  name: string;
  email: string;
}

/** What the operator may set by hand (a billing module's override): a plan for nothing, or the trial run to a date. */
export type PlanOverrideKind = { kind: 'complimentary'; plan: 'solo' | 'team' | 'business' } | { kind: 'trial'; until: string };

/** A change the operator made: an override, or `normal` (back to billing as usual). */
export type PlanChange = PlanOverrideKind | { kind: 'normal' };

/** Who changed a plan by hand: their account, name and address at the time. */
export interface PlanStamp {
  account: string;
  name: string;
  email?: string;
}

/** An override in force: what, when, by whom, why. */
export type PlanOverride = PlanOverrideKind & { at: string; by: PlanStamp; reason: string };

/** One line of a workspace's log of plans set by hand. */
export interface PlanLogEntry {
  at: string;
  by: PlanStamp;
  change: PlanChange;
  reason: string;
}

/** A workspace's plan as its billing module tells the operator (server/extension.ts OperatorPlans). */
export interface OperatorPlan {
  /** The module's plan id (free, solo, team, business) and its name. */
  plan: string;
  name: string;
  /** complimentary: never billed; trial: until `trialEndsAt`; grace and read-only: why in `reason`. */
  state: 'active' | 'trial' | 'grace' | 'read-only' | 'complimentary';
  reason?: 'payment' | 'over-limit' | 'trial-ended' | 'canceled';
  trialEndsAt?: string;
  graceUntil?: string;
  /** The storage the plan includes, in bytes; null: no limit. */
  storage: number | null;
  /** What the operator set by hand, in force now. */
  override?: PlanOverride;
  /** Complimentary by the server's settings, not this page: its own workspace, or LAMPO_COMPLIMENTARY. */
  fixed?: 'own' | 'env';
  /** A subscription is paid for (an override can't stand in for it). */
  paying?: boolean;
}

/** One workspace in the operator's list. */
export interface OperatorWorkspace {
  id: string;
  name: string;
  created: string;
  /** Its first active owner (null: none left). */
  owner: OperatorPerson | null;
  /** People with an account in it. */
  members: number;
  /** Videos, the first run's sample left out. */
  videos: number;
  /** Bytes of its versions. */
  bytes: number;
  /** When anything last happened in it (its log's newest event); null: nothing yet. */
  active: string | null;
  /** Its plan, when a billing module runs. */
  plan?: OperatorPlan;
  /** The server's operator suspended it (A13 CLOUD-5): read-only for its people, its review links stopped. */
  suspended?: WorkspaceSuspensionShown;
}

/** A suspension as the operator's pages show it: when, by whom (their name at the time), why. */
export interface WorkspaceSuspensionShown {
  at: string;
  by: string;
  reason: string;
}

/**
 * What deleting a workspace takes with it, counted before anyone confirms (`GET /api/operator/workspaces/:id/deletion`,
 * `GET /api/workspaces/current/deletion`, `vr admin delete-workspace --dry-run`). Never a note or a name of a video.
 */
export interface WorkspaceDeletionPlan {
  id: string;
  name: string;
  /** Why it can't be deleted (the server's own workspace, an unreadable registry): absent when it can. */
  refused?: string;
  /** Members whose account goes with it (it is the only workspace they work in), and those who stay elsewhere. */
  members: { total: number; accountsGone: number };
  videos: number;
  /** Bytes of the versions it holds. */
  bytes: number;
  /** Review links that stop, invites that go, API tokens and connected apps that stop. */
  links: number;
  invites: number;
  tokens: number;
  apps: number;
}

/** `GET /api/operator/workspaces`. */
export interface OperatorWorkspaces {
  /** A billing module answers for plans here: the plan column and the plan's controls. */
  plans: boolean;
  workspaces: OperatorWorkspace[];
}

/** A member as the operator's workspace page lists them. */
export interface OperatorMember extends OperatorPerson {
  role: Role;
  since: string;
  /** Its admins disabled the person there. */
  suspended?: string;
  /** The account is disabled (everywhere). */
  disabled?: string;
}

/** `GET /api/operator/workspaces/:id`. */
export interface OperatorWorkspaceDetail {
  plans: boolean;
  workspace: OperatorWorkspace;
  members: OperatorMember[];
  /** The plans set by hand, newest first (empty without a module). */
  log: PlanLogEntry[];
}

/** One account in the operator's list. */
export interface OperatorAccount extends OperatorPerson {
  created: string;
  /** Its last sign-in (null: none recorded since the server began to keep it). */
  signedIn: string | null;
  /** When it was disabled (null: it is active). */
  disabled: string | null;
  /** A sign-up whose address isn't confirmed yet. */
  unverified?: boolean;
  workspaces: { id: string; name: string; role: Role; suspended?: string }[];
  /** It runs this server (lib/operator.ts). */
  operator?: boolean;
  /** The account asking. */
  you?: boolean;
}

/** `GET /api/operator/accounts`. */
export interface OperatorAccounts {
  accounts: OperatorAccount[];
}

/** Where a workspace stands with its billing provider, as Settings → Billing and the banners show it. */
export type BillingState = 'trial' | 'free' | 'paid' | 'grace' | 'read-only';

/**
 * `GET /api/billing`, answered by a billing provider (a module, server/extension.ts) — the open app only shows it.
 * Amounts are in the currency's minor unit (cents); dates are ISO. Everyone in the workspace may read it; `manage`,
 * the offers and the provider's links are for the people who may change what the workspace pays.
 */
export interface BillingInfo {
  /** The plan in force and its name as the provider calls it. */
  plan: string;
  planName: string;
  state: BillingState;
  /** Why the workspace is in grace or read-only: a failed payment, more than the plan holds, the trial or plan ended. */
  reason?: 'payment' | 'over-limit' | 'trial-ended' | 'canceled';
  /** The trial runs until then (state `trial`). */
  trialEndsAt?: string;
  /** Everything keeps working until then (state `grace`). */
  graceUntil?: string;
  /** The next renewal of a paid plan. */
  renewsAt?: string;
  /** A paid plan that was cancelled ends then; the workspace goes to the free plan. */
  endsAt?: string;
  interval?: 'month' | 'year';
  /** What the workspace uses, and what its plan holds (null: no limit). */
  usage: { members: number; bytes: number; activeVideos: number };
  limits: { members: number | null; bytes: number | null; activeVideos: number | null };
  /** Members billed on a per-member plan. */
  seats?: number;
  /** The person may change what the workspace pays (an owner or admin, signed in in the browser). */
  manage: boolean;
  /** Never billed (the operator's own workspace): nobody chooses a plan here, its owner included. */
  complimentary?: boolean;
  /** Paying works here now (the provider is set up). */
  available?: boolean;
  /** A running subscription: picking another plan switches it (POST /api/billing/plan) instead of a checkout. */
  subscribed?: boolean;
  /** A billing account exists: its details, payment methods and invoices are managed on the page (GET /api/billing/account). */
  account?: boolean;
  /**
   * How the page takes payments, while paying works: the provider's payment elements, loaded on Settings → Billing only
   * when a payment form opens (`key` is the provider's publishable key: public by design). Without it nobody can pay here.
   */
  payments?: { provider: 'stripe'; key: string };
  /** The currency the prices show in first, and the ones the picker offers (one when a subscription fixed it). */
  currency?: string;
  currencies?: string[];
  offers?: BillingOffer[];
  /** Whether the prices shown include tax or have it added (from the billing address) when paying. */
  tax?: 'excluded' | 'included';
  /**
   * The VAT a consumer pays on the offers' prices before an address is known (percent; the seller's own country's): the
   * plans show consumers gross prices (PAngV). The checkout's order says the tax for the billing address itself.
   */
  vat?: { rate: number };
  /**
   * The checkout offers reverse charge: a business with a VAT ID from another EU country pays no VAT (the provider's
   * seller has a VAT ID of its own to put on that invoice). Absent: everyone pays VAT, a business's VAT ID goes on the
   * invoice only, and the page says nothing of reverse charge.
   */
  reverseCharge?: boolean;
  /** A cancellation with one month's notice owes this refund once the plan has ended (minor units, tax included). */
  refund?: { amount: number; currency: string };
  /** The trial began then (state `trial`): with trialEndsAt, the trial's ruler. */
  trialStartsAt?: string;
  /**
   * Extra storage on a running subscription (owners and admins): the terabytes on it, and one terabyte's price per the
   * subscription's interval in its currency (minor units) — there with none bought too, for the limit sheet's "+1 TB".
   */
  addons?: { storageTB: number; price: number };
  /**
   * Which of what a higher plan brings this workspace's plan includes now (the trial's plan included); false: a higher
   * plan's. The in-app conversion locks or explains a feature by it; one it doesn't name is never locked. `inUse`: what
   * the workspace uses of them now, when the provider knows.
   */
  features?: { insights?: boolean; roles?: boolean; webhooks?: boolean; inUse?: { insights?: boolean; roles?: boolean; webhooks?: boolean } };
  /** The provider's upcoming invoice, estimated (owners and admins). */
  next?: { date: string; amount: number; currency: string };
  /**
   * The renewal that didn't go through (state `grace`/`read-only`, reason `payment`; owners and admins): the open
   * invoice, what it's for, the card it tried, why (the provider's decline code; the page says it in its own words) and
   * when the provider tries again.
   */
  failure?: { invoice: string; amount: number; currency: string; method?: string; code?: string; retryAt?: string[] };
}

/**
 * The body of a 402 (server/extension.ts refusal): the workspace's plan has no room for this now, or it is read-only.
 * `error` and `messages` are the billing provider's sentence (agents and `vr` read `error`); the rest is for the limit
 * sheet.
 */
export interface PlanRefusal {
  error: string;
  reason: 'storage' | 'members' | 'videos' | 'read-only' | 'payment';
  /** The same sentence by language code (`de`). */
  messages?: Record<string, string>;
  /** The next plan up, as before `fits`. */
  upgrade?: string;
  /** What was asked for: an upload's bytes, or the address of the member to add (when the request named one). */
  needed?: number | string;
  /** Storage: the room the workspace could make instead, its final or archived videos and the bytes they hold. */
  room?: { videos: number; bytes: number };
  /** The smallest step that fits: a plan id (`solo`, `team`, `business`) or `addon:storage_tb` (a terabyte more). */
  fits?: string;
}

/**
 * `GET /api/billing/cancel` (owners and admins): how the plan may be cancelled today beyond the two ways every plan has
 * (at the period's end; for an important reason). `notice`: a consumer's yearly plan after its first year (§ 309 Nr. 9
 * BGB) ends one month from today (`endsAt`) and the time paid for after that is refunded pro rata (`refund`, minor units,
 * tax included: the days refunded of the days paid for). Absent: the plan has no such right, or its period ends sooner.
 */
export interface BillingCancelOptions {
  notice?: { endsAt: string; refund: { amount: number; currency: string; days: number; of: number } };
}

/** `POST /api/billing/cancel`'s answer: when it was received, when the plan ends, and with notice what is refunded. */
export interface BillingCancelled {
  ok: boolean;
  kind: 'ordinary' | 'extraordinary' | 'notice';
  receivedAt: string;
  endsAt: string | null;
  refund?: { amount: number; currency: string; days: number; of: number };
}

/** `POST /api/billing/checkout`, `/payment-method`, `/invoice/pay`: what the page's payment form is mounted with. */
export interface BillingSecret {
  /** The provider's client secret for this one checkout, setup or payment of the workspace's own (never stored). */
  clientSecret: string;
  /** An open invoice's amount still due (minor units) and currency. */
  amount?: number;
  currency?: string;
}

/** The address on a workspace's invoices. */
export interface BillingAddress {
  line1: string;
  line2?: string;
  postalCode: string;
  city: string;
  state?: string;
  /** ISO 3166-1 alpha-2. */
  country: string;
}

/** A saved way to pay, as the page shows it: its kind, a card's brand and last four, never more. */
export interface BillingMethod {
  id: string;
  /** The provider's type: card, sepa_debit, link, paypal, … */
  type: string;
  brand?: string;
  last4?: string;
  expMonth?: number;
  expYear?: number;
  email?: string;
  /** Renewals are charged to it. */
  default: boolean;
  /** Its expiry month has passed. */
  expired?: boolean;
}

/** An issued invoice (drafts never show). */
export interface BillingInvoice {
  id: string;
  number: string | null;
  date: string;
  /** Minor units. */
  total: number;
  currency: string;
  status: 'paid' | 'open' | 'void' | 'uncollectible';
  /** The provider's PDF of it, to download. */
  pdf?: string;
  /**
   * What it's for, in a line of fixed parts the page can put in its own words: `<Plan>`, `monthly`|`yearly`,
   * `<n> member(s)` (per-member plans), `<n> TB extra`, joined by " · ", each only when the invoice has it
   * ("Team · yearly · 4 members · 1 TB extra", "Solo · monthly").
   */
  description?: string;
}

/** `GET /api/billing/account`: what the provider's own billing page used to show, for owners and admins. */
export interface BillingAccount {
  details: {
    name: string | null;
    email: string | null;
    address: BillingAddress | null;
    /** `verification`: the provider's check with the tax authority (VIES for EU VAT IDs) and the name it returned. */
    taxIds: { id: string; type: string; value: string; verification?: { status: 'pending' | 'verified' | 'unverified' | 'unavailable'; name?: string } }[];
  };
  methods: BillingMethod[];
  invoices: BillingInvoice[];
}

/** `POST /api/billing/plan/preview`: what the next invoice will be after a plan change (minor units, ISO date). */
export interface BillingPreview {
  amount: number;
  currency: string;
  date: string | null;
  /** The switch's own part of `amount`: what the rest of this period costs, or (negative) credits, for the new plan. */
  prorated?: number;
}

/** A plan the workspace could choose (Settings → Billing's picker). */
export interface BillingOffer {
  plan: string;
  name: string;
  /** Billed per member (at least `members.min`), or once per workspace. */
  perMember: boolean;
  members: { min: number; max: number | null };
  /** Included storage: `base` + `perMember` × billed members (bytes). */
  bytes: { base: number; perMember: number };
  activeVideos: number | null;
  /** Price per billed unit and currency: `month` billed monthly, `year` billed once a year (minor units). */
  prices: Record<string, { month: number; year: number }>;
  /** The workspace's members fit it now. */
  fits: boolean;
  /** A few words on what it adds, per language (`en` at least). */
  highlights?: Record<string, string[]>;
}

/**
 * What the app can do beyond the hosted app because it runs on the person's own machine. The UI decides by these,
 * never by a mode: accounts, uploads, review links, OAuth and settings work the same everywhere.
 */
export interface Capabilities {
  /** Link a render that lives on this disk (no upload; new renders are picked up where they are) + the folder browser. */
  linkFiles: boolean;
  /** Claude Code sessions running on this machine show up as agents. */
  localAgents: boolean;
  /** Show a file in the Finder. */
  reveal: boolean;
  /** Apple's Vision reads on-screen text for Auto-check. */
  visionOcr: boolean;
  /** Project timelines and caption files next to a linked render feed the words lane and Auto-check. */
  projectFiles: boolean;
  /** INBOX.md is written into the store for agents that read files. */
  inboxFile: boolean;
  /** A public tunnel (cloudflared) can publish review links from this machine. */
  tunnel: boolean;
  /** Phones on the LAN open the app through the QR link. */
  lan: boolean;
  /** An assigned Claude Code session that isn't running can be started for a request (from this machine only). */
  wakeAgents: boolean;
}

export interface InfoFeatures {
  /** Resumable uploads at /api/uploads (tus). */
  uploads: boolean;
  /** Add videos by path + the folder browser (local mode). */
  paths: boolean;
  /** Accounts: always on now (on the person's own machine its owner is signed in automatically). */
  accounts: boolean;
  /** Public tunnel for share links (cloudflared, local mode). */
  tunnel: boolean;
  /** Where the session list comes from: `claude agents` on this machine, and/or agents that connected with `vr watch`. */
  sessions: 'claude' | 'agents';
  /** Largest accepted upload in bytes. */
  upload_max_bytes: number;
  storage: 'local' | 'bunny' | 's3';
  /** MCP clients on other devices may connect through OAuth sign-in: /.well-known/oauth-protected-resource/mcp. */
  oauth?: boolean;
}

// ---------------------------------------------------------------- "For you" and push notifications

/** `post`: a post of a final video that failed — for people who may publish (lib/publish/posts.ts failedPosts). */
export type ForYouKind = 'question' | 'verify' | 'review' | 'client' | 'approval' | 'answer' | 'version' | 'playbook' | 'stalled' | 'post';

/** One thing that waits for a person (lib/foryou.ts). */
export interface ForYouItem {
  /** Stable key, also what "Got it" dismisses: q:<note>, fix:<note>, client:<note>, appr:…, ans:…, ver:<slug>:<v>. */
  key: string;
  kind: ForYouKind;
  at: string;
  slug: string;
  /** File name of the video. */
  video: string;
  folder: string | null;
  /** New versions: the render's poster frame (notes show their marked frame instead). */
  poster?: string;
  /** The note it is about. */
  id?: string;
  v?: number;
  frame?: number;
  timecode?: string;
  /** The note, the reply, or the approval text. */
  text?: string;
  /** Fixes: what the agent says it changed. */
  note?: string | null;
  /** Answers: the note the agent replied to. */
  question?: string;
  /** Questions: the answers the agent offers (Comment.choices). */
  choices?: string[];
  /** Questions with options (Comment.options): each group's label, how many items it offers and what they are. */
  options?: OptionSeen[];
  by?: string | null;
  /** URL of the marked frame. */
  marked?: string | null;
  /** A note about the whole video (`scope: 'video'`): it has no moment of its own. */
  whole?: boolean;
  /** New versions and renders to review: it is a partial render (lib/part.ts), a quick check of a few shots. */
  part?: boolean;
  /** Playbook suggestions: the playbook (''= House) and the proposal; `slug` is empty, `video` names the playbook. */
  scope?: PlaybookScope;
  proposal?: string;
  /** Playbook suggestions: what it changes ("rules", "skill:export-reels"). */
  section?: string;
  /** Stalled videos: whom it waits for (you: nobody is on it), why it is listed, and how long nothing happened. */
  waitingOn?: InsightsWaitingOn;
  reason?: StalledReason;
  /** Fixes that came back and aren't settled (reopened), the newest render (rounds). */
  count?: number;
  /** Hours since anything happened on the video (a note, a reply, a render, a verdict). */
  waitingHours?: number;
  /** The agent the video is handed to: it can be nudged. */
  agent?: string | null;
  /** Failed posts (kind `post`): which post, where it was going and why it failed (`text` says it too). */
  post?: {
    id: string;
    platform: PublishPlatform;
    account?: string | null;
    error: string;
    /** `failed`, or `sent` (not confirmed by the platform). */
    state?: PostState;
    /** The platform holds it (it went out before): Retry asks the platform again, it doesn't send. */
    remote?: boolean;
  };
  /** Leaves with "Got it" (others leave when answered or verified). */
  dismissible: boolean;
  /** Put aside with "Later" until then (only on items in `ForYouResponse.later`). */
  snoozed?: string;
}

/** Why a video is stalled: its fixes keep coming back, many renders and no approval, nothing happened for a while. */
export type StalledReason = 'reopened' | 'rounds' | 'waiting';

/** Items per kind. `total` is what waits for you — the bell's number; stalled videos (waiting on others, or on nobody)
 * are listed and counted in `stalled`, but not in `total`. */
export type ForYouCounts = Record<ForYouKind, number> & {
  total: number;
  /** Put aside with "Later" by this person (not in `total`, not in `items`). */
  later?: number;
};

/** GET /api/for-you[?limit=n] */
export interface ForYouResponse {
  items: ForYouItem[];
  /** Always every item, also when `limit` left some out of `items`. */
  counts: ForYouCounts;
  /** With `?limit=n`: at most n items of each kind were sent (the newest), and some were left out. */
  truncated?: boolean;
  /** What this person put aside ("Later"), each with `snoozed`: it comes back then, or when its video moves. */
  later?: ForYouItem[];
  /** The earliest time something put aside comes back on its own (ask again then). */
  wake?: string;
}

/** What a device wants to be told about (per subscription). */
export interface PushPrefs {
  /** An agent asked something. */
  questions: boolean;
  /** A new render with fixes to verify (one notification per render). */
  fixes: boolean;
  /** Any new render. */
  versions: boolean;
  /** Client notes and approvals from review links. */
  clients: boolean;
  /** Agents replying to your notes. */
  answers: boolean;
  /** A post of a final video went out or failed (absent on older subscriptions: on). */
  posts?: boolean;
}

/** GET /api/push?endpoint=… */
export interface PushState {
  /** The VAPID public key (the browser's applicationServerKey). */
  publicKey: string;
  /** This device's subscription, if the endpoint is known. */
  subscription: { id: string; name: string; prefs: PushPrefs; created: string; last_ok: string | null } | null;
  /** How many devices of yours get notifications. */
  devices: number;
}

/**
 * Whether a connected agent hears new notes (server/agents.ts): `listening` — in `wait_for_feedback` now (or between
 * two of them), or following with `vr watch`; `working` — its last wait handed it something a few minutes ago and it
 * is still calling (it waits again when done); `idle` — connected, but nothing makes it look: new notes wait until a
 * person tells it to (an MCP client acts only when prompted).
 */
export type AgentListenState = 'listening' | 'working' | 'idle';

/** An agent that announced itself: `vr watch` (POST /api/agents/heartbeat), or an MCP client calling /mcp. */
export interface ConnectedAgent {
  session_id: string;
  name: string;
  cwd: string | null;
  host: string | null;
  /** The account the agent works for; null when it runs on the machine itself. */
  user: string | null;
  last_seen: string;
  /** What kind of agent (from the MCP client's name, or what `vr` says it runs in). */
  kind?: AgentKind;
  /** Whether it hears new notes (absent from older servers). */
  state?: AgentListenState;
  /** When it last listened: now while it waits, else when its last wait ended (null: not since the app started). */
  listened?: string | null;
}

/** POST /api/uploads (tus) finish: which review the render became. */
/** GET /api/review/:slug/part: the stretch a partial render would cover, snapped to the render's shots. */
export interface PartSuggestion {
  v: number;
  part: PartRequest;
  /** The stretch is the whole video (one shot): render it in full. */
  whole: boolean;
  /** How many shots the render has. */
  shots: number;
}

export interface UploadResult {
  slug: string;
  v: number;
  created: boolean;
  /** The same bytes as the newest version: nothing new was registered. */
  duplicate: boolean;
  video: string;
  /** A partial render: where it went and how its seams fit. */
  part?: VersionPart;
  /**
   * An upload URL's answer (PUT /api/uploads/direct/:ticket): a wait_for_feedback cursor from the moment the render was
   * taken, and the line that says to wait now with it (lib/handoff.ts). Absent elsewhere.
   */
  cursor?: string;
  next?: string;
}

export interface VoiceResponse {
  id: string;
  /** '' for silence, null when no speech-to-text ran. */
  transcript: string | null;
  /** A transcript was produced (field name kept for older clients). */
  whisper: boolean;
}

/** SSE event names the server broadcasts on /api/events. */
export type ServerEvent =
  | 'library'
  | 'review'
  | 'sessions'
  | 'poster'
  | 'sprite'
  | 'analysis'
  | 'diff'
  | 'qa'
  | 'qa-progress'
  | 'transcript'
  | 'events'
  | 'event'
  | 'for-you'
  | 'playbook'
  | 'recording'
  | 'agent-runs'
  | 'agent-activity'
  /** Your drafts on a video changed: sent only to your own streams (EventHub.tell), never broadcast. */
  | 'drafts'
  /** A question asked on a folder before any render was asked, answered or removed (lib/asks.ts). */
  | 'asks'
  /** A post of a final video changed (drafted, published, sending, out, failed): `{slug}`. */
  | 'posts'
  /** A publishing connection was added, checked, changed or removed. */
  | 'connections'
  /** A video's footage index changed (lib/footage/: its newest version indexed, or failed): `{slug}`. */
  | 'footage'
  /** A conversion moment waits for you (`{id}`, lib/moments.ts): sent only to your own streams (EventHub.tell). */
  | 'moment';

// ---------------------------------------------------------------- accounts (server mode)

/** owner/admin run the server, members do the work, reviewers watch, comment and approve (see lib/permissions.ts). */
export type Role = 'owner' | 'admin' | 'member' | 'reviewer';

/** An account as the API shows it (never the password hash). */
export interface PublicUser {
  id: string;
  email: string;
  /** Shown as the author of notes. */
  name: string;
  role: Role;
  created: string;
  /** When the account was disabled; absent while it is active. */
  disabled?: string;
  /** Choices that follow the person from device to device; absent until they make one. */
  prefs?: UserPrefs;
  /** The owner of the machine the app runs on: signed in automatically there (created on first start). */
  local?: boolean;
  /** Whether the account can sign in with a password (the machine's owner has none until they set one). */
  has_password?: boolean;
  /** The profile picture's stored file (lib/avatars.ts); absent: initials. */
  avatar?: string;
  /**
   * Since when the address waits to be confirmed (an emailed link). Absent: confirmed, or vouched for by whoever made
   * the account (setup, an admin, an invite made out to it) — accounts from before email count as confirmed.
   */
  unverified?: string;
  /** When the person signed up on their own (VR_SIGNUP): until the address is confirmed such an account can do nothing. */
  signup?: string;
  /** A new address waiting for its emailed link; the account keeps signing in with `email` until then. */
  pending_email?: string;
}

/** A change to someone's prefs: as UserPrefs, but `voice_languages: null` goes back to the server's list. */
export type UserPrefsPatch = Omit<UserPrefs, 'voice_languages'> & { voice_languages?: string[] | null };

/** Light, dark, or whatever the device is set to. */
export type ThemePref = 'light' | 'dark' | 'system';

/** English, German, or whatever the browser prefers. */
export type LangPref = 'en' | 'de' | 'auto';

export interface UserPrefs {
  theme?: ThemePref;
  lang?: LangPref;
  /**
   * Languages this person speaks into voice notes and recorded feedback (ISO 639-1, the first one wins when unsure);
   * `[]`: Automatic, any language as detected; absent: the server's list.
   */
  voice_languages?: string[];
  /** On the machine: what sending something to an agent that isn't running does (absent: ask each time). */
  wake?: WakePref;
  /**
   * The first run (lib/onboarding.ts). Set when the account is created; absent on accounts from before it, which count
   * as done and never see it. Only the server writes `done` and `complete`, from what the person did.
   */
  onboarding?: OnboardingPrefs;
  /** An email when the account signs in from a browser or `vr` it hasn't seen (absent: off). */
  signin_alerts?: boolean;
  /**
   * Conversion moments this person put away, per workspace: the moment's id → until when (ISO). Written only by `PUT
   * /api/moments/:id` (lib/auth.ts setMomentHidden), so "Not now" holds on every device; past ones are dropped there.
   */
  moments?: Record<string, Partial<Record<MomentId, string>>>;
}

/**
 * A step of the first run's Get started; which ones an account has depends on its role, where the app runs and the
 * workspace's personas (lib/onboarding.ts stepsFor). `sample`: the sample's fix checked or its question answered.
 * `workspace`, `note` and `check` are no longer listed (the setup names the workspace, the sample teaches notes and
 * checks) but stay readable in accounts that recorded them.
 */
export type OnboardingStep = 'sample' | 'workspace' | 'video' | 'note' | 'agent' | 'share' | 'invite' | 'check' | 'approve';

/** The agent a person picked in the setup (web/src/onboarding/), or `none` (none yet). */
export type SetupAgent = 'claude-code' | 'codex' | 'cursor' | 'chatgpt' | 'claude' | 'other' | 'none';

/** The plan a person picked on the website before signing up (`?plan=` on the sign-up link): known ids only. */
export type SignupPlan = 'cloud-solo' | 'cloud-team' | 'cloud-business';

export interface OnboardingPrefs {
  /** When it started: the account was created. */
  since: string;
  /** Each step the server saw done, and when (from real state, never from a click on the list); kept once seen. */
  done?: Partial<Record<OnboardingStep, string>>;
  /** Put away by the person; the account menu brings it back. */
  hidden?: string;
  /** Every step of the account's role was done. */
  complete?: string;
  /**
   * The setup (Welcome and the few steps after it, web/src/onboarding/Setup.tsx) shows on the next visit: set when the
   * account is made; absent on accounts from before it, which never see it.
   */
  setup_due?: true;
  /** When the setup was finished or skipped: it doesn't show again. */
  setup_done?: string;
  /** The agent picked in the setup: Get started's and the sample's words name it. */
  agent?: SetupAgent;
  /** The plan picked on the website before signing up (carried through the confirm link): Get started offers it. */
  plan?: SignupPlan;
}

/** Who a workspace's videos are for (the setup's "Who are the videos for?", several picks). */
export type Persona = 'agency' | 'inhouse' | 'creator' | 'other';

/** PUT /api/onboarding: put away / bring back, the setup finished or skipped, the agent picked. */
export interface OnboardingUpdate {
  hidden?: boolean;
  /** The setup is over (finished or skipped): it doesn't show again. */
  setup?: 'done';
  agent?: SetupAgent;
}

/** PUT /api/workspaces/current/persona: who the workspace's videos are for (owners and admins). */
export interface PersonaUpdate {
  personas: Persona[];
  /** "Something else", in a few words (kept only with `other` among the picks). */
  personaOther?: string;
}

/**
 * GET /api/server/health: what a team on this server will need, checked (the server setup's health check). Owners and
 * admins of the server's first workspace only, people only; no secrets (no relay password, no storage keys).
 */
export interface ServerHealth {
  /** Review links and emails point here (VR_PUBLIC_URL); ok when it is set and https (or loopback). */
  public_url: { ok: boolean; url: string | null };
  /** Where renders live: written to and read back just now; free space when the disk says. */
  storage: { ok: boolean; kind: 'local' | 's3' | 'bunny'; writable: boolean; free_bytes: number | null; where: string | null };
  /** How mail leaves: `smtp` through a relay (its host only), `log` = written to the server's outbox, never sent. */
  mail: { ok: boolean; transport: 'log' | 'smtp'; from: string | null; relay: string | null };
  /** The speech engine (as /api/info.stt): ready, loading with its progress (0–1), off or failed. */
  stt: { ok: boolean; state: string; model: string | null; device: string | null; progress: number | null };
}

/** POST /api/server/mail-test: a test mail went to the asker's own address. */
export interface MailTestResult {
  ok: true;
  to: string;
}

/** GET /api/onboarding: the first run as it stands for the asker. */
export interface OnboardingResponse {
  /** The account's first run, with the steps seen done just now recorded; null for an account from before it. */
  onboarding: OnboardingPrefs | null;
  /** The account's steps in order. */
  steps: { id: OnboardingStep; done: boolean }[];
  /**
   * The sample, while there is one. `check`: its fixed note while it waits for a check (Open the sample opens check
   * mode on it, `#/v/<slug>?verify=<id>`), else null; `question`: the agent's question on it.
   */
  sample: { slug: string; name: string; check?: string | null; question?: string | null } | null;
  /** Where "Leave a note" and "Share a review link" take you: the newest video that isn't the sample, else the sample. */
  video: { slug: string; name: string } | null;
  /** Whether this account may make a sample (it may add videos). */
  can_sample: boolean;
  /** The plan picked on the website before signing up, while the workspace pays nothing yet (Get started offers it). */
  plan?: SignupPlan | null;
  /**
   * Who invited this account into the workspace it works in (the invite it accepted: the inviter's name now and role
   * there now), for the invited member's Welcome; null when it wasn't invited here or the inviter left.
   */
  invited_by?: { name: string; role: Role } | null;
}

/**
 * GET /api/onboarding/folders (the machine only): folders on this machine that hold videos, for the local setup's
 * "Where do your renders land?" — a few likely places, newest first. Linking stays POST /api/library.
 */
export interface OnboardingFolders {
  folders: { path: string; count: number; files: { name: string; path: string; size: number | null; mtime: string | null }[] }[];
}

/**
 * GET /api/onboarding/agents (the machine only): the agents installed here, found by looking (never by running them),
 * for the local setup's tiles ("Found · 2.1.4"); `version` when a file says it.
 */
export interface OnboardingAgentsFound {
  found: { kind: 'claude-code' | 'codex' | 'cursor'; version: string | null }[];
}

/** An API token as the API shows it: the secret itself is only returned once, when it is created. */
export interface PublicToken {
  id: string;
  /** Id of the user it belongs to. */
  user: string;
  name: string;
  /** First characters, so people can tell tokens apart. */
  prefix: string;
  created: string;
  last_used: string | null;
  /** After this the token stops working (optional: tokens without it work until revoked). */
  expires?: string;
  /** The workspace it acts in (lib/workspaces.ts); absent: workspace #1 (tokens from before workspaces). */
  workspace?: string;
}

/** An app connected through OAuth (a grant): an MCP client the user allowed to act for them. Tokens never leave the server. */
export interface PublicApp {
  id: string;
  /** Id of the user who allowed it. */
  user: string;
  client_name: string;
  /** The host that vouches for the app (its metadata document's host), or the host it declared about itself. */
  client_host: string | null;
  /** True when the name comes from a client metadata document on client_host; false when the app registered itself. */
  verified: boolean;
  scopes: string[];
  created: string;
  last_used: string | null;
  /** The workspace it acts in; absent: workspace #1. */
  workspace?: string;
}

/** GET /api/oauth/requests/:id: what the consent screen shows about a pending authorization request. */
export interface OAuthRequestView {
  client_name: string;
  client_host: string | null;
  verified: boolean;
  /** Where the answer goes; its host is shown on the consent screen. */
  redirect_uri: string;
  redirect_host: string;
  /** Only loopback redirects: any program on the user's machine could be asking. */
  local_redirect: boolean;
  scopes: string[];
  /** Scopes the account's role can't use: listed but inert. */
  capped: string[];
  resource: string;
  /** The workspace the app will act in (the session's current one); absent on a store with one workspace. */
  workspace?: WorkspaceInfo;
  /**
   * `vr login` asking (no scopes): the computer as it names itself, the days its API token works (null: until revoked)
   * and the token's name as Settings → API tokens lists it.
   */
  vr?: { machine: string; days: number | null; token: string };
}

/** GET /api/auth/status: what the app shell needs before anything else (public). */
export interface AuthStatus {
  /** local: the app runs on the person's own machine; server: a hosted instance. */
  mode: 'local' | 'server';
  /** A hosted server without any account yet: the setup screen (one-time token from the server log). */
  setup: boolean;
  user: PublicUser | null;
  /** local: the machine itself (signed in without a password); lan: a phone with the LAN link; cookie / token. */
  via: 'local' | 'lan' | 'cookie' | 'token' | null;
  /** The workspace this session works in (`user.role` is the role there); absent while signed out. */
  workspace?: MyWorkspace;
  /** Every workspace the account belongs to (the switcher shows itself with more than one, or with workspace_create). */
  workspaces?: MyWorkspace[];
  /** A person in the browser who may make a new workspace here (lib/workspaces.ts mayCreateWorkspace): the account
   * menu offers "New workspace…" even while they have one. Absent otherwise. */
  workspace_create?: boolean;
  /** This person runs the server (lib/operator.ts): the account menu leads to the operator pages. Absent otherwise. */
  operator?: true;
}

// ---------------------------------------------------------------- workspaces (lib/workspaces.ts)

/**
 * A team's own space on a hosted server: its videos, notes, links, playbooks, events and members, seen by nobody else.
 * Workspace #1 (`w1`) is the store as it always was; the others live in `data/w/<id>/`.
 */
export interface WorkspaceInfo {
  /** `w1`, or `w_` + 12 random lower-case letters and digits. */
  id: string;
  name: string;
  created: string;
}

/** A membership: an account and its role in one workspace. */
export interface WorkspaceMember {
  user: string;
  role: Role;
  since: string;
  /**
   * When an admin of this workspace disabled the person here (A12 INV-REV-2): no role in it until they are let in again.
   * The account itself stays the person's (sign-in, resets, other workspaces).
   */
  suspended?: string;
}

/** data/workspaces.json (0600): written once a hosted store is migrated; without it the store is workspace #1 alone,
 * its members every account with the account's `role`. */
/**
 * A workspace the server's operator suspended (A13 CLOUD-5: a takedown): every write in it is refused, its review links
 * answer 410, its people were told. `by` is the operator's account id; `reason` their one line (shown to the operator
 * only, never to the workspace's people or its visitors).
 */
export interface WorkspaceSuspension {
  at: string;
  by: string;
  reason: string;
}

export interface StoredWorkspace extends WorkspaceInfo {
  members: WorkspaceMember[];
  /** Suspended by the server's operator; absent while it works as usual. */
  suspended?: WorkspaceSuspension;
  /** Made for someone who signed up on their own (VR_SIGNUP=open): its name was a placeholder (their name). */
  signup?: true;
  /** When a person chose its name (made from the app or `vr admin`, or renamed); absent: never named by anyone. */
  named?: string;
  /** The account that made it (its first owner); absent on workspace #1 and on workspaces made before it was kept. */
  by?: string;
  /** Who its videos are for, as its owner picked in the setup (several); absent: never asked or skipped. */
  personas?: Persona[];
  /** "Something else", in a few words. */
  personaOther?: string;
  /**
   * Its admins hid "Powered by Lampo" on its review links (A13 CLOUD-7). Kept when the plan lapses, but only a plan that
   * may hide it (server/extension.ts badgeOptional) does: the links show it again until then.
   */
  badge?: 'hidden';
}

export interface WorkspacesFile {
  workspaces: StoredWorkspace[];
}

/** A workspace as one of its members sees it (the switcher, Settings → Workspace). */
export interface MyWorkspace extends WorkspaceInfo {
  role: Role;
  /** People with an account in it (clients on review links and agents never count). */
  members: number;
  /** The one this session works in. */
  current: boolean;
  /** Made at sign-up (its owner's first run asks to name it, lib/onboarding.ts). */
  signup?: true;
  /**
   * This account joined it through an invite (only on the workspace the session works in): its setup is an invited
   * teammate's, whatever role the invite gave it — never the server's or the workspace's own.
   */
  invited?: true;
  /**
   * Who its videos are for (StoredWorkspace.personas): words, Get started's order and the invite role follow them.
   * Only on the workspace the session works in (`current`).
   */
  personas?: Persona[];
  personaOther?: string;
  /** Since when the server's operator holds it read-only (StoredWorkspace.suspended; never the reason). */
  suspended?: string;
}

/** GET /api/workspaces. */
export interface WorkspacesResponse {
  workspaces: MyWorkspace[];
  /** Whether this instance hosts workspaces at all (a hosted server; never the app on a person's own machine). */
  enabled: boolean;
  /** Whether this person may make a new one (VR_WORKSPACE_CREATE). */
  create: boolean;
}

/**
 * Someone as a workspace's admins see them (A13 PEOPLE-3): who they are here, never what the account keeps for itself —
 * its prefs (other workspaces' ids and dates, its first runs, a sign-up's plan), a new address waiting for its link, its
 * sign-ins. The account's own record is for `/api/auth/me`.
 */
export type MemberView = Pick<PublicUser, 'id' | 'email' | 'name' | 'role' | 'created' | 'disabled' | 'avatar' | 'unverified'>;

/** GET /api/admin/users: users with the number of API tokens and connected apps they hold. */
export interface AdminUser extends MemberView {
  tokens: number;
  apps?: number;
}

/**
 * What deleting your own account means, asked before the person confirms (`GET /api/auth/me/deletion`): the workspaces
 * that go with it (you are their only member), those you leave, and those that stop it — you own them and others work
 * there: hand them over (make someone else an owner) or delete them first.
 */
export interface AccountDeletionPlan {
  /** Why it can't go at all (the machine's own account): absent when it can. */
  refused?: string;
  goWith: WorkspaceInfo[];
  leave: WorkspaceInfo[];
  blockedBy: WorkspaceInfo[];
  /** Whether a password confirms it (accounts without one confirm by a recent sign-in). */
  password: boolean;
}

/** An invitation to create an account (server mode). The secret link is shown when it is created and to admins. */
export interface PublicInvite {
  id: string;
  role: Role;
  /** Suggestions for the form; the invitee may change them. */
  name: string | null;
  email: string | null;
  created: string;
  /** Name of the admin who invited. */
  by: string;
  expires: string;
  status: 'pending' | 'accepted' | 'revoked' | 'expired';
  /** Name of the account that accepted it. */
  accepted_by?: string;
  /** When it was last emailed to `email`, and how often (absent: never emailed, only copied). */
  sent?: string;
  sent_count?: number;
  /** The workspace it joins, when it isn't workspace #1. */
  workspace?: string;
}

/** POST /api/admin/invites: the link carries the one-time token. */
export interface InviteCreated {
  invite: PublicInvite;
  url: string;
  /** It was handed to the mailer for `invite.email` (with `send: true`). */
  sent?: boolean;
}

/** POST /api/auth/invite/peek: what the accept screen shows before anyone signs up. */
export interface InvitePeek {
  /** On a server with more than one workspace: an account here may join with its own email and password. */
  several?: boolean;
  /** The workspace the invite is for, on a server with more than one — by name once someone named it. */
  workspace?: string;
  /**
   * With `several`, for someone signed in who opens it: `member` — they are in that workspace already
   * (`workspace_id` says which); `join` — their account may join it; `other` — it is made out to another address.
   */
  you?: 'member' | 'join' | 'other';
  workspace_id?: string;
  role: Role;
  name: string | null;
  email: string | null;
  by: string;
  expires: string;
}

// ---------------------------------------------------------------- publishing a final video (lib/publish/)

/**
 * Where a final video can be posted from Lampo (lib/publish/platforms.ts says each one's limits). TikTok, LinkedIn and
 * X come through the same path later (docs/publishing.md); readers skip platforms they don't know.
 */
export type PublishPlatform = 'youtube' | 'instagram' | 'facebook';

/**
 * How Lampo reaches a platform: `youtube` — YouTube directly, through the person's own Google Cloud OAuth client;
 * `zernio` — a unified posting API (Zernio, formerly Late) with the person's own key, for Instagram and Facebook.
 */
export type ConnectionKind = 'youtube' | 'zernio';

/** Who may watch a post once it is out. */
export type PostVisibility = 'public' | 'unlisted' | 'private';

/**
 * Where a post stands:
 * draft — being written (agents and people);
 * queued — a person published it: it waits for its turn, or for its time when Lampo sends it then;
 * uploading — Lampo is sending it now;
 * scheduled — the platform (or the posting API) holds it until `schedule_at`;
 * posted — it is out (`url`);
 * failed — the platform said no, or it kept failing (`error`, a sentence);
 * cancelled — a person took it back, or it paused itself because the final moved (`error` says which);
 * sent — it went to the platform, but the platform never said whether it is out (an answer lost after the post was
 *   asked for, or a platform that kept working on it past 6 hours): look on the platform. Never sent again by itself.
 * A post with `remote_id` went out before, at least partly: Retry asks the platform again; it is sent again only when
 * a person asks for that (`again`).
 */
export type PostState = 'draft' | 'queued' | 'uploading' | 'scheduled' | 'posted' | 'failed' | 'cancelled' | 'sent';

/** YouTube's own fields. */
export interface PostYouTube {
  /** YouTube's video category id ("22" People & Blogs, "1" Film & Animation …; YOUTUBE_CATEGORIES). */
  category?: string;
  /** "Made for kids" (COPPA): a required answer, never defaulted; null until given. */
  made_for_kids?: boolean | null;
}

/** Instagram's own fields. */
export interface PostInstagram {
  /** A Reel (the default) or a video in the feed. */
  kind?: 'reel' | 'feed';
  /** A Reel shown in the profile's feed too (default true). */
  share_to_feed?: boolean;
}

/** What a person or an agent writes into a post (on a change every field is optional: absent = unchanged). */
export interface PostFields {
  /** The connection it goes out through (PublishConnectionInfo.id); null = none chosen yet (the kit works without). */
  connection?: string | null;
  /** The account of that connection it posts as: a YouTube channel, an Instagram account, a Facebook Page. */
  account?: string | null;
  title?: string;
  /** The description (YouTube) or the caption (Instagram, Facebook). */
  description?: string;
  tags?: string[];
  /** The frame of the final version used as the cover; null = the platform's own choice. */
  cover_frame?: number | null;
  visibility?: PostVisibility;
  /** When it goes live (ISO 8601); null = as soon as a person publishes it. */
  schedule_at?: string | null;
  /** "Contains realistic AI-generated or altered people, places or events?" — a required answer; null until given. */
  ai_generated?: boolean | null;
  youtube?: PostYouTube;
  instagram?: PostInstagram;
}

/** One line of a post's history, oldest first. */
export interface PostHistoryEntry {
  at: string;
  state: PostState;
  by: string;
  /** What happened, in a sentence (the platform's reason, "uploaded"). */
  note?: string;
}

/** Which file went out: the final version's own bytes, or the platform's encode made from them (the kit's). */
export interface PostFile {
  kind: 'final' | 'encode';
  /** The final version's render key (lib/renderKey.ts); for an encode the sha256 of the encode's bytes. */
  hash: string;
  bytes: number;
}

/**
 * One post: one platform, one final version of one video (`data/posts.json` per workspace, lib/publish/posts.ts).
 * Written by people and agents while it is a draft; published only by a person (POST /api/posts/:id/publish).
 */
export interface Post {
  id: string;
  slug: string;
  /** The review it is for (Review.id), when the review has one. */
  video_id?: string;
  /** The final version it posts, and that render's key: exactly that file goes out (or an encode made from it). */
  v: number;
  render: string;
  platform: PublishPlatform;
  connection: string | null;
  account: string | null;
  title: string;
  description: string;
  tags: string[];
  cover_frame: number | null;
  visibility: PostVisibility;
  schedule_at: string | null;
  ai_generated: boolean | null;
  youtube?: PostYouTube;
  instagram?: PostInstagram;
  state: PostState;
  created: string;
  by: string;
  by_id?: string;
  updated: string;
  /** Who published it (a person, never a token), and when. */
  published_by?: string;
  published_by_id?: string;
  published_at?: string;
  /** The platform's (or the posting API's) id for it, and where it can be watched once it is out. */
  remote_id?: string;
  url?: string | null;
  /** YouTube kept the upload private: the Google project hasn't passed YouTube's API audit (make it public in Studio). */
  locked?: boolean;
  /** Why it failed or was taken back, as a sentence. */
  error?: string;
  /** Tries so far, and when the next one is due (passing failures: the network, a 5xx, a rate limit). */
  attempts?: number;
  next_try?: string;
  /** How far an upload got, in bytes. */
  progress?: { sent: number; total: number };
  file?: PostFile;
  history: PostHistoryEntry[];
}

/** A rule a post breaks or a platform limit it is near: `block` stops publishing, `warn` only says so. */
export interface PostProblem {
  field: keyof PostFields | 'video' | 'final';
  level: 'block' | 'warn';
  /** A stable key (the UI's words, lib/publish/platforms.ts). */
  code: string;
  /** The sentence in English, as agents read it. */
  message: string;
  /** Numbers and names the sentence uses. */
  vars?: Record<string, string | number>;
}

/** A post as the API shows it: with what it breaks, the connection's and account's names, the kit. */
export interface PostView extends Post {
  problems: PostProblem[];
  /** The video's file name. */
  video: string;
  connection_label?: string | null;
  account_name?: string | null;
  /** Whether the connection holds a scheduled post itself; else Lampo sends it at its time (keep the machine awake). */
  holds_schedule?: boolean;
  /** A YouTube upload kept private, or any YouTube post: where to change it in YouTube Studio. */
  studio_url?: string;
  kit?: KitInfo | null;
  /** A hash of every field that goes out: the publish confirmation carries it, so what goes is what the person saw. */
  digest?: string;
}

/** GET /api/posts, GET /api/review/:slug/posts */
export interface PostsResponse {
  posts: PostView[];
}

/** POST /api/posts/:id/publish: what the person confirmed (it must still be what the post names). */
export interface PublishConfirm {
  platform: PublishPlatform;
  account: string | null;
  /** The post's `digest` as the person saw it: every field that goes out (A12 PUB-3). Required: no digest, no publish. */
  digest: string;
}

/** An account a connection posts as: a YouTube channel, an Instagram account, a Facebook Page. */
export interface PublishAccount {
  id: string;
  platform: PublishPlatform;
  name: string;
  /** A handle or a second line ("@studio"). */
  detail?: string;
}

/**
 * A connection as the team sees it (GET /api/publish/connections): never a secret — not the API key, the client secret
 * or a token; `key_hint` is the last four characters of the key or of the client id.
 */
export interface PublishConnectionInfo {
  id: string;
  kind: ConnectionKind;
  label: string;
  /** needs_auth: YouTube waits for the Google sign-in · ready · error: the last check failed (`error`). */
  state: 'needs_auth' | 'ready' | 'error';
  error?: string;
  platforms: PublishPlatform[];
  accounts: PublishAccount[];
  key_hint?: string;
  /** YouTube: the redirect URI to add to the Google OAuth client. */
  redirect_uri?: string;
  /**
   * YouTube: the person says their Google project passed YouTube's API audit. Until then YouTube keeps every upload
   * private (a schedule never goes public) and the post links to YouTube Studio instead.
   */
  audited?: boolean;
  /** Whether the platform or the posting API holds a scheduled post itself (else Lampo sends it at its time). */
  holds_schedule: boolean;
  created: string;
  by: string;
  /** When it was last checked against the platform. */
  checked?: string;
}

/** GET /api/publish/connections */
export interface ConnectionsResponse {
  connections: PublishConnectionInfo[];
  /** Whether this instance runs all the time (hosted) or on a machine that may sleep. */
  hosted: boolean;
}

/** The publish kit of one post: the platform's encode, an SRT from the transcript, the cover, the copy. */
export interface KitInfo {
  state: 'making' | 'ready' | 'failed';
  error?: string;
  /** Its files by name (GET /api/posts/:id/kit/<name>); `kit.zip` holds them all. */
  files: KitFile[];
  made?: string;
}

export interface KitFile {
  name: string;
  bytes: number;
  kind: 'video' | 'captions' | 'cover' | 'copy' | 'zip';
}

/** What the stage knows of a final version's posts (StageInfo.published): one line per platform. */
export interface PublishedSignal {
  v: number;
  posts: { id: string; platform: PublishPlatform; state: PostState; url?: string | null; at: string; locked?: boolean }[];
}

/** `post` events: which post, where it stands now. */
export interface PostEventInfo {
  id: string;
  platform: PublishPlatform;
  state: PostState;
  url?: string | null;
  /** The account's name it went to. */
  account?: string | null;
  error?: string;
}
