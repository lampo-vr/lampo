// What a signed-in account's screens cached: everything but who is signed in. Signing in or out drops all of it — the
// account's API tokens, connected apps, users and invites included — so the next account never sees them, not even for
// the moment before its own arrive.
export const isAccountData = (key: readonly unknown[]): boolean => !(key[0] === 'auth' && key[1] === 'status');
