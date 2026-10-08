// Who may call which MCP tool: the same permission table as the HTTP API and the UI (lib/permissions.ts), plus the
// OAuth scopes an app was granted. And what of the backend a caller reaches: files on this server's disk only for the
// machine itself.
import os from 'node:os';
import path from 'node:path';
import type { Backend } from '../lib/backend/types.ts';
import { slugify } from '../lib/paths.ts';
import { type Action, can } from '../lib/permissions.ts';
import type { Audience } from '../lib/publicError.ts';
import { SCOPE_LIST, type Scope, scopeAllows, scopeFor } from '../lib/scopes.ts';
import type { Role } from '../lib/types.ts';

/**
 * Who is on the other end. Stdio and loopback HTTP are the machine's own agent; hosted HTTP is a signed-in account
 * (an API token, or an app connected through OAuth, whose scopes cap it further).
 */
export interface Principal {
  /** local: the machine itself (a stdio server, or /mcp from the machine the app runs on); lan: a device with the LAN link. */
  via: 'local' | 'lan' | 'cookie' | 'token' | 'oauth';
  /** The account's name (writes that aren't `agent:…` are attributed to it). */
  name: string;
  /** The account's id, when there is one: recorded with what it writes as itself (Comment.author_id). */
  id?: string;
  role: string;
  /** OAuth apps only: what the user allowed it (lib/scopes.ts). Absent = the role alone decides. */
  scopes?: readonly string[];
}

/** What a tool needs: an action from the one permission table the HTTP API and the UI use too. */
export type Access = Action;

/**
 * What each tool needs. /mcp reads it before a call runs, so an OAuth app missing a scope gets a proper
 * `403 insufficient_scope` challenge; the tools themselves check the same entry.
 */
export const TOOL_ACCESS: Record<string, Access> = {
  list_videos: 'view',
  get_open_notes: 'view',
  get_note: 'view',
  get_frame: 'view',
  get_taste: 'view',
  get_transcript: 'view',
  get_playbook: 'view',
  get_skill: 'view',
  list_folders: 'view',
  wait_for_feedback: 'view',
  show_review: 'view',
  review_frame: 'view',
  reply: 'comment',
  add_note: 'comment',
  mark_fixed: 'resolve',
  wont_fix: 'resolve',
  attach_preview: 'resolve',
  // A reference to your own note or with a reply: anyone who may comment (the server checks whose note it is).
  attach_reference: 'comment',
  // Options to pick from: a question like add_note's (making a folder for it needs organize, checked in the tool).
  ask_options: 'comment',
  // A suggestion changes nothing until a person with the playbook action accepts it.
  propose_playbook_change: 'comment',
  track_video: 'upload',
  request_upload: 'upload',
  set_render_source: 'upload',
  move_video: 'organize',
  set_status: 'agents',
  // A draft only: publishing is a person's, in the app (PERSON_ONLY), and no tool or scope does it.
  draft_post: 'post',
  get_posts: 'view',
  // Footage search: reading the workspace's index (and one contact sheet of what it found).
  find_footage: 'view',
};

/**
 * The writes that replace or move what is there: a video filed elsewhere, a version's source said anew, a draft written
 * over. Clients ask before each of these (Claude always does for a destructive tool). Every other write adds something
 * or keeps its history and can be undone in the app: a note, a reply, a fix (reopened by a person), a status.
 */
export const OVERWRITES: ReadonlySet<string> = new Set(['move_video', 'set_render_source', 'draft_post']);

/** What a tool says it does, for clients to decide when to ask the person (MCP tool annotations; every hint explicit). */
export interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  openWorldHint: boolean;
}

/**
 * A tool's hints, from its TOOL_ACCESS entry: reading (`view`) changes nothing; a write is destructive only when it
 * overwrites (OVERWRITES). None reaches beyond the workspace: no tool fetches from the web or sends anything outside
 * (a link a note keeps is stored, never fetched; publishing is a person's, in the app).
 */
