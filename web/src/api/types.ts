// What the server sends. The data contract and the API shapes the server declares come from lib/types.ts (one source
// of truth for server, CLI, MCP and this UI); what stays here are the UI's views of endpoints that also answer with
// "pending"/"none" placeholders, and lenient shapes for data written by older versions.

export type {
  ActivityWords,
  AdminUser,
  AgentActivity,
  AgentActivityResponse,
  AgentLive,
  AgentRunInfo,
  AgentRunLive,
  AgentStatus,
  Approval,
  ArchiveInfo,
  AskView,
  AssignedSession as SessionRef,
  AudienceViewer,
  AuthStatus,
  BrowseEntry,
  BrowseResponse,
  CommentStatus as Status,
  ConnectedAgent,
  Counts,
  FixPreview,
  FolderSuggestion,
  ForYouCounts,
  ForYouItem,
  ForYouKind,
  ForYouResponse,
  FrameRange,
  FreezeRange,
  GuestCompareResponse as GuestCompare,
  GuestLinkResponse as GuestLink,
  GuestNote,
  GuestPerms,
  GuestRef,
  GuestReviewResponse as GuestReview,
  GuestVideo,
  InfoFeatures,
  InfoResponse as Info,
  Insights,
  InsightsAgent,
  InsightsAttention,
  InsightsBackNote,
  InsightsBoard,
  InsightsCause,
  InsightsCauses,
  InsightsFirstTime,
  InsightsFlow,
  InsightsMetric,
  InsightsPeriod,
  InsightsRepeat,
  InsightsStillWrong,
  InsightsStuck,
  InsightsToApproval,
  InsightsTopic,
  InsightsTurnaround,
  InsightsUnopened,
  InsightsWaitingOn,
  InsightsWatchedVideo,
  InsightsWatching,
  InsightsWatchPerson,
  InsightsWatchViewer,
  InviteCreated,
  InvitePeek,
  LangPref,
  Loudness,
  MediaInfo,
  MyWorkspace,
  NoteKind,
  NoteRef,
  OAuthRequestView,
  OptionAnswer,
  OptionGroup,
  OptionItem,
  OptionSeen,
  PartRequest,
  PartSuggestion,
  PublicApp,
  PublicInvite,
  PublicToken,
  PublicUser,
  PushPrefs,
  PushState,
  QaWhy,
  Recording,
  RecordingDraft,
  RecordingEvent,
  RecordingSent,
  RecordingsResponse,
  Retime,
  Role,
  Run,
  RunBrief,
  RunDetail,
  RunPlanItem,
  RunPlanState,
  RunProgress,
  RunState,
  RunStepLine,
  RunStepType,
  RunsResponse,
  RunWriteResponse,
  Severity,
  Shape,
  ShareActivityInfo,
  ShareInput,
  ShareSettings,
  ShareVideoWatch,
  ShareWithToken as Share,
  StalledReason,
  TextEdit,
  ThemePref,
  TrackSegment,
  TrackWord,
  Transcript,
  TranscriptAnswer,
  TranscriptLine,
  TranscriptWord,
  UnsentResponse,
  UploadResult,
  UserPrefs,
  UserPrefsPatch,
  VersionDownload,
  VideoAudience,
  WakePref,
  WebhookDelivery,
  WebhookFormat,
  WebhookInfo,
  WorkspaceInfo,
  WorkspacesResponse,
} from '../../../lib/types.ts';

import type { ShareInfo as ApiShareInfo, SharesResponse as ApiSharesResponse } from '../../../lib/types.ts';

/** A review link as this app gets it: the app is a person's own browser, so every link comes with its token. */
export type ShareInfo = ApiShareInfo & { token: string };
export interface SharesResponse extends Omit<ApiSharesResponse, 'shares'> {
  shares: (ShareInfo & { gone?: boolean })[];
}

import type {
  AgentKind,
  AgentRunInfo,
  AgentStatus,
  Approval,
  ApprovalEntry,
  Counts,
  FinalEntry,
  FinalMark,
  FixPreview,
  FolderSuggestion,
  FrameRange,
  FreezeRange,
  Loudness,
  MediaInfo,
  NoteKind,
  NoteRef,
  OptionAnswer,
  OptionGroup,
  PartRequest,
  PartSuggestion,
  QaWhy,
  Retime,
  RunBrief,
  AssignedSession as SessionRef,
  Severity,
  Shape,
  StageInfo,
  CommentStatus as Status,
  TextEdit,
  TrackSegment,
  TrackWord,
  VersionPart,
} from '../../../lib/types.ts';

