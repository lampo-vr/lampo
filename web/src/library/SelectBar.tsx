// The bar over the library's ticked videos (./select.ts): how many, then what to do with all of them at once — Move to…
// (the ⋯ menu's folder picker, for every one), Archive (with one Undo for all) and Share as one link (one review link
// for exactly these videos: share/ShareModal.tsx) — and ✕. One float at the foot of
// what scrolls (sticky, in the flow: it keeps its room at the list's end, so the last row can always be scrolled clear
// of it). Each video is held to what its own ⋯ menu allows; what an action leaves (not allowed, refused, failed) stays
// ticked, and the bar says why. Its own chunk: it comes with the first box ticked.
import { useQueryClient } from '@tanstack/react-query';
import { useLayoutEffect, useRef, useState } from 'react';
import type { Action } from '../../../lib/permissions.ts';
import { SHARE_SET_MAX } from '../../../lib/shareSet.ts';
import { ApiError, api, enc } from '../api/client.ts';
import { guess, useSettle } from '../api/mutations.ts';
import { keys } from '../api/queries.ts';
import type { LibraryResponse, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { crumbs } from '../lib/nav.ts';
import { errorMessage, toastError, toastUndo } from '../lib/toast.ts';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Modal } from '../ui/primitives.tsx';
import { FolderPicker } from './FolderPicker.tsx';
import '../styles/library-select.css';

interface Props {
  /** The ticked videos, in the view's order. */
  videos: VideoSummary[];
  /** Where videos may go (no archived project). */
  folders: string[];
  /** Why the last action left some ticked. */
  why: string | null;
  /** What this person may do (the library's: a library module imported here would split its first chunk). */
  can: (action: Action) => boolean;
  onClear: () => void;
  onKeep: (slugs: string[], why: string | null) => void;
}

/** How many requests go at once: a big selection moves in a few seconds without a burst the server would turn away. */
const AT_ONCE = 4;

/** Runs `fn` for each, a few at a time; every outcome, in order. */
async function each<T>(list: T[], fn: (x: T) => Promise<unknown>, onDone?: (n: number) => void): Promise<(unknown | null)[]> {
  const errors: (unknown | null)[] = list.map(() => null);
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < list.length) {
      const i = next++;
      try {
        await fn(list[i] as T);
      } catch (e) {
        errors[i] = e ?? new Error('failed');
      }
      onDone?.(++done);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, list.length) }, worker));
  return errors;
}

const names = (list: VideoSummary[]) => {
  const shown = list.slice(0, 3).map((v) => `“${v.name}”`);
  return list.length > 3 ? t('{names} and {n} more', { names: shown.join(', '), n: list.length - 3 }) : shown.join(', ');
};

/** Why some didn't go: refused by the server (whose it is) or failed, by kind. */
function failures(list: VideoSummary[], errors: (unknown | null)[]): { left: VideoSummary[]; why: string[] } {
  const refused = list.filter((_, i) => errors[i] instanceof ApiError && (errors[i] as ApiError).status === 403);
  const failed = list.filter((_, i) => errors[i] && !refused.includes(list[i] as VideoSummary));
  const first = errors.find((e, i) => e && !refused.includes(list[i] as VideoSummary));
  return {
    left: [...refused, ...failed],
    why: [
      refused.length > 0 && t('{names}: not yours to change', { names: names(refused) }),
      failed.length > 0 && `${names(failed)}: ${errorMessage(first)}`,
    ].filter((x): x is string => !!x),
  };
}

