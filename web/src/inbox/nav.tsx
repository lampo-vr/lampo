// The keyboard's place in the inbox's list (shared by the bell's popover and the inbox view), the width at which list
// and preview stand side by side, and the list's loading layout. Light: the inbox view's first paint needs them, the
// rows themselves (Rows.tsx) come in a chunk of their own.
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';
import type { ForYouItem } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { useInboxMode } from './mode.ts';

/** The list asks the preview to open the full player (↵ on the item already in the preview): the preview knows the
 * frame on screen. A DOM event on the list, so it reaches the preview of this inbox only (the popover's or the view's). */
export const OPEN_PLAYER = 'inbox-open-player';

/** The inbox view's header asks the list for its keys (Tally.tsx → Rows.tsx, a chunk of its own): a window event. */
export const KEYS_HELP = 'inbox-keys-help';

/** Wide enough for the list and the preview side by side (the popover grows to both; the inbox view splits). */
export const INBOX_WIDE = '(min-width: 1100px)';

/**
 * The keyboard's place in the list, and what opening an item and finishing one do. `follow`: the preview follows the
 * keys (the inbox view, where something is always open); otherwise Enter opens what the keys are on (the popover).
 */
export function useInboxNav(items: ForYouItem[], picked: string | null, setPicked: (key: string | null) => void, { follow = false } = {}) {
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      items.findIndex((i) => i.key === picked),
    ),
  );
  const list = useRef<HTMLDivElement>(null);
  // the keys' row stays on its item when the list changes around it (an update above it seen, a fix checked elsewhere)
  const before = useRef(items);
  useEffect(() => {
    const key = before.current[active]?.key;
    before.current = items;
    const at = key ? items.findIndex((i) => i.key === key) : -1;
    if (at >= 0 && at !== active) setActive(at);
    else if (active > items.length - 1) setActive(Math.max(0, items.length - 1));
  }, [items, active]);
  // keep the keyboard's row in view (in a long group it may take a frame or two to be rendered where it was scrolled to)
  useEffect(() => {
    let frame = 0;
    const show = (tries: number) => {
      const row = list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
      if (row) row.scrollIntoView({ block: 'nearest' });
      else if (tries) frame = requestAnimationFrame(() => show(tries - 1));
    };
    show(4);
    return () => cancelAnimationFrame(frame);
  }, [active]);

  const open = (i: ForYouItem) => {
    setActive(items.indexOf(i));
    setPicked(i.key);
  };
  const move = (to: number) => {
    setActive(to);
    if (follow && items[to]) setPicked(items[to].key);
  };
  const onKey = (e: KeyboardEvent) => {
    if (!items.length) return;
    if (e.key === 'ArrowDown' || e.key === 'j') {
      e.preventDefault();
      move(Math.min(items.length - 1, active + 1));
    } else if (e.key === 'ArrowUp' || e.key === 'k') {
      e.preventDefault();
      move(Math.max(0, active - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const i = items[active];
      if (!i) return;
      // the item already in the preview: ↵ goes on to the full player, at the frame the preview shows
      if (follow || i.key === picked) e.currentTarget.dispatchEvent(new CustomEvent(OPEN_PLAYER, { bubbles: true }));
      else open(i);
    }
  };
  /** Done with one: the next one in the list takes its place (`keep`: where the preview stays open), so a run of
   * fixes is checked one after another. */
  const done = (key: string, keep: boolean) => {
    const at = items.findIndex((i) => i.key === key);
    const rest = items.filter((i) => i.key !== key);
    const next = rest[Math.min(at, rest.length - 1)];
    setPicked(next && keep ? next.key : null);
    setActive(Math.max(0, Math.min(at, rest.length - 1)));
  };
  return { active, list, open, onKey, done };
}

export type InboxNav = ReturnType<typeof useInboxNav>;

/** The list while it loads (the inbox view): the first group's head — a video's, or a kind's — and rows in the rows'
 * own boxes, as the mode will show them. */
export function InboxRowsPending() {
  const [mode] = useInboxMode();
  const video = mode === 'video';
  return (
    <SkeletonRegion label={t('Loading the inbox')} className={`inbox-list by-${mode}`}>
      <div className={`inbox-group ${video ? 'g-video' : ''}`}>
        {video ? (
          <div className="inbox-vhead">
            <span className="inbox-vhead-name">
              <SkLine w="9em" />
            </span>
            <span className="inbox-vhead-sum">
              <SkLine w="12em" />
            </span>
          </div>
        ) : (
          <div className="inbox-group-h">
            <SkLine w="8em" />
          </div>
        )}
        {['72%', '56%', '64%', '48%'].map((w) => (
          <div key={w} className="inbox-row pending">
            <span className="inbox-thumb" />
            <span className="inbox-row-body">
              <span className="inbox-row-top">
                <span className={`inbox-row-name ${video ? 'what' : ''}`}>
                  <SkLine w="40%" />
                </span>
              </span>
              <span className="inbox-row-text">
                <SkLine w={w} />
              </span>
            </span>
          </div>
        ))}
      </div>
    </SkeletonRegion>
  );
}
