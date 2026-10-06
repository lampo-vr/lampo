// What the `vr` CLI and the MCP server need from a review store. LocalBackend reads and writes data/ directly (no
// server needed, the classic setup); RemoteBackend talks to a hosted server over HTTP with an API token. Both hand
// out plain data; screenshots always come back as paths on this machine, so an agent can open them either way.
import type { FootageAnswer, FootageRequest, FootageStatus } from '../footage/types.ts';
import type { GrabCount } from '../shots.ts';
import type { SessionInput, SyncResult } from '../store.ts';
import type {
  AgentStatus,
  ArchivedProject,
  AskCreated,
  AskView,
  ClaudeSession,
  Comment,
  DiffResult,
  ElementsAttached,
  FixPreview,
  FrameRange,
  NoteKind,
  NoteRef,
  OptionGroup,
  PlaybookProposal,
  PlaybookProposalView,
  PlaybookSkillView,
  PlaybookStamp,
  PlaybookView,
  PostFields,
  PostView,
  PublishPlatform,
  QaResult,
  RenderSource,
  Review,
  ReviewEvent,
  ReviewPointers,
  Severity,
  Shape,
  StageInfo,
  Taste,
  TasteScope,
  Transcript,
  Version,
  VersionPart,
} from '../types.ts';

export interface Resolved {
  video: string;
  slug: string;
  /** A file on this machine that is not under review yet. */
  fresh?: boolean;
}

export interface NoteInput {
  v: number;
  frame: number;
  range: FrameRange | null;
  text: string;
  tags: string[];
  severity: Severity;
  /** Default: question for agents, feedback for people. */
  kind?: NoteKind;
  drawing: Shape[];
  author: string;
  /** The account of `author` (MCP over HTTP, a person writing as themselves); a server decides it on its own. */
  author_id?: string;
  /** About the whole video, not a moment of it (frame 0, no screenshots). */
  scope?: 'video';
  /** Questions: answers offered for a one-click reply (lib/choices.ts). */
  choices?: string[];
}

export interface NotePatch {
  status?: Comment['status'];
  note?: string;
  fixed_in_v?: number | string;
  /** A fix preview of the note this refers to (FixPreview.id). */
  preview?: string;
  by: string;
}

/** A still or clip of a fix (lib/previews.ts): what it shows and whether it marks the note fixed. */
export interface PreviewAttach {
  kind: 'still' | 'clip';
  /** The newest render's frame it shows (a clip: its first); default: the note's frame. */
  frame?: number;
  source?: FixPreview['source'];
  fixed?: boolean;
  note?: string;
  by: string;
}

/** A reference for a note (lib/refs.ts): a file on this machine, a link, or a moment of a render in the library. */
/** `by_id`: the account of `by`, like NoteInput.author_id. */
export type RefInput =
  | { kind: 'file'; path: string; as?: 'image' | 'clip'; caption?: string; note?: string; by: string; by_id?: string }
  | { kind: 'link'; url: string; caption?: string; note?: string; by: string; by_id?: string }
  | { kind: 'frame'; video: string; v?: number; frame: number; to_frame?: number; caption?: string; note?: string; by: string; by_id?: string };

/**
 * A question with options (lib/options.ts): on a video (`slug`), or before any render on a project or folder
 * (lib/asks.ts). The person auditions the items and picks; the answer comes back as PICKED group=item ….
 */
export interface AskRequest {
  slug?: string;
  folder?: string;
  text: string;
  groups: AskGroupRequest[];
  /** What the free-text field asks. */
  answer_prompt?: string;
  by: string;
  by_id?: string;
  /** May make the project or folder when it doesn't exist yet (the caller may organize; a server decides by role). */
  makeFolder?: boolean;
  /**
   * The local backend on a server (MCP over HTTP): hands out the URLs of items with `upload`, once the id is reserved and
   * before the question is written (`makeAsk`'s `mint`); its result is the answer's `uploads`. A remote server mints its
   * own.
   */
  mintUploads?: (id: string, offered: OptionGroup[]) => AskCreated['uploads'];
}

export interface AskGroupRequest {
  id: string;
  label?: string;
  pick?: 'one' | 'many';
  items: AskItemRequest[];
}

/**
 * An item: its label and what to audition — a file on this machine (`path`), a link, or a moment of a render in the
 * library (`video` + `frame`). `upload`: a server hands back a one-time URL for its file instead (MCP over HTTP).
 */