export function hintsFor(name: string): ToolHints {
  const access = TOOL_ACCESS[name];
  if (!access) throw new Error(`${name} is missing from TOOL_ACCESS`);
  const reads = access === 'view';
  return { readOnlyHint: reads, destructiveHint: !reads && OVERWRITES.has(name), openWorldHint: false };
}

/**
 * What an app connecting to /mcp is asked to allow by default: the scopes its tools need, nothing more (the project
 * files' scopes join once a tool reads or writes files). An app may still ask for others by name; a tool beyond what
 * it was given asks for more (`insufficient_scope`).
 */
export const MCP_SCOPES: readonly Scope[] = SCOPE_LIST.filter((s) => Object.values(TOOL_ACCESS).some((a) => scopeFor(a) === s));

/**
 * Stdio and loopback are the machine's own agent; hosted accounts get exactly what their role may do in the app, and
 * an OAuth app no more than its scopes on top of that.
 */
export function allowed(p: Principal, access: Access): boolean {
  if (p.via === 'local') return true;
  return can(p.role as Role, access) && (!p.scopes || scopeAllows(p.scopes, access));
}

/**
 * Whether the caller counts as a person for what only people do (the API's PERSON_ONLY): an API token or an OAuth app
 * never does; the machine itself does, where a person and their agent can't be told apart (docs/playbooks.md, "Trust").
 */
export const byPerson = (p: Pick<Principal, 'via'>): boolean => p.via !== 'token' && p.via !== 'oauth';

/** Who an error's text is for (lib/publicError.ts): the machine's own agent sees it as it is, anyone else a sentence. */
export const audienceOf = (p: Pick<Principal, 'via'>): Audience => (p.via === 'local' ? 'owner' : 'other');

/** What a caller that isn't the machine gets for naming a file: one answer, whether or not anything is there. */
export const NO_FILES = 'this server cannot read files on your machine: name a video by its slug or name (list_videos), or upload a render (request_upload)';

/**
 * The backend as a principal may use it. The machine itself (stdio, loopback) names files on its disk: it tracks
 * renders where they are. Anyone else names videos by what the library calls them, never by a path on this server —
 * a path that is no review's name is refused like any unknown name, so nothing tells whether a file exists. Tracking
 * and pushing a path are the machine's; files attached for others are only the scratch copies the tools write of the
 * data they were sent.
 */
export function backendFor(p: Principal, b: Backend): Backend {
  if (p.via === 'local') return b;
  const refuse = (): never => {
    throw new Error(NO_FILES);
  };
  const scratch = (file: string) => {
    const dir = path.dirname(file);
    if (path.dirname(dir) !== os.tmpdir() || !/^vr-mcp-(ref|preview)-/.test(path.basename(dir))) refuse();
  };
  const fenced: Partial<Backend> = {
    async resolve(arg) {
      const r = await b.resolve(arg);
      if (r.fresh) throw new Error(`no reviewed video matches "${arg}"`);
      return r;
    },
    track: async () => refuse(),
    push: async () => refuse(),
    async attachPreview(id, file, o) {
      scratch(file);
      return b.attachPreview(id, file, o);
    },
    async attachRef(id, input) {
      if (input.kind === 'file') scratch(input.path);
      return b.attachRef(id, input);
    },
    async ask(input) {
      for (const g of input.groups) for (const it of g.items) if (it.path) scratch(it.path);
      return b.ask(input);
    },
    // What it says: where files are fetched from, never where they lie on this server.
    reviewMarkdown: (slug, o) => b.reviewMarkdown(slug, { ...o, files: false }),
    // Shots name the render's file on this disk for the machine itself only: no render is fetched (from a bucket, a
    // part's splice) to be named, and a backend that names one anyway has it taken out.
    async findFootage(req) {
      const a = await b.findFootage(req, { files: false });
      return { ...a, shots: a.shots.map(({ file: _file, ...s }) => s) };
    },
    refLocation: (review, file) => `/api/refs/${encodeURIComponent(slugify(review.video))}/${encodeURIComponent(file)}`,
  };
  return new Proxy(b, { get: (target, key) => (key in fenced ? fenced[key as keyof Backend] : Reflect.get(target, key)) });
}
