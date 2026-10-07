// What waits for you, shared by the full "For you" page and the inbox popover: the groups, the words for each item,
// and the actions (answer, verify, still wrong, got it, nudge an agent) with the optimistic removal from the list.
import { useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useState } from 'react';
import { useCan } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { playbookHref } from '../api/playbooks.ts';
import { keys, useInfo, useLibrary } from '../api/queries.ts';
import type { ForYouItem, ForYouKind, ForYouResponse } from '../api/types.ts';
import { locale, perLang, t } from '../i18n/index.ts';
import { hoursWords } from '../lib/format.ts';
import { later as afterUndo, toast, toastError, toastUndo } from '../lib/toast.ts';
import { OptionsAsk } from '../options/OptionsAsk.tsx';
import { sectionWords } from '../playbook/PlaybookShell.tsx';
import { PLATFORM_LABEL } from '../publish/words.ts';
import { useWakeChoice, WakeAsk } from '../sessions/Wake.tsx';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import { Choices } from '../ui/Choices.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { aside, doneOf, laterUntil, tallyOf } from './group.ts';
import { hide, unhide } from './hidden.ts';

export const GROUPS = perLang((): { kind: ForYouKind; title: string }[] => [
  { kind: 'question', title: t('Questions from agents') },
  { kind: 'verify', title: t('Fixes to check') },
  { kind: 'review', title: t('To review') },
  { kind: 'post', title: t('Posts that failed') },
  { kind: 'client', title: t('From review links') },
  { kind: 'playbook', title: t('Playbook suggestions') },
  { kind: 'approval', title: t('Approvals') },
  { kind: 'answer', title: t('Replies to your notes') },
  { kind: 'version', title: t('New versions') },
  // last and quieter: videos that stalled, waiting on others (or on nobody) for too long — not in the bell's number
  { kind: 'stalled', title: t('Stalled') },
]);

/** Items in the order the groups show them, so keyboard navigation walks the list as it reads. */
export const ordered = (items: ForYouItem[]): ForYouItem[] => GROUPS().flatMap((g) => items.filter((i) => i.kind === g.kind));

export { OPEN_PLAYER } from './nav.tsx';

export const who = (by: string | null | undefined) => (by ? by.replace(/^agent:/, '') : '');

/** Kinds that are a conversation — a question, an answer to your note, a client's note: the preview puts what was said
 * first and where you answer right under it, the picture beside it (Preview.tsx). */
export const isTalk = (i: Pick<ForYouItem, 'kind'>): boolean => i.kind === 'question' || i.kind === 'answer' || i.kind === 'client';

export const when = (iso: string) => {
  const m = Math.round((Date.now() - Date.parse(iso)) / 60000);
  return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.round(m / 60)} h` : `${Math.round(m / 1440)} d`;
};
/**
 * The full player for an item: verify mode at a fix, its note open for the rest. `at`: the version and frame a preview
 * shows, so the player opens on that very frame. Verify mode always shows the newest render, so a fix only takes a
 * frame from a preview of the newest render (another version's frame numbers would land elsewhere).
 */
export function openHref(i: ForYouItem, at?: { v: number; f: number; newest: boolean }): string {
  // a suggestion for a playbook opens that playbook on its suggestions
  if (i.kind === 'playbook') return `${playbookHref(i.scope ?? '')}?tab=suggestions${i.proposal ? `&id=${enc(i.proposal)}` : ''}`;
  // a failed post opens its composer on the player
  if (i.kind === 'post') return `#/v/${enc(i.slug)}?publish=${enc(i.post?.id ?? '1')}`;
  const q = new URLSearchParams();
  if (i.kind === 'verify' && i.id) q.set('verify', i.id);
  else if (i.id && i.kind !== 'version' && i.kind !== 'review') q.set('c', i.id);
  if (at && (i.kind !== 'verify' || at.newest)) {
    q.set('v', String(at.v));
    q.set('f', String(at.f));
  }
  const s = q.toString();
  return `#/v/${enc(i.slug)}${s ? `?${s}` : ''}`;
}

