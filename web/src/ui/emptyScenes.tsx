// The drawings of the empty-state scenes (ui/emptyArt.tsx shows them): timelines, easing curves, keyframes, a playhead,
// film frames, 240 × 144 in the theme's inks (currentColor is the muted line colour), with one lit element in the brand
// colour at most — the keyframe or window the scene is about. What is drawn is the scene at rest: reduced motion shows
// it, and every loop starts from it and comes back to it. The loops are timelines in ./emptyMotion.ts, keyed by the
// `data-m` names below. This module and the timelines are one chunk, loaded when an empty state first shows: the
// start of the app carries neither.

import type { ReactElement } from 'react';
import type { EmptyArtName } from './emptyArt.tsx';

export { playScene } from './emptyMotion.ts';

/** A keyframe: a diamond with half-diagonal r. `m` names it for the scene's timeline. */
const Key = ({ x, y, r = 6, className = 'ea-key', m }: { x: number; y: number; r?: number; className?: string; m?: string }) => (
  <path data-m={m} className={className} d={`M${x} ${y - r}l${r} ${r}-${r} ${r}-${r}-${r}z`} />
);

/** The lit keyframe (brand colour) in its own soft light. `under`: an unlit keyframe beneath, for scenes whose loop
 * puts the light out and on again. */
const Lit = ({ id, x, y, r = 7, under }: { id: string; x: number; y: number; r?: number; under?: boolean }) => (
  <>
    {under && <Key x={x} y={y} r={r} />}
    <circle data-m="glow" cx={x} cy={y} r={r * 3.4} fill={`url(#${id}-glow)`} />
    <Key m="lit" x={x} y={y} r={r} className="ea-lit" />
  </>
);

/** A time ruler: a tick every 12, a longer one every 48. */
const Ruler = ({ y = 132, x1 = 24, x2 = 216 }: { y?: number; x1?: number; x2?: number }) => {
  let d = `M${x1} ${y}H${x2}`;
  for (let x = x1, i = 0; x <= x2; x += 12, i++) d += `M${x} ${y}v${i % 4 ? -3 : -6}`;
  return <path className="ea-ruler" d={d} />;
};

/** The playhead at x: a cap and a line. */
const Playhead = ({ x, y1, y2, lit }: { x: number; y1: number; y2: number; lit?: boolean }) => (
  <g data-m="ph">
    <path className="ea-head" d={`M${x} ${y1 + 6}V${y2}`} />
    <path className={lit ? 'ea-lit' : 'ea-head-cap'} d={`M${x - 5} ${y1}h10v4l-5 5-5-5z`} />
  </g>
);

/** The five empty frames of the film strip (x of each; 36 wide, centres 38 · 79 · 120 · 161 · 202). */
const FRAMES = [20, 61, 102, 143, 184];

/** A strip of film with empty frames; `scan`: a highlight per frame for the timeline to light as it passes. */
const Film = ({ scan }: { scan?: boolean }) => (
  <>
    <rect className="ea-film" x="14" y="34" width="212" height="60" rx="6" />
    {Array.from({ length: 17 }, (_, i) => 20 + i * 12).map((x) => (
      <g key={x}>
        <rect className="ea-hole" x={x} y="38" width="6" height="4" rx="1" />
        <rect className="ea-hole" x={x} y="86" width="6" height="4" rx="1" />
      </g>
    ))}
    {FRAMES.map((x) => (
      <rect key={x} className="ea-frame" x={x} y="47" width="36" height="34" rx="3" />
    ))}
    {scan && FRAMES.map((x, i) => <rect key={x} data-m={`scan${i}`} className="ea-scan ea-enter" x={x} y="47" width="36" height="34" rx="3" />)}
  </>
);

/** A folder from `y` down to 118, its tab on the left. */
const Folder = ({ y = 34 }: { y?: number }) => (
  <path className="ea-card" d={`M40 ${y}h40l8 8h112a6 6 0 0 1 6 6v${98 - y}a6 6 0 0 1-6 6H40a6 6 0 0 1-6-6V${y + 6}a6 6 0 0 1 6-6z`} />
);

const Person = ({ x, y, s = 1 }: { x: number; y: number; s?: number }) => (
  <path
    className="ea-line strong"
    d={`M${x} ${y - 14 * s}a${7 * s} ${7 * s} 0 1 1 0 ${14 * s}a${7 * s} ${7 * s} 0 1 1 0-${14 * s}zM${x - 13 * s} ${y + 18 * s}c${2 * s}-${9 * s} ${7 * s}-${13 * s} ${13 * s}-${13 * s}s${11 * s} ${4 * s} ${13 * s} ${13 * s}`}
  />
);

