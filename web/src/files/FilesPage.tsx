// The Files tab (design §6.1): a calm list of an area's material — a project's, a folder's, or the House's (Settings →
// Files) — beside its videos and its playbook. One line of numbers (its files, what it inherits), search, Add files
// (the one primary), then the folder you are in, the kinds to narrow it to and the order; the rows (folders, files,
// what is on its way), what it inherits folded under them, and at the foot its trash and what the plan holds. Files
// and folders dropped anywhere on the tab are checked before a byte moves (Check.tsx) and go to the upload tray.
// Keys: ↑↓ (⇧ to pick), ↵ opens, Space looks, ⌫ trashes with Undo, ⌘A picks all, Esc. A file opens beside the list
// (FileSheet.tsx). Reviewers never see this (the tab isn't there, the API answers 404). Loaded on demand with its styles.
import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dirOf, FILE_LIMITS, nameOf } from '../../../lib/fileText.ts';
import { can as roleCan } from '../../../lib/permissions.ts';
import type { BillingInfo, FileAreaInfo, FileDirInfo, FileKind, FilesTrash } from '../../../lib/types.ts';
import { useAuthStatus, useCan, useLikelyRole } from '../api/auth.ts';
import { useSSE } from '../api/events.ts';
import { useBilling, useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { ago, pct } from '../lib/format.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import { usePhone, useTouch } from '../lib/media.ts';
import { copyText, later, toast, toastError, toastUndo } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { KindIcon } from '../ui/kindIcons.tsx';
import { IconButton, Menu, type MenuEntry, Segmented, Tip } from '../ui/primitives.tsx';
import { SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import {
  createFolder,
  download,
  fileKeys,
  heardFiles,
  type Listing,
  moveFile,
  patchLists,
  refreshArea,
  restoreFile,
  trashFile,
  useFilesList,
  useFilesMedia,
  useFilesSummary,
  useFilesTrash,
} from './api.ts';
import { CheckSheet } from './Check.tsx';
import { MoveDialog, NameDialog, takenIn } from './Dialogs.tsx';
import { draggingFiles, fromDrop, fromInput, type Gathered } from './drop.ts';
import { type FileActs, FileSheet } from './FileSheet.tsx';
import { columnsOf, DirTileView, FileTileView, GoingTile, GridHead, TilePending } from './Grid.tsx';
import {
  between,
  crumbsOf,
  type FileRow,
  KINDS,
  kindWords,
  mcpCall,
  nextOrder,
  type Order,
  orderOf,
  orderWord,
  pictured,
  pullCommand,
  type SortBy,
  size,
  sortDirs,
  sortFiles,
  spaced,
  type TrashRow,
  type Who,
  whoOf,
} from './model.ts';
import { Peek, peekAt } from './Peek.tsx';
import { QuickLook } from './QuickLook.tsx';
import { Columns, DirRowView, FileRowView, GoingRowView, RowPending, WhoTag } from './Rows.tsx';
import { filesHref, noteOpen, useFilesAt } from './route.ts';
import { bindFileUploads, type FileUpload, useFileUploads } from './uploadStore.ts';
import '../styles/files.css';

// a folder's page asks for what its Files tab shows first once it has painted (Library.tsx)
export { prefetchArea } from './api.ts';

// ---------------------------------------------------------------- small pieces

const SORT_KEY = 'vr.files.sort';
/** The list's order, kept per browser: a column and which way ("size:asc"; a column alone is its first way). */
function useOrder(): [Order, (by: SortBy) => void] {
  const [order, setOrder] = useState<Order>(() => {
    try {
      return orderOf(localStorage.getItem(SORT_KEY));
    } catch {
      return orderOf(null);
    }
  });
  return [
    order,
    (by) =>
      setOrder((o) => {
        const next = nextOrder(o, by);
        try {
          localStorage.setItem(SORT_KEY, orderWord(next));
        } catch {}
        return next;
      }),
  ];
}

/** An area by its last name ("Spring sale"); the House is the House. */
const areaName = (area: string) => (area ? (area.split('/').at(-1) as string) : t('House'));

/** The keys of the list's rows: a file by its id, a folder by its path, a file on its way by its upload. */
const fileKey = (id: string) => `f:${id}`;
const dirKey = (path: string) => `d:${path}`;

type Row =
  | { key: string; kind: 'dir'; d: FileDirInfo; going?: { files: number; pct: number | null } }
  | { key: string; kind: 'file'; f: FileRow; upload?: FileUpload }
  | { key: string; kind: 'going'; u: FileUpload };

type Dialog = { kind: 'rename'; row: Row } | { kind: 'move'; keys: string[] } | { kind: 'new' } | null;

/**
 * Where the list is, inside a folder of the area or in its trash: the area's name, then the folders down to here, each
 * a way back up. At the area's top there is none: the page's title says where.
 */
function Place({ area, path, trash }: { area: string; path: string; trash: boolean }) {
  const parts = crumbsOf(path);
  return (
    <nav className="pf-place" aria-label={t('Where in the files')} data-testid="files-place">
      <a className="pf-crumb" href={filesHref(area)}>
        {areaName(area)}
      </a>
      {parts.map(([name, to], i) => (
        <span key={to} className="pf-crumb-step">
          <I name="right" size={12} className="pf-crumb-sep" />
          {i === parts.length - 1 && !trash ? (
            <span className="pf-crumb here" aria-current="page">
              {name}
            </span>
          ) : (
            <a className="pf-crumb" href={filesHref(area, { path: to })}>
              {name}
            </a>
          )}
        </span>
      ))}
      {trash && (
        <span className="pf-crumb-step">
          <I name="right" size={12} className="pf-crumb-sep" />
          <span className="pf-crumb here" aria-current="page">
            {t('Trash')}
          </span>
        </span>
      )}
    </nav>
  );
}

/**
 * What the plan's storage holds (where a billing provider runs), at the list's foot: a bar and "310 GB of 2.5 TB", in
 * amber near the end, a way to Settings → Billing. Its tooltip (and its name) splits it into files and videos.
 */
function Storage({ billing }: { billing: BillingInfo | undefined }) {
  const usage = billing?.usage;
  const limit = billing?.limits.bytes ?? null;
  if (!usage || limit === null) return null;
  const share = usage.bytes / limit;
  const near = share >= 0.8;
  const split = usage.files
    ? `${t('Files {files} · videos {videos} · {used} of {limit} in use', {
        files: size(usage.files.bytes),
        videos: size(Math.max(0, usage.bytes - usage.files.bytes)),
        used: size(usage.bytes),
        limit: size(limit),
      })}${usage.files.kept > 0 ? t(' · trash and older versions {size}, not counted', { size: size(usage.files.kept) }) : ''}`
    : t('{used} of {limit} in use', { used: size(usage.bytes), limit: size(limit) });
  return (
    <Tip content={split}>
      <a
        className={`pf-store ${near ? 'near' : ''}`}
        href="#/settings/billing"
        aria-label={near ? `${split} · ${t('{pct} of storage used', { pct: pct(share) })}` : split}
        data-testid="files-usage"
      >
        <span className="pf-store-bar" style={{ '--v': Math.min(1, share) } as CSSProperties} aria-hidden="true" />
        <span className="pf-store-words">{t('{used} of {limit}', { used: size(usage.bytes), limit: size(limit) })}</span>
        {near && (
          <span className="pf-store-near" data-testid="files-quota-near">
            {share >= 1 ? t('Storage full') : t('{pct} of storage used', { pct: pct(share) })}
          </span>
        )}
      </a>
    </Tip>
  );
}

// ---------------------------------------------------------------- the page

/**
 * A click that presses a row: on the row itself, not on its ⋯ (which opens its menu), and not from a layer that ⋯ opened.
 * A click in its menu (a portal) still bubbles up React's tree to the row: a tap on ⋯ whose menu opens over it (a row
 * near a phone's foot, a wider face on Linux or Windows) landed on the menu's frame and opened the file as well.
 */
const onRowItself = (e: MouseEvent): boolean => (e.currentTarget as Element).contains(e.target as Node) && !(e.target as Element).closest('.pf-c-acts');

export default function FilesPage({ area, pending = false, readOnly = false }: { area: string; pending?: boolean; readOnly?: boolean }) {
  useLang();
  const qc = useQueryClient();
  const at = useFilesAt();
  const path = at.path;
  const can = useCan();
  const write = can('files-write') && !readOnly && !pending;
  // Add files stands from the first paint (the role this browser saw last), so the head doesn't shift when the server answers
  const likely = useLikelyRole();
  const mayAdd = !!likely && roleCan(likely, 'files-write') && !readOnly;
  // a member trashes what they added; owners and admins anyone's (the server holds the same rule)
  const status = useAuthStatus().data;
  const me = status?.user?.name ?? null;
  const mayTrash = (f: FileRow) => write && (can('remove') || f.added_by === me);
  const phone = usePhone();
  const touch = useTouch();
  const info = useInfo(!pending);
  const billing = useBilling(!pending && !!info?.billing).data;
  const summary = useFilesSummary(area, !pending);
  const [typed, setTyped] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    const id = setTimeout(() => setQ(typed.trim()), 180);
    return () => clearTimeout(id);
  }, [typed]);
  const [kind, setKind] = useState<FileKind | ''>('');
  // another area or folder starts afresh (a search looks inside the folder it was typed in)
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new place only
  useEffect(() => {
    setTyped('');
    setQ('');
    setKind('');
  }, [area, path, at.trash]);
  const [listOrder, setListOrder] = useOrder();
  // a grid or a list, per folder (kept in this browser); a folder that holds footage or pictures opens as a grid
  const viewKey = `vr.files.view:${area}/${path}`;
  const readView = (k: string): 'grid' | 'list' | null => {
    try {
      const v = localStorage.getItem(k);
      return v === 'grid' || v === 'list' ? v : null;
    } catch {
      return null;
    }
  };
  const [viewPick, setViewPick] = useState<'grid' | 'list' | null>(() => readView(viewKey));
  // biome-ignore lint/correctness/useExhaustiveDependencies: on a new place only
  useEffect(() => setViewPick(readView(viewKey)), [viewKey]);
  const pickView = (v: 'grid' | 'list') => {
    setViewPick(v);
    try {
      localStorage.setItem(viewKey, v);
    } catch {}
  };
  // ⌘1 a grid, ⌘2 a list (Finder's keys for its views), and 1 / 2 as the Videos tab's layout keys
  const pickViewRef = useRef(pickView);
  pickViewRef.current = pickView;
  useEffect(() => {
    if (at.trash) return;
    const f = (e: globalThis.KeyboardEvent) => {
      if ((e.key !== '1' && e.key !== '2') || e.altKey || e.shiftKey) return;
      if ((e.target as Element | null)?.closest?.('input, textarea, select, [role=dialog], [role=menu]')) return;
      e.preventDefault();
      pickViewRef.current(e.key === '1' ? 'grid' : 'list');
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [at.trash]);
  const searching = !!(q || kind);
  const list = useFilesList(area, { path, q, kind }, !pending && !at.trash);
  const trash = useFilesTrash(area, !pending && at.trash);
  const { uploads, batches } = useFileUploads();
  useEffect(() => bindFileUploads(qc), [qc]);
  useSSE('files', (d) => {
    if (typeof d.area === 'string') heardFiles(qc, d.area, Number(d.rev) || 0);
  });

  // trashed a moment ago: gone from the list while the toast offers Undo (sent once it goes)
  const [hidden, setHidden] = useState<ReadonlySet<string>>(new Set());
  const hide = (keys: string[], on: boolean) =>
    setHidden((h) => {
      const next = new Set(h);
      for (const k of keys) on ? next.add(k) : next.delete(k);
      return next;
    });

  // ---- the rows
  const pages = list.data?.pages;
  const listedAt = list.dataUpdatedAt;
  const rows = useMemo((): Row[] => {
    if (!pages) return [];
    const files = pages.flatMap((p) => p.files);
    const dirs = searching ? [] : (pages[0]?.dirs ?? []);
    const listed = new Map(files.map((f) => [f.path, f]));
    const batchArea = new Map(batches.map((b) => [b.id, b.area]));
    // files on their way into this folder: new ones as rows of their own until the list has them, new versions on
    // their file's row
    const here = uploads.filter(
      (u) => batchArea.get(u.batch) === area && u.state !== 'canceled' && (u.state !== 'done' || (u.doneAt ?? 0) > listedAt) && !searching,
    );
    const onRow = new Map<string, FileUpload>();
    const going: FileUpload[] = [];
    const deeper = new Map<string, FileUpload[]>();
    for (const u of here) {
      const d = dirOf(u.path);
      if (d === path) {
        if (listed.has(u.path)) onRow.set(u.path, u);
        else going.push(u);
      } else if (!path || d.startsWith(`${path}/`)) {
        const top = (path ? u.path.slice(path.length + 1) : u.path).split('/')[0] as string;
        const key = path ? `${path}/${top}` : top;
        deeper.set(key, [...(deeper.get(key) ?? []), u]);
      }
    }
    const dirRows: Row[] = sortDirs(
      [...dirs, ...[...deeper.keys()].filter((p) => !dirs.some((d) => d.path === p)).map((p) => ({ path: p, files: 0, bytes: 0 }))],
      listOrder.by,
      listOrder.dir,
    )
      .filter((d) => !hidden.has(dirKey(d.path)))
      .map((d) => {
        const us = deeper.get(d.path);
        const live = us?.filter((u) => u.state !== 'done');
        const tot = us?.reduce((s, u) => s + u.size, 0) ?? 0;
        const sent = us?.reduce((s, u) => s + (u.state === 'done' ? u.size : u.sent), 0) ?? 0;
        return {
          key: dirKey(d.path),
          kind: 'dir',
          d,
          going: live?.length ? { files: live.length, pct: tot ? Math.floor((sent / tot) * 100) : null } : undefined,
        };
      });
    const now = new Date().toISOString();
    const mixed = sortFiles(
      [
        ...files
          .filter((f) => !hidden.has(fileKey(f.id)))
          .map((f) => ({ path: f.path, size: f.size, at: f.at, row: { key: fileKey(f.id), kind: 'file', f, upload: onRow.get(f.path) } as Row })),
        ...going.map((u) => ({ path: u.path, size: u.size, at: now, row: { key: `u:${u.key}`, kind: 'going', u } as Row })),
      ],
      listOrder.by,
      listOrder.dir,
    ).map((x) => x.row);
    return [...dirRows, ...mixed];
  }, [pages, searching, uploads, batches, area, path, listOrder, hidden, listedAt]);

  const order = useMemo(() => rows.filter((r) => r.kind !== 'going').map((r) => r.key), [rows]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const files = useMemo(() => rows.flatMap((r) => (r.kind === 'file' ? [r.f] : [])), [rows]);

  // ---- selection, keys and the sheet
  const [active, setActive] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<{ id: string; area: string; focus: boolean } | null>(at.open ? { id: at.open, area, focus: false } : null);
  // Quick Look: the file large, ← → through the folder's files
  const [look, setLook] = useState<string | null>(null);
  // a pictured row's larger picture beside its name, a moment after the pointer stops on it
  const [peek, setPeek] = useState<{ id: string; at: { x: number; y: number; below: boolean } } | null>(null);
  const peekRow = useRef<string | null>(null);
  const peekTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(peekTimer.current), []);
  // a new folder: nothing picked, nothing open
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the place changes
  useEffect(() => {
    setChecked(new Set());
    setActive(null);
  }, [area, path, at.trash, q, kind]);
  const open = (id: string | null, o: { area?: string; focus?: boolean } = {}) => {
    setOpened(id ? { id, area: o.area ?? area, focus: !!o.focus } : null);
    noteOpen(id);
  };
  // Esc closes the file beside the list from anywhere on the page (not from a field, a dialog or a menu)
  const sheetOpen = !!opened && !phone;
  useEffect(() => {
    if (!sheetOpen) return;
    const f = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      if ((e.target as Element | null)?.closest?.('input, textarea, [role=dialog]:not(.pf-sheet), [role=menu], [role=alertdialog]')) return;
      setOpened(null);
      noteOpen(null);
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [sheetOpen]);
  // the address says which file is open: Back, a link or another folder's address open or close it
  const openedId = opened?.id ?? null;
  // biome-ignore lint/correctness/useExhaustiveDependencies: when the address changes
  useEffect(() => {
    if ((at.open ?? null) !== openedId) setOpened(at.open ? { id: at.open, area, focus: false } : null);
  }, [at.open]);
  const grid = useRef<HTMLDivElement>(null);
  const enter = (to: string) => {
    location.hash = filesHref(area, { path: to });
  };
  const toggle = (key: string) =>
    setChecked((c) => {
      const next = new Set(c);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const press = (r: Row, e: MouseEvent) => {
    if (!onRowItself(e) || (e.target as Element).closest('.pf-tick, a')) return;
    if (r.kind === 'going') return;
    if (e.metaKey || e.ctrlKey) {
      toggle(r.key);
      setActive(r.key);
      return;
    }
    if (e.shiftKey && active) {
      setChecked(new Set(between(order, active, r.key)));
      return;
    }
    setActive(r.key);
    if (r.kind === 'dir') enter(r.d.path);
    else if (opened?.id === r.f.id) open(null);
    else open(r.f.id);
  };
  const reveal = (key: string) => requestAnimationFrame(() => document.getElementById(rowId(key))?.scrollIntoView({ block: 'nearest' }));
  const rowIds = useMemo(() => new Map(order.map((k, i) => [k, `pf-r${i}`])), [order]);
  const rowId = (key: string) => rowIds.get(key) ?? '';

  // Quick Look closed: the keys go back to the list, on the row they were on (a task after the dialog is gone: its own
  // focus return comes then, and left the focus on the page's body)
  const hadLook = useRef(false);
  useEffect(() => {
    if (look) {
      hadLook.current = true;
      return;
    }
    if (!hadLook.current) return;
    hadLook.current = false;
    const back = setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) grid.current?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(back);
  }, [look]);

  const [dialog, setDialog] = useState<Dialog>(null);
  // A dialog that closes and leaves the focus on nothing (it gives it back to its own field, gone with it: F2's rename)
  // hands the keys back to the list. Run after the dialog's own focus return, which comes a task after it unmounts.
  const hadDialog = useRef(false);
  useEffect(() => {
    if (dialog) {
      hadDialog.current = true;
      return;
    }
    if (!hadDialog.current) return;
    hadDialog.current = false;
    const back = setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) grid.current?.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(back);
  }, [dialog]);
  const [check, setCheck] = useState<{ gathered: Gathered; dir: string } | null>(null);

  // ---- actions
  const nameOfKey = (k: string) => {
    const r = byKey.get(k);
    return r?.kind === 'file' ? nameOf(r.f.path) : r?.kind === 'dir' ? nameOf(r.d.path) : '';
  };
  /** The id the server knows a row by: a file's, or a folder's (one made only by files on their way has none yet). */
  const idOfKey = (k: string): string | null => {
    const r = byKey.get(k);
    return r?.kind === 'file' ? r.f.id : r?.kind === 'dir' ? (r.d.id ?? null) : null;
  };
  const trashKeys = (keys: string[]) => {
    const theirs = keys.filter((k) => {
      const r = byKey.get(k);
      return r?.kind === 'file' && !mayTrash(r.f);
    });
    if (theirs.length) toast(t('Only owners and admins move files someone else added to the trash.'), 'info');
    const ks = keys.filter((k) => !!idOfKey(k) && !theirs.includes(k));
    if (!ks.length || !write) return;
    const ids = ks.map((k) => idOfKey(k) as string);
    if (opened && ids.includes(opened.id)) open(null);
    setChecked(new Set());
    later({
      message: ks.length === 1 ? t('“{name}” is in the trash', { name: nameOfKey(ks[0] as string) }) : t('{n} items are in the trash', { n: ks.length }),
      apply: () => hide(ks, true),
      revert: () => hide(ks, false),
      commit: async () => {
        try {
          await Promise.all(ids.map((id) => trashFile(id)));
        } finally {
          await refreshArea(qc, area);
          hide(ks, false);
        }
      },
    });
  };
  const copyFor = async (keys: string[]) => {
    const fs = keys.flatMap((k) => (byKey.get(k)?.kind === 'file' ? [(byKey.get(k) as { f: FileRow }).f.path] : []));
    const ds = keys.flatMap((k) => (byKey.get(k)?.kind === 'dir' ? [(byKey.get(k) as { d: FileDirInfo }).d.path] : []));
    const text = `${pullCommand(area, fs, ds)}\n${mcpCall(area, ds.length === 1 && !fs.length ? (ds[0] as string) : path)}`;
    if (await copyText(text)) toast(t('Copied for an agent: the lampo command, and the MCP call under it'), 'ok');
  };
  const downloadKeys = (keys: string[]) => {
    for (const k of keys) {
      const r = byKey.get(k);
      if (r?.kind === 'file') download(r.f.id);
    }
  };
  const renameTo = async (r: Row, name: string) => {
    setDialog(null);
    if (r.kind === 'file') {
      const to = dirOf(r.f.path) ? `${dirOf(r.f.path)}/${name}` : name;
      const before = qc.getQueriesData<{ pages: Listing[] }>({ queryKey: [...fileKeys.area(area), 'list'] });
      patchLists(qc, area, (fs) => fs.map((f) => (f.id === r.f.id ? { ...f, path: to } : f)));
      try {
        await moveFile(r.f.id, { path: to });
        void refreshArea(qc, area);
      } catch (e) {
        for (const [k, d] of before) qc.setQueryData(k, d);
        toastError(e);
      }
    } else if (r.kind === 'dir' && r.d.id) {
      const to = dirOf(r.d.path) ? `${dirOf(r.d.path)}/${name}` : name;
      // shown at once under its new name (the files in it come with the next answer)
      qc.setQueriesData<{ pages: Listing[]; pageParams: unknown[] }>({ queryKey: [...fileKeys.area(area), 'list'] }, (d) =>
        d ? { ...d, pages: d.pages.map((pg) => ({ ...pg, dirs: pg.dirs.map((x) => (x.id === r.d.id ? { ...x, path: to } : x)) })) } : d,
      );
      // a folder's row goes by its path: the keys stay on it under its new name
      setActive((a) => (a === r.key ? dirKey(to) : a));
      try {
        await moveFile(r.d.id, { path: to });
      } catch (e) {
        toastError(e);
      }
      void refreshArea(qc, area);
    }
  };
  const moveTo = async (keys: string[], to: { area: string; dir: string }) => {
    setDialog(null);
    setChecked(new Set());
    const moves = keys.flatMap((k) => {
      const r = byKey.get(k);
      if (r?.kind === 'file') {
        const p = to.dir ? `${to.dir}/${nameOf(r.f.path)}` : nameOf(r.f.path);
        return [
          {
            k,
            run: () => moveFile(r.f.id, { path: p, ...(to.area !== area ? { folder: to.area } : {}) }),
            back: () => moveFile(r.f.id, { path: r.f.path, ...(to.area !== area ? { folder: area } : {}) }),
          },
        ];
      }
      if (r?.kind === 'dir' && r.d.id) {
        const id = r.d.id;
        const p = to.dir ? `${to.dir}/${nameOf(r.d.path)}` : nameOf(r.d.path);
        return [
          {
            k,
            run: () => moveFile(id, { path: p, ...(to.area !== area ? { folder: to.area } : {}) }),
            back: () => moveFile(id, { path: r.d.path, ...(to.area !== area ? { folder: area } : {}) }),
          },
        ];
      }
      return [];
    });
    if (!moves.length) return;
    hide(
      moves.map((m) => m.k),
      true,
    );
    try {
      await Promise.all(moves.map((m) => m.run()));
      const where = to.area === area ? (to.dir ? spaced(to.dir) : areaName(area)) : `${areaName(to.area)}${to.dir ? ` · ${spaced(to.dir)}` : ''}`;
      toastUndo(moves.length === 1 ? t('Moved to {where}', { where }) : t('{n} moved to {where}', { n: moves.length, where }), async () => {
        await Promise.all(moves.map((m) => m.back()));
        void refreshArea(qc, area);
      });
    } catch (e) {
      toastError(e);
    } finally {
      await refreshArea(qc, area);
      if (to.area !== area) void refreshArea(qc, to.area);
      hide(
        moves.map((m) => m.k),
        false,
      );
    }
  };
  const makeFolder = async (name: string) => {
    setDialog(null);
    const p = path ? `${path}/${name}` : name;
    // shown at once, empty
    qc.setQueriesData<{ pages: Listing[]; pageParams: unknown[] }>({ queryKey: fileKeys.list(area, { path, q: '', kind: '' }) }, (d) =>
      d?.pages[0] ? { ...d, pages: [{ ...d.pages[0], dirs: [...d.pages[0].dirs, { path: p, files: 0, bytes: 0 }] }, ...d.pages.slice(1)] } : d,
    );
    try {
      await createFolder(area, p);
    } catch (e) {
      toastError(e);
    }
    void refreshArea(qc, area);
  };
  const acts: FileActs = {
    rename: (f) => setDialog({ kind: 'rename', row: { key: fileKey(f.id), kind: 'file', f } }),
    move: (f) => setDialog({ kind: 'move', keys: [fileKey(f.id)] }),
    trash: (f) => trashKeys([fileKey(f.id)]),
    copy: (f) => void copyFor([fileKey(f.id)]),
  };
  // a finger has no pointer to bring the boxes out with: picking starts from a row's ⋯, then every row shows its box
  const pickFirst = (key: string): MenuEntry => touch && !checked.size && { label: t('Select'), icon: 'check', onClick: () => toggle(key) };
  const fileMenu = (f: FileRow): MenuEntry[] => [
    pickFirst(fileKey(f.id)),
    'sep',
    { label: t('Download'), icon: 'download', onClick: () => download(f.id) },
    { label: t('Copy for an agent'), icon: 'copy', onClick: () => void copyFor([fileKey(f.id)]) },
    'sep',
    write && { label: t('Rename'), icon: 'edit', shortcut: 'F2', onClick: () => acts.rename(f) },
    write && { label: t('Move to…'), icon: 'moveTo', onClick: () => acts.move(f) },
    { label: t('Versions'), icon: 'history', onClick: () => open(f.id) },
    'sep',
    mayTrash(f) && { label: t('Trash'), icon: 'trash', danger: true, shortcut: '⌫', onClick: () => acts.trash(f) },
  ];
  const dirMenu = (r: Row & { kind: 'dir' }): MenuEntry[] => [
    (write || !phone) && pickFirst(r.key),
    'sep',
    { label: t('Open'), icon: 'folderOpen', onClick: () => enter(r.d.path) },
    { label: t('Copy for an agent'), icon: 'copy', onClick: () => void copyFor([r.key]) },
    'sep',
    write && !!r.d.id && { label: t('Rename'), icon: 'edit', shortcut: 'F2', onClick: () => setDialog({ kind: 'rename', row: r }) },
    write && !!r.d.id && { label: t('Move to…'), icon: 'moveTo', onClick: () => setDialog({ kind: 'move', keys: [r.key] }) },
    'sep',
    write && !!r.d.id && { label: t('Trash'), icon: 'trash', danger: true, shortcut: '⌫', onClick: () => trashKeys([r.key]) },
  ];

  // ---- the keys (on the list)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('input, textarea, [role=menu]')) return;
    // the keys take over from the pointer: its card goes
    setPeek(null);
    const i = active ? order.indexOf(active) : -1;
    const go = (j: number, extend: boolean) => {
      const k = order[Math.max(0, Math.min(order.length - 1, j))];
      if (!k) return;
      e.preventDefault();
      if (extend && active) setChecked((c) => new Set([...c, active, k]));
      setActive(k);
      reveal(k);
      // the sheet follows the keys
      const r = byKey.get(k);
      if (opened && r?.kind === 'file') open(r.f.id);
    };
    const r = active ? byKey.get(active) : undefined;
    const step = view === 'grid' ? columnsOf(grid.current) : 1;
    if (e.key === 'ArrowDown') go(i + step, e.shiftKey);
    else if (e.key === 'ArrowUp' && e.metaKey && path) {
      e.preventDefault();
      enter(dirOf(path));
    } else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - step, e.shiftKey);
    else if (e.key === 'ArrowRight' && view === 'grid') go(i + 1, e.shiftKey);
    else if (e.key === 'ArrowLeft' && view === 'grid') go(Math.max(0, i - 1), e.shiftKey);
    else if (e.key === 'Home') go(0, false);
    else if (e.key === 'End') go(order.length - 1, false);
    else if (e.key === 'Enter' && r) {
      e.preventDefault();
      if (r.kind === 'dir') enter(r.d.path);
      else if (r.kind === 'file') open(r.f.id, { focus: true });
    } else if (e.key === ' ' && r?.kind === 'file') {
      e.preventDefault();
      setLook(r.f.id);
    } else if (e.key === 'F2' && write && r && (r.kind === 'file' || (r.kind === 'dir' && r.d.id))) {
      // Rename from the keys, as in a file manager: a folder's Rename otherwise sits only in its row's ⋯ (pointer)
      e.preventDefault();
      setDialog({ kind: 'rename', row: r });
    } else if ((e.key === 'Backspace' || e.key === 'Delete') && write) {
      e.preventDefault();
      trashKeys(checked.size ? [...checked] : active ? [active] : []);
    } else if (e.key === 'a' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      setChecked(new Set(order));
    } else if (e.key === 'x' && active && !e.metaKey && !e.ctrlKey) {
      e.preventDefault();
      toggle(active);
    } else if (e.key === 'Escape') {
      if (opened) open(null);
      else if (checked.size) setChecked(new Set());
    }
  };
  // `/` searches, from anywhere on the page
  const search = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const f = (e: globalThis.KeyboardEvent) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || (e.target as Element | null)?.closest?.('input, textarea, [role=dialog]:not(.pf-sheet), [role=menu]'))
        return;
      e.preventDefault();
      search.current?.focus();
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  // ---- adding: drop anywhere on the tab, or the pickers
  const pickFiles = useRef<HTMLInputElement>(null);
  const pickDir = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const droppable = write && !at.trash && !phone;
  useEffect(() => {
    if (!droppable) return;
    let depth = 0;
    const enter = (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      depth++;
      setOver(true);
    };
    const overFn = (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      e.preventDefault();
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy';
    };
    const leave = (e: DragEvent) => {
      if (!draggingFiles(e)) return;
      depth = Math.max(0, depth - 1);
      if (!depth) setOver(false);
    };
    const drop = (e: DragEvent) => {
      if (!draggingFiles(e) || !e.dataTransfer) return;
      e.preventDefault();
      depth = 0;
      setOver(false);
      const dir = path;
      void fromDrop(e.dataTransfer).then((g) => (g.picked.length || g.junk.length ? setCheck({ gathered: g, dir }) : undefined), toastError);
    };
    window.addEventListener('dragenter', enter);
    window.addEventListener('dragover', overFn);
    window.addEventListener('dragleave', leave);
    window.addEventListener('drop', drop);
    return () => {
      window.removeEventListener('dragenter', enter);
      window.removeEventListener('dragover', overFn);
      window.removeEventListener('dragleave', leave);
      window.removeEventListener('drop', drop);
    };
  }, [droppable, path]);
  const picked = (list: FileList | null) => {
    const g = fromInput(list);
    if (g.picked.length || g.junk.length) setCheck({ gathered: g, dir: path });
  };

  // ---- the numbers: the area's (at its top), a folder's (from its listing), what a search found
  const own = summary.data?.areas.find((a) => a.area === area);
  const loading = !pending && !at.trash && !pages && !list.error;
  const empty = !!pages && !rows.length && !searching;
  // what the area inherits, folded under its own rows — once the rows are here, so they never push it down
  const inherited = !path && !searching && !at.trash && pages ? (summary.data?.areas.filter((a) => a.area !== area && a.files > 0) ?? []) : [];
  // what the rows show of footage, pictures and sound (lengths, sizes): asked for once the rows are here
  const mediaRows = useMemo(() => files.filter((f) => f.kind === 'footage' || f.kind === 'audio' || f.kind === 'image').slice(0, FILE_LIMITS.page), [files]);
  const mosaics = useMemo(() => (searching ? [] : (pages?.[0]?.dirs ?? []).flatMap((d) => d.pics ?? [])), [pages, searching]);
  const media = useFilesMedia(area, [...mediaRows, ...mosaics].slice(0, FILE_LIMITS.page), !pending && !at.trash).data?.files;
  // a grid where pictures dominate: more than half the files here are footage or pictures (a folder of folders: more
  // than half of them hold some); a list elsewhere
  const dirsHere = searching ? [] : (pages?.[0]?.dirs ?? []);
  const gridFits = files.length
    ? files.filter((f) => pictured(f.kind)).length * 2 > files.length
    : dirsHere.length > 0 && dirsHere.filter((d) => d.pics?.length).length * 2 > dirsHere.length;
  const view: 'grid' | 'list' = at.trash ? 'list' : (viewPick ?? (gridFits ? 'grid' : 'list'));
  // a poster's slot where the list has footage or pictures (from the listing: it is set before any picture comes)
  const pics = !at.trash && !pending && files.some((f) => pictured(f.kind));
  const hoverRow = (row: Element | null) => {
    const id = row?.getAttribute('data-id') ?? null;
    if (id === peekRow.current) return;
    peekRow.current = id;
    clearTimeout(peekTimer.current);
    setPeek(null);
    const f = id ? files.find((x) => x.id === id) : undefined;
    if (!row || !id || !f || !pictured(f.kind) || !media?.[id]?.poster || checked.size > 0 || look) return;
    peekTimer.current = setTimeout(() => setPeek({ id, at: peekAt(row) }), 350);
  };
  // how much the list holds, beside the columns' names
  const facts = ((): ReactNode => {
    if (at.trash)
      return trash.data ? (
        t(
          '{n} file, {size} · each kept up to 30 days, doesn’t count toward your storage|{n} files, {size} · each kept up to 30 days, doesn’t count toward your storage',
          {
            n: trash.data.files.length,
            size: size(trash.data.bytes),
          },
        )
      ) : (
        <SkLine w="14em" />
      );
    const sum = (n: number, bytes: number | null) => `${t('{n} file|{n} files', { n })}${n > 0 && bytes !== null ? ` · ${size(bytes)}` : ''}`;
    if (searching || path) {
      const first = pages?.[0];
      // (a list that didn't load says so under the heading: no numbers wait for it)
      if (!first) return list.error ? null : <SkLine w="7em" />;
      if (searching) return t('{n} file|{n} files', { n: first.total });
      // everything under this folder: its folders' (they count all inside them) and its own, whose sizes are all here
      // once every page is
      const bytes = list.hasNextPage ? null : first.dirs.reduce((s, d) => s + d.bytes, 0) + files.reduce((s, f) => s + f.size, 0);
      return sum(first.total + first.dirs.reduce((s, d) => s + d.files, 0), bytes);
    }
    return own ? sum(own.files, own.bytes) : summary.error ? null : <SkLine w="7em" />;
  })();
  const [kindsRef, kindsEdges] = useScrollEdges<HTMLDivElement>();
  // the kinds there are here: the area's, or inside a folder the kinds of its top folder (the summary's tops)
  const tops = summary.data?.areas.find((a) => a.area === area)?.tops ?? [];
  const top = path ? `${path.split('/')[0]}/` : null;
  const present = new Set(tops.filter((x) => !top || x.path === top).flatMap((x) => x.kinds));
  const kinds = KINDS.filter((k) => present.has(k) || k === kind);
  const selected = [...checked].filter((k) => byKey.has(k));
  const selectedBytes = selected.reduce((s, k) => {
    const r = byKey.get(k);
    return s + (r?.kind === 'file' ? r.f.size : r?.kind === 'dir' ? r.d.bytes : 0);
  }, 0);
  const openedRow = opened ? (files.find((f) => f.id === opened.id) ?? null) : null;

  return (
    <div className={`pf ${opened && !phone ? 'sheet-open' : ''}`} data-testid="files" data-area={area} data-path={path} aria-busy={loading || pending}>
      <input
        ref={pickFiles}
        type="file"
        multiple
        hidden
        onChange={(e) => {
          picked(e.target.files);
          e.target.value = '';
        }}
        data-testid="files-input"
      />
      <input
        ref={pickDir}
        type="file"
        hidden
        {...({ webkitdirectory: '' } as object)}
        onChange={(e) => {
          picked(e.target.files);
          e.target.value = '';
        }}
        data-testid="files-input-folder"
      />
      <div className="pf-main">
        {/* the tab's first row, the Videos tab's toolbar: search, the kinds as its quick views, the order, Add files */}
        <div className="lib-toolbar pf-toolbar" role="toolbar" aria-label={t('Files view')} data-tab-row>
          {at.trash ? (
            // (the trash has no search: it is one short list)
            <a className="btn pf-back" href={filesHref(area, { path })}>
              <I name="back" size={14} />
              {t('Back to the files')}
            </a>
          ) : (
            <label className="lib-filter pf-search">
              <I name="search" size={15} />
              <input
                ref={search}
                className="input"
                placeholder={t('Search files')}
                aria-label={t('Search the files here and in every folder inside')}
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape' && typed) {
                    e.stopPropagation();
                    setTyped('');
                  } else if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    grid.current?.focus();
                  }
                }}
                data-testid="files-search"
              />
              {typed ? (
                <IconButton className="lib-filter-clear" label={t('Clear the search')} shortcut="Esc" icon="x" size={13} onClick={() => setTyped('')} />
              ) : (
                <kbd className="kbd">/</kbd>
              )}
            </label>
          )}
          {!at.trash && (
            <div className={`lib-lanes pf-kinds ${kindsEdges}`} ref={kindsRef}>
              {/* All stands from the first paint; the kinds there are join it when the summary says (nothing moves) */}
              <Segmented
                label={t('Kind')}
                className="chips pf-kind-chips"
                value={kind || 'all'}
                onChange={(k) => setKind(k === 'all' ? '' : (k as FileKind))}
                options={[{ value: 'all', label: t('All') }, ...(kinds.length > 1 ? kinds : []).map((k) => ({ value: k, label: kindWords(k) }))]}
              />
            </div>
          )}
          <span className="grow" />
          {!at.trash && (
            <Segmented
              iconOnly
              className="pf-view"
              label={t('View')}
              value={view}
              onChange={(v) => pickView(v === 'grid' ? 'grid' : 'list')}
              options={[
                { value: 'grid', label: t('Grid'), icon: 'grid', shortcut: '⌘1' },
                { value: 'list', label: t('List'), icon: 'list', shortcut: '⌘2' },
              ]}
            />
          )}
          {mayAdd && !at.trash && (
            <div className="pf-add">
              <Button variant="primary" icon="upload" onClick={() => pickFiles.current?.click()} data-testid="files-add">
                <span className="pf-add-label">{t('Add files')}</span>
              </Button>
              <Menu
                trigger={<IconButton className="btn primary icon-only pf-add-more" label={t('More ways to add')} icon="down" size={14} />}
                items={[
                  { label: t('Add a folder…'), icon: 'folderOpen', onClick: () => pickDir.current?.click() },
                  { label: t('New folder'), icon: 'folderPlus', onClick: () => setDialog({ kind: 'new' }) },
                ]}
              />
            </div>
          )}
        </div>

        {/* the content, from where the Videos tab's first section starts: inside a folder where it is, the columns (each
            one orders the list, what it holds beside Name), then its rows — or, for an empty area, the empty state in
            their place — and at the foot its trash and what the plan's storage holds */}
        <div className={`pf-body ${pics ? 'pics' : ''}`} data-tab-body>
          {(path || at.trash) && <Place area={area} path={path} trash={at.trash} />}
          {at.trash ? (
            <TrashList area={area} write={write} data={trash.data} error={trash.error} count={facts} onOpen={(id) => open(id)} />
          ) : list.error && !pages ? (
            <EmptyState
              art="error"
              titleAs="h2"
              title={t('The files didn’t load')}
              action={
                <Button variant="primary" icon="refresh" onClick={() => void list.refetch()}>
                  {t('Try again')}
                </Button>
              }
            >
              {list.error.message}
            </EmptyState>
          ) : empty ? (
            <Empty area={area} path={path} write={write} onAdd={() => pickFiles.current?.click()} small={inherited.length > 0} />
          ) : view === 'grid' ? (
            <>
              <GridHead order={listOrder} onOrder={setListOrder} count={facts} />
              <div
                ref={grid}
                className={`pf-grid ${checked.size ? 'picking' : ''}`}
                role="listbox"
                aria-label={t('Files')}
                aria-multiselectable="true"
                aria-activedescendant={active && rowIds.has(active) ? rowId(active) : undefined}
                tabIndex={0}
                onKeyDown={onKey}
                onFocus={() => !active && order[0] && setActive(order[0])}
                data-testid="files-list"
              >
                {loading || pending
                  ? [1, 2, 3, 4, 5, 6].map((n) => <TilePending key={n} />)
                  : rows.map((r) => {
                      const rowLook = { active: active === r.key, picked: r.kind === 'file' && opened?.id === r.f.id, checked: checked.has(r.key) };
                      if (r.kind === 'going') return <GoingTile key={r.key} u={r.u} id={`pf-${r.key}`} />;
                      if (r.kind === 'dir')
                        return (
                          <DirTileView
                            key={r.key}
                            id={rowId(r.key)}
                            d={r.d}
                            media={media}
                            {...rowLook}
                            onPress={(e) => press(r, e)}
                            onCheck={write || !phone ? () => toggle(r.key) : undefined}
                            menu={dirMenu(r)}
                          />
                        );
                      return (
                        <FileTileView
                          key={r.key}
                          id={rowId(r.key)}
                          f={r.f}
                          media={media?.[r.f.id]}
                          onLook={() => {
                            setActive(r.key);
                            setLook(r.f.id);
                          }}
                          {...rowLook}
                          onPress={(e) => press(r, e)}
                          onCheck={() => toggle(r.key)}
                          menu={fileMenu(r.f)}
                        />
                      );
                    })}
              </div>
            </>
          ) : (
            <>
              <Columns order={listOrder} onOrder={setListOrder} count={facts} />
              <div
                ref={grid}
                className={`pf-list ${checked.size ? 'picking' : ''}`}
                role="listbox"
                aria-label={t('Files')}
                aria-multiselectable="true"
                aria-activedescendant={active && rowIds.has(active) ? rowId(active) : undefined}
                tabIndex={0}
                onKeyDown={onKey}
                onFocus={() => !active && order[0] && setActive(order[0])}
                onPointerOver={(e) => e.pointerType === 'mouse' && hoverRow((e.target as Element).closest('[data-testid=file-row]'))}
                onPointerLeave={() => hoverRow(null)}
                onScroll={() => hoverRow(null)}
                data-testid="files-list"
              >
                {loading || pending ? (
                  <SkeletonRegion label={t('Loading the files')} className="pf-wait">
                    {['9em', '12em', '7em', '10em', '8em', '11em'].map((w) => (
                      <RowPending key={w} w={w} />
                    ))}
                  </SkeletonRegion>
                ) : !rows.length ? (
                  <EmptyState
                    art="filter"
                    size="sm"
                    titleAs="h2"
                    title={t('Nothing matches')}
                    action={
                      <Button
                        icon="x"
                        onClick={() => {
                          setTyped('');
                          setKind('');
                        }}
                      >
                        {t('Clear the search')}
                      </Button>
                    }
                  >
                    {t('Try another word, or every kind.')}
                  </EmptyState>
                ) : (
                  rows.map((r) => {
                    const rowLook = { active: active === r.key, picked: r.kind === 'file' && opened?.id === r.f.id, checked: checked.has(r.key) };
                    // the row the keys are on takes Tab into its actions; the others' wait for the pointer
                    const tab = rowLook.active ? 0 : -1;
                    if (r.kind === 'going') return <GoingRowView key={r.key} u={r.u} id={`pf-${r.key}`} />;
                    if (r.kind === 'dir')
                      return (
                        <DirRowView
                          key={r.key}
                          id={rowId(r.key)}
                          d={r.d}
                          going={r.going}
                          {...rowLook}
                          onPress={(e) => press(r, e)}
                          onCheck={write || !phone ? () => toggle(r.key) : undefined}
                          menu={dirMenu(r)}
                          quick={
                            <IconButton
                              className="btn ghost sm icon-only pf-quick"
                              label={t('Copy {name} for an agent', { name: nameOf(r.d.path) })}
                              icon="copy"
                              size={14}
                              tabIndex={tab}
                              onClick={() => void copyFor([r.key])}
                            />
                          }
                        />
                      );
                    return (
                      <FileRowView
                        key={r.key}
                        id={rowId(r.key)}
                        f={r.f}
                        upload={r.upload}
                        showDir={searching}
                        media={media?.[r.f.id]}
                        onLook={() => {
                          setActive(r.key);
                          setLook(r.f.id);
                        }}
                        {...rowLook}
                        onPress={(e) => press(r, e)}
                        onCheck={() => toggle(r.key)}
                        menu={fileMenu(r.f)}
                        quick={
                          <>
                            <IconButton
                              className="btn ghost sm icon-only pf-quick pf-dl"
                              label={t('Download {name}', { name: nameOf(r.f.path) })}
                              icon="download"
                              size={14}
                              tabIndex={tab}
                              onClick={() => download(r.f.id)}
                            />
                            <IconButton
                              className="btn ghost sm icon-only pf-quick"
                              label={t('Copy {name} for an agent', { name: nameOf(r.f.path) })}
                              icon="copy"
                              size={14}
                              tabIndex={tab}
                              onClick={() => void copyFor([r.key])}
                            />
                          </>
                        }
                      />
                    );
                  })
                )}
                {list.hasNextPage && (
                  <button type="button" className="pf-more-rows" onClick={() => void list.fetchNextPage()} disabled={list.isFetchingNextPage}>
                    {t('Show more · {n} in all', { n: pages?.[0]?.total ?? 0 })}
                  </button>
                )}
              </div>
            </>
          )}

          {!at.trash && inherited.map((a, i) => <Inherited key={a.area} info={a} here={i === 0 ? area : null} onOpen={(id) => open(id, { area: a.area })} />)}

          {/* the area's trash at its top, and what the plan's storage holds: once the rows are here (nothing under them
              moves), never under an empty area's empty state */}
          {!at.trash && pages && !(empty && !path) && (
            <div className="pf-foot">
              {!path && own && own.trash > 0 && (
                <a className="pf-foot-link" href={filesHref(area, { trash: true })} data-testid="files-trash-link">
                  <I name="trash" size={14} />
                  {t('Trash: {n} file, {size}, doesn’t count toward your storage|Trash: {n} files, {size}, doesn’t count toward your storage', {
                    n: own.trash,
                    size: size(own.trash_bytes),
                  })}
                </a>
              )}
              <Storage billing={billing} />
            </div>
          )}
        </div>

        {selected.length > 0 && (
          <div className="pf-selbar" role="toolbar" aria-label={t('{n} selected', { n: selected.length })} data-testid="files-selbar">
            <span className="pf-selbar-n">
              {t('{n} selected', { n: selected.length })}
              {selectedBytes > 0 && <span className="pf-selbar-size"> · {size(selectedBytes)}</span>}
            </span>
            {/* on a narrow list the words give way to the glyphs; the names stay */}
            {selected.some((k) => k.startsWith('f:')) && (
              <button type="button" className="btn ghost sm" aria-label={t('Download')} onClick={() => downloadKeys(selected)}>
                <I name="download" size={14} /> <span className="pf-selbar-l">{t('Download')}</span>
              </button>
            )}
            <button type="button" className="btn ghost sm" aria-label={t('Copy for an agent')} onClick={() => void copyFor(selected)}>
              <I name="copy" size={14} /> <span className="pf-selbar-l">{t('Copy for an agent')}</span>
            </button>
            {write && (
              <button type="button" className="btn ghost sm" aria-label={t('Move')} onClick={() => setDialog({ kind: 'move', keys: selected })}>
                <I name="moveTo" size={14} /> <span className="pf-selbar-l">{t('Move')}</span>
              </button>
            )}
            {write && (
              <button type="button" className="btn ghost sm" aria-label={t('Trash')} onClick={() => trashKeys(selected)} data-testid="files-selbar-trash">
                <I name="trash" size={14} /> <span className="pf-selbar-l">{t('Trash')}</span>
              </button>
            )}
            <IconButton
              className="btn ghost sm icon-only pf-selbar-x"
              label={t('Clear the selection')}
              shortcut="Esc"
              icon="x"
              size={14}
              onClick={() => setChecked(new Set())}
            />
          </div>
        )}
      </div>

      {over && (
        <div className="pf-drop" aria-hidden="true" data-testid="files-drop">
          <p className="pf-drop-line">
            <I name="upload" size={16} />
            {path ? t('Drop to add to {area} · {path}', { area: areaName(area), path: spaced(path) }) : t('Drop to add to {area}', { area: areaName(area) })}
          </p>
        </div>
      )}

      {opened && (
        <FileSheet
          key={opened.id}
          id={opened.id}
          row={opened.area === area ? openedRow : null}
          area={opened.area}
          write={write && opened.area === area}
          phone={phone}
          focus={opened.focus}
          act={acts}
          mayTrash={openedRow ? mayTrash(openedRow) : false}
          onClose={() => {
            open(null);
            grid.current?.focus({ preventScroll: true });
          }}
        />
      )}
      {peek &&
        !look &&
        !checked.size &&
        (() => {
          const f = files.find((x) => x.id === peek.id);
          return f ? <Peek f={f} media={media?.[f.id]} at={peek.at} /> : null;
        })()}
      {look && files.some((f) => f.id === look) && (
        <QuickLook
          files={files}
          at={files.findIndex((f) => f.id === look)}
          media={media}
          onMove={(i) => {
            const f = files[i];
            if (!f) return;
            setLook(f.id);
            setActive(fileKey(f.id));
          }}
          onClose={() => setLook(null)}
          onCopy={(f) => void copyFor([fileKey(f.id)])}
          onDetails={(f) => {
            setLook(null);
            open(f.id);
          }}
        />
      )}
      {check && <CheckSheet area={area} dir={check.dir} gathered={check.gathered} billing={billing} onClose={() => setCheck(null)} />}
      {dialog?.kind === 'new' && (
        <NameDialog
          title={path ? t('New folder in {where}', { where: spaced(path) }) : t('New folder')}
          action={t('Create')}
          dir={path}
          taken={takenIn(rows.map((r) => (r.kind === 'dir' ? r.d.path : r.kind === 'file' ? r.f.path : r.u.path)))}
          onDone={(name) => void makeFolder(name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'rename' && dialog.row.kind !== 'going' && (
        <NameDialog
          title={t('Rename {name}', { name: dialog.row.kind === 'file' ? nameOf(dialog.row.f.path) : nameOf(dialog.row.d.path) })}
          action={t('Rename')}
          dir={dirOf(dialog.row.kind === 'file' ? dialog.row.f.path : dialog.row.d.path)}
          was={dialog.row.kind === 'file' ? nameOf(dialog.row.f.path) : nameOf(dialog.row.d.path)}
          taken={takenIn(rows.map((r) => (r.kind === 'dir' ? r.d.path : r.kind === 'file' ? r.f.path : r.u.path)))}
          onDone={(name) => void renameTo(dialog.row, name)}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          area={area}
          what={dialog.keys.length === 1 ? nameOfKey(dialog.keys[0] as string) : t('{n} items', { n: dialog.keys.length })}
          from={path}
          onDone={(to) => void moveTo(dialog.keys, to)}
          onClose={() => setDialog(null)}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------- empty, inherited, trash

// The prompt's builder (lib/mcpConfig.ts, with every client's setup): asked for once the empty project shows, and again
// when the pointer or the focus reaches the button, so the click writes the clipboard in its own moment (Safari).
const promptBuilder = loader(() => import('../../../lib/mcpConfig.ts'));

/**
 * An empty project's way in for an agent: one prompt copied (lib/mcpConfig.ts filesPrompt) — the agent connects itself
 * to this app unless its tools are there, asks which folder of the person's goes up, pushes it here with `lampo files
 * push` and says what went up and what was left out. It connects where every Copy prompt points (sessions/agentStart.tsx
 * `placeOf`, said again here so this lazy screen takes nothing of the library's first chunk): this app's /mcp, and at
 * the machine the app's folder.
 */
function FilesPrompt({ area }: { area: string }) {
  const info = useInfo();
  const via = useAuthStatus().data?.via;
  useLoaded(promptBuilder);
  const warm = () => void promptBuilder.load().catch(() => {});
  const copy = async () => {
    const place = info
      ? { url: `${(info.public_url || location.origin).replace(/\/+$/, '')}/mcp`, root: via === 'local' && info.root ? info.root : null }
      : null;
    const m = promptBuilder.ready ?? (await promptBuilder.load().catch(() => null));
    if (!place || !m || !(await copyText(m.filesPrompt({ ...place, area })))) return void toast(t('Could not copy'), 'error');
    toast(t('Copied'), 'ok');
  };
  return (
    <Button icon="copy" onClick={() => void copy()} onPointerEnter={warm} onFocus={warm} data-testid="files-prompt">
      {t('Copy prompt for your agent')}
    </Button>
  );
}

function Empty({ area, path, write, onAdd, small }: { area: string; path: string; write: boolean; onAdd: () => void; small: boolean }) {
  if (path)
    return (
      <EmptyState
        art="folder"
        size="sm"
        titleAs="h2"
        title={t('This folder is empty')}
        action={
          write && (
            // the toolbar's Add files is the page's one primary
            <Button icon="upload" onClick={onAdd}>
              {t('Add files')}
            </Button>
          )
        }
        tips={write ? [t('Drop files and folders anywhere on this page')] : undefined}
        testId="files-empty"
      >
        {t('Files you add here keep this folder in their path.')}
      </EmptyState>
    );
  // where the Videos tab's empty project stands, as big: Add files
  return (
    <EmptyState
      art="folder"
      size={small ? 'sm' : 'md'}
      titleAs="h2"
      className="pf-empty"
      testId="files-empty"
      title={t('No files yet')}
      action={
        write && (
          <span className="pf-empty-acts">
            {/* the toolbar's Add files is the page's one primary */}
            <Button icon="upload" onClick={onAdd}>
              {t('Add files')}
            </Button>
            <FilesPrompt area={area} />
          </span>
        )
      }
      tips={write ? [t('Drop files and folders anywhere on this page')] : undefined}
    >
      {t('Footage, music, fonts and project files: your team and its agents work from the same material.')}
    </EmptyState>
  );
}

/**
 * What this area inherits from one above (the playbook's way): folded to a line, open to its top-level files. `here`:
 * the area it is inherited into, said on the first of them: which file is used where both have one at the same place.
 */
function Inherited({ info, here, onOpen }: { info: FileAreaInfo; here: string | null; onOpen: (id: string) => void }) {
  const [open, setOpen] = useState(false);
  // the keys' row: none until the list has the keys
  const [active, setActive] = useState(-1);
  const list = useFilesList(info.area, { path: '', q: '', kind: '' }, open);
  const page = list.data?.pages[0];
  const name = areaName(info.area);
  const items = page
    ? [
        ...sortDirs(page.dirs, 'name').map((d) => ({ key: `d:${d.path}`, go: () => (location.hash = filesHref(info.area, { path: d.path })), d })),
        ...sortFiles(page.files, 'name').map((f) => ({ key: `f:${f.id}`, go: () => onOpen(f.id), f })),
      ]
    : [];
  const id = (i: number) => `pf-inh-${encodeURIComponent(info.area) || 'house'}-${i}`;
  const keys = (e: KeyboardEvent<HTMLDivElement>) => {
    const move = (j: number) => {
      e.preventDefault();
      const k = Math.max(0, Math.min(items.length - 1, j));
      setActive(k);
      document.getElementById(id(k))?.scrollIntoView({ block: 'nearest' });
    };
    if (e.key === 'ArrowDown') move(active + 1);
    else if (e.key === 'ArrowUp') move(active - 1);
    else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      items[active]?.go();
    }
  };
  const fileActs = (f: FileRow): MenuEntry[] => [
    { label: t('Download'), icon: 'download', onClick: () => download(f.id) },
    {
      label: t('Copy for an agent'),
      icon: 'copy',
      onClick: async () => (await copyText(`${pullCommand(info.area, [f.path])}\n${mcpCall(info.area, '')}`)) && toast(t('Copied'), 'ok'),
    },
  ];
  // "Also here, from the Acme project": the House's, a project's or a folder's, in plain words
  const from = !info.area
    ? t('Also here, from the House')
    : info.area.includes('/')
      ? t('Also here, from the {name} folder', { name })
      : t('Also here, from the {name} project', { name });
  // which one is used where both have a file of the same name in the same folder: this page's own
  const wins =
    here === null
      ? ''
      : here.includes('/')
        ? t('Same name in the same folder: this folder’s own file is used.')
        : t('Same name in the same folder: this project’s own file is used.');
  return (
    <section className={`pf-inh ${open ? 'open' : ''}`} aria-label={from} data-testid="files-inherited" data-area={info.area}>
      {/* a section's heading, as the Videos tab's: the fold, whose it is, what it holds, and which file is used */}
      <button type="button" className="pf-inh-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="files-inherited-head">
        <span className="pf-shead-lead" aria-hidden="true">
          <I name="right" size={13} className="pf-inh-chev" />
        </span>
        <span className="pf-inh-from">{from}</span>
        <span className="pf-inh-facts">
          {t('{n} file|{n} files', { n: info.files })} · {size(info.bytes)}
        </span>
        {wins && <span className="pf-inh-note">{wins}</span>}
      </button>
      {open && (
        <div
          className="pf-inh-list"
          role="listbox"
          tabIndex={0}
          aria-label={t('Files from {area}', { area: name })}
          aria-activedescendant={active >= 0 && items.length ? id(active) : undefined}
          onFocus={() => active < 0 && setActive(0)}
          onKeyDown={keys}
        >
          {!page
            ? ['8em', '10em'].map((w) => <RowPending key={w} w={w} />)
            : items.map((x, i) =>
                'd' in x && x.d ? (
                  <DirRowView
                    key={x.key}
                    id={id(i)}
                    d={x.d}
                    active={active === i}
                    picked={false}
                    checked={false}
                    onPress={(e) => onRowItself(e) && x.go()}
                    menu={[{ label: t('Open'), icon: 'folderOpen', onClick: x.go }]}
                    testid="inherited-dir-row"
                  />
                ) : 'f' in x && x.f ? (
                  <FileRowView
                    key={x.key}
                    id={id(i)}
                    f={x.f}
                    active={active === i}
                    picked={false}
                    checked={false}
                    onPress={(e) => onRowItself(e) && x.go()}
                    menu={fileActs(x.f)}
                    testid="inherited-file-row"
                  />
                ) : null,
              )}
        </div>
      )}
      {open && page && (
        <a className="pf-inh-all" href={filesHref(info.area)}>
          {t('All files of {area}', { area: name })}
          <I name="right" size={12} />
        </a>
      )}
    </section>
  );
}

function TrashList({
  area,
  write,
  data,
  error,
  count,
  onOpen,
}: {
  area: string;
  write: boolean;
  data: (Omit<FilesTrash, 'files'> & { files: TrashRow[] }) | undefined;
  error: Error | null;
  count: ReactNode;
  onOpen: (id: string) => void;
}) {
  const qc = useQueryClient();
  const [gone, setGone] = useState<ReadonlySet<string>>(new Set());
  const restore = useCallback(
    async (x: { id: string; path: string }, dir: boolean) => {
      setGone((g) => new Set([...g, x.id]));
      try {
        const back = await restoreFile(x.id);
        // a path taken meanwhile: it came back beside it, as "name (restored)"
        const at = back.path ?? x.path;
        toast(
          dir
            ? t('“{name}” is back, with everything in it', { name: nameOf(at) })
            : t('“{name}” is back in {where}', { name: nameOf(at), where: dirOf(at) ? spaced(dirOf(at)) : areaName(area) }),
          'ok',
        );
      } catch (e) {
        setGone((g) => {
          const next = new Set(g);
          next.delete(x.id);
          return next;
        });
        toastError(e);
      }
      void qc.invalidateQueries({ queryKey: fileKeys.area(area) });
    },
    [area, qc],
  );
  if (error && !data)
    return (
      <EmptyState art="error" titleAs="h2" title={t('The trash didn’t load')}>
        {error.message}
      </EmptyState>
    );
  const dirs = data?.dirs?.filter((d) => !gone.has(d.id)) ?? [];
  // a folder's files come back with it: listed under the folder, not on their own
  const inDir = (f: TrashRow) => (data?.dirs ?? []).some((d) => f.path.startsWith(`${d.path}/`) && d.trashed_at === f.trashed_at);
  const files = data?.files.filter((f) => !gone.has(f.id) && !inDir(f));
  if (files && !files.length && !dirs.length)
    return (
      <EmptyState art="clear" titleAs="h2" title={t('The trash is empty')} testId="files-trash-empty">
        {t('Files you trash stay here up to 30 days, then go for good: each says when. Trashing gives their space back at once.')}
      </EmptyState>
    );
  const restoreButton = (x: { id: string; path: string }, dir: boolean) =>
    write && (
      <button type="button" className="btn sm" onClick={() => void restore(x, dir)} data-testid="trash-restore">
        {t('Restore')}
      </button>
    );
  return (
    <>
      <Columns trash count={count} />
      <div className="pf-list trash" data-testid="files-trash">
        {!files ? (
          ['9em', '7em', '11em'].map((w) => <RowPending key={w} w={w} />)
        ) : (
          <>
            {dirs.map((d) => (
              <TrashRowView
                key={d.id}
                id={d.id}
                dir
                name={nameOf(d.path)}
                path={d.path}
                where={d.files ? t('{n} file|{n} files', { n: d.files }) : t('Empty folder')}
                purge={d.purge_at}
                bytes={d.files ? d.bytes : null}
                who={whoOf({ by: d.trashed_by, agent: d.trashed_agent })}
                at={d.trashed_at}
                action={restoreButton(d, true)}
              />
            ))}
            {files.map((f) => (
              <TrashRowView
                key={f.id}
                id={f.id}
                glyph={<KindIcon kind={f.kind} />}
                name={nameOf(f.path)}
                path={f.path}
                where={dirOf(f.path) ? t('from {where}', { where: spaced(dirOf(f.path)) }) : t('from the top')}
                purge={f.purge_at}
                bytes={f.size}
                who={whoOf({ by: f.trashed_by, agent: f.trashed_agent })}
                at={f.trashed_at}
                action={restoreButton(f, false)}
                onOpen={() => onOpen(f.id)}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

/**
 * A trashed file or folder, in the list's anatomy: what it is, its name with where it was and when it goes, its size,
 * who trashed it and when, Restore.
 */
function TrashRowView(p: {
  id: string;
  dir?: boolean;
  glyph?: ReactNode;
  name: string;
  path: string;
  where: string;
  purge: string;
  bytes: number | null;
  who: Who;
  at: string;
  action: ReactNode;
  onOpen?: () => void;
}) {
  const goes = t('goes {when}', { when: until(p.purge) });
  return (
    <div className={`pf-row ${p.dir ? 'dir' : ''}`} data-testid={p.dir ? 'trash-dir-row' : 'trash-row'} data-id={p.id}>
      <span className="pf-c pf-c-tick" />
      <span className="pf-c pf-c-lead">
        <span className="pf-thumb">
          <span className="pf-thumb-glyph">{p.dir ? <I name="folder" size={16} /> : p.glyph}</span>
        </span>
      </span>
      <span className="pf-c pf-c-name">
        {p.onOpen ? (
          <button type="button" className="pf-name pf-name-btn" title={p.path} onClick={p.onOpen}>
            {p.name}
          </button>
        ) : (
          <span className="pf-name" title={p.path}>
            {p.name}
          </span>
        )}
        <span className="pf-meta">
          {p.where} ·{' '}
          <span className="pf-v" title={new Date(p.purge).toLocaleString()}>
            {goes}
          </span>
        </span>
      </span>
      <span className="pf-c pf-c-size">{p.bytes !== null ? size(p.bytes) : ''}</span>
      <span className="pf-c pf-c-changed" title={new Date(p.at).toLocaleString()}>
        <WhoTag who={p.who} />
        <span className="pf-when"> · {ago(p.at)}</span>
      </span>
      <span className="pf-c pf-c-sub">{[...(p.bytes !== null ? [size(p.bytes)] : []), goes].join(' · ')}</span>
      <span className="pf-c pf-c-acts trash">{p.action}</span>
    </div>
  );
}

/** When a trashed file goes for good, in words: "in 23 days", "tomorrow". */
function until(iso: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
  return days <= 1 ? t('tomorrow') : t('in {n} days', { n: days });
}
