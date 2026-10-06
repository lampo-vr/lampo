// The board's drag (library/Board.tsx), loaded on the first press on a card: the library's first paint carries none of
// it. With a mouse or a pen the card lifts once the pointer has moved a few pixels; on a touch screen after a long
// press (then it follows the finger, and the lanes don't scroll under it). A lifted copy follows the pointer; the lane
// under it takes the card when the move is allowed there (the board lights it and shows where the card lands), the
// board scrolls sideways near its edges and a lane scrolls near its top and bottom; the wheel still scrolls. Dropping
// where nothing takes it, or Escape, puts the card back.

import { t } from '../i18n/index.ts';
import { LANE_SHAPE } from '../ui/glyphs.ts';
import { buildDragChip, DRAG_VIDEO, pointerDropTarget } from './drag.ts';
import { dropWords } from './moveSteps.ts';
import type { Move } from './moves.ts';

export interface DragHost {
  board: HTMLElement;
  /** A drag begins: the moves the card may make, by lane; null when it is gone. */
  begin: (slug: string, card: HTMLElement) => Map<string, Move> | null;
  /** The lane the card is over now (null: none, or its own). */
  over: (lane: string | null) => void;
  /** Dropped on a lane that takes it. */
  drop: (lane: string) => void;
  /** Called off: the card stays where it was. */
  cancel: () => void;
  /** A touch drag holds the page still (the board's touchmove listener asks). */
  lock: (on: boolean) => void;
}

export interface Press {
  x: number;
  y: number;
  pointerId: number;
  pointerType: string;
  card: HTMLElement;
  slug: string;
}

/** How far a mouse or pen moves before the card lifts, and a finger may wander during the long press. */
const SLOP = 5;
const TOUCH_SLOP = 8;
const LONG_PRESS = 350;
/** Near an edge the board or lane scrolls, faster the nearer. */
const EDGE = 56;
const SPEED = 18;
const SETTLE_MS = 160;

