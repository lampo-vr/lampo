// How far a client got in a video (Insights' Clients rows open it), drawn as what was recorded: the newest version cut
// into its hundredths (lib/watch.ts), one thin column each. What a column counts depends on who watched:
//   three viewers or more — how many of them played that part (the steps of an audience dropping off);
//   one or two — how often the part was played: with one viewer a part was seen or it wasn't, so counting viewers
//   would draw a solid block; counting plays draws the stretch they watched as a low strip and the parts they went back
//   to rising above it. The plot is as tall as the most played part needs (a version watched once is a slim strip).
// The stretches watched again and again are the columns in the brand's orange. A readout above names the part pointed
// at (or stepped to with the arrow keys), a key beside it says what the height and the orange mean.
// Its own chunk, loaded when a row's toggle is pointed at or opened, so the library's first paint doesn't carry it.
import { type CSSProperties, type KeyboardEvent, useState } from 'react';
import { PARTS } from '../../../lib/watch.ts';
import type { InsightsWatchedVideo } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { pct } from '../lib/format.ts';
import { chartLevelsOf, chartModeOf, clockAt, stretchOf, whoName } from './insightsWords.ts';

/** Tick spacings in seconds: the first that leaves at most five intervals across the version. */
const STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200];

/** The time axis: a few round moments of the version and its end, each at its place (0 … 1). */
function ticksOf(duration: number | null | undefined): { at: number; label: string }[] {
  if (!duration) return [0, 0.25, 0.5, 0.75, 1].map((at) => ({ at, label: pct(at) }));
  const step = STEPS.find((s) => duration / s <= 5) ?? (STEPS.at(-1) as number);
  const d = step >= 1 ? 0 : 1;
  const out: { at: number; label: string }[] = [];
  // the last round moment keeps its distance from the end's label
  for (let i = 0; i * step < duration - step * 0.6; i++) out.push({ at: (i * step) / duration, label: clockAt(i * step, d) });
  out.push({ at: 1, label: clockAt(duration, d) });
  return out;
}

/** The counts the axis names: every one up to five (the steps a column can take), else half and the top. */
const levelsOf = (top: number) => (top <= 5 ? Array.from({ length: top }, (_, i) => i + 1) : [Math.round(top / 2), top]);

export default function Chart({ v }: { v: InsightsWatchedVideo }) {
  const watchers = v.viewers.filter((x) => x.watched != null);
  const n = Math.max(1, v.seenBy ?? watchers.length);
  // a server from before sends only the shares: the counts come back from them
  const heat = v.heat?.length === PARTS ? v.heat : v.retention.map((r) => Math.round(r * n));
  const plays = v.plays?.length === PARTS ? v.plays : heat;
  const mode = chartModeOf(v);
  const counts = mode === 'viewers' ? heat : plays;
  const top = mode === 'viewers' ? n : Math.max(1, ...plays);
  const again = new Set(v.rewatched.flatMap((w) => Array.from({ length: w.to - w.from + 1 }, (_, i) => w.from + i)));
  const [at, setAt] = useState<number | null>(null);

  const p = v.completion == null ? '–' : pct(v.completion);
  const [a, b] = watchers[1]?.you ? [watchers[1], watchers[0]] : watchers;
  const rest =
    mode === 'viewers'
      ? `${t('{n} viewer|{n} viewers', { n })} · ${t('{p} watched on average', { p })}`
      : n === 2 && a && b
        ? t('{a} and {b} watched {p} of it on average', { a: whoName(a), b: whoName(b), p })
        : t('{who} watched {p} of it', { who: a ? whoName(a) : t('Someone'), p });
  const partWords = (i: number) => {
    const k = heat[i] ?? 0;
    const x = plays[i] ?? 0;
    const who = mode === 'plays' && n === 1 ? null : k === 0 ? t('nobody watched') : t('{k} of {n} watched', { k, n });
    const played = x > 0 ? t('played {n}×', { n: x }) : mode === 'plays' && n === 1 ? t('not played') : null;
    return [stretchOf({ from: i, to: i }, v.duration), who, played].filter(Boolean).join(' · ');
  };
  const read = at == null ? rest : partWords(at);
  const label = t('How far viewers got in {video}', { video: v.video });

  const move = (e: KeyboardEvent<HTMLDivElement>) => {
    const by = e.shiftKey ? 10 : 1;
    const to: Record<string, (x: number) => number> = {
      ArrowRight: (x) => x + by,
      ArrowUp: (x) => x + by,
      ArrowLeft: (x) => x - by,
      ArrowDown: (x) => x - by,
      Home: () => 0,
      End: () => PARTS - 1,
    };
    const f = to[e.key];
    if (!f) return;
    e.preventDefault();
    setAt((x) => Math.max(0, Math.min(PARTS - 1, f(x ?? 0))));
  };

  return (
    <div className="wc" data-testid="wv-chart" data-mode={mode} style={{ '--lvls': chartLevelsOf(v) } as CSSProperties}>
      <p className="wc-head">
        <span className={`wc-read ${at != null ? 'on' : ''}`} data-testid="wv-read">
          {read}
        </span>
        <span className="wc-keys">
          <span className="wc-key">
            <i aria-hidden="true" /> {mode === 'viewers' ? t('Viewers who watched the part') : t('Times played')}
          </span>
          {again.size > 0 && (
            <span className="wc-key again">
              <i aria-hidden="true" /> {t('Watched again and again')}
            </span>
          )}
        </span>
      </p>
      <div className="wc-y" aria-hidden="true">
        {levelsOf(top).map((k) => (
          <span key={k} style={{ '--y': k / top } as CSSProperties}>
            {mode === 'plays' ? t('{n}×', { n: k }) : k}
          </span>
        ))}
      </div>
      <div
        className="wc-plot"
        role="slider"
        tabIndex={0}
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={PARTS - 1}
        aria-valuenow={at ?? 0}
        aria-valuetext={read}
        onPointerMove={(e) => {
          const r = e.currentTarget.getBoundingClientRect();
          setAt(Math.max(0, Math.min(PARTS - 1, Math.floor(((e.clientX - r.left) / r.width) * PARTS))));
        }}
        onPointerLeave={() => setAt(null)}
        onKeyDown={move}
        onFocus={() => setAt((x) => x ?? 0)}
        onBlur={() => setAt(null)}
        data-testid="wv-curve"
      >
        {levelsOf(top).map((k) => (
          <span key={k} className="wc-grid" style={{ '--y': k / top } as CSSProperties} />
        ))}
        <div className="wc-cols" data-rewatched={v.rewatched.map((w) => `${w.from}-${w.to}`).join(' ')}>
          {at != null && <span className="wc-at" style={{ gridColumn: at + 1 }} />}
          {counts.map((k, i) =>
            k > 0 ? (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: one column per hundredth, in order, never reordered
                key={i}
                className={`wc-col ${again.has(i) ? 'again' : ''} ${at === i ? 'on' : ''}`}
                style={{ gridColumn: i + 1, '--v': Math.min(1, k / top) } as CSSProperties}
              />
            ) : null,
          )}
        </div>
      </div>
      <div className="wc-x" aria-hidden="true">
        {ticksOf(v.duration).map((x) => (
          <span key={x.at} style={{ '--x': x.at } as CSSProperties}>
            {x.label}
          </span>
        ))}
      </div>
    </div>
  );
}
