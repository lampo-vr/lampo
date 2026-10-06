// The Recent list's rules, without the browser: which videos it holds, for whom, in which order. Browser-safe and
// Node-safe (the unit tests import it); lib/recent.ts keeps it in this browser and exposes the hook.
/** Kept: enough that a few deleted or archived videos still leave a full list. */
export const RECENT_KEEP = 8;
/** Shown in the sidebar. */
export const RECENT_SHOWN = 5;

export interface KeptRecent {
  /** The account these were opened by; null before the app knew who (adopted by the first account that reads it). */
  who: string | null;
  slugs: string[];
}

export const EMPTY: KeptRecent = { who: null, slugs: [] };

/** The list as this account sees it: another account's list is nobody's here. */
export function recentFor(kept: KeptRecent, who: string | null): string[] {
  return !kept.who || !who || kept.who === who ? kept.slugs : [];
}

/** `slug` opened: first in the list, once, at most RECENT_KEEP. Unchanged (the same object) when it already leads. */
export function opened(kept: KeptRecent, who: string | null, slug: string): KeptRecent {
  const mine = recentFor(kept, who);
  if (mine[0] === slug && kept.who === who) return kept;
  return { who, slugs: [slug, ...mine.filter((s) => s !== slug)].slice(0, RECENT_KEEP) };
}

/** Without the videos that are gone (deleted, or a slug that never was one). */
export function without(kept: KeptRecent, gone: (slug: string) => boolean): KeptRecent {
  const slugs = kept.slugs.filter((s) => !gone(s));
  return slugs.length === kept.slugs.length ? kept : { ...kept, slugs };
}

export function parseKept(raw: string | null): KeptRecent {
  try {
    const k = JSON.parse(raw || 'null');
    if (!k || !Array.isArray(k.slugs)) return EMPTY;
    const slugs = [...new Set((k.slugs as unknown[]).filter((s): s is string => typeof s === 'string' && s.length > 0 && s.length <= 1024))];
    return { who: typeof k.who === 'string' ? k.who : null, slugs: slugs.slice(0, RECENT_KEEP) };
  } catch {
    return EMPTY;
  }
}
