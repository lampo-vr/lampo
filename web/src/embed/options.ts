// What the code a site pastes may ask of an Embed link's player, in its address (/e/<token>?autoplay=1&loop=1): a film
// that starts by itself, muted (browsers let only a silent video start on its own), plays on a loop, shows no controls
// (a page's background film: a click or Space still pauses it), or speaks German. Anything else is ignored. Shared with
// the tests: no browser APIs.
import type { Lang } from '../i18n/index.ts';

export interface EmbedOptions {
  /** Starts playing on its own, muted. */
  autoplay: boolean;
  muted: boolean;
  loop: boolean;
  /** false: no bar and no play button; the picture alone (and the mark while it shows). */
  controls: boolean;
  lang: Lang;
}

const yes = (v: string | null) => v === '1' || v === 'true';
const no = (v: string | null) => v === '0' || v === 'false';

export function embedOptions(search: string): EmbedOptions {
  const q = new URLSearchParams(search);
  const autoplay = yes(q.get('autoplay'));
  return {
    autoplay,
    muted: autoplay || yes(q.get('muted')),
    loop: yes(q.get('loop')),
    controls: !no(q.get('controls')),
    lang: q.get('lang') === 'de' ? 'de' : 'en',
  };
}

/** The link's token in the player's address (`/e/<token>`), or null when there is none of the right shape. */
export const tokenFromPath = (pathname: string): string | null => /^\/e\/([A-Za-z0-9_-]{20,40})$/.exec(pathname)?.[1] ?? null;
