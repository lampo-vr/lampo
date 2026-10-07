// Who may do what, in one place. The server enforces it (server/permissions.ts maps every route to an action) and
// the UI reads the same table to hide what a role can't do. Browser-safe: no Node imports.
import type { Role } from './types.ts';

export const ACTIONS = {
  view: 'watch videos, read notes, the inbox, insights and taste',
  comment: 'add notes and replies, voice notes; edit or delete your own notes and replies',
  verify: 'confirm a fix or reopen a note',
  approve: 'approve a version or ask for changes',
  finalize: 'mark a video final (the version that ships) or reopen it',
  'edit-notes': "edit or delete anyone's notes",
  resolve: "mark notes fixed or won't fix (the editor's side)",
  upload: 'upload videos and new versions, add videos by path',
  organize: 'folders, moving videos, assigning Claude sessions, checking for new renders',
  remove: 'remove any video (members may remove what they uploaded)',
  archive: 'archive a project and restore it; take videos out of an archived project',
  share: 'create, change and revoke client links',
  download: 'download videos (any version, as rendered) and whole folders (originals or previews) from the library',
  files: 'see, list and download the project files (footage, music, fonts, project files) of the House, projects and folders',
  'files-write': 'add, replace, rename, move, trash and restore project files, every change a version (trashing what someone else added needs remove)',
  agents: 'requests to agents, agent status, connecting agents, writing as agent:…',
  qa: 'rerun the pre-review, dismiss its suggestions',
  playbook: "edit playbooks (the House's and projects'), accept or reject what agents suggest",
  post: 'draft posts of a final video for YouTube, Instagram or Facebook, and download the publish kit',
  publish: 'connect publishing accounts and publish, schedule or take back posts (people only, never an API token)',
  admin: "accounts, invites, everyone's API tokens",
} as const;

export type Action = keyof typeof ACTIONS;

const EDITOR: Action[] = [
  'view',
  'comment',
  'verify',
  'approve',
  'finalize',
  'edit-notes',
  'resolve',
  'upload',
  'organize',
  'share',
  'download',
  'files',
  'files-write',
  'agents',
  'qa',
  'playbook',
  'post',
];

/**
 * reviewer: people who give feedback (producers, colleagues on the client side). They watch, comment, confirm fixes
 * and approve, but don't change what exists, don't hand work to agents (which costs time and money) and don't open
 * the project to outsiders. Nor do they see the project files (`files`): the material, often confidential, is the
 * team's — the one thing a role decides seeing, not only doing (their routes answer 404).
 */
export const ROLE_ACTIONS: Record<Role, ReadonlySet<Action>> = {
  owner: new Set(Object.keys(ACTIONS) as Action[]),
  admin: new Set(Object.keys(ACTIONS) as Action[]),
  member: new Set(EDITOR),
  reviewer: new Set<Action>(['view', 'comment', 'verify', 'approve']),
};

export const ROLE_LABELS: Record<Role, string> = {
  owner: 'Owner',
  admin: 'Admin',
  member: 'Member',
  reviewer: 'Reviewer',
};

export const ROLE_HINTS: Record<Role, string> = {
  owner: 'everything, including other owners',
  admin: 'everything except managing owners',
  member: 'uploads, notes, folders, links and agents',
  reviewer: 'watches, comments, confirms fixes and approves',
};

export const can = (role: Role | null | undefined, action: Action): boolean => !!role && ROLE_ACTIONS[role]?.has(action) === true;

/** Note statuses a role may set: reviewers confirm or reopen, the editor's side marks fixed or won't fix. */
export function canSetStatus(role: Role | null | undefined, status: string): boolean {
  if (status === 'verified' || status === 'open') return can(role, 'verify');
  return can(role, 'resolve');
}