/** Whom a stalled video waits on. */
const waitingOn = (i: ForYouItem): string =>
  i.waitingOn === 'agents'
    ? i.agent
      ? t('Waiting on {name}', { name: who(i.agent) })
      : t('Waiting on an agent')
    : i.waitingOn === 'client'
      ? t('Out for review')
      : t('Waiting on you');

/**
 * What happened, in a few words — a row's second line and the preview's first: "promo-edit asks", "New video", "New
 * version V3". `at`: the moment it is about (a note's timecode; none for a render or a note about the whole video).
 */
export function whatLine(i: ForYouItem): { text: string; at?: string } {
  const at = i.whole ? undefined : i.timecode;
  switch (i.kind) {
    case 'question':
      return { text: t('{name} asks', { name: who(i.by) }), at };
    case 'verify':
      return { text: who(i.by) ? t('{name} fixed it in V{v}', { name: who(i.by), v: i.v ?? '' }) : t('Fixed in V{v}', { v: i.v ?? '' }), at };
    case 'client':
      return { text: t('{name} · via review link', { name: i.by ?? '' }), at };
    case 'approval':
      return { text: t('{name} approved V{v} · via review link', { name: i.by ?? '', v: i.v ?? '' }) };
    case 'answer':
      return { text: t('{name} replied to your note', { name: who(i.by) }), at };
    case 'review':
      return { text: (i.v ?? 1) <= 1 ? t('New video') : i.part ? t('New version V{v} · part', { v: i.v ?? '' }) : t('New version V{v}', { v: i.v ?? '' }) };
    case 'version':
      return { text: i.part ? t('New version V{v} · part', { v: i.v ?? '' }) : t('New version V{v}', { v: i.v ?? '' }) };
    case 'playbook':
      return { text: t('{name} suggests a change to {what}', { name: who(i.by), what: sectionWords(i.section || '') }) };
    case 'stalled':
      return { text: waitingOn(i) };
    case 'post':
      return {
        text:
          i.post?.state === 'sent'
            ? t('The {platform} post of V{v} was sent, not confirmed', { platform: PLATFORM_LABEL[i.post?.platform ?? 'youtube'], v: i.v ?? '' })
            : t('The {platform} post of V{v} failed', { platform: PLATFORM_LABEL[i.post?.platform ?? 'youtube'], v: i.v ?? '' }),
      };
    default:
      return { text: '' };
  }
}

/** That line as shown: the words, then the moment in the timecode's own face. */
export function What({ item }: { item: ForYouItem }) {
  const w = whatLine(item);
  return (
    <>
      {w.text}
      {w.at && (
        <>
          {' · '}
          <span className="mono">{w.at}</span>
        </>
      )}
    </>
  );
}

/**
 * That line where it has one line to itself (a row, a card's head): its words give way with an ellipsis, the moment at
 * its end never does — the timecode is the part someone looks for ("… fixed it in V11 · 00:01:16", a German "korrigiert"
 * cut it to "· 00:…"). `before`: what comes first on the line, in its own look (the video's name, by kind).
 */
export function WhatLine({ item, before, className = '' }: { item: ForYouItem; before?: ReactNode; className?: string }) {
  const w = whatLine(item);
  return (
    <span className={`what-line ${className}`}>
      <span className="ellipsis">
        {before}
        <span className="what-text">{w.text}</span>
      </span>
      {w.at && (
        <span className="what-at">
          {' · '}
          <span className="mono">{w.at}</span>
        </span>
      )}
    </span>
  );
}

/**
 * "Changed" before what the agent said it did — unless its words start with it already ("Changed  Changed it in the
 * project"): its tinted box says it is the fix either way.
 */
export function ChangedLabel({ note, className }: { note: string; className: string }) {
  const word = t('Changed');
  // in the page's language or in the agent's (agents write English whatever the page says)
  const said = note.trim().toLowerCase();
  if (said.startsWith(word.toLowerCase()) || said.startsWith('changed')) return null;
  return (
    <>
      <span className={className}>{word}</span>{' '}
    </>
  );
}