export function SelectBar({ videos, folders, why, can, onClear, onKeep }: Props) {
  const qc = useQueryClient();
  const settle = useSettle();
  const [moving, setMoving] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const n = videos.length;

  // The bar keeps its own room at the end of what scrolls: when it comes while the list's end is in view, the page moves
  // on by that room at once, so it covers nothing that was in view.
  const bar = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = bar.current;
    const before = el?.previousElementSibling;
    const scroller = el?.closest('.lib-scroll');
    if (!el || !before || !scroller) return;
    const view = scroller.getBoundingClientRect().top + scroller.clientTop + scroller.clientHeight;
    if (before.getBoundingClientRect().bottom <= view + 1) scroller.scrollTop = scroller.scrollHeight;
    // Sticky stops short of the page's own room at its end (its padding): the bar reaches into it, so it floats at the
    // window's foot (library-select.css). The toasts at the foot stand above it, however tall it is: ui.css .toasts.
    const root = document.documentElement.style;
    const sized = new ResizeObserver(() => {
      el.style.setProperty('--lsel-under', getComputedStyle(scroller).paddingBottom);
      root.setProperty('--toast-lift', `${el.offsetHeight}px`);
    });
    sized.observe(el);
    sized.observe(scroller);
    return () => {
      sized.disconnect();
      root.removeProperty('--toast-lift');
    };
  }, []);

  // ---- Archive: what each video's ⋯ offers as Archive (a video with notes, not the sample, not archived already)
  const mayArchive = can('upload');
  const archive = async () => {
    const ok = videos.filter((v) => !v.sample && !v.archived && v.counts.total > 0);
    const notes = videos.filter((v) => !v.sample && !v.archived && !v.counts.total);
    const sample = videos.filter((v) => v.sample);
    const why: string[] = [
      notes.length > 0 &&
        t(
          '{names} has no notes to keep, so it isn’t archived: remove it from its ⋯ menu|{names} have no notes to keep, so they aren’t archived: remove them from their ⋯ menus',
          {
            n: notes.length,
            names: names(notes),
          },
        ),
      sample.length > 0 && t('The sample isn’t archived: remove it from its ⋯ menu'),
    ].filter((x): x is string => !!x);
    if (!ok.length) {
      onKeep(
        videos.map((v) => v.slug),
        why.join(' · ') || null,
      );
      return;
    }
    setArchiving(true);
    const undo = await guess<LibraryResponse>(qc, keys.library, (old) => ({
      ...old,
      videos: old.videos.map((v) => (ok.some((x) => x.slug === v.slug) ? { ...v, archived: true } : v)),
    }));
    const errors = await each(ok, (v) => api(`/api/library/${enc(v.slug)}`, { method: 'DELETE' }));
    setArchiving(false);
    const f = failures(ok, errors);
    const done = ok.filter((_, i) => !errors[i]);
    if (!done.length) undo();
    settle.library();
    if (done.length)
      toastUndo(t('Archived {n} video|Archived {n} videos', { n: done.length }), async () => {
        await guess<LibraryResponse>(qc, keys.library, (old) => ({
          ...old,
          videos: old.videos.map((v) => (done.some((x) => x.slug === v.slug) ? { ...v, archived: null } : v)),
        }));
        const back = await each(done, (v) => api(`/api/library/${enc(v.slug)}/restore`, { method: 'POST' }));
        settle.library();
        const lost = back.find((e) => e);
        if (lost) toastError(lost);
      });
    else if (errors[0]) toastError(errors[0]);
    const left = [...videos.filter((v) => !ok.includes(v)), ...f.left];
    onKeep(
      left.map((v) => v.slug),
      [...why, ...f.why].join(' · ') || null,
    );
  };

  // ---- Move to…: what each video's ⋯ offers (out of an archived project only for its owners and admins)
  const mayMove = can('organize');
  const movable = videos.filter((v) => !v.project_archived || can('archive'));
  const shutIn = videos.filter((v) => !movable.includes(v));
  const moved = (left: VideoSummary[], reasons: string[]) => {
    setMoving(false);
    const stuck = [...shutIn, ...left];
    const why = [
      shutIn.length > 0 &&
        t(
          '{names} is in an archived project: only its owners and admins move it out|{names} are in archived projects: only their owners and admins move them out',
          {
            n: shutIn.length,
            names: names(shutIn),
          },
        ),
      ...reasons,
    ].filter((x): x is string => !!x);
    if (stuck.length)
      onKeep(
        stuck.map((v) => v.slug),
        why.join(' · ') || null,
      );
    else onClear();
  };

  // ---- Share as one link: what each video's ⋯ offers as Share… (not archived, not in an archived project), one review
  // link for all of them; a single one is its own video's link
  const mayShare = can('share');
  const [sharing, setSharing] = useState<VideoSummary[] | null>(null);
  const share = () => {
    const ok = videos.filter((v) => !v.archived && !v.project_archived);
    const out = videos.filter((v) => !ok.includes(v));
    const why = [
      out.length > 0 &&
        t('{names} isn’t shared: archived, or in an archived project|{names} aren’t shared: archived, or in archived projects', {
          n: out.length,
          names: names(out),
        }),
      ok.length > SHARE_SET_MAX && t('A link covers at most {max} videos: share a folder for more.', { max: SHARE_SET_MAX }),
    ].filter((x): x is string => !!x);
    if (why.length)
      onKeep(
        videos.map((v) => v.slug),
        why.join(' · '),
      );
    if (ok.length && ok.length <= SHARE_SET_MAX) setSharing(ok);
  };

  const picking = n > 0;
  return (
    <>
      <div ref={bar} className={`lsel ${why ? 'has-why' : ''}`} role="toolbar" aria-label={t('Selected videos')} data-testid="library-selbar">
        {why && (
          <p className="lsel-why" data-testid="library-selbar-why">
            <I name="info" size={14} />
            <span>{why}</span>
          </p>
        )}
        <div className="lsel-row">
          <span className="lsel-n" role="status">
            {picking ? t('{n} selected', { n }) : t('Tap the videos to select them')}
          </span>
          {picking && mayMove && (
            <button
              type="button"
              className="btn ghost sm"
              aria-label={t('Move to…')}
              onClick={() => (movable.length ? setMoving(true) : moved([], []))}
              data-testid="library-sel-move"
            >
              <I name="moveTo" size={14} /> <span className="lsel-l">{t('Move to…')}</span>
            </button>
          )}
          {picking && mayArchive && (
            <button
              type="button"
              className="btn ghost sm"
              aria-label={t('Archive')}
              aria-busy={archiving || undefined}
              disabled={archiving}
              onClick={() => void archive()}
              data-testid="library-sel-archive"
            >
              {archiving ? <Spinner /> : <I name="archive" size={14} />} <span className="lsel-l">{t('Archive')}</span>
            </button>
          )}
          {picking && mayShare && (
            <button type="button" className="btn ghost sm" aria-label={t('Share as one link')} onClick={share} data-testid="library-sel-share">
              <I name="link" size={14} /> <span className="lsel-l">{t('Share as one link')}</span>
            </button>
          )}
          <IconButton
            className="btn ghost sm icon-only lsel-x"
            label={t('Clear the selection')}
            shortcut="Esc"
            icon="x"
            size={14}
            onClick={onClear}
            data-testid="library-sel-clear"
          />
        </div>
      </div>
      {moving && <MoveMany videos={movable} folders={folders} onClose={() => setMoving(false)} onDone={moved} />}
      {sharing &&
        (sharing.length === 1 ? (
          <LazyShareModal slug={sharing[0]?.slug} name={sharing[0]?.name} onClose={() => setSharing(null)} />
        ) : (
          <LazyShareModal videos={sharing.map((v) => ({ slug: v.slug, name: v.name }))} onClose={() => setSharing(null)} />
        ))}
    </>
  );
}

