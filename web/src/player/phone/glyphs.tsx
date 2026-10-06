// Generic icons for the apps the phone view imitates, drawn here on a 24-unit grid: a heart, a speech bubble, a paper
// plane, a house… — the kinds of glyph every app has, in the places they sit. No app's logo, wordmark or signature mark
// (no camera-in-a-square, no music-note logo, no red play button): the app's name only ever appears in the menu.

export type GlyphName =
  | 'heart'
  | 'bubble'
  | 'plane'
  | 'repost'
  | 'dots'
  | 'dotsV'
  | 'music'
  | 'camera'
  | 'search'
  | 'chevron'
  | 'home'
  | 'playbox'
  | 'people'
  | 'person'
  | 'inbox'
  | 'plus'
  | 'bookmark'
  | 'share'
  | 'bubbleFull'
  | 'thumb'
  | 'thumbDown'
  | 'square'
  | 'remix'
  | 'create'
  | 'stack'
  | 'vplay'
  | 'close';

const HEART = 'M12 20.6s-7.3-4.5-9.5-9C1 8.2 3.1 4.4 6.8 4.4c2.1 0 3.8 1.1 5.2 2.9 1.4-1.8 3.1-2.9 5.2-2.9 3.7 0 5.8 3.8 4.3 7.2-2.2 4.5-9.5 9-9.5 9z';
const HOUSE = 'M3.5 10.2 12 3.5l8.5 6.7V20a.8.8 0 0 1-.8.8h-5.2v-6h-5v6H4.3a.8.8 0 0 1-.8-.8z';
const THUMB = 'M2.6 10.4h3.6v10.2H2.6z M8.2 20.6V10.3l4.4-7c1.4-.4 2.6.7 2.4 2.1l-.8 4.2h5.3c1.4 0 2.4 1.3 2 2.6l-2.2 7.1c-.3.8-1 1.3-1.9 1.3z';

