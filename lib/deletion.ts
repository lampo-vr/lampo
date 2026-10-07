// Deleting a workspace or an account (A13 CLOUD-5 takedown, PEOPLE-1 erasure), the same way from the operator's page,
// Settings and `vr admin`: what goes is said first (the plans: counts, never contents), then it goes in an order that
// never leaves a way in to something half gone.
//
// A workspace: out of the registry first (nobody reaches it from then on: sessions fall back to their other workspaces,
// its review links name nothing), its API tokens, app connections, invites and links' index entries go, the accounts it
// leaves in no workspace go (each with what it kept: lib/erasure.ts afterAccountGone), its waiting jobs are dropped and
// the running one awaited, then its files — every object under its storage prefix and its folders —, then the billing
// module hears it (it cancels and forgets the subscription), and the erasure log gets a line. Never workspace #1.
//
// An account: refused while it is the last owner of a workspace where others work (it hands it over or deletes it
// first); it leaves the workspaces others go on with, the workspaces it alone works in go with it, then the account.
import * as auth from './auth.ts';
import { eraseWorkspaceFiles, erasuresSettled, listErasures, recordErasure } from './erasure.ts';
import { filesHeld } from './files.ts';
import { dropJobsOf } from './jobs.ts';
import { forgetGrants, listApps } from './oauth/store.ts';
import { DEFAULT_WORKSPACE } from './paths.ts';
import { inWorkspace } from './scope.ts';
import { forgetLinksIn, listShares } from './shares.ts';
import { listReviews } from './store.ts';
import type { AccountDeletionPlan, StoredWorkspace, WorkspaceDeletionPlan, WorkspaceInfo } from './types.ts';
import * as workspaces from './workspaces.ts';

/** Who asked, for the erasure log: the person themselves, a workspace's owner, the server's operator, `vr admin`. */
export type Deleter = 'self' | 'owner' | 'operator' | 'cli' | 'restore';

/** The workspace's own people with an active owner role (not suspended there, not disabled). */
const activeOwnersOf = (w: StoredWorkspace, except?: string) =>
  w.members.filter((m) => m.user !== except && m.role === 'owner' && !m.suspended && !auth.getUser(m.user)?.disabled);

/** Accounts that work in `ws` and nowhere else (a suspended membership elsewhere counts as somewhere). */
function onlyIn(w: StoredWorkspace): string[] {
  return w.members
    .map((m) => m.user)
    .filter((id) => !!auth.getUser(id) && workspaces.workspacesOf(id, { suspended: true }).every((x) => x.workspace.id === w.id));
}

/** What deleting workspace `ws` takes with it, counted (WorkspaceDeletionPlan). Throws 404 for no such workspace. */
export function planWorkspaceDeletion(ws: string): WorkspaceDeletionPlan {
  const w = workspaces.getWorkspace(ws);
  if (!w) throw new workspaces.WorkspaceError('no such workspace', 404);
  let videos = 0;
  let bytes = 0;
  let links = 0;
  let files = { count: 0, bytes: 0 };
  inWorkspace(ws, () => {
    for (const r of listReviews()) {
      if (r.onboarding_sample) continue;
      videos++;
      for (const v of r.versions) bytes += Number.isFinite(v.size) ? v.size : 0;
    }
    links = listShares().filter((s) => !s.revoked).length;
    try {
      files = filesHeld();
    } catch {
      // catalogs that can't be read are deleted with the rest; the plan only can't count them
    }
  });
  return {
    id: w.id,
    name: w.name,
    ...(ws === DEFAULT_WORKSPACE ? { refused: 'This is the server’s own workspace: it can’t be deleted.' } : {}),
    members: { total: w.members.length, accountsGone: onlyIn(w).length },
    videos,
    bytes,
    links,
    invites: auth.listInvites(ws).filter((i) => i.status === 'pending').length,
    tokens: auth.listTokens().filter((t) => auth.tokenWorkspace(t) === ws).length,
    apps: listApps(undefined, ws).length,
    files,
  };
}

/** A person told about a deletion: who they were (taken before their account may go), and whether it went too. */
export interface Told {
  user: Pick<auth.User, 'id' | 'email' | 'name' | 'prefs' | 'unverified'>;
  accountGone: boolean;
}

/**
 * Deletes workspace `ws` and everything it holds (see the top). Returns the plan as it stood and its people, each with
 * whether their account went too (whoever asked tells them: the server's mailer). Refuses workspace #1 (409).
 */
export async function deleteWorkspace(ws: string, by: Deleter): Promise<{ plan: WorkspaceDeletionPlan; people: Told[] }> {
  const plan = planWorkspaceDeletion(ws);
  if (plan.refused) throw new workspaces.WorkspaceError(plan.refused, 409);
  const w = workspaces.dropWorkspace(ws);
  auth.accessEnded();
  const people: Told[] = [];
  for (const m of w.members) {
    const u = auth.getUser(m.user);
    if (!u) continue;
    people.push({ user: { id: u.id, email: u.email, name: u.name, prefs: u.prefs, unverified: u.unverified }, accountGone: false });
  }
  auth.revokeTokensInWorkspace(ws);
  forgetGrants({ workspace: ws });
  auth.removeInvitesIn(ws);
  forgetLinksIn(ws);
  // Accounts left in no workspace go, as removing someone from their last workspace always did.
  for (const p of people)
    if (!workspaces.workspacesOf(p.user.id, { suspended: true }).length) {
      try {
        auth.deleteUser(p.user.id, { memberships: true });
        p.accountGone = true;
      } catch (e) {
        console.error(`deletion: account ${p.user.id} with ${ws}: ${(e as Error).message}`);
      }
    }
  await dropJobsOf(ws);
  await eraseWorkspaceFiles(ws);
  recordErasure('workspace', ws, by);
  workspaces.workspaceDeleted(ws);
  await erasuresSettled();
  return { plan, people };
}