export interface AskItemRequest {
  id: string;
  label?: string;
  path?: string;
  url?: string;
  video?: string;
  v?: number;
  frame?: number;
  to_frame?: number;
  upload?: boolean;
}

/** A post draft of a final video for one platform (lib/publish/posts.ts): made the first time, changed after. */
export interface PostDraftRequest {
  slug: string;
  platform: PublishPlatform;
  fields: PostFields;
  by: string;
  by_id?: string;
}

/** Which playbook: a video's (its folder's), or a folder's ('' or absent = the House). */
export interface PlaybookWhere {
  /** A video's slug. */
  video?: string;
  folder?: string;
}

/** A suggested change to a playbook (a person accepts or rejects it). */
export interface PlaybookProposalInput {
  section: 'brief' | 'rules' | 'skill';
  /** The whole new text of the section (a skill: its SKILL.md). */
  content: string;
  reason: string;
  /** Notes that led to it (comment ids). */
  evidence?: string[];
  by: string;
}

export interface PushResult {
  review: Review;
  created: boolean;
  duplicate: boolean;
  v: number;
  /** A partial render: where it went and how its seams fit (lib/part.ts). */
  part?: VersionPart;
}

/** A partial render to push (lib/parts.ts): the frame its stretch starts at, and its handles. */
export interface PartPushInput {
  at: number;
  handles?: number;
}

export interface Backend {
  readonly kind: 'local' | 'remote';
  /** Where reviews live: "data: /path" or "server: https://…". */
  readonly where: string;