/** Each glyph: what to draw, outlined (stroke) or solid (fill). */
function shape(name: GlyphName, solid: boolean) {
  const line = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
  const full = { fill: 'currentColor' } as const;
  switch (name) {
    case 'heart':
      return <path d={HEART} {...(solid ? full : line)} />;
    case 'bubble':
      return <path d="M4.95 17.4A9.2 9.2 0 1 1 9.62 20.4L2.6 21.4z" {...line} />;
    case 'plane':
      return <path d="M21.5 3 2.5 9.5l8.3 3.7 3.7 8.3zM21.5 3l-10.7 10.2" {...line} />;
    case 'repost':
      return <path d="M17 3l3.5 3.5L17 10M3.5 11.5v-2a3 3 0 0 1 3-3h14M7 21l-3.5-3.5L7 14M20.5 12.5v2a3 3 0 0 1-3 3h-14" {...line} />;
    case 'dots':
      return (
        <g {...full}>
          <circle cx="5" cy="12" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="19" cy="12" r="1.9" />
        </g>
      );
    case 'dotsV':
      return (
        <g {...full}>
          <circle cx="12" cy="5" r="1.9" />
          <circle cx="12" cy="12" r="1.9" />
          <circle cx="12" cy="19" r="1.9" />
        </g>
      );
    case 'music':
      return (
        <g>
          <path d="M9 18V5.6l11-2.3V16" {...line} />
          <circle cx="6.4" cy="18" r="2.6" {...full} />
          <circle cx="17.4" cy="16" r="2.6" {...full} />
        </g>
      );
    case 'camera':
      return (
        <g {...line}>
          <path d="M3 8.6a2 2 0 0 1 2-2h2.6l1.6-2.4h5.6l1.6 2.4H19a2 2 0 0 1 2 2V18a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
          <circle cx="12" cy="13" r="3.7" />
        </g>
      );
    case 'search':
      return (
        <g {...line} strokeWidth={2.2}>
          <circle cx="10.6" cy="10.6" r="6.8" />
          <path d="M15.8 15.8 21 21" />
        </g>
      );
    case 'chevron':
      return <path d="M6.5 9.5 12 15l5.5-5.5" {...line} strokeWidth={2.4} />;
    case 'home':
      return <path d={HOUSE} {...(solid ? full : line)} />;
    case 'playbox':
      // a frame of film with its play button, outlined; the tab you're on draws it heavier (never a filled block)
      return (
        <g>
          <path d="M3.5 6.5a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3v11a3 3 0 0 1-3 3h-11a3 3 0 0 1-3-3zM3.5 8.4h17" {...line} strokeWidth={solid ? 2.4 : 2} />
          <path d="M10.4 11.2v6l5-3z" {...full} />
        </g>
      );
    case 'people':
      return (
        <g {...line}>
          <circle cx="9" cy="8.2" r="3.5" />
          <path d="M2.6 20c.6-3.6 3.1-5.8 6.4-5.8s5.8 2.2 6.4 5.8" />
          <path d="M15.6 5.2a3 3 0 0 1 0 6M17.6 14.6c2 .6 3.3 2.4 3.7 5" />
        </g>
      );
    case 'person':
      return (
        <g {...line}>
          <circle cx="12" cy="8" r="4" />
          <path d="M4 20.6c.8-4.2 4-6.6 8-6.6s7.2 2.4 8 6.6" />
        </g>
      );
    case 'inbox':
      return <path d="M4.5 4h15A1.5 1.5 0 0 1 21 5.5v10a1.5 1.5 0 0 1-1.5 1.5H10l-4.5 3.6V17h-1A1.5 1.5 0 0 1 3 15.5v-10A1.5 1.5 0 0 1 4.5 4z" {...line} />;
    case 'plus':
      return <path d="M12 5v14M5 12h14" {...line} strokeWidth={2.6} />;
    case 'bookmark':
      return (
        <path d="M6.6 3.4h10.8a1 1 0 0 1 1 1v16.4L12 16.4l-6.4 4.4V4.4a1 1 0 0 1 1-1z" {...full} stroke="currentColor" strokeWidth={1} strokeLinejoin="round" />
      );
    case 'share':
      return <path d="M13.5 4.2 22 12l-8.5 7.8v-4.6c-5.7-.3-9 1.8-11.5 6 .7-6.8 4.4-11.4 11.5-12.2z" {...full} strokeLinejoin="round" />;
    case 'bubbleFull':
      return (
        <g>
          <path d="M12 3.2c5.5 0 10 3.7 10 8.3s-4.5 8.3-10 8.3c-1 0-2-.1-2.9-.4L4.4 21.6l.9-4.3C3.3 15.8 2 13.8 2 11.5 2 6.9 6.5 3.2 12 3.2z" {...full} />
          <g fill="#000" opacity="0.32">
            <circle cx="7.6" cy="11.6" r="1.3" />
            <circle cx="12" cy="11.6" r="1.3" />
            <circle cx="16.4" cy="11.6" r="1.3" />
          </g>
        </g>
      );
    case 'thumb':
      return <path d={THUMB} {...full} />;
    case 'thumbDown':
      return <path d={THUMB} {...full} transform="matrix(1 0 0 -1 0 24)" />;
    case 'square':
      return (
        <g>
          <path d="M4.2 3.6h15.6A1.6 1.6 0 0 1 21.4 5.2v10.6a1.6 1.6 0 0 1-1.6 1.6H9L4.2 21v-3.6A1.6 1.6 0 0 1 2.6 15.8V5.2A1.6 1.6 0 0 1 4.2 3.6z" {...full} />
          <path d="M7 8.4h10M7 12.4h7" stroke="#000" strokeOpacity="0.35" strokeWidth={1.8} strokeLinecap="round" />
        </g>
      );
    case 'remix':
      return (
        <g {...line}>
          <circle cx="8.8" cy="12" r="5.6" />
          <circle cx="15.2" cy="12" r="5.6" />
        </g>
      );
    case 'create':
      return (
        <g {...line} strokeWidth={1.6}>
          <circle cx="12" cy="12" r="10" />
          <path d="M12 7.2v9.6M7.2 12h9.6" strokeWidth={1.8} />
        </g>
      );
    case 'stack':
      return (
        <g>
          <path
            d="M4.6 9.4h14.8A1.6 1.6 0 0 1 21 11v8a1.6 1.6 0 0 1-1.6 1.6H4.6A1.6 1.6 0 0 1 3 19v-8a1.6 1.6 0 0 1 1.6-1.6zM5.6 6.4h12.8M7.6 3.4h8.8"
            {...line}
          />
          <path d="M10.4 12.4v5.2l4.4-2.6z" {...full} />
        </g>
      );
    case 'vplay':
      return solid ? (
        <g>
          <rect x="5.6" y="2.6" width="12.8" height="18.8" rx="3.2" {...full} />
          <path d="M10.2 8.8v6.4l5-3.2z" fill="#000" />
        </g>
      ) : (
        <g>
          <rect x="5.6" y="2.6" width="12.8" height="18.8" rx="3.2" {...line} />
          <path d="M10.2 8.8v6.4l5-3.2z" {...full} />
        </g>
      );
    case 'close':
      return <path d="M5.6 5.6l12.8 12.8M18.4 5.6 5.6 18.4" {...line} strokeWidth={2.2} />;
  }
}

/** A glyph `size` points square, in the text colour; `solid` for the filled variant (the tab you're on, TikTok's rail). */
export function Glyph({ name, size, solid = false, className }: { name: GlyphName; size: number; solid?: boolean; className?: string }) {
  return (
    <svg className={className ? `pu-g ${className}` : 'pu-g'} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
      {shape(name, solid)}
    </svg>
  );
}