const still = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Follows one press on a card: nothing happens unless it becomes a drag. Returns a function that calls it off. */
export function startPress(host: DragHost, p: Press): () => void {
  const touch = p.pointerType === 'touch';
  let x = p.x;
  let y = p.y;
  let state: 'pressed' | 'lifted' | 'dragging' | 'done' = 'pressed';
  let allowed = new Map<string, Move>();
  let from: string | null = null;
  let over: string | null = null;
  let layer: HTMLElement | null = null;
  let ghost: HTMLElement | null = null;
  // under the lifted card, what dropping it here does ("Drop to approve V9"), with the lane's keyframe
  let hint: { box: HTMLElement; glyph: HTMLElement; words: HTMLElement } | null = null;
  let offset = { x: 0, y: 0 };
  // over the board the card itself is lifted; off it (towards the sidebar's folders) the small chip every layout drags
  let chip: HTMLElement | null = null;
  let small = false;
  // a folder in the sidebar under the pointer (the browser's drag-and-drop never reaches it): it takes the video
  let folder: ReturnType<typeof pointerDropTarget> = null;
  let frame = 0;
  let timer = 0;
  const snap = host.board.style.scrollSnapType;

  const inside = (r: DOMRect, px: number, py: number) => px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;
  // the lane under the pointer, where the board shows it (a lane scrolled out of the board's view is under something else)
  const laneAt = (px: number, py: number) =>
    inside(host.board.getBoundingClientRect(), px, py)
      ? ([...host.board.querySelectorAll<HTMLElement>('.lane[data-lane]')].find((l) => inside(l.getBoundingClientRect(), px, py)) ?? null)
      : null;

  const place = () => {
    if (!ghost || !chip) return;
    const off = !inside(host.board.getBoundingClientRect(), x, y);
    if (off !== small) {
      small = off;
      ghost.style.display = small ? 'none' : '';
      chip.style.display = small ? '' : 'none';
      if (hint) (small ? chip : ghost).append(hint.box);
    }
    ghost.style.transform = `translate3d(${x - offset.x}px, ${y - offset.y}px, 0) scale(1.02)`;
    chip.style.transform = `translate3d(${x - 24}px, ${y - 24}px, 0)`;
  };
  // Which lane takes it: lit (the host's state) and the cursor says yes; one that doesn't, the cursor says no.
  const hit = () => {
    const lane = laneAt(x, y)?.dataset.lane ?? null;
    const takes = lane && lane !== from && allowed.has(lane) ? lane : null;
    if (layer) layer.dataset.drop = lane && lane !== from && !takes ? 'no' : 'ok';
    // off the board: a folder that takes videos (lit while the pointer is on it, "Move to …" under the chip)
    const f = lane ? null : pointerDropTarget(x, y, DRAG_VIDEO, [layer, ghost]);
    if (f?.el !== folder?.el) {
      folder?.target.over(false);
      folder = f;
      folder?.target.over(true);
      if (hint) {
        const name = folder?.el.querySelector('.nav-label, .sec-title')?.textContent?.trim();
        if (folder) {
          hint.box.dataset.lane = '';
          hint.glyph.dataset.shape = 'outline';
          hint.words.textContent = name ? t('Move to {folder}', { folder: name }) : t('Move here');
        }
        hint.box.classList.toggle('on', !!folder);
      }
    }
    if (takes !== over) {
      over = takes;
      host.over(takes);
      const m = takes ? allowed.get(takes) : undefined;
      if (hint && m) {
        hint.box.dataset.lane = m.to;
        hint.glyph.dataset.shape = LANE_SHAPE[m.to] ?? 'outline';
        hint.words.textContent = dropWords(m);
      }
      hint?.box.classList.toggle('on', !!m);
    }
  };
  const scroll = () => {
    const b = host.board.getBoundingClientRect();
    const near = (d: number) => SPEED * (1 - Math.max(0, Math.min(d, EDGE)) / EDGE);
    if (x < b.left + EDGE) host.board.scrollLeft -= near(x - b.left);
    else if (x > b.right - EDGE) host.board.scrollLeft += near(b.right - x);
    const box = laneAt(x, y)?.querySelector<HTMLElement>('.lane-scroll');
    if (box && box.scrollHeight > box.clientHeight) {
      const r = box.getBoundingClientRect();
      if (y < r.top + EDGE) box.scrollTop -= near(y - r.top);
      else if (y > r.bottom - EDGE) box.scrollTop += near(r.bottom - y);
    }
  };
  const tick = () => {
    frame = 0;
    if (state !== 'dragging') return;
    scroll();
    place();
    hit();
    frame = requestAnimationFrame(tick);
  };

  const lift = () => {
    const found = p.card.isConnected ? p.card : host.board.querySelector<HTMLElement>(`.bcard[data-slug="${CSS.escape(p.slug)}"]`);
    if (!found) return finish();
    p.card = found;
    const lanes = host.begin(p.slug, p.card);
    if (!lanes) return finish();
    allowed = lanes;
    from = p.card.closest<HTMLElement>('.lane[data-lane]')?.dataset.lane ?? null;
    state = 'dragging';
    window.getSelection()?.removeAllRanges();
    host.board.style.scrollSnapType = 'none';
    layer = document.createElement('div');
    layer.className = 'board-drag-layer';
    layer.dataset.drop = 'ok';
    layer.addEventListener('wheel', onWheel, { passive: false });
    document.body.append(layer);
    try {
      layer.setPointerCapture(p.pointerId);
    } catch {}
    const cardBox = p.card.getBoundingClientRect();
    offset = { x: p.x - cardBox.left, y: p.y - cardBox.top };
    ghost = p.card.cloneNode(true) as HTMLElement;
    ghost.classList.add('bcard-ghost');
    ghost.classList.remove('lifting', 'menu-open');
    for (const el of [ghost, ...ghost.querySelectorAll<HTMLElement>('*')])
      for (const a of ['id', 'data-testid', 'data-slug', 'data-nav', 'tabindex', 'role', 'aria-label']) el.removeAttribute(a);
    ghost.setAttribute('aria-hidden', 'true');
    ghost.inert = true;
    ghost.style.width = `${cardBox.width}px`;
    ghost.style.height = `${cardBox.height}px`;
    chip = buildDragChip(p.card.querySelector('.bcard-name')?.textContent?.trim() || p.slug, p.card);
    chip.classList.add('bcard-ghost', 'board-chip');
    chip.setAttribute('aria-hidden', 'true');
    chip.style.display = 'none';
    const box = document.createElement('div');
    box.className = 'bcard-ghost-hint';
    box.dataset.testid = 'drop-hint';
    const glyph = document.createElement('span');
    glyph.className = 'kg';
    const words = document.createElement('span');
    box.append(glyph, words);
    ghost.append(box);
    hint = { box, glyph, words };
    document.body.append(ghost, chip);
    place();
    hit();
    frame = requestAnimationFrame(tick);
  };

  // The copy flies to `to` (where the card lands, or back where it came from), then goes.
  const settle = (to: DOMRect | undefined, then: () => void) => {
    const g = small ? chip : ghost;
    if (!g || !to || still()) return then();
    const a = g.animate([{ transform: g.style.transform }, { transform: `translate3d(${to.left}px, ${to.top}px, 0) scale(1)`, boxShadow: 'none' }], {
      duration: SETTLE_MS,
      easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      fill: 'forwards',
    });
    a.finished.then(then, then);
  };

  const finish = () => {
    if (state === 'done') return;
    state = 'done';
    clearTimeout(timer);
    cancelAnimationFrame(frame);
    host.lock(false);
    p.card.classList.remove('lifting');
    window.removeEventListener('pointermove', onMove, true);
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
    window.removeEventListener('keydown', onKey, true);
    host.board.style.scrollSnapType = snap;
    layer?.remove();
    layer = null;
  };
  const dropGhost = () => {
    ghost?.remove();
    ghost = null;
    chip?.remove();
    chip = null;
  };

  const callOff = (fly: boolean) => {
    folder?.target.over(false);
    folder = null;
    const wasDragging = state === 'dragging';
    // back to the card's place (a re-render may have given the card a new element)
    const card = p.card.isConnected ? p.card : host.board.querySelector<HTMLElement>(`.bcard[data-slug="${CSS.escape(p.slug)}"]`);
    const back = fly ? card?.getBoundingClientRect() : undefined;
    finish();
    if (!wasDragging) return;
    host.over(null);
    settle(back, () => {
      dropGhost();
      host.cancel();
    });
  };

  function onMove(e: PointerEvent) {
    if (e.pointerId !== p.pointerId) return;
    x = e.clientX;
    y = e.clientY;
    const moved = Math.hypot(x - p.x, y - p.y);
    if (state === 'pressed') {
      if (!touch && moved > SLOP) lift();
      // a finger that moves before the long press is scrolling
      else if (touch && moved > TOUCH_SLOP) finish();
    } else if (state === 'lifted') lift();
    if (state === 'dragging') e.preventDefault();
  }
  function onUp(e: PointerEvent) {
    if (e.pointerId !== p.pointerId) return;
    if (state !== 'dragging') return finish();
    x = e.clientX;
    y = e.clientY;
    hit();
    const lane = over;
    if (!lane && folder) {
      const f = folder;
      f.target.over(false);
      folder = null;
      f.target.drop({ video: p.slug });
      return callOff(true);
    }
    if (!lane) return callOff(true);
    // the copy lands where the board shows the card's place in that lane
    const slot = host.board.querySelector<HTMLElement>(`.lane[data-lane="${lane}"] .bcard-slot`);
    const box = slot?.getBoundingClientRect();
    const seen = box && box.bottom > 0 && box.top < innerHeight;
    finish();
    settle(seen ? box : undefined, () => {
      host.drop(lane);
      // the card is in its lane from the next frame: the copy goes after it, so nothing blinks
      requestAnimationFrame(dropGhost);
    });
  }
  function onCancel(e: PointerEvent) {
    if (e.pointerId === p.pointerId) callOff(false);
  }
  function onKey(e: KeyboardEvent) {
    if (e.key !== 'Escape' || state === 'pressed') return;
    // the drag's, not a dialog's or a toast's underneath
    e.preventDefault();
    e.stopImmediatePropagation();
    callOff(true);
  }
  function onWheel(e: WheelEvent) {
    e.preventDefault();
    host.board.scrollLeft += e.deltaX;
    const box = laneAt(x, y)?.querySelector<HTMLElement>('.lane-scroll');
    if (box) box.scrollTop += e.deltaY;
  }

  window.addEventListener('pointermove', onMove, true);
  window.addEventListener('pointerup', onUp, true);
  window.addEventListener('pointercancel', onCancel, true);
  window.addEventListener('keydown', onKey, true);
  if (touch)
    timer = window.setTimeout(() => {
      if (state !== 'pressed') return;
      // a long press: the card lifts in place and follows the finger from its next move; the page holds still
      state = 'lifted';
      host.lock(true);
      p.card.classList.add('lifting');
      navigator.vibrate?.(8);
    }, LONG_PRESS);
  return () => callOff(false);
}
