// The empty-state scenes' loops (ui/emptyArt.tsx), written the way a motion designer keys a timeline: per element
// (its `data-m` name), a value at a time and the curve that leaves it. Every track starts from the drawn pose and comes
// back to it, then the scene holds; one loop is one period `T` for every element of a scene, so they stay in step.
// Web Animations, not CSS: the moves of one scene are timed against each other (a keyframe lights when the playhead
// reaches it), which percentages in shared @keyframes can't say. Loaded when a scene first shows (not at start).

import type { EmptyArtName } from './emptyArt.tsx';

/** The curves. `back` overshoots and settles, `anti` pulls back before it goes, `snap` lands a hop with a small
 * overshoot. Spelled out (never var()): Safari ignores var() in a keyframe's timing and runs the segment linear. */
const E = {
  lin: 'linear',
  out: 'cubic-bezier(0.16, 1, 0.3, 1)',
  in: 'cubic-bezier(0.55, 0, 0.75, 0.3)',
  io: 'cubic-bezier(0.65, 0, 0.35, 1)',
  sine: 'cubic-bezier(0.37, 0, 0.63, 1)',
  back: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
  snap: 'cubic-bezier(0.34, 1.3, 0.64, 1)',
  anti: 'cubic-bezier(0.36, 0, 0.66, -0.56)',
};

/** One element's values: x/y px, r deg, s (or sx/sy) scale, o opacity, d stroke-dashoffset, p offset-distance %. */
interface V {
  x?: number;
  y?: number;
  r?: number;
  s?: number;
  sx?: number;
  sy?: number;
  o?: number;
  d?: number;
  p?: number;
}
/** At `t` seconds the element has these values; `ease` is the curve to the next beat. */
type Beat = [t: number, v: V, ease?: string];
interface Track {
  m: string;
  beats: Beat[];
  /** Values at rest where they differ from the plain drawing (an element that only shows while moving: o 0). */
  rest?: V;
}
interface Choreo {
  T: number;
  tracks: Track[];
}

const REST: Required<V> = { x: 0, y: 0, r: 0, s: 1, sx: Number.NaN, sy: Number.NaN, o: 1, d: 0, p: 0 };

function keyframes(T: number, { beats, rest = {} }: Track): Keyframe[] {
  const used = new Set<keyof V>();
  for (const [, v] of beats) for (const k of Object.keys(v) as (keyof V)[]) used.add(k);
  const start: V = { ...REST, ...rest };
  const list: Beat[] = [...beats].sort((a, b) => a[0] - b[0]);
  if (list[0][0] > 0) list.unshift([0, {}, list[0][2] ?? E.lin]);
  let now: V = { ...start };
  const out: Keyframe[] = [];
  for (const [t, v, ease] of list) {
    now = { ...now, ...v };
    const f: Keyframe = { offset: Math.min(1, t / T), easing: ease ?? E.lin };
    if (used.has('x') || used.has('y') || used.has('r') || used.has('s') || used.has('sx') || used.has('sy')) {
      const s = now.s ?? 1;
      const sx = Number.isNaN(now.sx ?? Number.NaN) ? s : (now.sx as number);
      const sy = Number.isNaN(now.sy ?? Number.NaN) ? s : (now.sy as number);
      f.transform = `translate(${now.x}px, ${now.y}px) rotate(${now.r}deg) scale(${sx}, ${sy})`;
    }
    if (used.has('o')) f.opacity = now.o;
    if (used.has('d')) f.strokeDashoffset = String(now.d);
    if (used.has('p')) f.offsetDistance = `${now.p}%`;
    out.push(f);
  }
  // the loop ends where it began: hold the last values to T (a symmetric shape may end turned: it looks the same)
  if ((out.at(-1)?.offset as number) < 1) out.push({ ...out[out.length - 1], offset: 1 });
  return out;
}

