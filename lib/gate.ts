// Shared with the browser (no Node imports): whether an account is held until its address is confirmed.
import type { PublicUser } from './types.ts';

/**
 * A sign-up whose address isn't confirmed yet: it may sign in, but only to confirm it (server/permissions.ts lets it
 * reach nothing else; the app shows "Check your inbox"). Invited people whose address wasn't vouched for are
 * `unverified` too, but not held: the person who invited them vouched for them.
 */
export const isGated = (u: Pick<PublicUser, 'unverified' | 'signup'> | null | undefined): boolean => !!u?.unverified && !!u?.signup;
