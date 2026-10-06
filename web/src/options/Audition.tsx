// The audition: everything an agent offers before it spends a render, side by side, and one answer back. One section per
// group — sounds as rows with a player each, all of a group at the same loudness (lib/options.ts levelGains, applied
// while they play; the files stay as sent), pictures and clips as tiles (clips play together), links and plain lines as
// rows —, a pick per group (or several), the person's own words, and one "Send picks": an ordinary answer the agent's
// wait wakes on (`PICKED voice=v3 … · note: "…"`).
// Pictures and clips open large in the dialog itself (a click on one, or its Expand): one at most of the dialog's
// width with its own controls and its pick under it, ←/→ to the next of its group at the same moment, Esc or Back to
// all of them. Where they can, the dialog takes the room it has: wide, as tall as a dialog may be, the list and the
// large view in one cell, so switching moves nothing.
// Keys: 1–9 pick in the group in focus, ↑/↓ between groups, ←/→ between items, Space plays or stops, A (or B) swaps
// between the last two played at the same position, ⌘↵ sends. Its code is a chunk of its own (code.ts).
import { useEffect, useMemo, useRef, useState } from 'react';
import { lastAnswer, levelGains, volumesOf } from '../../../lib/options.ts';
import type { AskView, NoteRef, OptionGroup, OptionItem, OptionSeen } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { Modal } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Button } from '../ui/system.tsx';
import { IconButton } from '../ui/tip.tsx';
import { useAnswer, useAsk } from './api.ts';
import { createDeck, type Deck, type Track, useDeck } from './sound.ts';
import '../styles/options.css';

type Picks = Record<string, string[]>;
const who = (by: string) => by.replace(/^agent:/, '');
const keyOf = (g: string, i: string) => `${g}/${i}`;
const TILES = new Set<OptionSeen['kind']>(['image', 'clip', 'frame']);
/** How a group lays out: tiles for pictures and clips, rows for sounds, links, lines and a mix. */
function layoutOf(g: OptionGroup): OptionSeen['kind'] {
  const kinds = new Set(g.items.map((it) => it.ref?.kind ?? 'text'));
  return kinds.size === 1 ? ([...kinds][0] as OptionSeen['kind']) : 'mixed';
}
/** What the room is for, decided from the kinds alone — the list names them before the question loads, so the loading
 * state has the loaded one's size: `wide` where tiles are, `room` (the large view) where a picture may be (a mix too). */