/** Why a stalled video is listed, in a few words. */
export const stalledWhy = (i: ForYouItem): string =>
  i.reason === 'reopened'
    ? t('{n} fixes came back', { n: i.count ?? 0 })
    : i.reason === 'rounds'
      ? t('V{n} and not approved yet', { n: i.count ?? 0 })
      : t('Quiet for {d}', { d: hoursWords(i.waitingHours) });

/** The line under what happened: what was said, or why a stalled video is listed. A render to review has none: the
 * line above says it, the preview shows what it brings. */
export const itemText = (i: ForYouItem): string | undefined => (i.kind === 'stalled' ? stalledWhy(i) : i.kind === 'review' ? undefined : i.text);

/** What the agent reads when you nudge it (agent-facing text stays English, like everything agents parse). */
export const nudgeText = (i: ForYouItem) =>
  `A nudge from the inbox: ${i.video} ${
    i.reason === 'reopened'
      ? `has ${i.count} fixes that came back and are still open`
      : i.reason === 'rounds'
        ? `is at V${i.count} and not approved yet`
        : `has been quiet for ${Math.round(i.waitingHours ?? 0)} h`
  }. Please pick up its open notes.`;

/** What a video's group holds, in words: "3 questions · 2 fixes · V4 to review". */
export const tallyWords = (items: ForYouItem[]): string => tallyParts(items).join(' · ');

/** The same as parts, each a fact that wraps as one ("3 questions" never breaks between the number and the word). */
export function tallyParts(items: ForYouItem[]): string[] {
  return tallyOf(items)
    .map(({ kind, n, v }) => {
      switch (kind) {
        case 'question':
          return t('{n} question|{n} questions', { n });
        case 'verify':
          return t('{n} fix|{n} fixes', { n });
        case 'review':
          return v ? t('V{v} to review', { v }) : t('to review');
        case 'client':
          return t('{n} note via link|{n} notes via link', { n });
        case 'playbook':
          return t('{n} suggestion|{n} suggestions', { n });
        case 'approval':
          return t('approved');
        case 'answer':
          return t('{n} reply|{n} replies', { n });
        case 'version':
          return v ? t('V{v} is in', { v }) : t('a new version');
        case 'stalled':
          return t('stalled');
        case 'post':
          return t('{n} post failed|{n} posts failed', { n });
        default:
          return '';
      }
    })
    .filter(Boolean);
}

/** When something put aside comes back, in a few words: "tomorrow at 09:00", "Thursday at 09:00". */
export function whenWords(iso: string, now = new Date()): string {
  const d = new Date(iso);
  const time = d.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
  const day = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((day(d) - day(now)) / 86_400_000);
  if (days <= 0) return t('today at {time}', { time });
  if (days === 1) return t('tomorrow at {time}', { time });
  return t('{day} at {time}', { day: d.toLocaleDateString(locale(), days < 7 ? { weekday: 'long' } : { day: 'numeric', month: 'short' }), time });
}

