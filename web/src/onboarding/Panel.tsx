// Get started from the sidebar's foot: the row once its code is here (Row.tsx holds its room in the first paint) and the
// steps in a compact panel above it, each with the card's own pane (GetStarted.tsx Pane, never a copy) — the small ones
// done right here (an agent connected, a review link made, a teammate invited, a file linked), the big ones taken where
// they live (the sample in check mode, the library's upload). The steps' list stays put and every pane stands in one
// cell under it, the selected one shown, so the panel keeps one height from step to step. A step ticks the moment the
// server finds it done, in the panel and on the row. The panel's foot hides Get started for good (the card and the row,
// with Undo). From a phone's or tablet's drawer the panel is a sheet (a popover can't open over the drawer).
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ComponentProps, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { AuthStatus, OnboardingStep } from '../../../lib/types.ts';
import { authKeys } from '../api/auth.ts';
import { t } from '../i18n/index.ts';
import { toastError } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph, useChanged } from '../ui/KeyGlyph.tsx';
import { Modal, Popover } from '../ui/primitives.tsx';
import { comeBack, hideForGood, useOnboarding } from './data.ts';
import { type GetStartedProps, Pane, titleOf, useKeysMoved, useLive, usePaneCtx } from './GetStarted.tsx';
import { KG } from './parts.tsx';
import { useFirstRun } from './state.ts';
import '../styles/startpanel.css';

// The steps asked for from the account menu: the row on screen opens them (it may have just come back).
let asked = false;
const askers = new Set<() => void>();
const ask = (v: boolean) => {
  asked = v;
  for (const f of askers) f();
};
const useAsked = () =>
  useSyncExternalStore(
    (f) => {
      askers.add(f);
      return () => askers.delete(f);
    },
    () => asked,
  );

/** A desk's sidebar is on screen (not an empty library's page, not a phone's or tablet's drawer, not the player). */
const sidebarShown = () => !!document.querySelector('.lib > .nav')?.getClientRects().length;

/**
 * The account menu's "Get started": with a desk's sidebar on screen the steps open at its foot, where they live, and you
 * stay where you are (the inbox, a project); anywhere else (the player, Settings, a tablet, an empty library) the card
 * comes back above All videos. Either way what was hidden for good shows again.
 */
export function fromMenu(qc: QueryClient): void {
  const o = qc.getQueryData<AuthStatus>(authKeys.status)?.user?.prefs?.onboarding;
  const here = sidebarShown();
  // after the menu has handed the focus back to its button
  if (here) setTimeout(() => ask(true));
  else location.hash = '#/';
  if (o?.dismissed || (!here && o?.hidden)) comeBack(qc, !here).catch(toastError);
}

/** The row's face — the keyframe, the words, the steps as frames on a line — in the room Row.tsx held for it. */
function RowFace({ count, all, pop, ...button }: { count: { done: number; of: number }; all?: boolean; pop?: boolean } & ComponentProps<'button'>) {
  return (
    <button type="button" className={`ob-side-row ${all ? 'ob-all' : ''}`} aria-haspopup="dialog" data-testid="ob-row" {...button}>
      <KeyGlyph key={count.done} shape={all ? 'diamond' : count.done ? 'half' : 'outline'} pop={pop} className="ob-side-kg" />
      <span className="ob-side-label">{all ? t('You’re set') : t('Get started')}</span>
      <span className="ob-side-count" data-testid="ob-row-count">
        {t('{done} of {n}', { done: count.done, n: count.of })}
      </span>
      <span className="ob-side-line" aria-hidden="true">
        {Array.from({ length: count.of }, (_, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: a step's place on the line
          <i key={i} className={i < count.done ? 'ob-on' : undefined} />
        ))}
      </span>
    </button>
  );
}

