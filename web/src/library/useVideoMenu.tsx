// What you can do with a video wherever the library shows it (grid and compact cards, list rows, board cards): one
// list of actions for its ⋯ menu and its right-click menu, and the dialogs they open. What a card may do and the
// actions themselves come from the library once for all its cards (CardKit): a card used to subscribe to the signed-in
// account twice and to five mutations of its own, which made switching the layout of a long library slow.
// "Move to" lists the lanes the video may move to (library/moves.ts): the menu's way to do what a drag on the board does.
import { useQueryClient } from '@tanstack/react-query';
import { createContext, type ReactNode, type RefObject, use, useMemo, useState } from 'react';
import type { Action } from '../../../lib/permissions.ts';
import { api, enc } from '../api/client.ts';
import { useVideoActions } from '../api/mutations.ts';
import type { SessionPick, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { go } from '../lib/nav.ts';
import { copyText, toast, toastError, toastUndo } from '../lib/toast.ts';
import { getStartedCode } from '../onboarding/state.ts';
import { SessionPicker } from '../sessions/Sessions.tsx';
import { LazyShareModal } from '../share/LazyShareModal.tsx';
import { laneLabel } from '../status/stageText.ts';
import { LANE_SHAPE } from '../ui/glyphs.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Confirm, type MenuEntry, Modal } from '../ui/primitives.tsx';
import { downloadVersion } from './downloadVersion.ts';
import type { LaneId } from './model.ts';
import { moveCode } from './moved.ts';
import { movesOf, nextMove } from './moves.ts';

type Dialog = 'assign' | 'move' | 'share' | 'remove' | null;

export interface CardKit {
  can: (action: Action) => boolean;
  /** The library's video actions (read when one is used, so a card doesn't re-render when a mutation's state does). */
  actions: RefObject<ReturnType<typeof useVideoActions>>;
  /** Moves a video to another lane (library/moving.tsx). */
  move: (v: VideoSummary, to: LaneId, how?: { inPlace?: boolean; focus?: boolean }) => void;
  /** The library shows the board: a move asks for its sentence on the card, and ⌥← / ⌥→ move cards. */
  board: boolean;
}
export const CardKitContext = createContext<CardKit | null>(null);

export function useCardKit(): CardKit {
  const kit = use(CardKitContext);
  if (!kit) throw new Error('library cards need a CardKitContext');
  return kit;
}

export const videoLink = (slug: string) => `${location.origin}${location.pathname}#/v/${enc(slug)}`;

/** Opens the player; with ⌘ or Ctrl held (like a link), in a new tab. A move still waiting for its toast goes first, so
 * the player shows where the video stands. */
export const openVideo = (slug: string, e?: { metaKey: boolean; ctrlKey: boolean }) => {
  moveCode.ready?.sendMoveNow(slug);
  return e && (e.metaKey || e.ctrlKey) ? window.open(videoLink(slug), '_blank', 'noopener') : go(slug);
};

// A video with notes is archived (its review stays, Undo brings it back); one without is removed for good, so that
// asks first.
async function removeVideo(v: VideoSummary, { remove, restore }: ReturnType<typeof useVideoActions>, done?: () => void) {
  try {
    const r = await remove.mutateAsync(v.slug);
    done?.();
    if (r.archived) toastUndo(t('Archived {name}', { name: v.name }), () => restore.mutateAsync(v.slug));
    else toast(t('Removed {name}', { name: v.name }), 'ok');
  } catch (e) {
    toastError(e);
  }
}

/** "Remove … ?": its own mutation, so the button shows it working. */
// The move dialog's folder picker is its own chunk: asked for when Move is chosen, not in the library's first paint.
const pickerCode = loader(() => import('./FolderPicker.tsx'));

function RemoveConfirm({ v, onClose }: { v: VideoSummary; onClose: () => void }) {
  const actions = useVideoActions();
  const uploaded = v.video.startsWith('/@uploads/');
  return (
    <Confirm
      title={t('Remove “{name}” from the library?', { name: v.name })}
      action={t('Remove')}
      danger
      busy={actions.remove.isPending}
      onClose={onClose}
      onConfirm={() => removeVideo(v, actions, onClose)}
    >
      {uploaded
        ? t('Its versions are deleted from this server; it has no notes to keep.')
        : t('Its versions and review data are deleted; it has no notes to keep, and the file on your disk stays.')}
    </Confirm>
  );
}

type LaneItem = { to: LaneId; key?: string };
// Worked out once per video entry (a layout switch mounts new cards for the same entries).
const laneItems = new WeakMap<VideoSummary, { can: (a: Action) => boolean; board: boolean; items: LaneItem[] }>();

/** Where a video may go (the lanes, in their order); on the board the nearest one each way is a key away. */
function lanesFor(v: VideoSummary, can: (a: Action) => boolean, board: boolean): LaneItem[] {
  const hit = laneItems.get(v);
  if (hit && hit.can === can && hit.board === board) return hit.items;
  const keyed = board ? [nextMove(v, -1, can)?.to, nextMove(v, 1, can)?.to] : [];
  const items = movesOf(v, can).map((m) => ({ to: m.to, key: m.to === keyed[0] ? '⌥←' : m.to === keyed[1] ? '⌥→' : undefined }));
  laneItems.set(v, { can, board, items });
  return items;
}

export function useVideoMenu(v: VideoSummary, { home, folders }: { home?: string | null; folders: string[] }) {
  const [dialog, setDialog] = useState<Dialog>(null);
  const { can, actions, move, board } = useCardKit();
  const organize = can('organize');
  // Uploaded renders (hosted server) have no path on anyone's disk.
  const uploaded = v.video.startsWith('/@uploads/');
  const close = () => setDialog(null);

  const onAssign = async (session: SessionPick | null) => {
    try {
      await actions.current.assign.mutateAsync({ slug: v.slug, session });
      close();
      toast(session ? `${v.name} → ${session.name}` : t('No agent on {name} now', { name: v.name }), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const onRestore = () =>
    actions.current.restore.mutateAsync(v.slug).then(
      () => toast(t('{name} is back in the library', { name: v.name }), 'ok'),
      (e) => toastError(e),
    );

  const lanes = useMemo(() => lanesFor(v, can, board), [v, can, board]);
  // in an archived project (lib/archived.ts) nothing new: no link, post or agent; only its owners and admins move it out
  const shut = !!v.project_archived;
  // A removed video downloads again once it is restored (the server says the same).
  const newest = can('download') && !v.archived && v.v ? v.v : 0;
  // The first run's sample goes for good in one click (it is never archived; the first run offers it again).
  const qc = useQueryClient();
  const onRemoveSample = () =>
    getStartedCode
      .load()
      .then((m) => m.removeSample(qc))
      .then(() => toast(t('Sample removed'), 'ok'), toastError);

  const items: MenuEntry[] = [
    { label: t('Open'), icon: 'play', shortcut: '↵', onClick: () => openVideo(v.slug) },
    { label: t('Open in new tab'), icon: 'external', onClick: () => window.open(videoLink(v.slug), '_blank', 'noopener') },
    { label: t('Copy link for the team'), icon: 'link', onClick: async () => (await copyText(videoLink(v.slug))) && toast(t('Link copied'), 'ok') },
    'sep',
    { heading: t('Move to') },
    ...lanes.map(
      (l): MenuEntry => ({
        label: laneLabel(l.to),
        mark: (
          <span className="lane-mark" data-lane={l.to}>
            <KeyGlyph shape={LANE_SHAPE[l.to] ?? 'outline'} />
          </span>
        ),
        shortcut: l.key,
        onClick: () => move(v, l.to, { inPlace: board, focus: true }),
      }),
    ),
    'sep',
    can('share') && !v.archived && !shut && { label: t('Share…'), icon: 'send', onClick: () => setDialog('share') },
    // a final version's next step: the composer opens in the player (publish/Publishing.tsx)
    can('post') &&
      !shut &&
      v.stage.stage === 'final' &&
      !v.stage.final_superseded && { label: t('Publish…'), icon: 'upload', onClick: () => go(v.slug, 'publish=1') },
    // the newest version as its own file, the ones before it a step further in (versions count up from V1)
    newest > 0 && { label: t('Download V{v}', { v: newest }), icon: 'download', onClick: () => void downloadVersion(v.slug, newest) },
    newest > 0 && {
      sub: {
        label: t('Download another version'),
        icon: 'history',
        items: Array.from({ length: Math.max(0, Math.min(v.versions, newest) - 1) }, (_, i) => newest - 1 - i).map((n) => ({
          label: `V${n}`,
          onClick: () => void downloadVersion(v.slug, n),
        })),
      },
    },
    'sep',
    organize && (!shut || can('archive')) && { label: t('Move to…'), icon: 'moveTo', onClick: () => setDialog('move') },
    organize && !shut && { label: t('Assign agent…'), icon: 'terminal', onClick: () => setDialog('assign') },
    'sep',
    {
      label: t('Copy for an agent'),
      icon: 'spark',
      onClick: async () => (await copyText(await api<string>(`/api/review/${enc(v.slug)}/prompt`))) && toast(t('Copied for an agent'), 'ok'),
    },
    !uploaded && { label: t('Copy file path'), icon: 'copy', onClick: async () => (await copyText(v.video)) && toast(t('Path copied'), 'ok') },
    'sep',
    // Members may remove what they uploaded (the server checks whose it is).
    can('upload') &&
      (v.sample
        ? { label: t('Remove sample'), icon: 'trash', onClick: onRemoveSample }
        : v.archived
          ? { label: t('Restore'), icon: 'restore', onClick: onRestore }
          : v.counts.total
            ? { label: t('Archive'), icon: 'archive', onClick: () => removeVideo(v, actions.current) }
            : { label: t('Remove from library…'), icon: 'trash', danger: true, onClick: () => setDialog('remove') }),
  ];

  const Picker = useLoaded(pickerCode, dialog === 'move');
  const dialogs: ReactNode = (
    <>
      {dialog === 'assign' && (
        <Modal title={t('Assign an agent to {name}', { name: v.name })} onClose={close} width={640}>
          <SessionPicker video={v.video} current={v.session} onAssign={onAssign} home={home} />
        </Modal>
      )}
      {dialog === 'move' && Picker && <Picker.MoveModal video={v} folders={folders} onClose={close} />}
      {dialog === 'share' && <LazyShareModal slug={v.slug} name={v.name} onClose={close} />}
      {dialog === 'remove' && <RemoveConfirm v={v} onClose={close} />}
    </>
  );

  return { items, dialogs, organize, assign: organize && !shut ? () => setDialog('assign') : null };
}