/** The actions on items, each taking the item off the list at once (the server's answer and the stream settle it). */
export function useInboxActions() {
  const qc = useQueryClient();
  const can = useCan();
  const drop = (key: string) =>
    qc.setQueryData<ForYouResponse>(keys.forYou, (d) => {
      if (!d) return d;
      const gone = d.items.find((i) => i.key === key);
      if (!gone) return d;
      return {
        ...d,
        items: d.items.filter((i) => i.key !== key),
        // stalled videos aren't in the bell's number
        counts: { ...d.counts, [gone.kind]: d.counts[gone.kind] - 1, total: d.counts.total - (gone.kind === 'stalled' ? 0 : 1) },
      };
    });
  const act = async (item: ForYouItem, fn: () => Promise<unknown>, done: string): Promise<boolean> => {
    drop(item.key);
    let ok = true;
    try {
      await fn();
      toast(done, 'ok');
    } catch (e) {
      ok = false;
      toastError(e);
    }
    qc.invalidateQueries({ queryKey: keys.forYou });
    qc.invalidateQueries({ queryKey: keys.review(item.slug) });
    return ok;
  };
  const patch = (i: ForYouItem, body: object) => api(`/api/comments/${i.id}`, { method: 'PATCH', body });
  const dismiss = (i: ForYouItem) => api('/api/for-you/dismiss', { method: 'POST', body: { keys: [i.key] } });
  const settle = async (list: ForYouItem[]) => {
    await qc.invalidateQueries({ queryKey: keys.forYou });
    for (const slug of new Set(list.map((i) => i.slug).filter(Boolean))) qc.invalidateQueries({ queryKey: keys.review(slug) });
  };
  /** Off the list at once; the change reaches the server once its Undo toast is gone (lib/toast.ts `later`). */
  const deferred = (list: ForYouItem[], message: string, commit: () => Promise<unknown>) => {
    const gone = list.map((i) => i.key);
    afterUndo({
      message,
      apply: () => hide(gone),
      revert: () => unhide(gone),
      commit: async () => {
        try {
          await commit();
          await settle(list);
        } finally {
          unhide(gone);
        }
      },
    });
  };
  /** "Done" on what it applies to: questions close without an answer, what informs is waved through. */
  const doneAll = async (list: ForYouItem[]) => {
    const close = list.filter((i) => doneOf(i) === 'close');
    const wave = list.filter((i) => doneOf(i) === 'dismiss');
    // a question asked on a folder before any render closes through its own route (it is no note of a video)
    for (const i of close) await (i.slug ? patch(i, { status: 'verified' }) : api(`/api/asks/${enc(i.id ?? '')}/close`, { method: 'POST', body: {} }));
    if (wave.length) await api('/api/for-you/dismiss', { method: 'POST', body: { keys: wave.map((i) => i.key) } });
  };
  const snooze = async (list: ForYouItem[]) => {
    const gone = list.map((i) => i.key);
    const until = laterUntil();
    const before = qc.getQueryData<ForYouResponse>(keys.forYou);
    // Aside at once: off the list and into "n later" before the server answers (hidden too, so a refetch that
    // started earlier can't bring it back for a moment).
    qc.setQueryData<ForYouResponse>(keys.forYou, (d) => d && aside(d, gone, until));
    hide(gone);
    try {
      await api('/api/for-you/snooze', { method: 'POST', body: { keys: gone, until } });
      await settle(list);
      const when = whenWords(until);
      toastUndo(
        list.length === 1
          ? t('For later: back {when}, or once its video moves', { when })
          : t('{n} for later: back {when}, or once their video moves', { n: list.length, when }),
        () => bringBack(list),
      );
    } catch (e) {
      if (before) qc.setQueryData(keys.forYou, before);
      toastError(e);
    } finally {
      unhide(gone);
    }
  };
  const bringBack = async (list: ForYouItem[]) => {
    await api('/api/for-you/unsnooze', { method: 'POST', body: { keys: list.map((i) => i.key) } });
    await settle(list);
  };
  return {
    /** "Done" for one item (a question closes without an answer, what informs is waved through), with Undo. */
    done: (i: ForYouItem) => {
      const how = doneOf(i);
      if (!how) return;
      deferred([i], how === 'close' ? t('Closed without an answer') : t('Off your list'), () => doneAll([i]));
    },
    /** "Done" for several at once (what it doesn't apply to stays), with Undo. */
    doneMany: (list: ForYouItem[]) => {
      const ok = list.filter((i) => doneOf(i));
      if (!ok.length) return;
      deferred(ok, t('{n} done|{n} done', { n: ok.length }), () => doneAll(ok));
    },
    /** "Looks right" for one fix from the list, with Undo. */
    verifyUndo: (i: ForYouItem) =>
      deferred([i], who(i.by) ? t('Looks right — {name} hears about it', { name: who(i.by) }) : t('Looks right'), () => patch(i, { status: 'verified' })),
    /** "Looks right" for several fixes at once, with Undo. */
    verifyMany: (list: ForYouItem[]) => {
      const fixes = list.filter((i) => i.kind === 'verify');
      if (!fixes.length) return;
      deferred(fixes, t('{n} fix looks right|{n} fixes look right', { n: fixes.length }), async () => {
        for (const i of fixes) await patch(i, { status: 'verified' });
      });
    },
    /** "Later": off the list until tomorrow 9:00 in this browser's day, or until its video moves. */
    later: (list: ForYouItem[]) => snooze(list),
    /** Back from "later" now. */
    bringBack: (list: ForYouItem[]) => bringBack(list).catch(toastError),
    /** Any action on an item: it leaves the list at once; resolves false when the server said no. */
    act,
    gotIt: (i: ForYouItem) => act(i, () => dismiss(i), t('Off your list')),
    /** Seen without an action (inbox/seen.ts): an update that only informs leaves the list quietly — no toast, the note's
     * thread keeps what it said. */
    seen: (i: ForYouItem) => {
      hide([i.key]);
      dismiss(i)
        .then(() => settle([i]))
        .catch(() => {})
        .finally(() => unhide([i.key]));
    },
    /** "Got it" with Undo (the list's own buttons and keys). */
    gotItUndo: (i: ForYouItem) => deferred([i], t('Off your list'), () => dismiss(i)),
    /** Whether this person may send a failed post again (publishing is owners' and admins'). */
    canRetry: can('publish'),
    /** A failed post is sent again, one the platform holds is asked about (it leaves the list once it is on its way). */
    retryPost: (i: ForYouItem) => act(i, () => api(`/api/posts/${enc(i.post?.id ?? '')}/retry`, { method: 'POST' }), postRetry(i)?.done ?? ''),
    /** A stalled video's agent gets a request to pick it up (it reads it in its inbox); the video leaves the list until
     * it moves and stalls again. */
    nudge: (i: ForYouItem, start = false) =>
      act(
        i,
        async () => {
          await api(`/api/review/${enc(i.slug)}/request`, { method: 'POST', body: { text: nudgeText(i), nudge: true, ...(start ? { start: true } : {}) } });
          await dismiss(i);
        },
        start ? t('Nudged and started {name}', { name: who(i.agent) }) : t('Nudged {name}', { name: who(i.agent) }),
      ),
    verify: (i: ForYouItem) => act(i, () => patch(i, { status: 'verified' }), t('Looks right — {name} hears about it', { name: who(i.by) })),
    answer: (i: ForYouItem, text: string) => act(i, () => patch(i, { status: 'verified', note: text }), t('Answered — {name} gets it', { name: who(i.by) })),
    stillWrong: (i: ForYouItem, text: string) =>
      act(
        i,
        () => patch(i, { status: 'open', note: text || t('Still wrong') }),
        who(i.by) ? t('Still wrong — {name} takes another look', { name: who(i.by) }) : t('Still wrong — back to the agent'),
      ),
  };
}