export type Tool = 'none' | 'box' | 'arrow' | 'freehand';

/** GET /api/review/:slug/part: the stretch a partial render would cover, or that the shots are being found / can't be. */
export type PartAnswer = PartSuggestion | { pending: true } | { none: true; error?: string };

export interface Reply {
  by: string;
  text?: string | null;
  status?: Status | null;
  fixed_in_v?: number | null;
  /** The fix preview this fix or verdict refers to. */
  preview?: string;
  /** References that came with this reply (NoteRef ids). */
  refs?: string[];
  /** Picks from the question's options (lib/options.ts): `text` is then the PICKED line agents read. */
  answer?: OptionAnswer;
  at: string;
  /** The author's account, when a signed-in person wrote it: whose it is to change. */
  by_id?: string;
  /** When its author last changed its words. */
  edited?: string;
}

export interface Comment {
  id: string;
  v: number;
  frame: number;
  timecode: string;
  t: number;
  range: FrameRange | null;
  text: string;
  tags: string[];
  severity: Severity;
  /** Absent = feedback (see lib/types.ts). */
  kind?: NoteKind;
  drawing: Shape[];
  shots: { clean: string; marked: string } | null;
  voice: { file: string; transcript: string | null } | null;
  status: Status;
  author: string;
  /** The author's account, when a signed-in person wrote it (see lib/types.ts): what "mine" goes by. */
  author_id?: string;
  created: string;
  replies: Reply[];
  check_again?: boolean;
  carried_to?: number;
  /** The render the agent says fixed it. */
  fixed_in_v?: number;
  /** Stills and clips of the fix, made before it was rendered (lib/previews.ts). */
  previews?: FixPreview[];
  /** Verified on a fix preview; no render has the fix yet. */
  verified_on?: { preview: string; v: number };
  /** References: images, clips, links, moments of renders (lib/refs.ts). */
  refs?: NoteRef[];
  /** About the whole video. */
  scope?: 'video';
  /** A change to what is said: the words heard in the note's range and what they should say. */
  text_edit?: TextEdit;
  /** Questions: the answers the agent offers (lib/choices.ts); picking one sends it as the answer. */
  choices?: string[];
  /** Questions: groups of options to audition and pick from (lib/options.ts), and what the free-text field asks. */
  options?: OptionGroup[];
  answer_prompt?: string;
  /** Said while watching (recorded feedback): its recording and the seconds of its audio; `voice` is its clip. */
  source?: 'recording';
  recording?: { id: string; t0: number; t1: number };
  /** The person allows a partial render of these frames (lib/part.ts). */
  part?: PartRequest;
  /** Not sent yet: only its author sees it (lib/drafts.ts). */
  draft?: true;
}

/** GET /api/review/:slug/drafts: your notes on the video that are not sent yet, oldest first. */
export interface DraftsResponse {
  drafts: Comment[];
}

/** POST /api/review/:slug/drafts/send: the notes it made (one batch) and what stayed behind. */
export interface DraftsSent {
  notes: Comment[];
  left: number;
  error?: string;
  run?: AgentRunInfo | null;
}

export interface Version {
  v: number;
  hash: string;
  mtime?: string;
  size?: number;
  frames: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  registered: string;
  /** Who uploaded this render (uploads only). */
  by?: string;
  /** The playbook revisions in force when it arrived (House first, the folder's own last). */
  playbook?: { scope: string; rev: number }[];
  /** A partial render spliced into version `of` (lib/part.ts): its stretch, seams and what the next full render said. */
  part?: VersionPart;
  /** The agent's work that made it (lib/types.ts Run): who, in how long, what it fixed. */
  run?: string;
}

export interface Review {
  video: string;
  project: string;
  fps: number;
  width: number;
  height: number;
  duration: number;
  frames: number;
  versions: Version[];
  comments: Comment[];
  session: SessionRef | null;
  folder: string | null;
  added: string;
  added_by?: string;
  missing?: boolean;
  archived?: boolean | null;
  approval?: Approval | null;
  approvals?: ApprovalEntry[];
  final?: FinalMark | null;
  finals?: FinalEntry[];
  agent_status?: AgentStatus | null;
  qa_dismissed?: string[];
  qa_stretches?: Record<string, FrameRange>;
}

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
  v: number;
  hash: string;
  versions: number;
  counts: Counts;
  session: SessionRef | null;
  folder: string | null;
  approval: Approval | null;
  stage: StageInfo;
  agent_status: AgentStatus | null;
  /** The video's agent work: the open one, else the last that ended in the past 24 hours. Absent from older servers. */
  run?: RunBrief | null;
  sessionActive: boolean | null;
  /** Whether the assigned agent hears new notes by itself (lib/types.ts); absent from older servers. */
  sessionListening?: boolean | null;
  mtime: string | null;
  missing: boolean;
  archived: boolean | null;
  /** Its project is archived (lib/archived.ts): since when. Read-only until restored; absent while it isn't. */
  project_archived?: string;
  added: string;
  updated?: string;
  lastComment: string;
  /** The first run's sample: marked as one wherever it shows, removed in one click. */
  sample?: true;
}