/** The "caught up" scene's queue: three waiting items (their centre line, their text's length), above the tray. */
const INBOX_ROWS: [number, number][] = [
  [18, 52],
  [38, 40],
  [58, 60],
];

/** The way a render drops from the target to the playhead. */
const DROP_ROUTE = 'M120 52V63C120 80 48 74 48 88V103';
const WEBHOOK_ROUTE = 'M70 88C112 88 116 52 152 52';

/** The API key, one outline: a round bow (r 24 about 54,72; its hole holds the keyframe), a shoulder, the blade with a
 * pointed tip, and a bit of four teeth of different depths — a key cut for one lock. */
const KEY_OUTLINE = 'M76.63 64H84V67H160L166 72L160 77H158V84H152V89H146V83H140V87H134V77H84V80H76.63A24 24 0 1 1 76.63 64Z';
/** The lock the key goes into: a plate with a keyhole cut out of it. */
const LOCK_PLATE =
  'M182 40h16a10 10 0 0 1 10 10v44a10 10 0 0 1-10 10h-16a10 10 0 0 1-10-10V50a10 10 0 0 1 10-10zM190 59a5 5 0 0 0-2.5 9.33V78a2.5 2.5 0 0 0 5 0V68.33A5 5 0 0 0 190 59z';

type Scene = (p: { id: string }) => ReactElement;