/** Folds the row away: its height eases to nothing, so the foot settles once instead of jumping. */
function fold(el: HTMLElement | null): Promise<unknown> {
  if (!el) return Promise.resolve();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  return el
    .animate(
      [
        { height: `${el.offsetHeight}px`, opacity: 1 },
        { height: '0px', opacity: 0 },
      ],
      { duration: still ? 0 : 320, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' },
    )
    .finished.catch(() => {});
}

/**
 * The sidebar's row with its code: the panel above it (a sheet in the drawer), its count kept live while it shows, and
 * — when the last step ticks while it shows — "You're set" for as long as the card says it, then it folds away.
 */
export function SideRow(props: GetStartedProps) {
  const run = useFirstRun();
  const count = run.steps.length ? { done: run.steps.filter((s) => s.done).length, of: run.steps.length } : null;
  const all = !!count && count.done === count.of;
  const [open, setOpen] = useState<'pop' | 'sheet' | null>(null);
  // shown with steps open in this visit: when the last one ticks it says so before it goes
  const [stay, setStay] = useState(run.side && !all);
  const [gone, setGone] = useState(false);
  const finale = stay && all && !!run.o && !run.o.dismissed && !gone;
  const show = (run.side && !all) || finale;
  const wrap = useRef<HTMLDivElement>(null);
  const button = useRef<HTMLButtonElement>(null);
  const popped = useChanged(count?.done);
  const want = useAsked();
  useEffect(() => {
    if (run.side && !all) setStay(true);
  }, [run.side, all]);
  // everything done: "You're set" while the card says it too, then both fold away
  useEffect(() => {
    if (!finale) return;
    let live = true;
    const tm = setTimeout(() => {
      setOpen(null);
      void fold(wrap.current).then(() => live && setGone(true));
    }, 3200);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [finale]);
  // a step that goes where it lives (the sample, a video) closes the panel on the way there
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(null);
    window.addEventListener('hashchange', close);
    return () => window.removeEventListener('hashchange', close);
  }, [open]);
  const sheet = () => !!button.current?.closest('.drawer');
  // asked from elsewhere (the row clicked before this code arrived, the account menu): the row on screen opens
  useEffect(() => {
    if (want && show && button.current?.getClientRects().length) {
      ask(false);
      setOpen(sheet() ? 'sheet' : 'pop');
    }
  });

  if (!show) return null;
  // the account not heard yet (the room held from what this browser saw last): the row's box, empty
  if (!count) return <div className="ob-side ob-side-room" aria-hidden="true" data-testid="ob-row-wrap" />;
  const close = () => setOpen(null);
  const title = all ? t('You’re set') : t('Get started');
  const panel = (inSheet: boolean) => <StartPanel {...props} sheet={inSheet} onClose={close} />;
  return (
    <div className="ob-side" ref={wrap} data-testid="ob-row-wrap">
      {run.side && <Follow />}
      <Popover
        open={open === 'pop'}
        onOpenChange={(o) => setOpen(o ? 'pop' : null)}
        trigger={
          <RowFace
            ref={button}
            count={count}
            all={all}
            pop={popped}
            aria-expanded={!!open}
            onClick={(e) => {
              // from the drawer a sheet; at a desk the popover's own toggle
              if (!sheet()) return;
              e.preventDefault();
              setOpen(open ? null : 'sheet');
            }}
          />
        }
        // it opens upward: the row stands at the window's foot, and there is never room for it below (the popover's own
        // flip; the shared popover stays as it is, the first paint has no room for more)
        align="start"
        sideOffset={6}
        className="ob-sp-pop"
        onOpenAutoFocus={(e) => {
          // named by its headline; the panel speaks first (its words, then Tab to its steps), not its ×
          e.preventDefault();
          const box = e.currentTarget as HTMLElement | null;
          box?.setAttribute('aria-labelledby', 'ob-sp-title');
          box?.querySelector<HTMLElement>('.ob-sp')?.focus();
        }}
      >
        {open === 'pop' && panel(false)}
      </Popover>
      {open === 'sheet' && (
        <Modal
          title={title}
          width={440}
          head={<small className="ob-sp-sheet-count">{t('{done} of {n}', { done: count.done, n: count.of })}</small>}
          onClose={close}
        >
          {panel(true)}
        </Modal>
      )}
    </div>
  );
}

/** Keeps the row's count live while it shows (what the server finds done, as it happens): nothing on screen. */
function Follow() {
  useOnboarding(true);
  useLive();
  return null;
}

/** The account menu shows where the person is (a desk, a tablet, an empty library on a phone): it still has Get started. */
const menuShown = () => !!document.querySelector('.topbar .user-chip')?.getClientRects().length;

export interface StartPanelProps extends GetStartedProps {
  onClose: () => void;
  /** In a sheet (the drawer's row on a phone or tablet): the sheet's head says what it is and closes it. */
  sheet?: boolean;
}

