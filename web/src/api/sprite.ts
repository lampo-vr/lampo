// A render's hover-scrub sprite (lib/sprite.ts), for the library's cards and the player's timeline preview. The server
// makes it on first request, after all other background work: 202 + Retry-After until then, then a `sprite` event.
// Review links have no event stream, so a pending sprite is also asked for again when Retry-After says. What the
// server answered is remembered per URL for the page's life, so a grid of cards asks once each.
import { useEffect, useState } from 'react';
import { spriteUrl } from '../../../lib/sprite.ts';
import { on } from './events.ts';

// The URL carries the sprite layout's version, so a new layout never meets an old cached image.
export { spriteUrl };

const MAX_TRIES = 20;
const known = new Map<string, 'ready' | 'none'>();

/** 'ready' (and in the HTTP cache), 'none' (this render gets none), seconds to wait, or null when unreachable. */
async function ask(url: string): Promise<'ready' | 'none' | number | null> {
  try {
    const res = await fetch(url);
    if (res.status === 202) return Math.min(30, Math.max(2, Number(res.headers.get('retry-after')) || 5));
    if (!res.ok) return 'none';
    // Cached for good (immutable): the CSS background that follows costs no second download.
    await res.blob();
    return 'ready';
  } catch {
    return null;
  }
}

/** Asks for a sprite ahead of time (the player shows it on the timeline): once per URL, and nothing waits for it. */
export async function warmSprite(url: string): Promise<void> {
  if (known.has(url)) return;
  const answer = await ask(url);
  if (answer === 'ready' || answer === 'none') known.set(url, answer);
}

/** The sprite's URL once it exists, else null. `wanted` says when to ask: a card while it's hovered, the player always. */
export function useSprite(url: string | null, slug: string, wanted: boolean): string | null {
  const [ready, setReady] = useState<string | null>(() => (url && known.get(url) === 'ready' ? url : null));
  useEffect(() => {
    setReady(url && known.get(url) === 'ready' ? url : null);
    if (!url || !wanted || known.has(url)) return;
    let live = true;
    let tries = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const check = async () => {
      clearTimeout(timer);
      const answer = await ask(url);
      if (!live) return;
      if (answer === 'ready' || answer === 'none') {
        known.set(url, answer);
        if (answer === 'ready') setReady(url);
      } else if (answer !== null && ++tries < MAX_TRIES) timer = setTimeout(check, answer * 1000);
    };
    void check();
    const off = on('sprite', (d) => {
      if (d.slug === slug) void check();
    });
    return () => {
      live = false;
      clearTimeout(timer);
      off();
    };
  }, [url, slug, wanted]);
  return ready;
}
