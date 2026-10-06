// The inbox's list, shared by the bell's popover and phone sheet (InboxPanel.tsx) and the inbox view (InboxView.tsx).
// By video (the default): one group per video — its poster, name, project and what it holds ("3 questions · 2 fixes ·
// V4 to review") —, its items under it, most urgent first; by kind: the groups of before. In the popover and the sheet
// (`compact`) a video with three or more items folds to its head and its most urgent item until it is opened.
// Every row clears where it is: while the pointer or the keys are on it, its own actions take the time's place — Done
// (a question closes without an answer), Looks right / Still wrong (a fix; Still wrong asks why, in the row), Got it
// (what only informs), Later (anything: back tomorrow at 9:00, or once its video moves) —; on touch a ⋯ holds them.
// Several at once: the checkbox on a row's picture, ⇧-click for a run, ⌘-click, X, ⌘A; a bar floating over the list's
// foot acts on them. One quiet system: under the pointer or the keys a faint fill, the item in the preview and the ones
// picked a deeper one (picked ones with their check filled) — flat, never lifted, never orange.
// Keys (never while typing): E done, ⇧E done for the whole video, H later, X select, ⌘A all, Esc clears, ? lists them
// (the inbox view's header has them too: Tally.tsx, through KEYS_HELP).
import { type ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { enc } from '../api/client.ts';
import type { ForYouItem } from '../api/types.ts';
import { perLang, t } from '../i18n/index.ts';
import { useMedia } from '../lib/media.ts';
import { toast } from '../lib/toast.ts';
import { useMeasuredWindow, WINDOW_FROM } from '../lib/windowing.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Kbd, Menu, type MenuEntry, Modal, Tip } from '../ui/primitives.tsx';
import { SayButton, withSaid } from '../ui/VoiceButton.tsx';
import { doneOf, type InboxGroup, laterUntil } from './group.ts';
import { GROUPS, type InboxActions, itemText, postRetry, Thumb, tallyWords, WhatLine, When, whenWords } from './items.tsx';
import { LaterLine } from './Later.tsx';
import type { InboxList } from './list.ts';
import { type InboxNav, KEYS_HELP } from './nav.tsx';
import { type Selection, useSelection } from './select.ts';

const typing = (el: Element | null) => !!el?.closest?.('input, textarea, select, [contenteditable=""], [contenteditable="true"]');
/** What scrolls around the list: the inbox view's column, or the popover's / sheet's scroll area. */
const scrollerOf = (el: Element) => {
  let s = el.parentElement;
  while (s && !/(auto|scroll)/.test(getComputedStyle(s).overflowY)) s = s.parentElement;
  return s;
};
const stop = (f: () => void) => (e: React.SyntheticEvent) => {
  e.stopPropagation();
  f();
};
/** What a key that only clears asks of an item that doesn't clear that way. */
const hint = (i: ForYouItem) =>
  toast(
    i.kind === 'verify'
      ? t('A fix leaves with Looks right or Still wrong — or Later')
      : i.kind === 'review'
        ? t('A version leaves with Approve or Request changes — or Later')
        : t('This one leaves once it is done — or Later'),
  );

interface RowsProps {
  list: InboxList;
  later: ForYouItem[];
  nav: InboxNav;
  shown: ForYouItem | null;
  actions: InboxActions;
  /** Under the list, above where the selection's bar floats (the inbox view: this device's notifications). */
  children?: ReactNode;
}

export function InboxRows({ list, later, nav, shown, actions, children }: RowsProps) {
  const { groups, rows, mode } = list;
  const sel = useSelection(rows);
  const touch = useMedia('(hover: none)');
  // the fix whose "Still wrong" field is open in its row
  const [asking, setAsking] = useState<string | null>(null);
  const [help, setHelp] = useState(false);
  const indexOf = useMemo(() => new Map(rows.map((x, k) => [x.key, k])), [rows]);
  const everything = useMemo(() => groups.flatMap((g) => (g.hidden ? [...g.items, ...g.hidden] : g.items)), [groups]);
  const active = rows[nav.active] ?? null;
  const laterTip = t('Later: back {when}, or once its video moves', { when: whenWords(laterUntil()) });

  const run = {
    done: (i: ForYouItem) => (doneOf(i) ? actions.done(i) : hint(i)),
    /** Done for everything of the item's video that Done applies to. */
    doneVideo: (i: ForYouItem) => {
      const all = (i.slug ? everything.filter((x) => x.slug === i.slug) : [i]).filter((x) => doneOf(x));
      if (all.length) actions.doneMany(all);
      else hint(i);
    },
    doneMany: (list: ForYouItem[]) => {
      if (!list.some((i) => doneOf(i))) return hint(list[0] as ForYouItem);
      actions.doneMany(list);
      sel.clear();
    },
    later: (list: ForYouItem[]) => {
      actions.later(list);
      sel.clear();
    },
    verifyMany: (list: ForYouItem[]) => {
      actions.verifyMany(list);
      sel.clear();
    },
  };

  // E / ⇧E / H / X / ? / Esc: in the bell's popover (or sheet) while it is open, else on the page — never while typing,
  // never in a dialog or menu above it.
  const live = useRef({ active, sel, run });
  live.current = { active, sel, run };
  const { list: listRef } = nav;
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const pop = el.closest<HTMLElement>('[data-testid="inbox"]');
    const scope: HTMLElement | Window = pop ?? window;
    const mine = (target: Element | null) => (pop ? true : !target?.closest?.('[role=dialog], [role=menu], [data-radix-popper-content-wrapper]'));
    const onKey = (e: Event) => {
      const k = e as KeyboardEvent;
      const target = k.target instanceof Element ? k.target : null;
      if (k.defaultPrevented || k.metaKey || k.ctrlKey || k.altKey || typing(target) || !mine(target)) return;
      const { active, sel, run } = live.current;
      const key = k.key.length === 1 ? k.key.toLowerCase() : k.key;
      if (key === 'e') {
        k.preventDefault();
        if (k.shiftKey) active && run.doneVideo(active);
        else if (sel.picked.length) run.doneMany(sel.picked);
        else if (active) run.done(active);
      } else if (key === 'h' && !k.shiftKey) {
        k.preventDefault();
        if (sel.picked.length) run.later(sel.picked);
        else if (active) run.later([active]);
      } else if (key === 'x' && !k.shiftKey && active) {
        k.preventDefault();
        sel.toggle(active);
      } else if (k.key === '?') {
        k.preventDefault();
        setHelp(true);
      } else if (k.key === 'Escape' && sel.keys.size && !pop) {
        k.preventDefault();
        sel.clear();
      }
    };
    // the inbox view's header asks for the keys' list (Tally.tsx); the bell's popover has no header of its own for it
    const ask = () => setHelp(true);
    scope.addEventListener('keydown', onKey);
    if (!pop) window.addEventListener(KEYS_HELP, ask);
    return () => {
      scope.removeEventListener('keydown', onKey);
      window.removeEventListener(KEYS_HELP, ask);
    };
  }, [listRef]);

  // The selection's bar keeps a room of its own at the end of what scrolls (sticky, in the flow: its height and a gap),
  // so the last row and what follows the list can always be scrolled clear of it. When the bar comes while the list's
  // end is in view (a short list shows all of it), the list moves on by that room at once: the bar covers nothing that
  // was in view.
  const bar = useRef<HTMLDivElement>(null);
  const selecting = sel.keys.size > 0;
  useLayoutEffect(() => {
    const el = bar.current;
    const before = el?.previousElementSibling;
    const scroller = el && scrollerOf(el);
    if (!selecting || !before || !scroller) return;
    const view = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
    if (before.getBoundingClientRect().bottom <= view + 1) scroller.scrollTop = scroller.scrollHeight;
  }, [selecting]);

  const row = (i: ForYouItem) => {
    const index = indexOf.get(i.key) ?? -1;
    const on = sel.keys.has(i.key);
    return (
      // biome-ignore lint/a11y/useKeyWithClickEvents: an option of the listbox, whose keys (↑/↓, j/k, Enter, E, H, X) the list takes
      <div
        key={i.key}
        id={`inbox-${i.key}`}
        role="option"
        tabIndex={-1}
        aria-selected={shown?.key === i.key}
        data-index={index}
        data-key={i.key}
        data-testid={`inbox-row-${i.kind}`}
        className={`inbox-row k-${i.kind} ${index === nav.active ? 'active' : ''} ${shown?.key === i.key ? 'picked' : ''} ${on ? 'checked' : ''}`}
        onMouseDown={(e) => e.shiftKey && e.preventDefault()}
        onClick={(e) => {
          if (e.shiftKey || e.metaKey || e.ctrlKey) sel.toggle(i, e.shiftKey);
          else nav.open(i);
        }}
      >
        <span className="inbox-thumb">
          <Thumb item={i} />
          {/* biome-ignore lint/a11y/useSemanticElements: a box drawn on the picture that takes a click, not a form field */}
          <button
            type="button"
            role="checkbox"
            aria-checked={on}
            tabIndex={-1}
            className="inbox-check"
            aria-label={t('Select: {video}', { video: i.video })}
            data-testid="inbox-check"
            onClick={(e) => {
              e.stopPropagation();
              sel.toggle(i, e.shiftKey);
            }}
          >
            <I name="check" size={12} />
          </button>
        </span>
        <span className="inbox-row-body">
          {/* one anatomy for every kind; by video the group's head names the video, so the row starts with what happened */}
          <span className="inbox-row-top">
            {mode === 'video' ? (
              <WhatLine item={i} className="inbox-row-name what" />
            ) : (
              <WhatLine
                item={i}
                className="inbox-row-name by-kind"
                before={
                  <>
                    {i.video}
                    <span className="inbox-row-what">{' · '}</span>
                  </>
                }
              />
            )}
            <span className="inbox-row-end">
              <When at={i.at} />
              {touch ? (
                <RowMenu i={i} actions={actions} run={run} sel={sel} onAsk={setAsking} />
              ) : (
                <RowActs i={i} actions={actions} run={run} onAsk={setAsking} laterTip={laterTip} />
              )}
            </span>
          </span>
          {itemText(i) && <span className="inbox-row-text">{itemText(i)}</span>}
          {asking === i.key && (
            <StillWrong
              onCancel={() => setAsking(null)}
              onSend={(text) => {
                setAsking(null);
                actions.stillWrong(i, text);
              }}
            />
          )}
        </span>
      </div>
    );
  };

  const reveal = (g: InboxGroup) => {
    const at = g.items.findIndex((i) => indexOf.get(i.key) === nav.active);
    return at < 0 ? null : at;
  };
  const group = (g: InboxGroup) =>
    mode === 'video' ? (
      // biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox
      <div key={g.key} role="group" aria-label={g.name ?? ''} className="inbox-group g-video" data-testid="inbox-vgroup">
        <VideoHead g={g} actions={actions} run={run} sel={sel} />
        <GroupRows group={g.items} row={row} reveal={reveal(g)} />
        {g.hidden && (
          <button type="button" className="inbox-vmore" onClick={() => list.unfold(g.key)} data-testid="inbox-vmore">
            {t('{n} more|{n} more', { n: g.hidden.length })}
          </button>
        )}
      </div>
    ) : (
      // biome-ignore lint/a11y/useSemanticElements: a group of options inside the listbox
      <div key={g.key} role="group" aria-label={titleOf(g)} className={`inbox-group g-${g.kind}`}>
        <div className="inbox-group-h" aria-hidden="true">
          {titleOf(g)} <span>{g.items.length}</span>
        </div>
        <GroupRows group={g.items} row={row} reveal={reveal(g)} />
      </div>
    );

  const picked = sel.picked;
  const fixes = picked.length > 0 && picked.every((i) => i.kind === 'verify');
  return (
    <>
      <div
        ref={nav.list}
        className={`inbox-list ${sel.keys.size ? 'selecting' : ''} by-${mode}`}
        role="listbox"
        tabIndex={0}
        aria-label={t('Waiting for you')}
        aria-activedescendant={rows[nav.active] ? `inbox-${rows[nav.active]?.key}` : undefined}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && !e.shiftKey && e.key.toLowerCase() === 'a') {
            e.preventDefault();
            sel.all();
          } else nav.onKey(e);
        }}
        data-testid="inbox-list"
      >
        {mode === 'video' ? <VideoGroups groups={groups} rows={rows.length} group={group} active={active} /> : groups.map(group)}
      </div>
      {later.length > 0 && (
        <div className="inbox-foot">
          <LaterLine later={later} actions={actions} />
        </div>
      )}
      {children}
      {picked.length > 0 && (
        // floats over the list's foot (sticky to the bottom of what scrolls), in the material every float wears
        <div ref={bar} className="inbox-selbar" role="toolbar" aria-label={t('{n} selected', { n: picked.length })} data-testid="inbox-selbar">
          <span className="inbox-selbar-n">{t('{n} selected', { n: picked.length })}</span>
          {fixes && (
            <button type="button" className="btn ghost sm" onClick={() => run.verifyMany(picked)} data-testid="inbox-sel-right">
              <I name="check" size={14} /> {t('Looks right')}
            </button>
          )}
          {picked.some((i) => doneOf(i)) && (
            <Tip content={t('Questions close without an answer, updates are waved through; fixes and versions stay')} shortcut="E">
              <button type="button" className="btn ghost sm" onClick={() => run.doneMany(picked)} data-testid="inbox-sel-done">
                <I name="check" size={14} /> {t('Done')}
              </button>
            </Tip>
          )}
          <Tip content={laterTip} shortcut="H">
            <button type="button" className="btn ghost sm" onClick={() => run.later(picked)} data-testid="inbox-sel-later">
              <I name="clock" size={14} /> {t('Later')}
            </button>
          </Tip>
          <IconButton
            className="btn ghost sm icon-only inbox-selbar-x"
            label={t('Clear the selection')}
            shortcut="Esc"
            icon="x"
            size={14}
            onClick={sel.clear}
            data-testid="inbox-sel-clear"
          />
        </div>
      )}
      {help && <KeysHelp onClose={() => setHelp(false)} />}
    </>
  );
}