export function StartPanel({ onClose, sheet, add, upload }: StartPanelProps) {
  const qc = useQueryClient();
  const run = useFirstRun();
  const { data } = useOnboarding(true);
  useLive();
  const list = useRef<HTMLOListElement>(null);
  useKeysMoved(list);
  const steps = data?.onboarding ? data.steps : run.steps;
  const next = steps.find((s) => !s.done)?.id ?? null;
  // the step open stays open (a step done shows what it made: the link to copy, the agent connected); the person
  // moves on with a click — it opens on the next one
  const [sel, setSel] = useState<OnboardingStep | null>(next);
  const [ticked, setTicked] = useState<OnboardingStep | null>(null);
  // adding a video goes where it lives: the library's own picker (or the machine's add dialog), the panel out of its way
  const base = usePaneCtx(
    {
      add: add
        ? () => {
            onClose();
            add();
          }
        : null,
      upload,
    },
    data,
  );
  // a step that ticks pops
  const doneKey = steps
    .filter((s) => s.done)
    .map((s) => s.id)
    .join(',');
  const prevDone = useRef(doneKey);
  useEffect(() => {
    if (prevDone.current === doneKey) return;
    const before = new Set(prevDone.current.split(','));
    prevDone.current = doneKey;
    const fresh = steps.find((s) => s.done && !before.has(s.id));
    if (!fresh) return;
    setTicked(fresh.id);
    const tm = setTimeout(() => setTicked(null), 1100);
    return () => clearTimeout(tm);
  }, [doneKey, steps]);

  if (!steps.length) return null;
  const all = !next;
  const current = sel && steps.some((s) => s.id === sel) ? sel : (next ?? steps[steps.length - 1].id);
  const doneN = steps.filter((s) => s.done).length;
  const hide = () => {
    onClose();
    hideForGood(qc, menuShown());
    // the row goes: the keyboard stays at the sidebar's foot
    // (the one on screen: a desk's sidebar, or the drawer's on a phone or tablet)
    requestAnimationFrame(() => [...document.querySelectorAll<HTMLElement>('.nav-foot .nav-settings')].find((e) => e.getClientRects().length)?.focus());
  };
  return (
    <div className={`ob-sp ${sheet ? 'ob-sp-sheet' : ''}`} data-testid="ob-sp" tabIndex={-1}>
      {!sheet && (
        <div className="ob-sp-head">
          <h2 className="ob-sp-title" id="ob-sp-title">
            {all ? t('You’re set') : t('Get started')}
            <small data-testid="ob-sp-count">{t('{done} of {n}', { done: doneN, n: steps.length })}</small>
          </h2>
          <button type="button" className="ob-ibtn ob-sp-x" onClick={onClose} aria-label={t('Close')} data-testid="ob-sp-close">
            <I name="x" size={14} />
          </button>
        </div>
      )}
      <ol className="ob-sp-list" ref={list}>
        {steps.map((s) => (
          <li key={s.id}>
            <button
              type="button"
              className={`ob-sp-row ${s.done ? 'ob-done' : ''} ${ticked === s.id ? 'ob-ticked' : ''}`}
              onClick={() => setSel(s.id)}
              aria-current={current === s.id ? 'step' : undefined}
              data-step={s.id}
              data-done={s.done || undefined}
              data-testid="ob-sp-step"
            >
              <KG shape={s.done ? 'diamond' : 'outline'} />
              <span>{titleOf(s.id, base.agent, upload)}</span>
              <span className="ob-when">{s.done ? t('Done') : ''}</span>
            </button>
          </li>
        ))}
      </ol>
      {/* every step's pane in one cell, the selected one shown: the panel is as tall as its tallest pane */}
      <div className="ob-sp-pane" data-testid="ob-sp-pane" data-pane={current}>
        {steps.map((s) => {
          const on = s.id === current;
          return (
            <div key={s.id} className={`ob-gs-slot ${on ? 'ob-on' : ''}`} inert={!on} aria-hidden={on ? undefined : true} data-slot={s.id}>
              <Pane id={s.id} ctx={{ ...base, done: s.done, where: sheet ? 'sheet' : 'sp' }} />
            </div>
          );
        })}
      </div>
      {/* nothing to hide once everything is done: the foot keeps its room while "You're set" shows */}
      <div className="ob-sp-foot" inert={all} style={all ? { visibility: 'hidden' } : undefined}>
        <button type="button" className="ob-lk" onClick={hide} data-testid="ob-sp-hide">
          {t('Hide for good')}
        </button>
      </div>
    </div>
  );
}