/** A keyframe hit: from `from` it jumps past full size and settles (with a little give) — a key being set. */
const hit = (t: number, peak = 1.45, from = 1): Beat[] => [
  [t, { s: from }, E.out],
  [t + 0.08, { s: peak }, E.back],
  [t + 0.45, { s: 1 }],
];
/** A light going out (the scene rewinds) and on again at `on`, where it pops. */
const relight = (off: number, on: number, peak = 1.55): Beat[] => [
  [0, { o: 1, s: 1 }],
  [off, { o: 1, s: 1 }, E.in],
  [off + 0.1, { o: 0, s: 0.7 }],
  [on, { o: 0, s: 0.7 }, E.out],
  [on + 0.08, { o: 1, s: peak }, E.back],
  [on + 0.5, { o: 1, s: 1 }],
];
/** The glow around a lit keyframe: out with it, and blooming a little past its size when it lights. */
const bloom = (on: number, off?: number): Beat[] => [
  [0, { o: 1, s: 1 }],
  ...(off === undefined
    ? ([
        [on - 0.04, { o: 1, s: 1 }, E.in],
        [on + 0.06, { o: 0.5, s: 0.75 }, E.out],
      ] as Beat[])
    : ([
        [off, { o: 1, s: 1 }, E.in],
        [off + 0.15, { o: 0, s: 0.6 }],
        [on, { o: 0, s: 0.6 }, E.out],
      ] as Beat[])),
  [on + 0.3, { o: 1, s: 1.28 }, E.io],
  [on + 0.95, { o: 1, s: 1 }],
];
/** A stroke that is gone quickly at `off` and draws itself from `from` to `to` (pathLength 1). */
const redraw = (off: number, from: number, to: number, ease = E.io): Beat[] => [
  [0, { d: 0, o: 1 }],
  [off, { d: 0, o: 1 }, E.in],
  [off + 0.1, { d: 0, o: 0 }],
  [off + 0.12, { d: 1, o: 0 }],
  [from, { d: 1, o: 0 }],
  [from + 0.01, { d: 1, o: 1 }, ease],
  [to, { d: 0, o: 1 }],
];
/** A link drawing itself in from its start (pathLength 1) between `t0` and `t1`, held, and let go at `off`. */
const connect = (t0: number, t1: number, off: number): Beat[] => [
  [0, { d: 1, o: 0 }],
  [t0, { d: 1, o: 0 }],
  [t0 + 0.01, { d: 1, o: 1 }, E.in],
  [t1, { d: 0, o: 1 }],
  [off, { d: 0, o: 1 }, E.io],
  [off + 0.45, { d: 0, o: 0 }],
  [off + 0.47, { d: 1, o: 0 }],
];

/** When a playhead moving linearly from x0 (at t0) to x1 (at t1) passes x. */
const at = (x: number, x0: number, x1: number, t0: number, t1: number) => t0 + ((x - x0) / (x1 - x0)) * (t1 - t0);