const titleOf = (g: InboxGroup) => GROUPS().find((x) => x.kind === g.kind)?.title ?? '';

type Run = {
  done: (i: ForYouItem) => void;
  doneVideo: (i: ForYouItem) => void;
  doneMany: (list: ForYouItem[]) => void;
  later: (list: ForYouItem[]) => void;
  verifyMany: (list: ForYouItem[]) => void;
};

/** A row's own actions, in the time's place while the pointer or the keys are on it (nothing moves). */
function RowActs({ i, actions, run, onAsk, laterTip }: { i: ForYouItem; actions: InboxActions; run: Run; onAsk: (key: string) => void; laterTip: string }) {
  const how = doneOf(i);
  return (
    <span className="inbox-row-acts">
      {i.kind === 'verify' && (
        <>
          <IconButton
            className="btn ghost sm icon-only"
            label={t('Still wrong: {video}', { video: i.video })}
            tip={t('Still wrong — say what')}
            icon="reopen"
            size={14}
            onClick={stop(() => onAsk(i.key))}
            data-testid="inbox-row-wrong"
          />
          <IconButton
            className="btn ghost sm icon-only"
            label={t('Looks right: {video}', { video: i.video })}
            tip={t('Looks right')}
            icon="check"
            size={14}
            onClick={stop(() => actions.verifyUndo(i))}
            data-testid="inbox-row-right"
          />
        </>
      )}
      {i.kind === 'post' && actions.canRetry && postRetry(i) && (
        <IconButton
          className="btn ghost sm icon-only"
          label={t('{action}: the post of {video}', { action: postRetry(i)?.label ?? '', video: i.video })}
          tip={postRetry(i)?.label}
          icon="refresh"
          size={14}
          onClick={stop(() => void actions.retryPost(i))}
          data-testid="inbox-row-retry"
        />
      )}
      {how && (
        <IconButton
          className="btn ghost sm icon-only"
          label={how === 'close' ? t('Done: {video}', { video: i.video }) : t('Got it: {video}', { video: i.video })}
          tip={how === 'close' ? t('Done: close without an answer') : t('Got it')}
          shortcut="E"
          icon="check"
          size={14}
          onClick={stop(() => run.done(i))}
          data-testid="inbox-row-done"
        />
      )}
      <IconButton
        className="btn ghost sm icon-only"
        label={t('Later: {video}', { video: i.video })}
        tip={laterTip}
        shortcut="H"
        icon="clock"
        size={14}
        onClick={stop(() => run.later([i]))}
        data-testid="inbox-row-later"
      />
    </span>
  );
}

