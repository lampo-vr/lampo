// OAuth scopes for apps that connect to a hosted server's MCP endpoint through its sign-in (ChatGPT, Claude.ai, Cursor,
// Codex, …). A scope caps what a connected app may do; the account's role (lib/permissions.ts) still applies on top,
// so a scope never grants more than the role allows. Browser-safe: the consent screen reads the same table.
import type { Action } from './permissions.ts';

export const SCOPES = {
  'review:read': {
    label: 'Read reviews',
    hint: 'see videos, notes and marked frames; wait for new feedback',
    actions: ['view'],
  },
  'review:comment': {
    label: 'Write notes',
    hint: 'ask questions and leave notes on frames, reply to notes',
    actions: ['view', 'comment'],
  },
  'review:act': {
    label: 'Act on feedback',
    hint: 'mark notes fixed or won’t fix, add and file renders, report what the agent is doing',
    actions: ['view', 'comment', 'resolve', 'upload', 'organize', 'agents', 'qa'],
  },
  // Drafting only: no scope grants publishing (a person publishes, in the app — `publish` is PERSON_ONLY).
  'post:draft': {
    label: 'Draft posts',
    hint: 'write post drafts of final videos for YouTube, Instagram and Facebook (a person publishes them)',
    actions: ['view', 'post'],
  },
  // Project files are their own scopes: an app connected with review:act (which uploads renders) must not silently
  // gain the project's footage. An app connected before these existed has neither.
  'files:read': {
    label: 'Read project files',
    hint: 'list and download the project files (footage, audio, fonts, project files)',
    actions: ['files'],
  },
  'files:write': {
    label: 'Add project files',
    hint: 'add, replace, rename, move and trash project files; every change is a version anyone can bring back',
    actions: ['files', 'files-write'],
  },
} as const satisfies Record<string, { label: string; hint: string; actions: readonly Action[] }>;

export type Scope = keyof typeof SCOPES;
export const SCOPE_LIST = Object.keys(SCOPES) as Scope[];

export const isScope = (s: string): s is Scope => Object.hasOwn(SCOPES, s);

/** The supported scopes in a space-separated `scope` parameter, deduplicated, in table order. */
export function parseScope(raw: string | null | undefined): Scope[] {
  const asked = new Set(
    String(raw || '')
      .split(/\s+/)
      .filter(Boolean),
  );
  return SCOPE_LIST.filter((s) => asked.has(s));
}

/** Broader scopes include the narrower ones (review:act can also read and comment). */
export const scopeAllows = (scopes: readonly string[], action: Action): boolean =>
  scopes.some((s) => isScope(s) && (SCOPES[s].actions as readonly Action[]).includes(action));

/** The narrowest scope that allows an action, for insufficient_scope challenges; null when no app may ever do it. */
export const scopeFor = (action: Action): Scope | null => SCOPE_LIST.find((s) => (SCOPES[s].actions as readonly Action[]).includes(action)) ?? null;
