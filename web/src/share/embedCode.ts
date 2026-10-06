// The code a site pastes to show an Embed link's video (docs/sharing.md, "Embedding a video"): one <iframe> as wide
// as the place it is put and as tall as the video's shape asks (CSS aspect-ratio on the frame itself, no wrapper), lazy,
// allowed to go full screen. Shared with the tests: no browser APIs.

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/** `1920 × 1080` → `16/9` (no spaces: the code stays one word there however it is wrapped); a size that isn't one (an
 * older server's link) is 16/9. */
export function ratioOf(width: number | undefined, height: number | undefined): string {
  if (!width || !height || width < 1 || height < 1) return '16/9';
  const d = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width) / d}/${Math.round(height) / d}`;
}

const attr = (s: string) => s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** The <iframe> for `src` (the player's address, /e/<token>), named `title` for people using a screen reader. */
export function embedCode({ src, title, width, height }: { src: string; title: string; width?: number; height?: number }): string {
  return `<iframe src="${attr(src)}" title="${attr(title)}" style="display:block;width:100%;aspect-ratio:${ratioOf(width, height)};border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>`;
}

/** The player's address for a link's watch-page address (`…/g/<token>` → `…/e/<token>`). */
export const embedSrc = (watchUrl: string): string => watchUrl.replace(/\/g\/([^/?#]+)$/, '/e/$1');