/** Touch: the same actions behind a ⋯ (no pointer to rest on a row), and Select. */
function RowMenu({ i, actions, run, sel, onAsk }: { i: ForYouItem; actions: InboxActions; run: Run; sel: Selection; onAsk: (key: string) => void }) {
  const how = doneOf(i);
  const items: MenuEntry[] = [
    i.kind === 'verify' && { label: t('Looks right'), icon: 'check', onClick: () => actions.verifyUndo(i) },
    i.kind === 'verify' && { label: t('Still wrong…'), icon: 'reopen', onClick: () => onAsk(i.key) },
    i.kind === 'post' && actions.canRetry && postRetry(i) && { label: postRetry(i)?.label ?? '', icon: 'refresh', onClick: () => void actions.retryPost(i) },
    how === 'close' && { label: t('Done: close without an answer'), icon: 'check', onClick: () => run.done(i) },
    how === 'dismiss' && { label: t('Got it'), icon: 'check', onClick: () => run.done(i) },
    { label: t('Later'), icon: 'clock', onClick: () => run.later([i]) },
    'sep',
    { label: sel.keys.has(i.key) ? t('Unselect') : t('Select'), icon: 'list', onClick: () => sel.toggle(i) },
  ];
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps a tap on the ⋯ from opening the row
    // biome-ignore lint/a11y/useKeyWithClickEvents: the menu's trigger has its own keys
    <span className="inbox-row-more" onClick={(e) => e.stopPropagation()}>
      <Menu
        trigger={
          <IconButton
            className="btn ghost sm icon-only"
            label={t('Actions for {video}', { video: i.video })}
            icon="more"
            size={15}
            data-testid="inbox-row-menu"
          />
        }
        items={items}
      />
    </span>
  );
}