export const ART: Record<EmptyArtName, Scene> = {
  // the first render drops onto an empty layer: the drop target, the way down, the first keyframe waiting at the playhead
  library: ({ id }) => (
    <>
      <rect className="ea-drop" x="76" y="8" width="88" height="55" rx="8" />
      <path data-m="arrow" className="ea-line strong" d="M120 22v20M112 35l8 8 8-8" />
      <path data-m="route" className="ea-line ea-dash ea-dim" d="M120 63C120 80 48 74 48 88" />
      <rect className="ea-lane" x="24" y="94" width="192" height="18" rx="5" />
      {[96, 144, 192].map((x, i) => (
        <Key key={x} m={`g${i}`} x={x} y={103} className="ea-key ghost" />
      ))}
      <Ruler />
      <Playhead x={48} y1={84} y2={134} />
      <Lit id={id} x={48} y={103} />
      <rect data-m="tile" className="ea-tile ea-enter" x="-9" y="-6" width="18" height="12" rx="2.5" style={{ offsetPath: `path('${DROP_ROUTE}')` }} />
    </>
  ),
  // a scrubber jogs frame to frame over empty frames and finds nothing
  filter: () => (
    <>
      <Film scan />
      <Ruler y={128} />
      <Playhead x={161} y1={16} y2={130} lit />
    </>
  ),
  // a lens looks into one frame after another
  search: () => (
    <>
      <Film />
      <Ruler y={128} />
      <g data-m="lens" style={{ transformBox: 'view-box', transformOrigin: '161px 64px' }}>
        <circle className="ea-lens" cx="161" cy="64" r="21" />
        <path className="ea-lens-rim" d="M161 43a21 21 0 1 1 0 42a21 21 0 1 1 0-42zM176 79l13 13" />
      </g>
    </>
  ),
  // an empty folder: a dashed slot for the first video, a keyframe waiting on its track
  folder: ({ id }) => (
    <>
      <Folder />
      <rect className="ea-drop" x="90" y="54" width="60" height="38" rx="5" />
      <path data-m="plus" className="ea-line strong" d="M120 65v16M112 73h16" />
      <rect data-m="card" className="ea-frame raised ea-enter" x="96" y="58" width="48" height="30" rx="4" />
      <path className="ea-ruler" d="M52 108H188" />
      <Lit id={id} x={120} y={108} r={6} />
    </>
  ),
  // everything filed: frames tucked into a folder, the front of it lit with a settled keyframe
  filed: ({ id }) => (
    <>
      <Folder y={30} />
      {[
        [66, 24, -7],
        [92, 16, 0],
        [118, 22, 7],
      ].map(([x, y, a], i) => (
        <g key={x} data-m={`f${i}`}>
          <rect className="ea-frame raised" x={x} y={y} width="56" height="36" rx="4" transform={`rotate(${a} ${x + 28} ${y + 18})`} />
        </g>
      ))}
      <path className="ea-card front" d="M34 60h172v52a6 6 0 0 1-6 6H40a6 6 0 0 1-6-6z" />
      <Lit id={id} x={120} y={90} />
    </>
  ),
  // every keyframe ticked off, the last one lit; the playhead has played past them all
  clear: ({ id }) => (
    <>
      <rect className="ea-lane" x="24" y="30" width="192" height="12" rx="4" />
      <rect className="ea-lane" x="24" y="94" width="192" height="12" rx="4" />
      <rect className="ea-lane" x="24" y="60" width="192" height="20" rx="5" />
      {[48, 96, 144].map((x, i) => (
        <path key={x} data-m={`s${i}`} className="ea-line strong ea-dim ea-draw" pathLength={1} d={`M${x + 6} 70H${x + 42}`} />
      ))}
      {[48, 96, 144].map((x, i) => (
        <g key={x}>
          <Key x={x} y={70} />
          <Key m={`k${i}`} x={x} y={70} className="ea-key on" />
        </g>
      ))}
      {[48, 96, 144, 192].map((x, i) => (
        <path key={x} data-m={`t${i}`} className={`ea-line ea-draw${i === 3 ? ' strong' : ''}`} pathLength={1} d={`M${x - 5} 49l3.5 3.5 6.5-7`} />
      ))}
      <Ruler />
      <Playhead x={206} y1={16} y2={134} />
      <Lit id={id} x={192} y={70} under />
    </>
  ),
  // before and after, settled: a wipe shows the fix in the second frame, its keyframe lit
  check: ({ id }) => (
    <>
      <rect className="ea-frame" x="26" y="10" width="84" height="54" rx="6" />
      <rect className="ea-frame" x="130" y="10" width="84" height="54" rx="6" />
      <path className="ea-line ea-dim" d="M34 54C52 54 58 34 76 34s22 8 28 8" />
      <circle className="ea-line ea-dash" cx="60" cy="28" r="7" />
      <path className="ea-line strong" d="M138 54c18 0 24-20 42-20s22 8 28 8" />
      <circle data-m="after" className="ea-dot strong" cx="172" cy="26" r="7" />
      <path data-m="wipe" className="ea-wipe ea-enter" d="M131 11V63" />
      <path data-m="arrow" className="ea-line ea-dim" d="M114 37h12m-4-4 4 4-4 4" />
      <rect className="ea-lane" x="24" y="84" width="192" height="18" rx="5" />
      <path data-m="run" className="ea-line strong ea-dim ea-draw" pathLength={1} d="M68 93H172" />
      <Key x={68} y={93} className="ea-key on" />
      <Ruler />
      <Playhead x={172} y1={74} y2={134} />
      <Lit id={id} x={172} y={93} under />
    </>
  ),
  // caught up: what waited is set and filed — each item gets its keyframe and drops into the tray — and the tray rests
  // empty, its keyframe lit. At rest only the tray is there; the items show while the loop files them.
  inbox: ({ id }) => (
    <>
      {/* the tray's opening, behind what drops into it */}
      <rect className="ea-frame" x="66" y="72" width="108" height="12" rx="3" />
      {INBOX_ROWS.map(([y, w], i) => (
        <g key={y} data-m={`c${i}`} className="ea-enter">
          <rect className="ea-card" x="72" y={y - 8} width="96" height="16" rx="5" />
          <Key x={84} y={y} r={4.5} className="ea-key ghost" />
          <Key m={`k${i}`} x={84} y={y} r={4.5} className="ea-key on" />
          <rect className="ea-bar" x="95" y={y - 2.5} width={w} height="5" rx="2.5" />
        </g>
      ))}
      {/* done: the tick over the empty tray (drawn once the last item is in) */}
      <path data-m="tick" className="ea-line strong ea-draw" pathLength={1} d="M107 41l9 9 17-18" />
      {/* the tray's front, with the slot the items go through */}
      <g data-m="tray">
        <path className="ea-card" d="M62 80H96l6 9h36l6-9h34v34a8 8 0 0 1-8 8H70a8 8 0 0 1-8-8z" />
        <Lit id={id} x={120} y={106} r={6.5} />
      </g>
    </>
  ),
  // not enough yet: the bars rise as the playhead reads across, the last point lit
  insights: ({ id }) => (
    <>
      <path className="ea-grid" d="M24 40H216M24 72H216" />
      {[
        [36, 24],
        [62, 40],
        [88, 18],
        [114, 52],
        [140, 30],
        [166, 44],
        [192, 20],
      ].map(([x, h], i) => (
        <rect key={x} data-m={`b${i}`} className="ea-ghost" x={x} y={104 - h} width="14" height={h} rx="3" style={{ transformOrigin: '50% 100%' }} />
      ))}
      <path data-m="run" className="ea-line strong ea-draw" pathLength={1} d="M43 104H199" />
      <Key m="first" x={43} y={104} className="ea-key on" />
      <Ruler />
      <Playhead x={199} y1={18} y2={134} />
      <Lit id={id} x={199} y={104} under />
    </>
  ),
  // rows to come: the first one there, its keyframe lit, the others arriving in outline
  list: ({ id }) => (
    <>
      <g data-m="row">
        <rect className="ea-card" x="40" y="18" width="160" height="28" rx="7" />
        <rect className="ea-bar" x="74" y="29" width="84" height="6" rx="3" />
        <Lit id={id} x={58} y={32} r={6} />
      </g>
      {[58, 98].map((y, i) => (
        <g key={y} data-m={`r${i}`}>
          <rect className="ea-ghost" x="40" y={y} width="160" height="28" rx="7" />
          <Key x={58} y={y + 14} r={5} className="ea-key ghost" />
          <rect className="ea-bar ea-dim" x="74" y={y + 11} width={i ? 56 : 100} height="6" rx="3" />
        </g>
      ))}
    </>
  ),
  // pause on a frame, mark it up with the pencil (an arrow, a line under the title), leave the note; its keyframe lit
  // where the playhead stopped
  note: ({ id }) => (
    <>
      <rect className="ea-frame" x="36" y="8" width="120" height="75" rx="7" />
      <rect className="ea-bar" x="50" y="48" width="56" height="7" rx="3.5" />
      <rect className="ea-bar ea-dim" x="50" y="60" width="36" height="5" rx="2.5" />
      <path data-m="shaft" className="ea-pencil ea-draw" pathLength={1} d="M132 20c-8 4-16 12-19 21" />
      <path data-m="tip" className="ea-pencil ea-draw" pathLength={1} d="M111 33l2 8 8-3" />
      <path data-m="under" className="ea-pencil ea-draw" pathLength={1} d="M48 72c14-3 38-4 64-2" />
      <g data-m="bubble" style={{ transformOrigin: '15% 100%' }}>
        <path className="ea-card" d="M150 16h52a7 7 0 0 1 7 7v24a7 7 0 0 1-7 7h-34l-10 9v-9h-8a7 7 0 0 1-7-7V23a7 7 0 0 1 7-7z" />
        <rect className="ea-bar" x="152" y="27" width="46" height="5" rx="2.5" />
        <rect className="ea-bar ea-dim" x="152" y="38" width="30" height="5" rx="2.5" />
      </g>
      <rect className="ea-lane" x="24" y="96" width="192" height="16" rx="5" />
      <Ruler />
      <Playhead x={112} y1={88} y2={134} />
      <Lit id={id} x={112} y={104} r={6} under />
    </>
  ),
  // a person and an agent, the keyframe between them waiting for the link
  // a suggestion: the playbook's rules, and a rule an agent proposes sliding in beneath them, marked lit — yours to take
  suggest: ({ id }) => (
    <>
      <rect className="ea-card" x="52" y="10" width="136" height="124" rx="9" />
      <rect className="ea-bar" x="66" y="24" width="48" height="7" rx="3.5" />
      {[44, 60, 76].map((y, i) => (
        <g key={y}>
          <circle className="ea-dot" cx="70" cy={y} r="2.4" />
          <rect className="ea-bar ea-dim" x="80" y={y - 3} width={[82, 64, 74][i]} height="6" rx="3" />
        </g>
      ))}
      <g data-m="sug">
        <rect className="ea-ghost" x="60" y="92" width="120" height="28" rx="7" />
        <rect data-m="sugbar" className="ea-bar" x="86" y="103" width="70" height="6" rx="3" style={{ transformOrigin: '0% 50%' }} />
        <Lit id={id} x={73} y={106} r={6} />
      </g>
    </>
  ),
  agents: ({ id }) => (
    <>
      <g data-m="you">
        <rect className="ea-card" x="20" y="42" width="60" height="60" rx="14" />
        <Person x={50} y={70} s={0.9} />
      </g>
      <g data-m="bot">
        <rect className="ea-card" x="160" y="42" width="60" height="60" rx="14" />
        <path
          data-m="spark"
          className="ea-line strong"
          d="M190 58c1.5 8 4.5 11 12.5 12.5-8 1.5-11 4.5-12.5 12.5-1.5-8-4.5-11-12.5-12.5 8-1.5 11-4.5 12.5-12.5z"
        />
      </g>
      <path className="ea-line ea-dash" d="M84 72H156" />
      <path data-m="cl" className="ea-link ea-draw" pathLength={1} d="M84 72H113" />
      <path data-m="cr" className="ea-link ea-draw" pathLength={1} d="M156 72H127" />
      <Lit id={id} x={120} y={72} />
    </>
  ),
  // the frame you review, lit — it switches on — and the way it travels to people without an account
  client: ({ id }) => (
    <>
      <circle data-m="glow" cx="120" cy="42" r="38" fill={`url(#${id}-glow)`} />
      <g transform="translate(120 42) skewX(-8) translate(-120 -42)">
        <path className="ea-frame-o" fillRule="evenodd" d="M96 22h48a6 6 0 0 1 6 6v28a6 6 0 0 1-6 6H96a6 6 0 0 1-6-6V28a6 6 0 0 1 6-6zM97 26v32h46V26z" />
        <rect data-m="lamp" className="ea-lit" x="97" y="26" width="46" height="32" />
      </g>
      {/* the routes, and the links drawn along them from the frame to each person */}
      <path className="ea-line ea-dash ea-dim" d="M148 68C160 94 170 100 184 104" />
      <path className="ea-line ea-dash ea-dim" d="M92 68C80 94 70 100 56 104" />
      <path data-m="lR" className="ea-line strong ea-draw" pathLength={1} d="M148 68C160 94 170 100 184 104" />
      <path data-m="lL" className="ea-line strong ea-draw" pathLength={1} d="M92 68C80 94 70 100 56 104" />
      <g data-m="pR">
        <circle className="ea-card" cx="200" cy="108" r="16" />
        <Person x={200} y={106} s={0.55} />
      </g>
      <g data-m="pL">
        <circle className="ea-card" cx="40" cy="108" r="16" />
        <Person x={40} y={106} s={0.55} />
      </g>
    </>
  ),
  // a key, its keyframe held in the bow, and the lock it goes into
  token: ({ id }) => (
    <>
      <g data-m="key">
        <path className="ea-card" d={KEY_OUTLINE} />
        {/* the milled groove along the blade */}
        <path className="ea-line ea-dim" d="M92 72H152" />
        <circle className="ea-hole-ring" cx="54" cy="72" r="13" />
        <Lit id={id} x={54} y={72} r={6.5} />
      </g>
      <path data-m="plate" className="ea-card front" fillRule="evenodd" d={LOCK_PLATE} />
    </>
  ),
  // an event leaves a keyframe and rides out to another tool
  webhook: ({ id }) => (
    <>
      <circle className="ea-card" cx="52" cy="92" r="18" />
      <Key m="src" x={52} y={92} className="ea-key on" />
      <g data-m="card">
        <rect className="ea-card" x="152" y="30" width="64" height="44" rx="8" />
        <rect data-m="bar0" className="ea-bar" x="162" y="43" width="42" height="5" rx="2.5" style={{ transformOrigin: '0 50%' }} />
        <rect data-m="bar1" className="ea-bar ea-dim" x="162" y="55" width="28" height="5" rx="2.5" style={{ transformOrigin: '0 50%' }} />
      </g>
      <path data-m="route" className="ea-line ea-dash" d={WEBHOOK_ROUTE} />
      <g data-m="pulse" className="ea-pulse" style={{ offsetPath: `path('${WEBHOOK_ROUTE}')` }}>
        <circle r="18" fill={`url(#${id}-glow)`} />
        <circle className="ea-lit" r="4.5" />
      </g>
    </>
  ),
  // it broke off: the curve snaps where the rest didn't arrive
  error: () => (
    <g data-m="all">
      <rect className="ea-frame" x="44" y="20" width="152" height="96" rx="8" />
      <path data-m="curve" className="ea-line strong ea-draw" pathLength={1} d="M62 98C88 98 100 72 116 66" />
      <path data-m="sparks" className="ea-line" d="M121 58l-2.5-7M127 57l2.5-7M131 63l6.5-3" />
      <g data-m="rest">
        <path className="ea-line ea-dash ea-dim" d="M134 60C150 55 162 45 172 40" />
        <Key x={178} y={40} className="ea-key ghost" />
      </g>
      <Key m="start" x={62} y={98} className="ea-key on" />
    </g>
  ),
};