export type InboxActions = ReturnType<typeof useInboxActions>;

/**
 * What a stalled video offers: its agent a nudge, the client's review link (the card says who watched how far, and has
 * the link to send again), else the player; and "Got it". `done`: the item left the list (the list moves on).
 */
export function StalledActions({ item: i, actions, done }: { item: ForYouItem; actions: InboxActions; done?: (p: Promise<boolean>) => void }) {
  const can = useCan();
  const [link, setLink] = useState(false);
  // "Send and start" or "Only send", when the agent isn't running and the person asked to be asked.
  const [asking, setAsking] = useState(false);
  const run = (p: Promise<boolean>) => (done ? done(p) : void p);
  // The video's agent as the library knows it: can this machine start it for the nudge?
  const video = useLibrary(i.waitingOn === 'agents').data?.videos.find((v) => v.slug === i.slug);
  const home = useInfo()?.home;
  const wake = useWakeChoice(video?.session ?? null, video?.sessionActive ?? null, home);
  const nudge = () => {
    if (!wake.possible || wake.pref === 'send') return run(actions.nudge(i));
    if (wake.pref === 'start') return run(actions.nudge(i, true));
    setAsking(true);
  };
  if (asking && video?.session)
    return (
      <WakeAsk name={video.session.name} folder={wake.folder} busy={false} onStart={() => run(actions.nudge(i, true))} onSend={() => run(actions.nudge(i))} />
    );
  const main =
    i.waitingOn === 'agents' && i.agent && can('agents') ? (
      <button type="button" className="btn primary sm" onClick={nudge} data-testid="inbox-nudge">
        <I name="send" size={14} /> {t('Nudge agent')}
      </button>
    ) : i.waitingOn === 'client' && can('share') ? (
      <button type="button" className="btn primary sm" onClick={() => setLink(true)} data-testid="inbox-link">
        <I name="link" size={14} /> {t('Review link')}
      </button>
    ) : (
      <a className="btn primary sm" href={openHref(i)}>
        {t('Open')}
      </a>
    );
  return (
    <>
      <button type="button" className="btn ghost sm" onClick={() => run(actions.gotIt(i))}>
        {t('Got it')}
      </button>
      {main}
      {link && <LazyShareModal slug={i.slug} name={i.video} onClose={() => setLink(false)} />}
    </>
  );
}