/** "Still wrong", said in the row: what is still wrong (optional, typed or said), then back to the agent. */
function StillWrong({ onCancel, onSend }: { onCancel: () => void; onSend: (text: string) => void }) {
  const [text, setText] = useState('');
  // while the microphone is live or the words are being heard, the reason isn't complete yet
  const [held, setHeld] = useState(false);
  return (
    <form
      className="inbox-row-ask"
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        e.stopPropagation();
        if (e.key === 'Escape') {
          e.preventDefault();
          onCancel();
        }
      }}
      onSubmit={(e) => {
        e.preventDefault();
        if (!held) onSend(text.trim());
      }}
      data-testid="inbox-row-ask"
    >
      <input
        className="input sm"
        autoFocus
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={t('What is still wrong? (optional)')}
        aria-label={t('What is still wrong')}
        maxLength={2000}
      />
      <span className="inbox-row-ask-acts">
        <SayButton onSaid={(said) => setText((x) => withSaid(x, said))} onHold={setHeld} />
        <button type="button" className="btn ghost sm" onClick={onCancel}>
          {t('Cancel')}
        </button>
        <button type="submit" className="btn sm" disabled={held}>
          {t('Still wrong')}
        </button>
      </span>
    </form>
  );
}

/** A video's head: its poster, name, project and what it holds; ⋯ clears the whole video. */
/**
 * A video's head over its rows: a quiet one-line header — its name (a link to the player), what it holds, and its menu.
 * No picture of its own: the rows under it carry the pictures, so the head repeats none and has no dead click.
 */