  listReviews(): Promise<Review[]>;
  /** Where the video stands (lib/stage.ts): computed here (local) or as the server reported it (remote). */
  stage(review: Review): StageInfo;
  /** A path, slug or unique part of a reviewed path → the review. */
  resolve(arg: string | undefined, opts?: { mustExist?: boolean }): Promise<Resolved>;
  /** The review, with a re-render on disk registered first (`wait`: until a render that is still being written settles). */
  review(slug: string, opts?: { wait?: boolean }): Promise<Review>;
  findComment(id: string): Promise<{ slug: string; review: Review; comment: Comment } | null>;
  /** Asks a question with options (on a video, or on a folder before any render); upload URLs for items that asked for one. */
  ask(input: AskRequest): Promise<AskCreated>;
  /** A question with options as the audition reads it (a note's or a folder's), or null. */
  askView(id: string): Promise<AskView | null>;
  addNote(slug: string, note: NoteInput): Promise<{ comment: Comment; review: Review }>;
  updateComment(id: string, patch: NotePatch): Promise<Comment>;
  /** Attach a still or clip of a fix (a file on this machine) to a note. */
  attachPreview(commentId: string, file: string, p: PreviewAttach): Promise<{ preview: FixPreview; comment: Comment }>;
  /** Adds a reference to a note: to the note itself, or with `note` as a reply. */
  attachRef(commentId: string, input: RefInput): Promise<{ ref: NoteRef; comment: Comment }>;
  /** A reference file as a path on this machine (remote: downloaded into the cache); null when it is gone. */
  refFile(review: Review, file: string): Promise<string | null>;
  /** Where a reference file is found: a path on this machine, or the server's URL. */
  refLocation(review: Review, file: string): string;
  /** Record where a render was made (null clears it); default: the newest version. */
  setSource(slug: string, v: number | undefined, source: RenderSource | null, by: string): Promise<Version>;
  /** Put a render under review: a path on this machine (local) or an upload of that file (remote). */
  track(videoPath: string, o: { by: string; byId?: string; session?: SessionInput | null; folder?: string }): Promise<{ review: Review; created: boolean }>;
  /** Upload a render as a new review or the next version of one (`to`: its slug). */
  push(file: string, o: { by: string; folder?: string | null; name?: string; to?: string | null; part?: PartPushInput }): Promise<PushResult>;
  /** Attaches an elements map (parsed JSON, checked whole where it is stored) to version `v`, the newest when absent. */
  putElements(slug: string, v: number | undefined, map: unknown): Promise<ElementsAttached>;
  /** What these notes point at in their versions' elements maps, and those elements' names (empty without maps). */
  pointers(review: Review, comments: readonly Comment[]): Promise<ReviewPointers>;
  /** `out`: the caller may take a video out of an archived project (owners and admins; a server decides by role). */
  move(slug: string, folder: string | null, by: string, o?: { out?: boolean }): Promise<Review>;
  folders(reviews: Review[]): Promise<string[]>;
  /** The archived projects (lib/archived.ts), by name: what agents' lists leave out unless asked. None from older servers. */
  archivedProjects(): Promise<Readonly<Record<string, Pick<ArchivedProject, 'at' | 'by'>>>>;
  assign(slug: string, session: SessionInput | null, by: string): Promise<void>;
  sync(slug: string): Promise<(SyncResult & { review: Review }) | null>;
  sessions(): Promise<ClaudeSession[]>;
  qa(review: Review, ver: Version, o: { rerun?: boolean; progress?: (msg: string) => void }): Promise<QaResult>;
  /** What is said in version `ver`, on its frames (heard once per render; waits while it is being heard). */
  transcript(review: Review, ver: Version, o: { rerun?: boolean; progress?: (msg: string) => void }): Promise<Transcript>;
  diff(review: Review, oldV: Version, newV: Version): Promise<DiffResult>;
  /** The taste file for a scope, written where the agent can read it. */
  taste(scope: TasteScope): Promise<{ taste: Taste; file: string }>;
  /** The playbook that applies there: the merged markdown agents read, its layers and skills (lib/playbooks.ts). */
  playbook(where: PlaybookWhere): Promise<PlaybookView>;
  /** One skill as it applies there (its own or inherited), with its SKILL.md. */
  skill(where: PlaybookWhere, name: string): Promise<PlaybookSkillView>;
  /** A skill's file as a path on this machine (remote: downloaded into the cache); null when it is gone. */
  skillFile(scope: string, skill: string, name: string): Promise<string | null>;
  /** The revisions in force for a folder, House first (cheap: for the pointer in notes). */
  playbookStamp(folder: string | null): Promise<PlaybookStamp[]>;
  /** Suggests a change to a playbook; a person accepts or rejects it. */
  proposePlaybook(where: PlaybookWhere, input: PlaybookProposalInput): Promise<PlaybookProposal>;
  /** A suggestion and where it stands (accepted, rejected with the reason, pending). */
  proposal(id: string): Promise<PlaybookProposalView>;
  setStatus(slug: string, status: { text: string; eta_seconds?: number } | null, by: string): Promise<AgentStatus | null>;
  /** Writes the post draft of a final video for one platform; a person publishes it (never an agent: no method here). */
  draftPost(input: PostDraftRequest): Promise<{ post: PostView; created: boolean }>;
  /** Posts and where they stand: a video's, or every one. */
  posts(slug?: string): Promise<PostView[]>;
  /** Footage search (lib/footage/): the workspace's shots for a request, best first. Local: with the render's path. */
  findFootage(req: FootageRequest): Promise<FootageAnswer>;
  /** A labelled contact sheet of shots by id, as a JPEG on this machine (`out`, or the cache). */
  footageSheet(ids: string[], out?: string): Promise<{ file: string }>;
  /** How far the workspace's footage index is. */
  footageStatus(): Promise<FootageStatus>;
  /** Turns footage search on or off for the workspace (a hosted server lets owners and admins). */
  setFootage(on: boolean, by: string): Promise<FootageStatus>;
  /**
   * Newest events, oldest first (screenshot paths already local). `since`: only events after this moment are needed —
   * a hint that saves a hosted server's caller the rest (the local store reads its cached log either way).
   */
  events(limit: number, o?: { since?: string }): Promise<ReviewEvent[]>;
  /** Calls onEvent for every new event until the process ends, or until `signal` aborts (then it resolves). */
  watch(onEvent: (e: ReviewEvent) => void, o?: { session?: ClaudeSession | null; signal?: AbortSignal }): Promise<void>;

  /** A screenshot of this review as a path on this machine (remote: in the download cache, see fetchShots). */
  shotFile(review: Review, file: string | null | undefined): string | null;
  /** Makes sure the screenshots of these notes are on this machine. */
  fetchShots(review: Review, comments: Comment[]): Promise<void>;
  /**
   * An exact frame as a PNG on this machine. `count`: the caller's new frames are counted (lib/shots.ts GrabCount),
   * asked before a frame is grabbed and told once it was; a frame made before isn't a grab.
   */
  frame(review: Review, ver: Version, frame: number, o?: { count?: GrabCount | null }): Promise<string>;
  /** Where review.json can be read: a path, or the API URL of a remote review. */
  reviewData(review: Review): string;
  inboxMarkdown(): Promise<string>;
  /** review.md; `agentDetails: false` leaves out where the assigned agent works (for callers who may not see it); `files: false` names screenshots and data by their URLs, never paths on this disk. */
  reviewMarkdown(slug: string, o?: { agentDetails?: boolean; files?: boolean }): Promise<string>;
}