/**
 * What Retry does with a post in the inbox (A12 PUB-1): one that never reached the platform is sent again; one the
 * platform holds is only asked about ("Check again"); one sent without an answer has none here — the composer asks
 * before it posts it again, after the person looked on the platform.
 */
export function postRetry(i: ForYouItem): { label: string; done: string } | null {
  const name = PLATFORM_LABEL[i.post?.platform ?? 'youtube'];
  if (i.post?.remote) return { label: t('Check again'), done: t('Asking {platform} where it stands', { platform: name }) };
  if (i.post?.state === 'sent') return null;
  return { label: t('Try again'), done: t('Sending the {platform} post again', { platform: name }) };
}

/** "Try again" (or "Check again") on a post: for whoever may publish (the others open it and see why). */
export function PostRetry({ item: i, actions, done }: { item: ForYouItem; actions: InboxActions; done?: (p: Promise<boolean>) => void }) {
  const how = postRetry(i);
  if (!actions.canRetry || !how) return null;
  return (
    <button
      type="button"
      className="btn primary sm"
      onClick={() => (done ? done(actions.retryPost(i)) : void actions.retryPost(i))}
      data-testid="inbox-post-retry"
    >
      <I name="refresh" size={14} /> {how.label}
    </button>
  );
}

/** The thumbnail: the marked frame of a note, else the poster of its render (a note about the whole video, or one
 * without a screenshot yet). */
export function Thumb({ item: i }: { item: ForYouItem }) {
  if (i.kind === 'playbook') return <I name="playbook" size={22} />;
  const src = i.marked || i.poster || (i.slug ? `/api/poster/${enc(i.slug)}.jpg${i.v ? `?v=${i.v}` : ''}` : null);
  return src ? <img src={src} alt="" loading="lazy" /> : <I name="film" size={22} />;
}

/** When, quietly: "now", "12 min", "4 h", "3 d". */
export const When = ({ at }: { at: string }) => (
  <time className="inbox-when" dateTime={at} title={new Date(at).toLocaleString()}>
    {when(at)}
  </time>
);

/** "Later" on a card: back tomorrow at 9:00, or once the video moves. */
const LaterButton = ({ item: i, actions }: { item: ForYouItem; actions: InboxActions }) => (
  <IconButton
    className="btn ghost sm icon-only"
    label={t('Later: {video}', { video: i.video })}
    tip={t('Later: back {when}, or once its video moves', { when: whenWords(laterUntil()) })}
    icon="clock"
    size={14}
    onClick={() => actions.later([i])}
    data-testid="fy-later"
  />
);

/** A full card with its actions right on it (the "For you" page). `inVideo`: under its video's head, so the card
 * starts with what happened instead of the video's name. */