function VideoHead({ g, actions, run, sel }: { g: InboxGroup; actions: InboxActions; run: Run; sel: Selection }) {
  const all = g.hidden ? [...g.items, ...g.hidden] : g.items;
  const updates = all.filter((i) => doneOf(i) === 'dismiss');
  const doable = all.filter((i) => doneOf(i));
  const items: MenuEntry[] = [
    updates.length > 0 && { label: t('Got it on all updates ({n})', { n: updates.length }), icon: 'check', onClick: () => actions.doneMany(updates) },
    doable.length > 0 && { label: t('Done for this video'), icon: 'check', shortcut: '⇧E', onClick: () => run.doneMany(doable) },
    { label: t('Later for this video'), icon: 'clock', onClick: () => run.later(all) },
    'sep',
    g.items.length > 1 && { label: t('Select its items'), icon: 'list', onClick: () => sel.set(g.items) },
    !!g.slug && {
      label: t('Open in player'),
      icon: 'external',
      onClick: () => {
        location.hash = `#/v/${enc(g.slug ?? '')}`;
      },
    },
  ];
  return (
    <div className="inbox-vhead">
      {g.slug ? (
        <a className="inbox-vhead-name ellipsis" href={`#/v/${enc(g.slug)}`} tabIndex={-1} title={t('Open in player')} data-testid="inbox-vhead-link">
          {g.name}
        </a>
      ) : (
        <span className="inbox-vhead-name ellipsis">{g.name}</span>
      )}
      {/* what it holds first, where it lives last: a short line drops the folder, not the counts */}
      <span className="inbox-vhead-sum ellipsis" data-testid="inbox-video-sum">
        {[tallyWords(all), g.folder?.split('/').join(' / ')].filter(Boolean).join(' · ')}
      </span>
      <Menu
        trigger={
          <IconButton
            className="btn ghost sm icon-only inbox-vhead-more"
            label={t('Actions for {video}', { video: g.name ?? '' })}
            icon="more"
            size={15}
            data-testid="inbox-video-menu"
          />
        }
        items={items}
      />
    </div>
  );
}

