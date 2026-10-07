// The Files tab (design §6.1): a calm list of an area's material — a project's, a folder's, or the House's (Settings →
// Files) — beside its videos and its playbook. One line of numbers (its files, what it inherits), search, Add files
// (the one primary), then the folder you are in, the kinds to narrow it to and the order; the rows (folders, files,
// what is on its way), what it inherits folded under them, and at the foot its trash and what the plan holds. Files
// and folders dropped anywhere on the tab are checked before a byte moves (Check.tsx) and go to the upload tray.
// Keys: ↑↓ (⇧ to pick), ↵ opens, Space looks, ⌫ trashes with Undo, ⌘A picks all, Esc. A file opens beside the list
// (FileSheet.tsx). Reviewers never see this (the tab isn't there, the API answers 404). Loaded on demand with its styles.
import { useQueryClient } from '@tanstack/react-query';
import { type KeyboardEvent, type MouseEvent, type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { dirOf, nameOf } from '../../../lib/fileText.ts';
import { can as roleCan } from '../../../lib/permissions.ts';
import type { FileAreaInfo, FileDirInfo, FileKind, FilesTrash, TrashedDirInfo } from '../../../lib/types.ts';
import { useAuthStatus, useCan, useLikelyRole } from '../api/auth.ts';
import { useSSE } from '../api/events.ts';
import { useBilling, useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { ago, pct } from '../lib/format.ts';
import { useScrollEdges } from '../lib/hooks.ts';
import { usePhone, useTouch } from '../lib/media.ts';
import { copyText, later, toast, toastError, toastUndo } from '../lib/toast.ts';
import { Code } from '../settings/parts.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
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
  useFilesSummary,
  useFilesTrash,
} from './api.ts';
import { CheckSheet } from './Check.tsx';
import { MoveDialog, NameDialog, takenIn } from './Dialogs.tsx';
import { draggingFiles, fromDrop, fromInput, type Gathered } from './drop.ts';
import { type FileActs, FileSheet } from './FileSheet.tsx';
import {
  between,
  crumbsOf,
  type FileRow,
  KINDS,
  kindWords,
  mcpCall,
  pullCommand,
  pushCommand,
  type SortBy,
  size,
  sortDirs,
  sortFiles,
  spaced,
  type TrashRow,
  whoOf,
} from './model.ts';
import { Columns, DirRowView, FileRowView, GoingRowView, RowPending, WhoTag } from './Rows.tsx';
import { filesHref, noteOpen, useFilesAt } from './route.ts';
import { bindFileUploads, type FileUpload, useFileUploads } from './uploadStore.ts';
import '../styles/files.css';

// ---------------------------------------------------------------- small pieces

const SORT_KEY = 'vr.files.sort';
function useSort(): [SortBy, (s: SortBy) => void] {
  const [sort, setSort] = useState<SortBy>(() => {
    try {
      const v = localStorage.getItem(SORT_KEY);
      return v === 'size' || v === 'changed' ? v : 'name';
    } catch {
      return 'name';
    }
  });
  return [
    sort,
    (s) => {
      setSort(s);
      try {
        localStorage.setItem(SORT_KEY, s);
      } catch {}
    },
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

/** The page's numbers on one line: this area's files and size, then what it inherits (each a way there). */
function Count({ areas, area }: { areas: FileAreaInfo[] | undefined; area: string }) {
  const own = areas?.find((a) => a.area === area);
  const above = areas?.filter((a) => a.area !== area && a.files > 0) ?? [];
  return (
    <p className="pf-count" data-testid="files-count">
      {own ? (
        <>
          <b>{own.files}</b> {t('file|files', { n: own.files })}
          {own.files > 0 && (
            <>
              {' · '}
              <b>{size(own.bytes)}</b>
            </>
          )}
        </>
      ) : areas ? (
        t('No files yet')
      ) : (
        <SkLine w="9em" />
      )}
      {above.map((a) => (
        <span key={a.area} className="pf-count-up">
          {' · '}
          <a href={filesHref(a.area)} title={t('{n} file from {area}|{n} files from {area}', { n: a.files, area: areaName(a.area) })}>
            {areaName(a.area)} <b>{a.files}</b>
          </a>
        </span>
      ))}
    </p>
  );
}

/** Where the page is in the area: its name, then the folders down to here, each a way back up. */
function Crumbs({ area, path, trash }: { area: string; path: string; trash: boolean }) {
  const parts = crumbsOf(path);
  return (
    <nav className="pf-crumbs" aria-label={t('Where in the files')}>
      <a className={`pf-crumb ${!parts.length && !trash ? 'here' : ''}`} href={filesHref(area)} aria-current={!parts.length && !trash ? 'page' : undefined}>
        <I name="files" size={14} />
        {areaName(area)}
      </a>
      {parts.map(([name, to], i) => (
        <span key={to} className="pf-crumb-step">
          <I name="right" size={12} className="pf-crumb-sep" />
          <a
            className={`pf-crumb ${i === parts.length - 1 ? 'here' : ''}`}
            href={filesHref(area, { path: to })}
            aria-current={i === parts.length - 1 ? 'page' : undefined}
          >
            {name}
          </a>
        </span>
      ))}
      {trash && (
        <span className="pf-crumb-step">
          <I name="right" size={12} className="pf-crumb-sep" />
          <span className="pf-crumb here" aria-current="page">
            <I name="trash" size={14} />
            {t('Trash')}
          </span>
        </span>
      )}
    </nav>
  );
}

// ---------------------------------------------------------------- the page

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
  const me = useAuthStatus().data?.user?.name ?? null;
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
  const [sort, setSort] = useSort();
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
      sort,
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
      sort,
    ).map((x) => x.row);
    return [...dirRows, ...mixed];
  }, [pages, searching, uploads, batches, area, path, sort, hidden, listedAt]);

  const order = useMemo(() => rows.filter((r) => r.kind !== 'going').map((r) => r.key), [rows]);
  const byKey = useMemo(() => new Map(rows.map((r) => [r.key, r])), [rows]);
  const files = useMemo(() => rows.flatMap((r) => (r.kind === 'file' ? [r.f] : [])), [rows]);

  // ---- selection, keys and the sheet
  const [active, setActive] = useState<string | null>(null);
  const [checked, setChecked] = useState<ReadonlySet<string>>(new Set());
  const [opened, setOpened] = useState<{ id: string; area: string; focus: boolean } | null>(at.open ? { id: at.open, area, focus: false } : null);
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
    if ((e.target as Element).closest('.pf-c-acts, .pf-tick, a')) return;
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

  const [dialog, setDialog] = useState<Dialog>(null);
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
    write && { label: t('Rename'), icon: 'edit', onClick: () => acts.rename(f) },
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
    write && !!r.d.id && { label: t('Rename'), icon: 'edit', onClick: () => setDialog({ kind: 'rename', row: r }) },
    write && !!r.d.id && { label: t('Move to…'), icon: 'moveTo', onClick: () => setDialog({ kind: 'move', keys: [r.key] }) },
    'sep',
    write && !!r.d.id && { label: t('Trash'), icon: 'trash', danger: true, shortcut: '⌫', onClick: () => trashKeys([r.key]) },
  ];

  // ---- the keys (on the list)
  const onKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if ((e.target as Element).closest('input, textarea, [role=menu]')) return;
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
    if (e.key === 'ArrowDown') go(i + 1, e.shiftKey);
    else if (e.key === 'ArrowUp' && e.metaKey && path) {
      e.preventDefault();
      enter(dirOf(path));
    } else if (e.key === 'ArrowUp') go(i < 0 ? 0 : i - 1, e.shiftKey);
    else if (e.key === 'Home') go(0, false);
    else if (e.key === 'End') go(order.length - 1, false);
    else if (e.key === 'Enter' && r) {
      e.preventDefault();
      if (r.kind === 'dir') enter(r.d.path);
      else if (r.kind === 'file') open(r.f.id, { focus: true });
    } else if (e.key === ' ' && r?.kind === 'file') {
      e.preventDefault();
      open(opened?.id === r.f.id ? null : r.f.id);
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

  // ---- the plan and the trash, in numbers
  const own = summary.data?.areas.find((a) => a.area === area);
  // (the plan's storage counts files too; `files` says how much of it they are)
  const usage = billing?.usage;
  const limit = billing?.limits.bytes ?? null;
  const share = limit && usage ? usage.bytes / limit : null;
  const near = share !== null && share >= 0.8;

  const loading = !pending && !at.trash && !pages && !list.error;
  const showCols = !phone;
  const empty = !!pages && !rows.length && !searching;
  const inherited = !path && !searching && !at.trash ? (summary.data?.areas.filter((a) => a.area !== area && a.files > 0) ?? []) : [];
  const [kindsRef, kindsEdges] = useScrollEdges<HTMLDivElement>();
  // the kinds there are here: the area's, or inside a folder the kinds of its top folder (the summary's tops)
  const tops = summary.data?.areas.find((a) => a.area === area)?.tops ?? [];
  const top = path ? `${path.split('/')[0]}/` : null;
  const present = new Set(tops.filter((x) => !top || x.path === top).flatMap((x) => x.kinds));
  const kinds = KINDS.filter((k) => present.has(k) || k === kind);
  const kindsWait = !summary.data && !summary.error;
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
        <div className="pf-head">
          <Count areas={summary.data?.areas} area={area} />
          {near && (
            <a className="pf-quota" href="#/settings/billing" data-testid="files-quota-near">
              <KeyGlyph shape={share >= 1 ? 'diamond' : 'half'} size={10} />
              {share >= 1 ? t('Storage full') : t('{pct} of storage used', { pct: pct(share) })}
            </a>
          )}
          {/* (the trash has no search: it is one short list) */}
          {!at.trash && (
            <label className="pf-search">
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
                <IconButton className="pf-search-clear" label={t('Clear the search')} shortcut="Esc" icon="x" size={13} onClick={() => setTyped('')} />
              ) : (
                <kbd className="kbd">/</kbd>
              )}
            </label>
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
        <div className="pf-bar">
          <Crumbs area={area} path={path} trash={at.trash} />
          {!at.trash && (
            <>
              <div className={`pf-kinds ${kindsEdges}`} ref={kindsRef}>
                {/* until the summary says which kinds there are, All holds their line (a phone's own: nothing moves) */}
                {(kinds.length > 1 || kindsWait) && (
                  <Segmented
                    label={t('Kind')}
                    className="pf-kind-chips"
                    value={kind || 'all'}
                    onChange={(k) => setKind(k === 'all' ? '' : (k as FileKind))}
                    options={[{ value: 'all', label: t('All') }, ...(kinds.length > 1 ? kinds : []).map((k) => ({ value: k, label: kindWords(k) }))]}
                  />
                )}
              </div>
              <Menu
                trigger={
                  <Tip content={t('Order')}>
                    <button type="button" className="btn ghost sm pf-sort" aria-label={t('Order')} data-testid="files-sort">
                      <I name="sortable" size={14} />
                      <span className="pf-sort-label">{sort === 'size' ? t('Size') : sort === 'changed' ? t('Last changed') : t('Name')}</span>
                    </button>
                  </Tip>
                }
                items={[
                  { label: t('Name'), checked: sort === 'name', onClick: () => setSort('name') },
                  { label: t('Size'), checked: sort === 'size', onClick: () => setSort('size') },
                  { label: t('Last changed'), checked: sort === 'changed', onClick: () => setSort('changed') },
                ]}
              />
            </>
          )}
        </div>

        {at.trash ? (
          <TrashList area={area} write={write} data={trash.data} error={trash.error} onOpen={(id) => open(id)} />
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
        ) : (
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
            data-testid="files-list"
          >
            {showCols && <Columns />}
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
                const look = { active: active === r.key, picked: r.kind === 'file' && opened?.id === r.f.id, checked: checked.has(r.key) };
                if (r.kind === 'going') return <GoingRowView key={r.key} u={r.u} id={`pf-${r.key}`} />;
                if (r.kind === 'dir')
                  return (
                    <DirRowView
                      key={r.key}
                      id={rowId(r.key)}
                      d={r.d}
                      going={r.going}
                      {...look}
                      onPress={(e) => press(r, e)}
                      onCheck={write || !phone ? () => toggle(r.key) : undefined}
                      menu={dirMenu(r)}
                    />
                  );
                return (
                  <FileRowView
                    key={r.key}
                    id={rowId(r.key)}
                    f={r.f}
                    upload={r.upload}
                    showDir={searching}
                    {...look}
                    onPress={(e) => press(r, e)}
                    onCheck={() => toggle(r.key)}
                    menu={fileMenu(r.f)}
                    quick={
                      <IconButton
                        className="btn ghost sm icon-only pf-dl"
                        label={t('Download {name}', { name: nameOf(r.f.path) })}
                        icon="download"
                        size={14}
                        tabIndex={-1}
                        onClick={() => download(r.f.id)}
                      />
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
        )}

        {!at.trash && inherited.map((a, i) => <Inherited key={a.area} info={a} here={i === 0 ? area : null} onOpen={(id) => open(id, { area: a.area })} />)}

        {/* (once the area's numbers are here: nothing under the rows moves while they load) */}
        {summary.data && (
          <div className="pf-foot">
            {at.trash ? (
              <a className="pf-foot-link" href={filesHref(area, { path })}>
                <I name="back" size={14} />
                {t('Back to the files')}
              </a>
            ) : (
              // the area's trash, at its top
              !path &&
              own &&
              own.trash > 0 && (
                <a className="pf-foot-link" href={filesHref(area, { trash: true })} data-testid="files-trash-link">
                  <I name="trash" size={14} />
                  {t('Trash · {n} file · {size}, not counted|Trash · {n} files · {size}, not counted', { n: own.trash, size: size(own.trash_bytes) })}
                </a>
              )
            )}
            {usage && limit !== null && (
              <span className={`pf-usage ${near ? 'near' : ''}`} data-testid="files-usage">
                {usage.files
                  ? t('Files {files} · videos {videos} · {used} of {limit} in use', {
                      files: size(usage.files.bytes),
                      videos: size(Math.max(0, usage.bytes - usage.files.bytes)),
                      used: size(usage.bytes),
                      limit: size(limit),
                    })
                  : t('{used} of {limit} in use', { used: size(usage.bytes), limit: size(limit) })}
                {usage.files && usage.files.kept > 0 && (
                  <span className="pf-usage-kept">{t(' · trash and older versions {size}, not counted', { size: size(usage.files.kept) })}</span>
                )}
              </span>
            )}
          </div>
        )}
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
            // the head's Add files is the page's one primary
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
  return (
    <div className="pf-empty" data-testid="files-empty">
      <EmptyState
        art="folder"
        size={small ? 'sm' : 'md'}
        titleAs="h2"
        title={t('No files yet')}
        action={
          write && (
            // the head's Add files is the page's one primary
            <Button icon="upload" onClick={onAdd}>
              {t('Add files')}
            </Button>
          )
        }
        tips={write ? [t('Drop files and folders anywhere on this page')] : undefined}
      >
        {t('Footage, music, fonts and project files: your team and its agents work from the same material.')}
      </EmptyState>
      {write && (
        <div className="pf-empty-cli">
          <p>{t('From a terminal, or an agent:')}</p>
          <Code>{pushCommand(area, '', './<folder>')}</Code>
        </div>
      )}
    </div>
  );
}

/** What this area inherits from one above (the playbook's way): folded to a line, open to its top-level files. */
/** `here`: the area it is inherited into, said on the first of them (who wins where a path is the same). */
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
  return (
    <section className={`pf-inh ${open ? 'open' : ''}`} aria-label={t('From {area}', { area: name })} data-testid="files-inherited" data-area={info.area}>
      <button type="button" className="pf-inh-head" aria-expanded={open} onClick={() => setOpen((o) => !o)} data-testid="files-inherited-head">
        <KeyGlyph shape="half" size={10} />
        <span className="pf-inh-from">{t('From {area}', { area: name })}</span>
        <span className="pf-inh-facts">
          {t('{n} file|{n} files', { n: info.files })} · {size(info.bytes)}
        </span>
        <span className="pf-inh-note">{here !== null ? t('{area} wins where a path is the same', { area: areaName(here) }) : ''}</span>
        <I name="down" size={14} className={`pf-inh-chev ${open ? 'up' : ''}`} />
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
                    onPress={x.go}
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
                    onPress={(e) => !(e.target as Element).closest('.pf-c-acts') && x.go()}
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
  onOpen,
}: {
  area: string;
  write: boolean;
  data: (Omit<FilesTrash, 'files'> & { files: TrashRow[] }) | undefined;
  error: Error | null;
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
    <div className="pf-list trash" data-testid="files-trash">
      <p className="pf-trash-note">
        {data ? (
          t('{n} file · {size} · kept up to 30 days, not counted|{n} files · {size} · kept up to 30 days, not counted', {
            n: data.files.length,
            size: size(data.bytes),
          })
        ) : (
          <SkLine w="14em" />
        )}
      </p>
      <Columns trash />
      {!files ? (
        ['9em', '7em', '11em'].map((w) => <RowPending key={w} w={w} />)
      ) : (
        <>
          {dirs.map((d) => (
            <TrashDirRow key={d.id} d={d} action={restoreButton(d, true)} />
          ))}
          {files.map((f) => (
            <div key={f.id} className="pf-row" data-testid="trash-row" data-id={f.id}>
              <span className="pf-c pf-c-lead">
                <span className="pf-glyph">
                  <KindIcon kind={f.kind} />
                </span>
              </span>
              <span className="pf-c pf-c-name">
                <button type="button" className="pf-name pf-name-btn" title={f.path} onClick={() => onOpen(f.id)}>
                  {nameOf(f.path)}
                </button>
              </span>
              <span className="pf-c pf-c-kind">
                <span className="pf-kind">{dirOf(f.path) ? spaced(dirOf(f.path)) : t('At the top')}</span>
                <span className="pf-v" title={new Date(f.purge_at).toLocaleString()}>
                  {t('goes {when}', { when: until(f.purge_at) })}
                </span>
              </span>
              <span className="pf-c pf-c-size">{size(f.size)}</span>
              <span className="pf-c pf-c-who">
                <WhoTag who={whoOf({ by: f.trashed_by, agent: f.trashed_agent })} />
              </span>
              <span className="pf-c pf-c-when">{ago(f.trashed_at)}</span>
              <span className="pf-c pf-c-sub">{`${size(f.size)} · ${t('goes {when}', { when: until(f.purge_at) })}`}</span>
              <span className="pf-c pf-c-acts trash">{restoreButton(f, false)}</span>
            </div>
          ))}
        </>
      )}
    </div>
  );
}

function TrashDirRow({ d, action }: { d: TrashedDirInfo; action: ReactNode }) {
  return (
    <div className="pf-row dir" data-testid="trash-dir-row" data-id={d.id}>
      <span className="pf-c pf-c-lead">
        <span className="pf-glyph">
          <I name="folder" size={16} />
        </span>
      </span>
      <span className="pf-c pf-c-name">
        <span className="pf-name" title={d.path}>
          {nameOf(d.path)}
        </span>
      </span>
      <span className="pf-c pf-c-kind">
        <span className="pf-kind">{d.files ? t('{n} file|{n} files', { n: d.files }) : t('Empty folder')}</span>
        <span className="pf-v" title={new Date(d.purge_at).toLocaleString()}>
          {t('goes {when}', { when: until(d.purge_at) })}
        </span>
      </span>
      <span className="pf-c pf-c-size">{d.files ? size(d.bytes) : ''}</span>
      <span className="pf-c pf-c-who">
        <WhoTag who={whoOf({ by: d.trashed_by, agent: d.trashed_agent })} />
      </span>
      <span className="pf-c pf-c-when">{ago(d.trashed_at)}</span>
      <span className="pf-c pf-c-sub">{`${d.files ? `${t('{n} file|{n} files', { n: d.files })} · ` : ''}${t('goes {when}', { when: until(d.purge_at) })}`}</span>
      <span className="pf-c pf-c-acts trash">{action}</span>
    </div>
  );
}

/** When a trashed file goes for good, in words: "in 23 days", "tomorrow". */
function until(iso: string): string {
  const days = Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));
  return days <= 1 ? t('tomorrow') : t('in {n} days', { n: days });
}
