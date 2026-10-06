// The player's keyboard map (the Help modal lists it). Handlers come fresh every render; listeners attach once.
import { useEffect, useRef } from 'react';

export interface ShortcutHandlers {
  escape: (typing: boolean, target: HTMLElement) => void;
  /** ↵ with nothing focused that takes it (a button, a link): a note on the marked section. */
  enter: () => void;
  step: (frames: number) => void;
  first: () => void;
  last: () => void;
  togglePlay: () => void;
  pause: () => void;
  forward: () => void;
  reverse: () => void;
  markIn: (jump: boolean) => void;
  markOut: (jump: boolean) => void;
  clearRange: () => void;
  toggleLoop: () => void;
  toggleMute: () => void;
  compose: () => void;
  verify: () => void;
  togglePhone: () => void;
  change: (dir: 1 | -1) => void;
  talk: () => void;
  /** ⇧R: start recording feedback, or finish it. */
  record: () => void;
  stopTalking: () => void;
  cyclePreset: () => void;
  toggleAb: () => void;
  comment: (dir: 1 | -1) => void;
  /** ↑ / ↓: the note above or below the selected one in the list; false when the list isn't shown (the keys do
   * what they would anyway). */
  note: (dir: 1 | -1) => boolean;
  /** Review mode: the next (or previous) open note. */
  review: (dir: 1 | -1) => void;
  /** The timeline's zoom: in, out, the whole video, or the marked section (else around the playhead). */
  zoom: (to: 'in' | 'out' | 'fit' | 'section') => void;
  help: () => void;
}

const isTyping = (t: HTMLElement) => t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable;

export function useShortcuts(handlers: ShortcutHandlers) {
  const ref = useRef(handlers);
  ref.current = handlers;
  useEffect(() => {
    const down = (e: KeyboardEvent) => {
      const h = ref.current;
      const t = (e.target instanceof HTMLElement ? e.target : document.body) as HTMLElement;
      const typing = isTyping(t);
      // An Escape that closed a menu, popover or dialog is theirs (Radix marks it handled): it must not also close the
      // composer and throw the unsent note away.
      if (e.key === 'Escape') return e.defaultPrevented ? undefined : h.escape(typing, t);
      // Widgets that handle their own keys (menus, tabs, selects, dialogs) win.
      if (typing || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || t.closest('[role=dialog],[role=menu],[role=listbox]')) return;
      const step = e.shiftKey ? 10 : 1;
      const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
      const handled = () => e.preventDefault();
      switch (k) {
        case 'Enter':
          // a focused button or link answers ↵ itself
          if (e.shiftKey || e.repeat || t.closest('button, a[href], [role=button], [role=tab], [role=option], [role=slider], summary')) return;
          handled();
          return h.enter();
        case 'ArrowLeft':
        case ',':
          handled();
          return h.step(-step);
        case 'ArrowRight':
        case '.':
          handled();
          return h.step(step);
        case 'ArrowUp':
        case 'ArrowDown':
          if (h.note(k === 'ArrowUp' ? -1 : 1)) handled();
          return;
        case 'Home':
          handled();
          return h.first();
        case 'End':
          handled();
          return h.last();
        case ' ':
          handled();
          return h.togglePlay();
        case 'k':
          return h.pause();
        case 'l':
          return h.forward();
        case 'j':
          return h.reverse();
        case 'i':
          return h.markIn(e.shiftKey);
        case 'o':
          return h.markOut(e.shiftKey);
        case 'x':
          return h.clearRange();
        case 'r':
          return e.shiftKey ? h.record() : h.toggleLoop();
        case 'm':
          return h.toggleMute();
        case 'c':
          handled();
          return h.compose();
        case 'v':
          return e.shiftKey ? h.verify() : h.togglePhone();
        case 'd':
          return h.change(e.shiftKey ? -1 : 1);
        case 't':
          handled();
          if (!e.repeat) h.talk();
          return;
        case 'g':
          return h.cyclePreset();
        case 'b':
          return h.toggleAb();
        case '[':
          return h.comment(-1);
        case ']':
          return h.comment(1);
        case 'n':
          return h.review(e.shiftKey ? -1 : 1);
        case '=':
        case '+':
          return h.zoom('in');
        case '-':
          return h.zoom('out');
        case '0':
          return h.zoom('fit');
        case 'z':
          return h.zoom(e.shiftKey ? 'fit' : 'section');
        case '?':
          return h.help();
      }
    };
    const up = (e: KeyboardEvent) => (e.key === 't' || e.key === 'T') && ref.current.stopTalking();
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
    };
  }, []);
}