/** A row's height before one has been measured (a row with one line of text), and a video head's. */
const ROW_GUESS = 64;
const HEAD_GUESS = 40;
const itemKey = (i: ForYouItem) => i.key;
const groupKey = (g: InboxGroup) => g.key;

// A group of hundreds renders the rows near the view (lib/windowing.ts), the keyboard's row brought there when it
// moves; a shorter group renders whole, as the group's own children, exactly as before.
function GroupRows({ group, row, reveal }: { group: ForYouItem[]; row: (i: ForYouItem) => ReactNode; reveal: number | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const long = group.length > WINDOW_FROM;
  const w = useMeasuredWindow(ref, group, itemKey, { enabled: long, guess: ROW_GUESS, reveal });
  if (!long) return group.map(row);
  return (
    <div ref={ref} className="inbox-rows" style={{ paddingTop: w.before, paddingBottom: w.after }} data-windowed>
      {group.slice(w.first, w.last + 1).map(row)}
    </div>
  );
}

// By video the groups are short and many: past WINDOW_FROM rows the videos near the view are rendered, the one the
// keys are in brought there.
function VideoGroups({ groups, rows, group, active }: { groups: InboxGroup[]; rows: number; group: (g: InboxGroup) => ReactNode; active: ForYouItem | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const long = rows > WINDOW_FROM;
  const at = active ? groups.findIndex((g) => g.items.includes(active)) : -1;
  const guess = HEAD_GUESS + (ROW_GUESS * rows) / Math.max(1, groups.length);
  const w = useMeasuredWindow(ref, groups, groupKey, { enabled: long, guess, reveal: at < 0 ? null : at });
  if (!long) return groups.map(group);
  return (
    <div ref={ref} className="inbox-groups" style={{ paddingTop: w.before, paddingBottom: w.after }} data-windowed>
      {groups.slice(w.first, w.last + 1).map(group)}
    </div>
  );
}

const KEYS = perLang((): [string, string][] => [
  ['↑ ↓  J K', t('move through the list')],
  ['↵', t('open the preview (again: the full player)')],
  ['E', t('done: a question closes without an answer, an update is waved through')],
  ['⇧E', t('done for the whole video')],
  ['H', t('later: back tomorrow at 9:00, or once the video moves')],
  ['X', t('select (⇧-click: a run, ⌘-click: one more)')],
  ['⌘A', t('select everything in the list')],
  ['Esc', t('clear the selection')],
  [t('Space  ← →  O'), t('in the preview: play, a frame back or on, open in the player')],
]);

function KeysHelp({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={t('Inbox keys')} onClose={onClose} width={480}>
      <div className="inbox-help" data-testid="inbox-help">
        {KEYS().map(([k, d]) => (
          <div key={k} style={{ display: 'contents' }}>
            <Kbd>{k}</Kbd>
            <span>{d}</span>
          </div>
        ))}
      </div>
    </Modal>
  );
}