function roomFor(kinds: OptionSeen['kind'][]) {
  const wide = kinds.some((k) => TILES.has(k));
  return { wide, room: wide || kinds.includes('mixed') };
}
/** The items of a group that open large: those with a picture (a clip's still, an image, a frame). */
const largeOnes = (view: AskView, g: OptionGroup) => g.items.map((it, i) => ({ it, i })).filter(({ it }) => !!(it.ref && view.files[it.ref.id]?.still));
/** A group's clips play level with each other (and with its sounds), through their volume: it only turns down. */
function clipVolumesOf(view: AskView, g: OptionGroup): Map<string, number> {
  const clips = g.items.filter((it) => it.ref?.kind === 'clip' && view.files[it.ref.id]?.src);
  const v = volumesOf(levelGains(clips.map((it) => it.ref?.loudness)));
  return new Map(clips.map((it, n) => [it.id, v[n] ?? 1]));
}
/** Where the clip on show was, for the next one to start there: comparing is the same moment in each. */
interface Moment {
  t: number;
  playing: boolean;
}
const clock = (s: number) => {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s - m * 60)).padStart(2, '0')}`;
};
const same = (a: Picks, b: Picks) => {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)].filter((k) => a[k]?.length || b[k]?.length));
  return [...keys].every((k) => (a[k] ?? []).join('+') === (b[k] ?? []).join('+'));
};

export interface AuditionProps {
  id: string;
  text: string;
  by: string;
  /** The groups as the list named them: the loading state has their shape. */
  groups: OptionSeen[];
  onClose: () => void;
  onSent?: () => void;
}

export function AuditionDialog({ id, text, by, groups, onClose, onSent }: AuditionProps) {
  const q = useAsk(id);
  const view = q.data;
  const send = useAnswer(id);
  const [picks, setPicks] = useState<Picks>({});
  const [note, setNote] = useState('');
  const [cursor, setCursor] = useState({ g: 0, i: 0 });
  const [large, setLarge] = useState<{ g: number; i: number } | null>(null);
  // the one shown large before (A/B swaps back to it, at the same moment) and the moment carried to the next one
  const lastLarge = useRef<number | null>(null);
  const moment = useRef<Moment>({ t: 0, playing: true });
  const bigVideo = useRef<HTMLVideoElement>(null);
  // what opened the large view gets the focus back when it closes
  const opener = useRef<HTMLElement | null>(null);
  const shape = roomFor(view ? view.options.map(layoutOf) : groups.map((g) => g.kind));
  // The picks already sent (answered before): where the view starts, and what "unchanged" means.
  const before = useMemo<Picks>(() => (view ? (lastAnswer(view)?.answer?.picks ?? {}) : {}), [view]);
  const seeded = useRef(false);
  useEffect(() => {
    if (!view || seeded.current) return;
    seeded.current = true;
    setPicks(before);
  }, [view, before]);
  const deck = useMemo(() => createDeck(), []);
  useEffect(() => () => deck.dispose(), [deck]);
  const tracks = useMemo(() => (view ? tracksOf(view) : new Map<string, Track>()), [view]);
  const root = useRef<HTMLDivElement>(null);

  const pick = (g: OptionGroup, item: OptionItem) => {
    setPicks((p) => {
      const now = p[g.id] ?? [];
      const on = now.includes(item.id);
      const next = g.pick === 'many' ? (on ? now.filter((x) => x !== item.id) : [...now, item.id]) : on ? [] : [item.id];
      return { ...p, [g.id]: next };
    });
  };
  const play = (g: OptionGroup, item: OptionItem) => {
    const tr = tracks.get(keyOf(g.id, item.id));
    if (tr) deck.toggle(tr);
  };
  // Large: from the list (what plays there stops; a clip starts from its start), between the items of its group (at the
  // moment the one before was, playing if it played), back to the list.
  const openLarge = (gi: number, i: number) => {
    deck.stop();
    for (const v of root.current?.querySelectorAll<HTMLVideoElement>('.aud-list video') ?? []) v.pause();
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    moment.current = { t: 0, playing: true };
    lastLarge.current = null;
    setCursor({ g: gi, i });
    setLarge({ g: gi, i });
  };
  const moveLarge = (i: number) => {
    if (!large || i === large.i) return;
    const v = bigVideo.current;
    if (v) moment.current = { t: v.currentTime, playing: !v.paused && !v.ended };
    lastLarge.current = large.i;
    setCursor({ g: large.g, i });
    setLarge({ g: large.g, i });
  };
  const stepLarge = (by: 1 | -1) => {
    if (!large || !view) return;
    const shown = largeOnes(view, view.options[large.g]);
    const k = shown.findIndex((s) => s.i === large.i);
    const next = shown[(k + by + shown.length) % shown.length];
    if (next) moveLarge(next.i);
  };
  const closeLarge = () => setLarge(null);
  // back in the list: the focus where it was before, and the view where it was (the list kept its place)
  const wasLarge = useRef(false);
  useEffect(() => {
    if (large) wasLarge.current = true;
    else if (wasLarge.current) {
      wasLarge.current = false;
      if (opener.current?.isConnected) opener.current.focus({ preventScroll: true });
    }
  }, [large]);

  // The keys, while the dialog is the one in front and nothing is being typed.
  const live = useRef({ view, cursor, pick, play, large, moveLarge, stepLarge, closeLarge });
  live.current = { view, cursor, pick, play, large, moveLarge, stepLarge, closeLarge };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = root.current;
      const target = e.target instanceof Element ? e.target : null;
      const dialog = el?.closest('[role=dialog]');
      if (!el || !dialog || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;
      if (target && !dialog.contains(target) && target !== document.body) return;
      if (target?.closest('textarea, input, [contenteditable=""], [contenteditable="true"]')) return;
      const { view, cursor, pick, play, large, moveLarge, stepLarge, closeLarge } = live.current;
      if (!view) return;
      if (large) {
        // the large view's keys: ←/→ the next of its group, Space its clip, A/B the one before, 1–9 pick, Esc the list
        const g = view.options[large.g];
        const v = bigVideo.current;
        const done = () => {
          e.preventDefault();
          e.stopPropagation();
        };
        if (e.key === 'Escape') {
          done();
          closeLarge();
        } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
          done();
          stepLarge(e.key === 'ArrowRight' ? 1 : -1);
        } else if (e.key === ' ' && v) {
          done();
          if (v.paused || v.ended) void v.play().catch(() => {});
          else v.pause();
        } else if (/^[ab]$/i.test(e.key) && lastLarge.current !== null) {
          done();
          moveLarge(lastLarge.current);
        } else if (/^[1-9]$/.test(e.key) && g?.items[Number(e.key) - 1]) {
          done();
          const n = Number(e.key) - 1;
          pick(g, g.items[n]);
          if (largeOnes(view, g).some((s) => s.i === n)) moveLarge(n);
        }
        return;
      }
      const g = view.options[cursor.g];
      if (!g) return;
      if (/^[1-9]$/.test(e.key)) {
        const n = Number(e.key) - 1;
        const item = g.items[n];
        if (!item) return;
        e.preventDefault();
        e.stopPropagation();
        setCursor({ g: cursor.g, i: n });
        pick(g, item);
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        e.stopPropagation();
        const next = Math.max(0, Math.min(view.options.length - 1, cursor.g + (e.key === 'ArrowDown' ? 1 : -1)));
        setCursor({ g: next, i: Math.min(cursor.i, view.options[next].items.length - 1) });
        el.querySelector(`[data-group="${next}"]`)?.scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        e.stopPropagation();
        setCursor({ g: cursor.g, i: Math.max(0, Math.min(g.items.length - 1, cursor.i + (e.key === 'ArrowRight' ? 1 : -1))) });
      } else if (e.key === ' ') {
        // Space stops whatever plays (an A/B swap moved it off the cursor), else plays the item in focus.
        const item = g.items[cursor.i];
        const playing = deck.state().playing;
        if (!playing && (!item || !tracks.has(keyOf(g.id, item.id)))) return;
        e.preventDefault();
        e.stopPropagation();
        if (playing) deck.stop();
        else play(g, item as OptionItem);
      } else if (e.key === 'a' || e.key === 'A' || e.key === 'b' || e.key === 'B') {
        if (deck.ab(tracks)) {
          e.preventDefault();
          e.stopPropagation();
        }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [deck, tracks]);

  const total = view?.options.length ?? groups.length;
  const done = view ? view.options.filter((g) => picks[g.id]?.length).length : 0;
  const changed = !same(picks, before) || !!note.trim();
  const canSend = !!view && changed && (done > 0 || !!note.trim());
  const submit = async () => {
    if (!view || !canSend) return;
    deck.stop();
    try {
      await send.mutateAsync({ picks: Object.fromEntries(Object.entries(picks).filter(([, v]) => v.length)), ...(note.trim() ? { note: note.trim() } : {}) });
      toast(t('Picks sent — {name} gets them', { name: who(view.author) }), 'ok');
      onSent?.();
      onClose();
    } catch (e) {
      toastError(e);
    }
  };

  const foot = (
    <>
      <span className="aud-status" data-testid="audition-status">
        {t('{done} of {total} picked', { done, total })}
      </span>
      <span className="aud-keys" aria-hidden="true">
        {large ? t('1–9 pick · ←→ next · Space play · A/B compare · Esc all') : t('1–9 pick · ↑↓ group · Space play · A/B compare')}
      </span>
      <button type="button" className="btn primary" disabled={!canSend || send.isPending} onClick={submit} data-testid="audition-send">
        <I name="send" size={14} /> {t('Send picks')}
      </button>
    </>
  );

  return (
    <Modal title={t('Compare and pick')} onClose={onClose} width={shape.wide ? 1600 : 960} fill={shape.room} foot={foot}>
      <div
        className={`aud ${shape.room ? 'room' : ''}`}
        ref={root}
        data-testid="audition"
        data-loaded={view ? 'true' : 'false'}
        data-view={large ? 'large' : 'list'}
      >
        {/* the list and the large view share one cell: the list keeps its place (and its scroll) while one is large */}
        <div className="aud-list" inert={!!large}>
          <div className="aud-head">
            <p className="aud-q">{view?.text ?? text}</p>
            <p className="aud-meta">
              <b>{who(view?.author ?? by)}</b>
              <span className="aud-where">
                {view ? view.slug ? view.name : t('{folder} · before the first version', { folder: view.folder ?? '' }) : <SkLine w="10em" />}
              </span>
              {view && <span className="aud-ago">{ago(view.created)}</span>}
            </p>
            {view && view.status !== 'open' && lastAnswer(view) && (
              <p className="aud-answered" data-testid="audition-answered">
                <I name="check" size={14} />
                {t('Answered by {name} {when} — you can still change the picks', {
                  name: who(lastAnswer(view)?.by ?? ''),
                  when: ago(lastAnswer(view)?.at ?? ''),
                })}
              </p>
            )}
          </div>
          {view
            ? view.options.map((g, gi) => (
                <Group
                  key={g.id}
                  g={g}
                  gi={gi}
                  view={view}
                  picked={picks[g.id] ?? []}
                  focus={cursor.g === gi}
                  cursor={cursor.g === gi ? cursor.i : -1}
                  deck={deck}
                  tracks={tracks}
                  onPick={(item, i) => {
                    setCursor({ g: gi, i });
                    pick(g, item);
                  }}
                  onPlay={(item, i) => {
                    setCursor({ g: gi, i });
                    play(g, item);
                  }}
                  onFocus={(i) => setCursor({ g: gi, i })}
                  onLarge={(i) => openLarge(gi, i)}
                />
              ))
            : // biome-ignore lint/suspicious/noArrayIndexKey: the groups as listed, in their order
              groups.map((g, gi) => <GroupPending key={gi} g={g} />)}
          <label className="aud-note">
            <span className="aud-note-label">{view?.answer_prompt || t('Anything else? (optional)')}</span>
            <textarea
              className="textarea"
              rows={2}
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={t('What {name} should know with your picks', { name: who(view?.author ?? by) })}
              data-testid="audition-note"
            />
          </label>
        </div>
        {large && view && (
          <Large
            view={view}
            at={large}
            picked={(gid, iid) => (picks[gid] ?? []).includes(iid)}
            moment={moment}
            video={bigVideo}
            onStep={stepLarge}
            onPick={(g, item) => pick(g, item)}
            onBack={closeLarge}
          />
        )}
      </div>
    </Modal>
  );
}

/** Every sound of the question as a track at its group's level: gains through Web Audio, else volumes that only lower. */
function tracksOf(view: AskView): Map<string, Track> {
  const out = new Map<string, Track>();
  for (const g of view.options) {
    const sounds = g.items.filter((it) => it.ref?.kind === 'audio' && view.files[it.ref.id]?.src);
    const gains = levelGains(sounds.map((it) => it.ref?.loudness));
    const volumes = volumesOf(gains);
    sounds.forEach((it, n) => {
      const ref = it.ref as NoteRef;
      out.set(keyOf(g.id, it.id), {
        key: keyOf(g.id, it.id),
        src: view.files[ref.id]?.src as string,
        ...(view.level === 'gain' ? { mode: 'gain' as const, gain: gains[n] ?? 0 } : { mode: 'volume' as const, gain: volumes[n] ?? 1 }),
      });
    });
  }
  return out;
}

interface GroupProps {
  g: OptionGroup;
  gi: number;
  view: AskView;
  picked: string[];
  focus: boolean;
  cursor: number;
  deck: Deck;
  tracks: Map<string, Track>;
  onPick: (item: OptionItem, i: number) => void;
  onPlay: (item: OptionItem, i: number) => void;
  onFocus: (i: number) => void;
  onLarge: (i: number) => void;
}

function Group({ g, gi, view, picked, focus, cursor, deck, tracks, onPick, onPlay, onFocus, onLarge }: GroupProps) {
  const kind = layoutOf(g);
  const s = useDeck(deck);
  const sounds = g.items.filter((it) => tracks.has(keyOf(g.id, it.id)));
  const ab = s.recent.length === 2 && s.recent.every((k) => k.startsWith(`${g.id}/`));
  const head = `aud-g-${gi}`;
  const chosen = g.items.filter((it) => picked.includes(it.id)).map((it) => it.label);
  const section = useRef<HTMLElement>(null);
  // Clips with sound play level too, through their volume (lowered only): the same balance as the sounds.
  const clipVolumes = useMemo(() => clipVolumesOf(view, g), [g, view]);
  const clips = clipVolumes.size;
  // how many of the group's clips play: Play together becomes Pause while they do
  const [running, setRunning] = useState(0);
  const vids = () => [...(section.current?.querySelectorAll<HTMLVideoElement>('video.aud-video') ?? [])];
  const recount = () => setRunning(vids().filter((v) => !v.paused && !v.ended).length);
  // Side by side, in sync: every clip of the group from its start together, the one in focus heard.
  const together = () => {
    deck.stop();
    if (running) {
      for (const v of vids()) v.pause();
      return;
    }
    vids().forEach((v, n) => {
      v.muted = n !== Math.max(0, cursor);
      v.currentTime = 0;
      void v.play().catch(() => {});
    });
  };
  return (
    <section ref={section} className={`aud-group ${focus ? 'focus' : ''}`} data-group={gi} data-testid="audition-group" aria-labelledby={head}>
      <header className="aud-ghead">
        <h4 id={head} className="ellipsis">
          {g.label}
        </h4>
        <span className="aud-rule">{g.pick === 'many' ? t('Pick any') : t('Pick one')}</span>
        {sounds.length > 1 && (
          <span className="aud-level" title={t('Every take plays at the same loudness; the files stay as they were sent')}>
            <I name="wave" size={13} /> {t('Level')}
          </span>
        )}
        <span className="grow" />
        {clips > 1 && (
          <button type="button" className="btn ghost sm" onClick={together} data-testid="audition-together" data-playing={running > 0 || undefined}>
            <I name={running ? 'pause' : 'columns'} size={14} /> {running ? t('Pause') : t('Play together')}
          </button>
        )}
        {ab && (
          <button type="button" className="btn ghost sm aud-ab" onClick={() => deck.ab(tracks)} data-testid="audition-ab">
            {t('A/B')}
          </button>
        )}
        <span className={`aud-chosen ellipsis ${chosen.length ? 'on' : ''}`}>{chosen.length ? chosen.join(', ') : t('Not picked yet')}</span>
      </header>
      <Items one={g.pick === 'one'} className={`aud-items ${TILES.has(kind) ? 'tiles' : 'rows'}`} labelledBy={head}>
        {g.items.map((it, i) => {
          const k = keyOf(g.id, it.id);
          const track = tracks.get(k);
          const at = s.at[k];
          const props = {
            g,
            it,
            n: i + 1,
            view,
            on: picked.includes(it.id),
            here: focus && cursor === i,
            playing: s.playing === k,
            progress: at?.d ? at.t / at.d : 0,
            time: at ? clock(at.d - at.t > 0 && s.playing === k ? at.t : at.d) : it.ref?.duration ? clock(it.ref.duration) : '',
            gain: track?.mode === 'gain' ? track.gain : null,
            volume: clipVolumes.get(it.id) ?? 1,
            onPick: () => onPick(it, i),
            onPlay: track ? () => onPlay(it, i) : undefined,
            onFocus: () => onFocus(i),
            onLarge: () => onLarge(i),
            onRun: recount,
          };
          return TILES.has(kind) ? <Tile key={it.id} {...props} /> : <Row key={it.id} {...props} />;
        })}
      </Items>
    </section>
  );
}

interface ItemProps {
  g: OptionGroup;
  it: OptionItem;
  n: number;
  view: AskView;
  on: boolean;
  here: boolean;
  playing: boolean;
  progress: number;
  time: string;
  gain: number | null;
  /** A clip's volume, levelled with the group's other clips. */
  volume: number;
  onPick: () => void;
  onPlay?: () => void;
  onFocus: () => void;
  onLarge: () => void;
  /** A clip started or stopped (Play together counts them). */
  onRun?: () => void;
}

/** The pick itself: a radio (one per group) or a checkbox (several), its key, the item's words. */
function PickButton({
  g,
  it,
  n,
  on,
  onPick,
  onFocus,
  children,
  testId = 'audition-pick',
}: Pick<ItemProps, 'g' | 'it' | 'n' | 'on' | 'onPick' | 'onFocus'> & { children?: React.ReactNode; testId?: string }) {
  const inside = (
    <>
      {n <= 9 && <kbd className="aud-key">{n}</kbd>}
      <span className="aud-label ellipsis">{it.label}</span>
      {children}
      <span className="aud-check" aria-hidden="true">
        <I name="check" size={13} />
      </span>
    </>
  );
  const common = { type: 'button' as const, className: 'aud-pick', onClick: onPick, onFocus, 'data-testid': testId, 'data-item': it.id };
  // A whole row's worth of button that a click or a key picks (1–9 too): an input would be a box of its own.
  return g.pick === 'one' ? (
    // biome-ignore lint/a11y/useSemanticElements: the row is the radio (its key, its words, its check)
    <button {...common} role="radio" aria-checked={on}>
      {inside}
    </button>
  ) : (
    // biome-ignore lint/a11y/useSemanticElements: the row is the checkbox (its key, its words, its check)
    <button {...common} role="checkbox" aria-checked={on}>
      {inside}
    </button>
  );
}

/** A group's items: one pick (a radio group) or several (a group of checkboxes). */
function Items({ one, className, labelledBy, children }: { one: boolean; className: string; labelledBy: string; children: React.ReactNode }) {
  return one ? (
    <div className={className} role="radiogroup" aria-labelledby={labelledBy}>
      {children}
    </div>
  ) : (
    // biome-ignore lint/a11y/useSemanticElements: a fieldset would bring its own box into the list's grid
    <div className={className} role="group" aria-labelledby={labelledBy}>
      {children}
    </div>
  );
}

function Row(p: ItemProps) {
  const { it, view } = p;
  const ref = it.ref;
  const still = ref ? view.files[ref.id]?.still : null;
  return (
    <div
      className={`aud-item aud-row ${p.on ? 'on' : ''} ${p.here ? 'here' : ''} ${p.playing ? 'playing' : ''}`}
      data-testid="audition-item"
      data-gain={p.gain ?? undefined}
      data-playing={p.playing || undefined}
    >
      {p.onPlay ? (
        <IconButton
          className="btn ghost sm icon-only aud-play"
          label={p.playing ? t('Stop {label}', { label: it.label }) : t('Play {label}', { label: it.label })}
          icon={p.playing ? 'pause' : 'play'}
          size={14}
          onClick={p.onPlay}
          data-testid="audition-play"
        />
      ) : still ? (
        <button type="button" className="aud-thumb" onClick={p.onLarge} aria-label={t('Look at {label}', { label: it.label })}>
          <img src={still} alt="" loading="lazy" />
        </button>
      ) : ref?.kind === 'link' && ref.url ? (
        <a
          className="btn sm ghost icon-only aud-play"
          href={ref.url}
          target="_blank"
          rel="noreferrer noopener"
          aria-label={t('Open {site}', { site: ref.site ?? '' })}
        >
          <I name="external" size={14} />
        </a>
      ) : (
        <span className="aud-dot" aria-hidden="true" />
      )}
      <PickButton {...p}>
        {ref?.kind === 'link' && ref.site && <span className="aud-site ellipsis">{ref.site}</span>}
        {p.onPlay && (
          <span className="aud-bar" aria-hidden="true">
            <span style={{ transform: `scaleX(${p.progress})` }} />
          </span>
        )}
        {p.time && <span className="aud-time">{p.time}</span>}
      </PickButton>
    </div>
  );
}

function Tile(p: ItemProps) {
  const { it, view } = p;
  const ref = it.ref;
  const f = ref ? view.files[ref.id] : null;
  const clip = ref?.kind === 'clip' && f?.src;
  const look = t('Look at {label}', { label: it.label });
  // A clip shows its first moments here and plays only together with the others: a click opens it large, where it has
  // its own controls (and the others are a key away).
  return (
    <div className={`aud-item aud-tile ${p.on ? 'on' : ''} ${p.here ? 'here' : ''}`} data-testid="audition-item">
      <div className="aud-media">
        {clip ? (
          <button type="button" className="aud-shot" onClick={p.onLarge} aria-label={look} data-testid="audition-shot">
            {/* biome-ignore lint/a11y/useMediaCaption: an option's clip; its words are the label under it */}
            <video
              ref={(el) => {
                if (el) el.volume = p.volume;
              }}
              src={f.src as string}
              poster={f.still ?? undefined}
              playsInline
              preload="metadata"
              className="aud-video"
              onPlay={p.onRun}
              onPause={p.onRun}
              onEnded={p.onRun}
            />
          </button>
        ) : f?.still ? (
          <button type="button" className="aud-shot" onClick={p.onLarge} aria-label={look} data-testid="audition-shot">
            <img src={f.still} alt="" loading="lazy" />
          </button>
        ) : (
          <span className="aud-shot aud-noshot" aria-hidden="true">
            <I name="image" size={18} />
          </span>
        )}
      </div>
      <div className="aud-tile-foot">
        <PickButton {...p} />
        {f?.still && (
          <IconButton
            className="btn ghost sm icon-only aud-expand"
            label={t('Larger')}
            tip={look}
            icon="expand"
            size={14}
            onClick={p.onLarge}
            data-testid="audition-expand"
          />
        )}
      </div>
    </div>
  );
}

/** The shape of a group while its data arrives: the same rows or tiles, as many as it offers. */
function GroupPending({ g }: { g: OptionSeen }) {
  const tiles = TILES.has(g.kind);
  return (
    <section className="aud-group pending" aria-busy="true">
      <header className="aud-ghead">
        <h4 className="ellipsis">{g.label}</h4>
        <span className="aud-rule">
          <SkLine w="4em" />
        </span>
      </header>
      <div className={`aud-items ${tiles ? 'tiles' : 'rows'}`}>
        {Array.from({ length: g.n }, (_, i) =>
          tiles ? (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
            <div key={i} className="aud-item aud-tile">
              <div className="aud-media">
                <span className="aud-shot aud-noshot" />
              </div>
              <div className="aud-tile-foot">
                <span className="aud-pick">
                  <SkLine w="6em" />
                </span>
              </div>
            </div>
          ) : (
            // biome-ignore lint/suspicious/noArrayIndexKey: placeholders
            <div key={i} className="aud-item aud-row">
              <span className="aud-dot" />
              <span className="aud-pick">
                <SkLine w="8em" />
              </span>
            </div>
          ),
        )}
      </div>
    </section>
  );
}

/**
 * One picture or clip large, in the dialog's own cell: as much of it as fits at 16:9 (a clip with its own controls,
 * levelled like the others), its pick under it, the others of its group a key away (← →, at the moment this one is),
 * and the way back to all of them (Esc). Moving between them keeps the room as it is: the same box, another picture.
 */
function Large({
  view,
  at,
  picked,
  moment,
  video,
  onStep,
  onPick,
  onBack,
}: {
  view: AskView;
  at: { g: number; i: number };
  picked: (g: string, i: string) => boolean;
  /** Where the clip shown before was: this one starts there. */
  moment: React.RefObject<Moment>;
  video: React.RefObject<HTMLVideoElement | null>;
  onStep: (by: 1 | -1) => void;
  onPick: (g: OptionGroup, item: OptionItem) => void;
  onBack: () => void;
}) {
  const g = view.options[at.g];
  const shown = largeOnes(view, g);
  const k = Math.max(
    0,
    shown.findIndex((s) => s.i === at.i),
  );
  const cur = shown[k];
  // the focus comes in with it (what opened it is behind it now), on the view itself: no ring on a button nobody chose
  const self = useRef<HTMLElement>(null);
  useEffect(() => self.current?.focus({ preventScroll: true }), []);
  const volumes = useMemo(() => clipVolumesOf(view, g), [view, g]);
  if (!cur) return null;
  const ref = cur.it.ref as NoteRef;
  const files = view.files[ref.id];
  const clip = ref.kind === 'clip' && files?.src;
  return (
    <section ref={self} className="aud-big" tabIndex={-1} aria-label={cur.it.label} data-testid="audition-large" data-item={cur.it.id}>
      <div className="aud-big-head">
        <Button variant="ghost" size="sm" icon="back" onClick={onBack} data-testid="audition-back">
          {t('All options')}
        </Button>
        <span className="aud-big-where ellipsis">{g.label}</span>
        <span className="aud-big-n" data-testid="audition-large-n">
          {t('{n} of {total}', { n: k + 1, total: shown.length })}
        </span>
        <span className="grow" />
        {shown.length > 1 && (
          <>
            <IconButton
              className="btn ghost sm icon-only"
              label={t('Previous')}
              shortcut="←"
              icon="back"
              onClick={() => onStep(-1)}
              data-testid="audition-prev"
            />
            <IconButton className="btn ghost sm icon-only" label={t('Next')} shortcut="→" icon="right" onClick={() => onStep(1)} data-testid="audition-next" />
          </>
        )}
      </div>
      <div className="aud-big-room">
        <div className={`aud-item aud-tile aud-big-tile ${picked(g.id, cur.it.id) ? 'on' : ''}`}>
          <div className="aud-media">
            {clip ? (
              // biome-ignore lint/a11y/useMediaCaption: an option's clip; its words are the label under it
              <video
                key={cur.it.id}
                ref={(el) => {
                  video.current = el;
                  if (el) el.volume = volumes.get(cur.it.id) ?? 1;
                }}
                src={files.src as string}
                poster={files.still ?? undefined}
                controls
                playsInline
                preload="auto"
                className="aud-big-video"
                onLoadedMetadata={(e) => {
                  // at the moment the one before was (within this one), playing if it played
                  const v = e.currentTarget;
                  const m = moment.current;
                  if (m.t > 0 && Number.isFinite(v.duration)) v.currentTime = Math.min(m.t, Math.max(0, v.duration - 0.05));
                  if (m.playing) void v.play().catch(() => {});
                }}
                data-testid="audition-large-video"
              />
            ) : (
              <img key={cur.it.id} src={(ref.kind === 'image' ? files?.src : files?.still) ?? files?.still ?? ''} alt={cur.it.label} />
            )}
          </div>
          <div className="aud-tile-foot">
            <PickButton
              g={g}
              it={cur.it}
              n={cur.i + 1}
              on={picked(g.id, cur.it.id)}
              onPick={() => onPick(g, cur.it)}
              onFocus={() => {}}
              testId="audition-large-pick"
            />
          </div>
        </div>
      </div>
    </section>
  );
}
