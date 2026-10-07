// What a confirmed held account does on this server: where the person works from now on (lib/workspaces.ts
// placeSignup). Held accounts come from two places:
//
// - an invite taken on a server with workspaces (every hosted server): whoever made the invite holds its link too, so
//   taking it proves no inbox. The account is held, in no workspace, until its address is confirmed; then it joins the
//   workspaces of the invites it took, with their roles — the first account confirmed takes an invite. A reset link
//   proves the inbox too, but replaces the password the invites were taken with, so after one they are dropped (they
//   stay pending; the person takes them again with the new password).
// - LAMPO_SIGNUP=open (a hosted server only; lib/mail/config.ts refuses it anywhere else): a workspace of their own, empty,
//   with them as its owner, named after them until they name it (their first run asks) — never the existing team's
//   store. The account was created with the least role (`reviewer`, lib/auth.ts signUp) and belongs to no workspace
//   until this runs. On a server not open to sign-ups nobody gets a workspace here.
//
// LAMPO_SIGNUP=invite makes no account at all (an invited address gets its invite again; its link is the way in).
//
// Contract:
// - it runs when the address of a held account is confirmed (the emailed link, or a password reset from that inbox:
//   `reset`), before the account is let in and before the welcome email; the account is still held while it runs;
// - if it throws, the link is not used up and the account stays held: the person can open the link again;
// - two clicks on the same link can call it twice: it is idempotent (a person placed already stays where they are).
import type { PublicUser } from '../lib/types.ts';
import { placeSignup } from '../lib/workspaces.ts';

export interface SignupEvent {
  user: PublicUser;
  /** The address was proven with a reset link (a new password), not the confirm link. */
  reset?: boolean;
}

export type OnSignup = (e: SignupEvent) => Promise<void> | void;

export const onSignup: OnSignup | null = ({ user, reset }) => {
  placeSignup(user.id, { reset: !!reset });
};
