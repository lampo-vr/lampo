// Drag & drop of videos and folders onto folders (sidebar tree, folder tiles) — the browser's, and the board's own
// pointer drag through a registry of the same targets.
import { type DragEvent, useCallback, useRef, useState } from 'react';

export const DRAG_VIDEO = 'application/x-vr-video';
export const DRAG_FOLDER = 'application/x-vr-folder';

/**
 * What a video shows while it's dragged, in every layout: a small chip — its poster and name in the raised material.
 * A row is as wide as the page and a card as big as the grid makes it; the browser would drag all of it. The poster goes
 * through a canvas: a copy of an image that hasn't decoded yet would come out blank.
 */
export function buildDragChip(name: string, from: HTMLElement): HTMLElement {
  const chip = document.createElement('div');
  chip.className = 'lrow-drag';
  const img = from.querySelector('img');
  if (img?.complete && img.naturalWidth) {
    const c = document.createElement('canvas');
    const dpr = window.devicePixelRatio || 1;
    c.width = Math.round(64 * dpr);
    c.height = Math.round(36 * dpr);
    const scale = Math.max(c.width / img.naturalWidth, c.height / img.naturalHeight);
    const w = img.naturalWidth * scale;
    const h = img.naturalHeight * scale;
    c.getContext('2d')?.drawImage(img, (c.width - w) / 2, (c.height - h) / 2, w, h);
    chip.append(c);
  }
  const label = document.createElement('span');
  label.textContent = name;
  chip.append(label);
  return chip;
}

/** The browser's drag picture for a video: the chip, only for the moment the browser takes its picture. */
export function dragChip(e: DragEvent, name: string, from: HTMLElement) {
  const chip = buildDragChip(name, from);
  document.body.append(chip);
  e.dataTransfer.setDragImage(chip, 24, 24);
  setTimeout(() => chip.remove());
}

export type Dropped = { video: string; folder?: undefined } | { folder: string; video?: undefined };

/**
 * Drop targets for the board's own pointer drag (boardDrag.ts), which the browser's drag-and-drop events never reach:
 * every target `useDrop` makes registers its element here, and the board asks what is under the pointer.
 */
interface PointerTarget {
  accepts: (kind: string) => boolean;
  drop: (d: Dropped) => void;
  over: (on: boolean) => void;
}
const targets = new Map<Element, PointerTarget>();

/** The drop target under a point for a drag of `kind` (skipping the drag's own layers), or null. */
export function pointerDropTarget(x: number, y: number, kind: string, skip: (Element | null)[] = []): { el: Element; target: PointerTarget } | null {
  for (const el of document.elementsFromPoint(x, y)) {
    if (skip.some((s) => s && (s === el || s.contains(el)))) continue;
    const target = targets.get(el);
    if (target?.accepts(kind)) return { el, target };
  }
  return null;
}

export function useDrop(onDrop: (d: Dropped) => void, accept: string[] = [DRAG_VIDEO]) {
  const [over, setOver] = useState(false);
  const depth = useRef(0);
  const ok = (e: DragEvent) => accept.some((t) => e.dataTransfer.types.includes(t));
  // the latest handlers, for the pointer drag's registry (its entry is made once per element)
  const now = useRef({ onDrop, accept });
  now.current = { onDrop, accept };
  const ref = useCallback((el: HTMLElement | null) => {
    if (!el) return;
    targets.set(el, {
      accepts: (kind) => now.current.accept.includes(kind),
      drop: (d) => now.current.onDrop(d),
      over: setOver,
    });
    return () => {
      targets.delete(el);
    };
  }, []);
  return {
    over,
    props: {
      ref,
      onDragEnter: (e: DragEvent) => {
        if (!ok(e)) return;
        depth.current++;
        setOver(true);
      },
      onDragOver: (e: DragEvent) => {
        if (!ok(e)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
      },
      onDragLeave: () => {
        depth.current = Math.max(0, depth.current - 1);
        if (!depth.current) setOver(false);
      },
      onDrop: (e: DragEvent) => {
        if (!ok(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        const video = e.dataTransfer.getData(DRAG_VIDEO);
        onDrop(video ? { video } : { folder: e.dataTransfer.getData(DRAG_FOLDER) });
      },
    },
  };
}
