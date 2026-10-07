// Footage search (docs/footage.md): what an agent asks for and what it gets back — the contract `lampo footage find --json`,
// GET /api/footage/find and the MCP tool find_footage share. Browser-safe: no Node imports.

export type FootageAspect = '16:9' | '9:16' | '1:1';
/** The camera's move over a shot, measured from the picture (a global shift + zoom), never guessed by a model. */
export type FootageMotion = 'static' | 'push-in' | 'pull-out' | 'pan-left' | 'pan-right' | 'tilt-up' | 'tilt-down' | 'handheld';
export const FOOTAGE_MOTIONS: readonly FootageMotion[] = ['static', 'push-in', 'pull-out', 'pan-left', 'pan-right', 'tilt-up', 'tilt-down', 'handheld'];
/** What a request may name as its move: one of the moves, or a direction-free `pan` / `tilt`. */
export const MOTION_WORDS = ['static', 'push-in', 'pull-out', 'pan', 'pan-left', 'pan-right', 'tilt', 'tilt-up', 'tilt-down', 'handheld'] as const;
export type MotionWord = (typeof MOTION_WORDS)[number];

/** The version of what is written to `footage_version`: a new field is optional, nothing is renamed. */
export const FOOTAGE_VERSION = 1;

/**
 * A request: the words (filters in them are read, `find.ts` style), and filters given on their own, which win over what
 * the words say.
 */
export interface FootageRequest {
  /** What the picture should show, in plain words; may name filters too ("9:16, slow push-in, ≥ 2 s, no text"). */
  query: string;
  aspect?: FootageAspect;
  min_s?: number;
  max_s?: number;
  motion?: MotionWord;
  /** "none" (no legible text in the picture), or words on screen. */
  text?: string;
  /** Words said in the shot (from the video's transcript, when it has one). */
  said?: string;
  /** How many shots (default 6, at most 50). */
  limit?: number;
}

/** What the request was read as: the description the picture is matched against, and the filters. */
export interface FootageRead {
  /** The description alone ('' when the request was only filters or words). */
  show: string;
  aspect?: FootageAspect;
  min_s?: number;
  max_s?: number;
  motion?: FootageMotion[];
  speed?: 'slow' | 'fast';
  no_text?: true;
  /** Words to find on screen or in what is said. */
  words?: string;
  words_in?: 'text' | 'said' | 'any';
}

/** One shot: a stretch of a video between two cuts. */
export interface FootageShot {
  /** "s412": stable while the video's version stays the same; good for `lampo footage sheet` in the same workspace. */
  id: string;
  /** The video's slug (what get_frame, lampo open and the API take). */
  video: string;
  /** Its file name, as the library shows it. */
  name: string;
  folder: string | null;
  /** The version the shot is in (always the video's newest). */
  v: number;
  fps: number;
  /** First and last frame of the shot, both included (Lampo's frame ranges). */
  in: number;
  out: number;
  /** The same in seconds: t0 = in / fps, t1 = (out + 1) / fps (where the last frame ends). */
  t0: number;
  t1: number;
  /** t1 − t0, rounded to tenths. */
  length_s: number;
  width: number;
  height: number;
  aspect: FootageAspect;
  move: FootageMotion;
  /** slow / fast for a push, pull, pan or tilt; null for static and handheld. */
  speed: 'slow' | 'fast' | null;
  /** The frame that matched the description best (a keyframe of the shot). */
  frame: number;
  /** Text read in the picture ('' when none was read). */
  text: string;
  /** What is said during the shot ('' without a transcript or speech). */
  said: string;
  /** Higher is better; only comparable within one answer. */
  score: number;
  /** Where the request's words were found. */
  matched?: ('text' | 'said')[];
  /** The render's file on this machine: only for the machine itself (`lampo` on it, its own agent), never over the network. */
  file?: string;
}

/** How far the index of this workspace is. */
export interface FootageIndexState {
  /** Footage search is on for this workspace. */
  on: boolean;
  /** Why it is off, or why nothing could be indexed yet (the model is downloading, …). */
  note?: string;
  /** Videos it covers (the newest version of each, the sample left out). */
  videos: number;
  /** Of those, indexed and searchable by picture. */
  indexed: number;
  /** Still to do (shots found but not yet embedded count here too). */
  waiting: number;
  failed: number;
}

export interface FootageAnswer {
  footage_version: number;
  query: string;
  read: FootageRead;
  /** Best first. */
  shots: FootageShot[];
  /** Shots looked at (those the filters let through and the index holds). */
  searched: number;
  index: FootageIndexState;
  /** `--sheet`: the contact sheet of these shots, a JPEG on this machine. */
  sheet?: string;
}

export interface FootageStatus extends FootageIndexState {
  shots: number;
  /** The image/text model, and whether its files are on this machine (it downloads on first use). */
  model: string;
  model_ready: boolean;
  /** 0–1 while the model downloads. */
  download?: number;
}