/** Move to… for many: the folder picker the ⋯ menu's Move to… uses; the videos go a few at a time, the button says how far. */
function MoveMany({
  videos,
  folders,
  onClose,
  onDone,
}: {
  videos: VideoSummary[];
  folders: string[];
  onClose: () => void;
  /** What didn't move, and why. */
  onDone: (left: VideoSummary[], why: string[]) => void;
}) {
  const qc = useQueryClient();
  const settle = useSettle();
  const from = (v: VideoSummary) => v.folder || null;
  // where they all are, when that is one place ('' when they are in several: nothing chosen yet)
  const here = videos.every((v) => from(v) === from(videos[0] as VideoSummary)) ? from(videos[0] as VideoSummary) : '';
  const [sel, setSel] = useState<string | null>(here);
  const [done, setDone] = useState<number | null>(null);
  const going = videos.filter((v) => from(v) !== sel);
  const to = (folder: string | null) => (folder ? crumbs(folder) : t('No project'));
  const put = async (list: VideoSummary[], where: (v: VideoSummary) => string | null, onStep?: (n: number) => void) => {
    await guess<LibraryResponse>(qc, keys.library, (old) => ({
      ...old,
      folders: [...new Set([...old.folders, ...list.map(where).filter((f): f is string => !!f)])].sort(),
      videos: old.videos.map((v) => {
        const m = list.find((x) => x.slug === v.slug);
        if (!m) return v;
        const { project_archived: _was, ...out } = v;
        return { ...out, folder: where(m) };
      }),
    }));
    const errors = await each(list, (v) => api(`/api/review/${enc(v.slug)}/folder`, { method: 'PUT', body: { folder: where(v) } }), onStep);
    settle.library();
    return errors;
  };
  const submit = async () => {
    if (done !== null || sel === '') return;
    const target = sel;
    setDone(0);
    const errors = await put(going, () => target, setDone);
    const ok = going.filter((_, i) => !errors[i]);
    const f = failures(going, errors);
    if (ok.length)
      toastUndo(t('Moved {n} video to {folder}|Moved {n} videos to {folder}', { n: ok.length, folder: to(target) }), async () => {
        const back = await put(ok, from);
        const lost = back.find((e) => e);
        if (lost) toastError(lost);
      });
    else if (errors[0]) toastError(errors[0]);
    onClose();
    onDone(f.left, f.why);
  };
  const busy = done !== null;
  return (
    <Modal
      title={t('Move {n} video|Move {n} videos', { n: videos.length })}
      onClose={busy ? () => {} : onClose}
      width={520}
      foot={
        <>
          <span className="grow" />
          <button type="button" className="btn" onClick={onClose} disabled={busy}>
            {t('Cancel')}
          </button>
          <button
            type="button"
            className="btn primary"
            onClick={() => void submit()}
            disabled={busy || sel === '' || !going.length}
            aria-busy={busy || undefined}
            data-testid="library-move-many"
          >
            {busy ? (
              <>
                <Spinner /> {t('Moving {done} of {n}…', { done: done ?? 0, n: going.length })}
              </>
            ) : (
              t('Move here')
            )}
          </button>
        </>
      }
    >
      <FolderPicker folders={folders} value={sel} onChange={setSel} autoFocus />
    </Modal>
  );
}