/** What deleting account `userId` means (AccountDeletionPlan). Throws 404 for no such account. */
export function planAccountDeletion(userId: string): AccountDeletionPlan {
  const u = auth.getUser(userId);
  if (!u) throw new workspaces.WorkspaceError('no such account', 404);
  const plan: AccountDeletionPlan = { goWith: [], leave: [], blockedBy: [], password: !!u.password };
  if (u.local) return { ...plan, refused: 'This is the machine’s own account: it can’t be deleted.' };
  const info = (w: StoredWorkspace): WorkspaceInfo => workspaces.workspaceInfo(w);
  if (!workspaces.isMigrated()) {
    // One team on the server, no workspaces file: its last owner keeps it, as removing someone always did.
    const owners = auth.listUsers().filter((x) => x.role === 'owner' && !x.disabled && x.id !== userId);
    const others = auth.listUsers().filter((x) => x.id !== userId);
    const w1 = workspaces.getWorkspace(DEFAULT_WORKSPACE);
    if (u.role === 'owner' && !owners.length && w1) {
      if (others.length) plan.blockedBy.push(info(w1));
      else return { ...plan, refused: 'This account runs the server’s own workspace alone: it can’t be deleted.' };
    } else if (w1) plan.leave.push(info(w1));
    return plan;
  }
  for (const { workspace: w, role } of workspaces.workspacesOf(userId, { suspended: true })) {
    const others = w.members.filter((m) => m.user !== userId && !!auth.getUser(m.user));
    if (!others.length) {
      if (w.id === DEFAULT_WORKSPACE) return { ...plan, refused: 'This account runs the server’s own workspace alone: it can’t be deleted.' };
      if (w.suspended) return { ...plan, refused: 'A workspace only you work in is suspended: ask whoever runs this server.' };
      plan.goWith.push(info(w));
    } else if (role === 'owner' && !activeOwnersOf(w, userId).length) plan.blockedBy.push(info(w));
    else plan.leave.push(info(w));
  }
  return plan;
}

/**
 * Deletes account `userId`: refused (409) while `planAccountDeletion` refuses or names workspaces it must hand over or
 * delete first. It leaves the others' workspaces, its own go with it, then the account (lib/erasure.ts afterAccountGone
 * through onAccountGone). Returns the plan as it was carried out.
 */
export async function deleteAccount(userId: string, by: Deleter): Promise<AccountDeletionPlan> {
  const plan = planAccountDeletion(userId);
  if (plan.refused) throw new workspaces.WorkspaceError(plan.refused, 409);
  if (plan.blockedBy.length)
    throw new workspaces.WorkspaceError(
      `hand over or delete ${plan.blockedBy.map((w) => `“${w.name}”`).join(', ')} first: others work there and you are its last owner`,
      409,
      'owner',
    );
  // Others go on in these: the membership goes (on a store without workspaces that removes the account itself).
  for (const w of plan.leave) if (auth.getUser(userId)) workspaces.removeMember(w.id, userId);
  // Nobody else works in these: they go, and the account with the last of them.
  for (const w of plan.goWith) await deleteWorkspace(w.id, by);
  // (the last workspace it alone worked in may have taken it along; lib/erasure.ts writes the account down either way)
  if (auth.getUser(userId)) auth.deleteUser(userId, { memberships: workspaces.isMigrated() });
  await erasuresSettled();
  return plan;
}

/**
 * After a restore from a backup taken before some deletions: whatever the erasure log names that is back in the store
 * goes again (accounts first, then workspaces). `apply: false` only says what it would delete. Returns the ids.
 */
export async function reapplyErasures({ apply }: { apply: boolean }): Promise<{ accounts: string[]; workspaces: string[] }> {
  const log = listErasures();
  const accounts = [...new Set(log.filter((e) => e.kind === 'account').map((e) => e.id))].filter((id) => !!auth.getUser(id));
  const spaces = [...new Set(log.filter((e) => e.kind === 'workspace').map((e) => e.id))].filter(
    (id) => id !== DEFAULT_WORKSPACE && !!workspaces.getWorkspace(id),
  );
  if (!apply) return { accounts, workspaces: spaces };
  for (const id of spaces) if (workspaces.getWorkspace(id)) await deleteWorkspace(id, 'restore');
  for (const id of accounts) {
    if (!auth.getUser(id)) continue;
    // a restored account goes whatever it holds now: the log says its person asked (or the operator decided)
    for (const { workspace: w } of workspaces.workspacesOf(id, { suspended: true })) {
      if (w.members.every((m) => m.user === id) && w.id !== DEFAULT_WORKSPACE) await deleteWorkspace(w.id, 'restore');
      else if (auth.getUser(id))
        try {
          workspaces.removeMember(w.id, id);
        } catch (e) {
          console.error(`erasures: ${id} in ${w.id}: ${(e as Error).message}`);
        }
    }
    if (auth.getUser(id)) auth.deleteUser(id, { memberships: true });
  }
  return { accounts, workspaces: spaces };
}