export function ItemCard({ item: i, actions, inVideo = false }: { item: ForYouItem; actions: InboxActions; inVideo?: boolean }) {
  const [text, setText] = useState('');
  const href = openHref(i);
  return (
    <article className={`fy-item k-${i.kind}`} data-testid={`fy-${i.kind}`}>
      <a
        className="fy-thumb"
        href={href}
        aria-label={i.timecode ? t('Open {video} at {timecode}', { video: i.video, timecode: i.timecode }) : t('Open {video}', { video: i.video })}
      >
        <Thumb item={i} />
      </a>
      <div className="fy-body">
        <div className="fy-meta">
          {inVideo ? <WhatLine item={i} className="fy-video" /> : <span className="fy-video">{i.video}</span>}
          <When at={i.at} />
        </div>
        {!inVideo && (
          <div className="fy-who">
            <What item={i} />
          </div>
        )}
        {i.kind === 'answer' && i.question && <p className="fy-quote">{t('on “{question}”', { question: i.question })}</p>}
        {itemText(i) && <p className="fy-text">{itemText(i)}</p>}
        {i.kind === 'verify' && i.note && (
          <p className="fy-note">
            <ChangedLabel note={i.note} className="fy-changed" />
            {i.note}
          </p>
        )}
        {i.kind === 'question' && i.options?.length ? (
          // Options to audition: their own view; the picks are the answer.
          <div className="fy-answer">
            <OptionsAsk id={i.id as string} text={i.text ?? ''} by={i.by ?? ''} groups={i.options} />
            <div className="fy-actions">
              <LaterButton item={i} actions={actions} />
              <button type="button" className="btn ghost sm" onClick={() => actions.done(i)} data-testid="fy-done">
                {t('Done')}
              </button>
            </div>
          </div>
        ) : i.kind === 'question' ? (
          <form
            className="fy-answer"
            onSubmit={(e) => {
              e.preventDefault();
              if (text.trim()) actions.answer(i, text.trim());
            }}
          >
            {i.choices?.length ? <Choices choices={i.choices} name={who(i.by)} onPick={(c) => actions.answer(i, c)} /> : null}
            <textarea
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('Your answer…')}
              rows={2}
              aria-label={t('Answer {who}', { who: who(i.by) })}
            />
            <div className="fy-actions">
              <LaterButton item={i} actions={actions} />
              <button type="button" className="btn ghost sm" onClick={() => actions.done(i)} data-testid="fy-done">
                {t('Done')}
              </button>
              <a className="btn ghost sm" href={href}>
                {t('Open')}
              </a>
              <button type="submit" className="btn primary sm" disabled={!text.trim()}>
                <I name="reply" size={14} /> {t('Answer')}
              </button>
            </div>
          </form>
        ) : i.kind === 'playbook' ? (
          <div className="fy-actions">
            <LaterButton item={i} actions={actions} />
            <a className="btn primary sm" href={href} data-testid="fy-playbook-review">
              <I name="playbook" size={14} /> {t('Review the suggestion')}
            </a>
          </div>
        ) : i.kind === 'stalled' ? (
          <div className="fy-actions">
            <LaterButton item={i} actions={actions} />
            <StalledActions item={i} actions={actions} />
          </div>
        ) : i.kind === 'post' ? (
          <div className="fy-actions">
            <LaterButton item={i} actions={actions} />
            <a className="btn ghost sm" href={href}>
              {t('Open')}
            </a>
            <PostRetry item={i} actions={actions} />
          </div>
        ) : (
          <div className="fy-actions">
            <LaterButton item={i} actions={actions} />
            {i.kind === 'verify' ? (
              <>
                <button type="button" className="btn ghost sm" onClick={() => actions.verify(i)} data-testid="fy-right">
                  <I name="check" size={14} /> {t('Looks right')}
                </button>
                <a className="btn primary sm" href={href}>
                  <I name="eye" size={14} /> {t('Check')}
                </a>
              </>
            ) : i.kind === 'review' ? (
              // a render to review leaves the list with a verdict, given where the render can be watched
              <a className="btn primary sm" href={href} data-testid="fy-review-open">
                <I name="eye" size={14} /> {t('Review')}
              </a>
            ) : (
              <>
                <button type="button" className="btn ghost sm" onClick={() => actions.gotIt(i)}>
                  {t('Got it')}
                </button>
                <a className="btn sm" href={href}>
                  {i.kind === 'version' ? t('Watch') : t('Open')}
                </a>
              </>
            )}
          </div>
        )}
      </div>
    </article>
  );
}