/** An archived project: when, and by whom (a name). */
export interface ArchivedProjectInfo {
  at: string;
  by?: string;
}

export interface LibraryResponse {
  videos: VideoSummary[];
  /** Every folder, archived projects' included (`archived_projects` says which are). */
  folders: string[];
  /** The archived projects by name; absent while none is. */
  archived_projects?: Record<string, ArchivedProjectInfo>;
}

export interface ReviewResponse {
  slug: string;
  review: Review;
  summary: VideoSummary;
  approvals: ApprovalEntry[];
  media: Record<number, MediaInfo | undefined>;
  dataDir: string;
  user: string;
}

export interface Waveform {
  fps?: number;
  peaks: number[];
  rms?: number[];
  audio?: boolean;
}

export interface Analysis {
  pending?: boolean;
  loudness?: Loudness | null;
  freezes?: { ranges: FreezeRange[]; frames: number; threshold: number; min_frames: number } | null;
  at?: string;
}

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DiffRange {
  kind: 'video' | 'audio';
  in: number;
  out: number;
  score?: number;
  box?: Box | null;
  whole?: boolean;
}

export interface Diff {
  pending?: boolean;
  none?: boolean;
  error?: string;
  incomparable?: string;
  old: { v: number; hash?: string; frames?: number };
  new?: { v: number; hash?: string; frames?: number };
  ranges?: DiffRange[];
  retimes?: Retime[];
  summary: { changes: number; changed_seconds: number; audio_changes: number; retimes: number; identical: boolean };
}

export interface QaItem {
  key: string;
  kind: string;
  severity: Severity;
  tags?: string[];
  frame: number;
  range?: FrameRange | null;
  text: string;
  detail?: string;
  box?: Box | null;
  zone?: string;
  /** What Auto-check makes of it and why (lib/types.ts QaItem); absent in results from before. */
  likely?: 'intended' | 'problem';
  why?: QaWhy;
  holds?: FrameRange[];
  word?: string;
  guess?: string;
  line?: string;
  value?: number;
}

export interface QaResult {
  pending?: boolean;
  none?: boolean;
  /** With `none`: the check ran and couldn't read the version (Run again tries once more). */
  failed?: boolean;
  error?: string;
  items?: QaItem[];
  text_language?: string | null;
  spelling?: { state: 'checked' | 'skipped' | 'unavailable'; words: number; languages?: string[] };
}

export interface QaProgress {
  slug: string;
  v: number;
  step?: string;
  /** Steps done of all steps (lib/qa.ts). */
  done?: number;
  total?: number;
}

export interface Tracks {
  dir: string;
  timeline: string | null;
  words: TrackWord[] | null;
  segments: TrackSegment[] | null;
  fps?: number;
  wordsFile?: string;
}

export interface Session {
  name: string;
  sessionId: string | null;
  pid: number | null;
  cwd: string | null;
  kind: string | null;
  status: string | null;
  startedAt: number | null;
  score?: number;
  reason?: string;
  /** What kind of agent (absent from older servers: a Claude Code session). */
  agent?: AgentKind;
}

export interface SessionsResponse {
  sessions: Session[];
  at: number;
  refreshing: boolean;
}

// What the UI sends when it assigns a session (the server stores it as SessionRef).
export interface SessionPick {
  name: string;
  sessionId: string | null;
  cwd: string | null;
  agent?: AgentKind | null;
}

export interface Tunnel {
  available: boolean;
  running: boolean;
  url: string | null;
}

export interface FoldersResponse {
  folders: string[];
  suggestion?: FolderSuggestion;
}

export interface VoiceResult {
  id: string;
  transcript: string | null;
  whisper: boolean;
}

// A comment placed on the version that is on screen (frames converted when the fps differs).
export interface PlacedComment extends Comment {
  frameHere: number;
  timecodeHere: string;
  rangeHere: FrameRange | null;
  /** Its own version's frame size, which its screenshots have: the card keeps their room before they arrive. */
  shotSize?: { width: number; height: number };
}