const SCENES: Record<EmptyArtName, () => Choreo> = {
  // Rewind, then play through: every keyframe is set as the playhead reaches it, its tick draws, the line to the next
  // one follows the playhead; the last lights up and the playhead comes to rest just past it.
  clear: () => {
    const play = (x: number) => at(x, 34, 206, 0.9, 3.9);
    // the rewind (a whip, 0.18 → 0.62 s) passes the keyframes on its way back: these are the moments, right to left
    const back: Record<number, number> = { 192: 0.31, 144: 0.38, 96: 0.43, 48: 0.5 };
    const keys = [48, 96, 144];
    return {
      T: 6.4,
      tracks: [
        {
          m: 'ph',
          beats: [
            [0, { x: 0 }, E.io],
            [0.18, { x: 5 }, E.io],
            [0.62, { x: -172 }],
            [0.9, { x: -172 }, E.lin],
            [3.9, { x: 0 }, E.out],
            [4.12, { x: 3 }, E.io],
            [4.42, { x: 0 }],
          ],
        },
        ...keys.map((x, i) => ({ m: `k${i}`, beats: relight(back[x], play(x), 1.45) })),
        ...[...keys, 192].map((x, i) => ({ m: `t${i}`, beats: redraw(back[x], play(x) + 0.1, play(x) + 0.42, E.out) })),
        ...keys.map((x, i) => ({ m: `s${i}`, beats: redraw(back[x] - 0.04, play(x + 6), play(x + 42), E.lin) })),
        { m: 'lit', beats: relight(back[192], play(192), 1.6) },
        { m: 'glow', beats: bloom(play(192), back[192]) },
      ],
    };
  },

  // The render lifts out of the drop target, travels the way down, and lands on the playhead: the keyframe lights, the
  // keyframes still to come answer one after another.
  library: () => ({
    T: 5.2,
    tracks: [
      {
        m: 'arrow',
        beats: [
          [0.2, { y: 0 }, E.io],
          [0.45, { y: -3 }, E.in],
          [0.62, { y: 4 }, E.back],
          [1.0, { y: 0 }],
        ],
      },
      {
        m: 'tile',
        rest: { o: 0, p: 0, s: 0.6 },
        beats: [
          [0.55, { o: 0, p: 0, s: 0.6 }, E.out],
          [0.72, { o: 1, p: 0, s: 1 }, E.io],
          [1.82, { o: 1, p: 100, s: 1 }, E.in],
          [1.94, { o: 0, p: 100, s: 0.3 }],
          [2.0, { o: 0, p: 0, s: 0.6 }],
        ],
      },
      {
        m: 'route',
        beats: [
          [0.72, { d: 0 }, E.lin],
          [1.82, { d: -14 }],
        ],
      },
      {
        m: 'ph',
        beats: [
          [1.86, { y: 0 }, E.out],
          [1.94, { y: 2.5 }, E.back],
          [2.3, { y: 0 }],
        ],
      },
      { m: 'lit', beats: hit(1.88, 1.55) },
      { m: 'glow', beats: bloom(1.9) },
      ...[0, 1, 2].map((i) => ({
        m: `g${i}`,
        rest: { o: 0.6 },
        beats: [
          [2.1 + 0.14 * i, { s: 1, o: 0.6 }, E.out],
          [2.24 + 0.14 * i, { s: 1.3, o: 1 }, E.io],
          [2.7 + 0.14 * i, { s: 1, o: 0.6 }],
        ] as Beat[],
      })),
    ],
  }),

  // Scrubbing: the playhead jogs frame by frame (a small snap on each landing), each frame lights under it and shows
  // nothing; it glides back to where it rests.
  filter: () => {
    const stops = [-123, -82, -41, 0, 41];
    const arrive = [0.62, 1.22, 1.82, 2.42, 3.02];
    const ph: Beat[] = [
      [0, { x: 0 }, E.io],
      [0.2, { x: 4 }, E.io],
      [arrive[0], { x: stops[0] }],
    ];
    for (let i = 1; i < stops.length; i++) ph.push([arrive[i] - 0.28, { x: stops[i - 1] }, E.snap], [arrive[i], { x: stops[i] }]);
    ph.push([3.4, { x: 41 }, E.io], [3.98, { x: -3 }, E.io], [4.3, { x: 0 }]);
    return {
      T: 6.4,
      tracks: [
        { m: 'ph', beats: ph },
        ...arrive.map((t, i) => ({
          m: `scan${i}`,
          rest: { o: 0 },
          beats: [
            [t - 0.04, { o: 0 }, E.out],
            [t + 0.06, { o: 1 }, E.io],
            [t + 0.5, { o: 0 }],
          ] as Beat[],
        })),
      ],
    };
  },

  // A lens looks into one frame after another: glide, a closer look (a little zoom that settles), on to the next.
  search: () => {
    const look = (t: number, x: number): Beat[] => [
      [t, { x, s: 1 }, E.out],
      [t + 0.14, { x, s: 1.12 }, E.back],
      [t + 0.46, { x, s: 1 }],
    ];
    return {
      T: 5.4,
      tracks: [
        {
          m: 'lens',
          beats: [
            [0, { x: 0, s: 1 }, E.io],
            [0.25, { x: 3, s: 1 }, E.io],
            [0.8, { x: -82, s: 1 }],
            ...look(0.82, -82),
            [1.35, { x: -82, s: 1 }, E.io],
            [1.8, { x: -41, s: 1 }],
            ...look(1.82, -41),
            [2.35, { x: -41, s: 1 }, E.io],
            [2.8, { x: 0, s: 1 }],
            ...look(2.82, 0),
          ],
        },
      ],
    };
  },

  // The slot invites (the plus breathes), a render hovers in, hesitates, drops into place with a bounce; the keyframe
  // on the track lights. Then it lifts away and the folder is empty again.
  folder: () => ({
    T: 6.0,
    tracks: [
      {
        m: 'plus',
        beats: [
          [0.3, { s: 1, o: 1 }, E.sine],
          [0.65, { s: 1.16, o: 1 }, E.sine],
          [1.0, { s: 1, o: 1 }, E.sine],
          [1.35, { s: 1.16, o: 1 }, E.sine],
          [1.7, { s: 1, o: 1 }, E.in],
          [2.3, { s: 1, o: 1 }, E.in],
          [2.42, { s: 0.6, o: 0 }],
          [3.7, { s: 0.6, o: 0 }, E.back],
          [4.05, { s: 1, o: 1 }],
        ],
      },
      {
        m: 'card',
        rest: { o: 0, y: -16 },
        beats: [
          [1.55, { o: 0, y: -16 }, E.out],
          [1.9, { o: 1, y: -9 }, E.io],
          [2.08, { o: 1, y: -11 }, E.in],
          [2.3, { o: 1, y: 0 }, E.snap],
          [2.6, { o: 1, y: 0 }],
          [3.5, { o: 1, y: 0 }, E.in],
          [3.8, { o: 0, y: -6 }],
          [3.9, { o: 0, y: -16 }],
        ],
      },
      { m: 'lit', beats: hit(2.34, 1.5) },
      { m: 'glow', beats: bloom(2.36) },
    ],
  }),

  // The frames rise out of the folder one after another (a dip first, a fan as they go up) and tuck back in with a
  // little follow-through; the keyframe on the front lights as the last one settles.
  filed: () => ({
    T: 4.6,
    tracks: [
      ...[0, 1, 2].map((i) => {
        const t = 0.35 + 0.12 * i;
        const fan = (i - 1) * 3;
        return {
          m: `f${i}`,
          beats: [
            [t, { y: 0, r: 0 }, E.io],
            [t + 0.15, { y: 3, r: 0 }, E.out],
            [t + 0.55, { y: -12, r: fan }, E.io],
            [t + 0.9, { y: -12, r: fan }, E.in],
            [t + 1.14, { y: 2, r: 0 }, E.snap],
            [t + 1.4, { y: 0, r: 0 }],
          ] as Beat[],
        };
      }),
      { m: 'lit', beats: hit(1.72, 1.5) },
      { m: 'glow', beats: bloom(1.74) },
    ],
  }),

  // Checking a fix: the playhead goes back to the note and plays to the fix while the line between them draws; a wipe
  // crosses the second frame (the fix appears as it passes) and the keyframe lights.
  check: () => ({
    T: 5.2,
    tracks: [
      {
        m: 'ph',
        beats: [
          [0, { x: 0 }, E.io],
          [0.18, { x: 4 }, E.io],
          [0.6, { x: -104 }],
          [0.9, { x: -104 }, E.io],
          [2.2, { x: 0 }],
        ],
      },
      { m: 'run', beats: redraw(0.2, 0.9, 2.2) },
      {
        m: 'wipe',
        rest: { o: 0 },
        beats: [
          [0.95, { o: 0, x: 0 }, E.out],
          [1.05, { o: 1, x: 0 }, E.io],
          [2.1, { o: 1, x: 82 }, E.out],
          [2.3, { o: 0, x: 82 }],
          [2.35, { o: 0, x: 0 }],
        ],
      },
      { m: 'after', beats: hit(1.56, 1.35) },
      {
        m: 'arrow',
        beats: [
          [0.9, { x: 0 }, E.io],
          [1.05, { x: -2 }, E.out],
          [1.3, { x: 4 }, E.io],
          [1.7, { x: 0 }],
        ],
      },
      { m: 'lit', beats: relight(0.2, 2.2, 1.5) },
      { m: 'glow', beats: bloom(2.2, 0.2) },
    ],
  }),

  // Caught up: the waiting items come in as a queue (a stagger, easing out), then from the one nearest the tray up,
  // each gets its keyframe set (a pop past full size), lifts a touch — the anticipation — and drops through the slot,
  // shrinking a little as it goes in; the tray gives under it and springs back. When the last is filed the tray's
  // keyframe lights and its light blooms, and the tick over it draws itself: nothing waits. Then the empty tray holds.
  inbox: () => {
    const rows = [0, 1, 2];
    const into = [2, 1, 0];
    const come = (i: number) => 0.25 + 0.12 * i;
    const set = (i: number) => 1.15 + 0.72 * into.indexOf(i);
    const drop = (i: number) => set(i) + 0.32;
    const land = (i: number) => drop(i) + 0.5;
    const dy = (i: number) => 98 - [18, 38, 58][i];
    const done = land(0) + 0.08;
    return {
      T: 6.2,
      tracks: [
        ...rows.map((i) => ({
          m: `c${i}`,
          rest: { o: 0 },
          beats: [
            [come(i), { o: 0, x: 18 }, E.out],
            [come(i) + 0.5, { o: 1, x: 0 }],
            [drop(i), { o: 1, y: 0, s: 1 }, E.io],
            [drop(i) + 0.14, { o: 1, y: -3, s: 1 }, E.in],
            [land(i), { o: 0, y: dy(i), s: 0.86 }],
          ] as Beat[],
        })),
        ...rows.map((i) => ({
          m: `k${i}`,
          rest: { s: 0 },
          beats: [
            [set(i), { s: 0 }, E.back],
            [set(i) + 0.26, { s: 1 }],
          ] as Beat[],
        })),
        {
          m: 'tray',
          beats: into.flatMap((i) => [
            [land(i) - 0.06, { y: 0 }, E.out],
            [land(i) + 0.04, { y: 1.6 }, E.back],
            [land(i) + 0.34, { y: 0 }],
          ]) as Beat[],
        },
        { m: 'lit', beats: relight(0.12, done) },
        { m: 'glow', beats: bloom(done + 0.04, 0.12) },
        { m: 'tick', beats: redraw(0.12, done + 0.15, done + 0.6, E.out) },
      ],
    };
  },

  // Reading the period: the bars go down, the playhead returns to the first point and reads across; each bar rises
  // (past its height, then settles) as the playhead reaches it, the line follows, the last point lights.
  insights: () => {
    const read = (x: number) => at(x, 43, 199, 1.0, 3.0);
    return {
      T: 5.6,
      tracks: [
        ...[0, 1, 2, 3, 4, 5, 6].map((i) => ({
          m: `b${i}`,
          beats: [
            [0.2 + 0.03 * i, { sy: 1 }, E.in],
            [0.42 + 0.03 * i, { sy: 0 }],
            [read(43 + 26 * i) - 0.02, { sy: 0 }, E.back],
            [read(43 + 26 * i) + 0.42, { sy: 1 }],
          ] as Beat[],
        })),
        {
          m: 'ph',
          beats: [
            [0, { x: 0 }, E.io],
            [0.25, { x: 4 }, E.io],
            [0.75, { x: -156 }],
            [1.0, { x: -156 }, E.lin],
            [3.0, { x: 0 }, E.out],
            [3.2, { x: 3 }, E.io],
            [3.45, { x: 0 }],
          ],
        },
        { m: 'run', beats: redraw(0.3, 1.0, 3.0, E.lin) },
        { m: 'first', beats: hit(1.0, 1.35) },
        { m: 'lit', beats: relight(0.3, 3.0) },
        { m: 'glow', beats: bloom(3.0, 0.3) },
      ],
    };
  },

  // Rows to come: the outlines leave, the first row takes a breath and its keyframe lights, the outlines come back in
  // one after another.
  list: () => ({
    T: 4.4,
    tracks: [
      ...[0, 1].map((i) => ({
        m: `r${i}`,
        beats: [
          [0.2 + 0.08 * i, { o: 1, y: 0 }, E.in],
          [0.45 + 0.08 * i, { o: 0, y: 8 }],
          [1.3 + 0.15 * i, { o: 0, y: 12 }, E.out],
          [1.85 + 0.15 * i, { o: 1, y: 0 }],
        ] as Beat[],
      })),
      {
        m: 'row',
        beats: [
          [0.7, { y: 0 }, E.io],
          [0.85, { y: 2 }, E.out],
          [1.05, { y: -3 }, E.io],
          [1.4, { y: 0 }],
        ],
      },
      { m: 'lit', beats: hit(1.08, 1.5) },
      { m: 'glow', beats: bloom(1.1) },
    ],
  }),

  // Pause on a frame (the playhead comes to a stop), mark it up (the arrow draws, its tip, the line under the title),
  // leave the note (the bubble springs from its tail), and the keyframe lights where the playhead stopped.
  note: () => ({
    T: 5.6,
    tracks: [
      {
        m: 'ph',
        beats: [
          [0.2, { x: 0 }, E.io],
          [0.5, { x: -48 }],
          [0.7, { x: -48 }, E.out],
          [1.3, { x: 0 }],
        ],
      },
      { m: 'shaft', beats: redraw(0.1, 1.4, 1.75) },
      { m: 'tip', beats: redraw(0.1, 1.75, 1.9, E.out) },
      { m: 'under', beats: redraw(0.1, 1.95, 2.35) },
      {
        m: 'bubble',
        beats: [
          [0.1, { o: 1, s: 1 }, E.in],
          [0.3, { o: 0, s: 0.8 }],
          [2.4, { o: 0, s: 0.6 }, E.back],
          [2.75, { o: 1, s: 1 }],
        ],
      },
      { m: 'lit', beats: relight(0.1, 2.9) },
      { m: 'glow', beats: bloom(2.9, 0.1) },
    ],
  }),

  // A handshake: the link draws in from the person and from the agent, they meet at the keyframe, it lights, the agent's
  // spark turns a quarter and both nod; the link lets go again (no agent is connected yet).
  // A rule is suggested: the proposal slides in under the rules with a little give, its line writes itself, and the
  // keyframe that marks it as a suggestion lights — then it waits for you.
  suggest: () => ({
    T: 4.8,
    tracks: [
      {
        m: 'sug',
        beats: [
          [0.15, { o: 1, y: 0 }, E.in],
          [0.4, { o: 0, y: 6 }],
          [0.9, { o: 0, y: 14 }, E.back],
          [1.35, { o: 1, y: 0 }],
        ],
      },
      {
        m: 'sugbar',
        beats: [
          [0.15, { sx: 1 }, E.in],
          [0.4, { sx: 0 }],
          [1.2, { sx: 0 }, E.out],
          [1.8, { sx: 1 }],
        ],
      },
      { m: 'lit', beats: relight(0.2, 1.9) },
      { m: 'glow', beats: bloom(1.95, 0.2) },
    ],
  }),

  agents: () => ({
    T: 4.6,
    tracks: [
      { m: 'cl', rest: { o: 0, d: 1 }, beats: connect(0.45, 1.1, 2.3) },
      { m: 'cr', rest: { o: 0, d: 1 }, beats: connect(0.45, 1.1, 2.3) },
      { m: 'lit', beats: hit(1.1, 1.6) },
      { m: 'glow', beats: bloom(1.12) },
      {
        m: 'spark',
        beats: [
          [1.16, { r: 0 }, E.back],
          [1.76, { r: 90 }],
        ],
      },
      ...['you', 'bot'].map((m, i) => ({
        m,
        beats: [
          [1.14 + 0.06 * i, { y: 0 }, E.out],
          [1.24 + 0.06 * i, { y: -3 }, E.back],
          [1.62 + 0.06 * i, { y: 0 }],
        ] as Beat[],
      })),
    ],
  }),

  // The lamp: the frame's light goes out and switches on again (a flicker, like a tube catching), the glow blooms,
  // then the light runs down both ways to the people, who light up as it arrives.
  client: () => {
    // The frame's light goes down with an ease and comes back up the same way — a lamp warming, never a strobe; then
    // the links draw out from the frame to each person in turn, and each one brightens (a little past, then settles)
    // as its link arrives.
    const on = 1.05;
    const reachR = 2.35;
    const reachL = 2.75;
    const person = (arrive: number): Beat[] => [
      [0.2, { o: 1, s: 1 }, E.io],
      [0.7, { o: 0.45, s: 1 }],
      [arrive - 0.02, { o: 0.45, s: 1 }, E.back],
      [arrive + 0.12, { o: 1, s: 1.1 }, E.io],
      [arrive + 0.55, { o: 1, s: 1 }],
    ];
    return {
      T: 5.6,
      tracks: [
        {
          m: 'lamp',
          beats: [
            [0.2, { o: 1 }, E.io],
            [0.75, { o: 0.14 }],
            [on, { o: 0.14 }, E.out],
            [on + 0.9, { o: 1 }],
          ],
        },
        {
          m: 'glow',
          beats: [
            [0.2, { o: 1, s: 1 }, E.io],
            [0.75, { o: 0.1, s: 0.8 }],
            [on + 0.1, { o: 0.1, s: 0.8 }, E.out],
            [on + 1.0, { o: 1, s: 1.1 }, E.io],
            [on + 1.6, { o: 1, s: 1 }],
          ],
        },
        { m: 'lR', beats: redraw(0.2, on + 0.75, reachR, E.out) },
        { m: 'lL', beats: redraw(0.2, on + 1.15, reachL, E.out) },
        { m: 'pR', beats: person(reachR) },
        { m: 'pL', beats: person(reachL) },
      ],
    };
  },

  // The key pulls back, goes into the lock and turns (it narrows: seen edge on); the keyframe in its bow lights; it
  // turns back and comes out. The keyframe is part of the key, so it never leaves the middle of the bow.
  token: () => ({
    // A key, moved flat (no squash pretending to turn it): a pull-back, it drives into the lock with a little
    // overshoot and settles, one short click deeper — the keyframe in its bow is set on that click — then it slides out.
    T: 5.2,
    tracks: [
      {
        m: 'key',
        beats: [
          [0.3, { x: 0 }, E.out],
          [0.55, { x: -4 }, E.io],
          [1.0, { x: 16 }, E.out],
          [1.14, { x: 14 }, E.io],
          [1.5, { x: 14 }, E.in],
          [1.58, { x: 15.5 }, E.out],
          [1.72, { x: 14 }, E.io],
          [2.7, { x: 14 }, E.io],
          [3.3, { x: 0 }],
        ],
      },
      {
        m: 'plate',
        beats: [
          [0.98, { x: 0 }, E.out],
          [1.04, { x: 1.5 }, E.io],
          [1.22, { x: 0 }, E.out],
          [1.58, { x: 0 }, E.out],
          [1.62, { x: 0.8 }, E.io],
          [1.76, { x: 0 }],
        ],
      },
      { m: 'lit', beats: hit(1.6, 1.5) },
      { m: 'glow', beats: bloom(1.62) },
    ],
  }),

  // An event: the pulse in flight arrives (the tool takes it: a nudge, its lines redraw), then the keyframe fires the
  // next one — a squash before it goes — and it flies out to where it was.
  webhook: () => ({
    T: 4.8,
    tracks: [
      {
        m: 'pulse',
        rest: { p: 56 },
        beats: [
          [0, { p: 56, o: 1 }, E.in],
          [0.62, { p: 100, o: 1 }, E.out],
          [0.74, { p: 100, o: 0 }],
          [1.3, { p: 0, o: 0 }, E.lin],
          [1.38, { p: 2, o: 1 }, E.out],
          [2.5, { p: 56, o: 1 }],
        ],
      },
      {
        m: 'card',
        beats: [
          [0.6, { x: 0 }, E.out],
          [0.68, { x: 3 }, E.back],
          [1.05, { x: 0 }],
        ],
      },
      ...[0, 1].map((i) => ({
        m: `bar${i}`,
        beats: [
          [0.58 + 0.08 * i, { sx: 1 }, E.in],
          [0.66 + 0.08 * i, { sx: 0 }],
          [0.72 + 0.08 * i, { sx: 0 }, E.out],
          [1.1 + 0.08 * i, { sx: 1 }],
        ] as Beat[],
      })),
      {
        m: 'src',
        beats: [
          [1.05, { s: 1 }, E.in],
          [1.22, { s: 0.8 }, E.out],
          [1.32, { s: 1.3 }, E.back],
          [1.7, { s: 1 }],
        ],
      },
      {
        m: 'route',
        beats: [
          [1.3, { d: 0 }, E.out],
          [2.5, { d: -14 }],
        ],
      },
    ],
  }),

  // It breaks off: the curve draws toward the next keyframe and snaps (sparks, a small jolt); the rest of the way tries
  // twice to come back and stays faint.
  error: () => ({
    T: 5.0,
    tracks: [
      { m: 'curve', beats: redraw(0.1, 0.5, 1.12) },
      { m: 'start', beats: hit(0.46, 1.3) },
      {
        m: 'sparks',
        rest: { o: 1 },
        beats: [
          [0.1, { o: 1, s: 1 }, E.in],
          [0.25, { o: 0, s: 0.5 }],
          [1.12, { o: 0, s: 0.5 }, E.out],
          [1.2, { o: 1, s: 1.25 }, E.back],
          [1.55, { o: 1, s: 1 }],
        ],
      },
      {
        m: 'all',
        beats: [
          [1.12, { x: 0 }, E.out],
          [1.17, { x: 2.5 }, E.io],
          [1.24, { x: -2 }, E.io],
          [1.31, { x: 1 }, E.io],
          [1.38, { x: 0 }],
        ],
      },
      {
        m: 'rest',
        beats: [
          [0.1, { o: 1 }, E.in],
          [0.25, { o: 0.2 }],
          [1.5, { o: 0.2 }, E.io],
          [1.75, { o: 0.9 }, E.io],
          [2.0, { o: 0.3 }, E.io],
          [2.25, { o: 0.9 }, E.io],
          [2.5, { o: 0.3 }, E.io],
          [2.9, { o: 1 }],
        ],
      },
    ],
  }),
};

/** Starts `name`'s loop on the elements of `svg`, every track on one clock. */
export function playScene(svg: SVGSVGElement, name: EmptyArtName): Animation[] {
  const { T, tracks } = SCENES[name]();
  const out: Animation[] = [];
  for (const tr of tracks)
    for (const el of svg.querySelectorAll(`[data-m="${tr.m}"]`))
      out.push(el.animate(keyframes(T, tr), { duration: T * 1000, iterations: Number.POSITIVE_INFINITY }));
  const now = document.timeline.currentTime;
  for (const a of out) a.startTime = now;
  return out;
}
