// A file, opened beside the list (a sheet at the window's right edge; on a phone, the bottom sheet every dialog is
// there): a look at it where the browser can show it cheaply (pictures, video, sound, PDF, the first 32 KB of a text
// file; anything else its kind's glyph), what it is, every version kept — who made it, when, an agent's marked as such —
// with Restore and Download, and what can be done to it. The list stays where it was: the sheet floats over its end.
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState } from 'react';
import { FILE_LIMITS, inlineType } from '../../../lib/fileText.ts';
import type { FileHistory, FileKind } from '../../../lib/types.ts';
import { ApiError } from '../api/client.ts';
import { locale, t } from '../i18n/index.ts';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { KindIcon } from '../ui/kindIcons.tsx';
import { IconButton, Menu, type MenuEntry, Modal } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Button, EmptyState } from '../ui/system.tsx';
import { download, fileKeys, inlineUrl, refreshArea, restoreFile, useFileHistory } from './api.ts';
import { againAt, type FileRow, nameOf, size, spaced, typeLabel, type VersionRow, whoOf } from './model.ts';
import { WhoTag } from './Rows.tsx';

export interface FileActs {
  rename: (f: FileRow) => void;
  move: (f: FileRow) => void;
  trash: (f: FileRow) => void;
  copy: (f: FileRow) => void;
}

/** "2 Oct, 14:02" (this year), "2 Oct 2025, 14:02" (before). */
export function when(iso: string): string {
  const d = new Date(iso);
  const thisYear = d.getFullYear() === new Date().getFullYear();
  return d.toLocaleString(locale(), { day: 'numeric', month: 'short', ...(thisYear ? {} : { year: 'numeric' }), hour: '2-digit', minute: '2-digit' });
}

/**
 * What the browser can show of a file: what its bytes say (`type`, never its name) and what kind of file it is both
 * have to agree — an After Effects project whose bytes happen to read as text is still a project file, never shown.
 */
type Look = 'image' | 'video' | 'audio' | 'pdf' | 'text' | null;
export function lookOf(type: string, kind: FileKind): Look {
  // what the server serves inline at all (lib/fileText.ts), and only where its kind agrees
  if (!inlineType(type)) return null;
  if (kind === 'image' && type.startsWith('image/')) return 'image';
  if (kind === 'footage' && /^video\/(mp4|quicktime|webm)$/.test(type)) return 'video';
  if (kind === 'audio' && type.startsWith('audio/')) return 'audio';
  if (kind === 'document' && type === 'application/pdf') return 'pdf';
  if (kind === 'document' && type === 'text/plain') return 'text';
  return null;
}

/** The first 32 KB of a text file, as text (never as a page). */
function TextLook({ url }: { url: string }) {
  const [text, setText] = useState<string | null>(null);
  const [cut, setCut] = useState(false);
  useEffect(() => {
    const ctl = new AbortController();
    setText(null);
    fetch(url, { headers: { Range: 'bytes=0-32767' }, signal: ctl.signal })
      .then(async (r) => {
        const buf = await r.arrayBuffer();
        setCut(buf.byteLength >= 32768 || r.status === 206);
        setText(new TextDecoder().decode(buf.slice(0, 32768)));
      })
      .catch(() => !ctl.signal.aborted && setText(''));
    return () => ctl.abort();
  }, [url]);
  return (
    <div className="pf-pv-text" data-testid="file-preview-text">
      {text === null ? <SkLine w="60%" /> : <pre>{text}</pre>}
      {cut && <p className="pf-pv-cut">{t('The first 32 KB')}</p>}
    </div>
  );
}

function Preview({ f }: { f: FileRow }) {
  const look = lookOf(f.type, f.kind);
  const url = inlineUrl(f.id, f.v);
  return (
    <div className={`pf-pv ${look ?? 'none'}`} data-testid="file-preview" data-look={look ?? 'none'}>
      {look === 'image' ? (
        <img src={url} alt={nameOf(f.path)} key={url} />
      ) : look === 'video' ? (
        <video src={url} key={url} controls preload="metadata" playsInline>
          <track kind="captions" />
        </video>
      ) : look === 'audio' ? (
        <div className="pf-pv-audio">
          <KindIcon kind="audio" size={28} />
          <audio src={url} key={url} controls preload="metadata">
            <track kind="captions" />
          </audio>
        </div>
      ) : look === 'pdf' ? (
        // never framed (no answer of this server may be): Chrome's viewer in a tab of its own. The link is the app's
        // route, which hands out a fresh sealed URL on each click; a sealed URL never sits in the page
        <div className="pf-pv-none pf-pv-pdf">
          <KindIcon kind={f.kind} size={32} />
          <span>{typeLabel(f.path, f.kind)}</span>
          <span className="pf-pv-acts">
            <a className="btn sm" href={url} target="_blank" rel="noopener noreferrer" data-testid="file-pdf-open">
              <I name="external" size={14} /> {t('Open')}
            </a>
            <button type="button" className="btn sm" onClick={() => download(f.id, f.v)} data-testid="file-pdf-download">
              <I name="download" size={14} /> {t('Download')}
            </button>
          </span>
        </div>
      ) : look === 'text' ? (
        <TextLook url={url} />
      ) : (
        <div className="pf-pv-none">
          <KindIcon kind={f.kind} size={32} />
          <span>{typeLabel(f.path, f.kind)}</span>
          <span className="pf-pv-why">{t('No preview in the browser: download it to open it')}</span>
        </div>
      )}
    </div>
  );
}

/** One version: which, who and how, when, how big, and what can be done with it. */
function Version({ x, f, write, busy, onRestore }: { x: VersionRow; f: FileRow; write: boolean; busy: boolean; onRestore: () => void }) {
  const who = whoOf(x);
  return (
    <li className={`pf-ver ${x.current ? 'current' : ''}`} data-testid="file-version" data-v={x.v}>
      <span className="pf-ver-v">V{x.v}</span>
      <span className="pf-ver-who">
        <WhoTag who={who} size={16} />
        {who.agent && (
          <span className="pf-ver-via" title={t('{agent}, the agent {name} works with', { agent: who.name, name: x.by })}>
            {t('via agent')}
          </span>
        )}
      </span>
      <span className="pf-ver-when" title={x.kept_until ? t('Kept until {date}', { date: when(x.kept_until) }) : undefined}>
        {when(x.at)}
      </span>
      <span className="pf-ver-size">{size(x.size)}</span>
      <span className="pf-ver-acts">
        {x.current ? (
          <span className="pf-ver-now">{t('current')}</span>
        ) : (
          <>
            <IconButton
              className="btn ghost sm icon-only"
              label={t('Download V{v}', { v: x.v })}
              icon="download"
              size={14}
              onClick={() => download(f.id, x.v)}
            />
            {write && (
              <button type="button" className="btn ghost sm" disabled={busy} onClick={onRestore} data-testid="file-restore-version">
                {t('Restore')}
              </button>
            )}
          </>
        )}
      </span>
    </li>
  );
}

function VersionsPending() {
  return (
    <ol className="pf-vers" aria-hidden="true">
      {[0, 1].map((i) => (
        <li key={i} className="pf-ver pending">
          <span className="pf-ver-v">
            <SkLine w="1.6em" />
          </span>
          <span className="pf-ver-who">
            <SkLine w="6em" />
          </span>
          <span className="pf-ver-when">
            <SkLine w="5em" />
          </span>
          <span className="pf-ver-size">
            <SkLine w="3em" />
          </span>
          <span className="pf-ver-acts" />
        </li>
      ))}
    </ol>
  );
}

function Body({ f, area, write, history }: { f: FileRow; area: string; write: boolean; history: FileHistory | undefined }) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  const dir = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
  const restore = async (v: number) => {
    setBusy(true);
    const key = fileKeys.history(f.id);
    const before = qc.getQueryData<FileHistory>(key);
    // shown at once: the old version comes back as the newest
    if (before) {
      const old = before.versions.find((x) => x.v === v);
      const next = Math.max(...before.versions.map((x) => x.v)) + 1;
      if (old)
        qc.setQueryData<FileHistory>(key, {
          ...before,
          versions: [
            { ...old, v: next, current: true, at: new Date().toISOString(), kept_until: undefined },
            ...before.versions.map((x) => ({ ...x, current: undefined })),
          ],
        });
    }
    try {
      const now = await restoreFile(f.id, v);
      toast(t('V{old} is the newest again, as V{v}', { old: v, v: now.v }), 'ok');
      void qc.invalidateQueries({ queryKey: key });
      void refreshArea(qc, area);
    } catch (e) {
      if (before) qc.setQueryData(key, before);
      // the day's versions are each account's own: said in the person's words, with when (the server's is for agents)
      if (e instanceof ApiError && e.status === 429) {
        const wait = e.retryAfter ?? Number(e.details.retry_after ?? 0);
        toast(
          t('You made {n} versions of this file today: it takes the next from you {when}. Download V{v} to add it under another name now.', {
            n: FILE_LIMITS.versionsPerDay,
            when: againAt(Date.now() + wait * 1000),
            v,
          }),
          'error',
        );
      } else toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Preview f={f} />
      <dl className="pf-sh-facts">
        <div>
          <dt>{t('Kind')}</dt>
          <dd>{typeLabel(f.path, f.kind)}</dd>
        </div>
        <div>
          <dt>{t('Size')}</dt>
          <dd>{size(f.size)}</dd>
        </div>
        <div>
          <dt>{t('Where')}</dt>
          <dd>{dir ? spaced(dir) : t('At the top')}</dd>
        </div>
        <div>
          <dt>{t('Added by')}</dt>
          <dd>{f.added_by}</dd>
        </div>
        <div>
          <dt>{t('Fingerprint')}</dt>
          <dd>
            <button
              type="button"
              className="pf-sha mono"
              title={t('SHA-256 of its bytes: copy it')}
              onClick={async () => (await copyText(f.sha256)) && toast(t('Copied'), 'ok')}
            >
              {f.sha256.slice(0, 8)}…{f.sha256.slice(-4)}
            </button>
          </dd>
        </div>
      </dl>
      <section className="pf-sh-sec" aria-labelledby={`${f.id}-vers`}>
        <h3 id={`${f.id}-vers`} className="pf-sh-label">
          {t('Versions')}
          {history && <span className="pf-sh-n">{history.versions.length}</span>}
        </h3>
        {history ? (
          <ol className="pf-vers">
            {history.versions.map((x) => (
              <Version key={x.v} x={x} f={f} write={write} busy={busy} onRestore={() => void restore(x.v)} />
            ))}
          </ol>
        ) : (
          <VersionsPending />
        )}
        <p className="pf-sh-note">{t('Older versions are kept up to 30 days after they were replaced, and don’t count toward the plan.')}</p>
      </section>
    </>
  );
}

function menuOf(f: FileRow, write: boolean, trash: boolean, act: FileActs): MenuEntry[] {
  return [
    write && { label: t('Rename'), icon: 'edit', onClick: () => act.rename(f) },
    write && { label: t('Move to…'), icon: 'moveTo', onClick: () => act.move(f) },
    'sep',
    trash && { label: t('Trash'), icon: 'trash', danger: true, shortcut: '⌫', onClick: () => act.trash(f) },
  ];
}

export function FileSheet({
  id,
  row,
  area,
  write,
  phone,
  focus,
  act,
  mayTrash = false,
  onClose,
}: {
  id: string;
  row: FileRow | null;
  area: string;
  write: boolean;
  phone: boolean;
  /** Opened from the keys (↵): the sheet takes the focus. */
  focus: boolean;
  act: FileActs;
  /** It may go to the trash from here (a member's own file; anyone's for owners and admins). */
  mayTrash?: boolean;
  onClose: () => void;
}) {
  const h = useFileHistory(id);
  const f: FileRow | null = row ?? (h.data?.file as FileRow | undefined) ?? null;
  // an address naming a file that isn't here (moved, trashed, another workspace's): said, with the way back
  const missing = !f && h.error ? <Missing error={h.error} onClose={onClose} onRetry={() => void h.refetch()} /> : null;
  const title = useId();
  const box = useRef<HTMLElement>(null);
  useEffect(() => {
    if (focus) box.current?.focus();
  }, [focus]);
  const foot = f && (
    <>
      <button type="button" className="btn" onClick={() => download(f.id)} data-testid="file-download">
        <I name="download" size={16} /> {t('Download')}
      </button>
      <button type="button" className="btn" onClick={() => act.copy(f)} data-testid="file-copy-agent">
        <I name="copy" size={16} /> {t('Copy for an agent')}
      </button>
      {write && (
        <Menu
          trigger={<IconButton className="btn icon-only pf-sh-more" label={t('More for {name}', { name: nameOf(f.path) })} icon="more" />}
          items={menuOf(f, write, mayTrash, act)}
        />
      )}
    </>
  );
  if (phone)
    return (
      <Modal title={f ? nameOf(f.path) : t('File')} onClose={onClose} foot={foot}>
        <div className="pf-sh-body" data-testid="file-sheet">
          {f ? <Body f={f} area={area} write={write} history={h.data} /> : (missing ?? <VersionsPending />)}
        </div>
      </Modal>
    );
  return (
    <aside
      ref={box}
      className="pf-sheet"
      role="dialog"
      aria-modal="false"
      aria-labelledby={title}
      tabIndex={-1}
      data-testid="file-sheet"
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          onClose();
        }
      }}
    >
      <header className="pf-sh-head">
        <span className="pf-sh-glyph">{f ? <KindIcon kind={f.kind} size={18} /> : <KeyGlyph shape="outline" size={10} />}</span>
        <h2 id={title} className="pf-sh-title" title={f?.path}>
          {f ? nameOf(f.path) : missing ? t('File') : <SkLine w="10em" />}
        </h2>
        <IconButton className="btn ghost icon-only" label={t('Close')} shortcut="Esc" icon="x" size={16} onClick={onClose} data-testid="file-sheet-close" />
      </header>
      <div className="pf-sh-body">{f ? <Body f={f} area={area} write={write} history={h.data} /> : (missing ?? <VersionsPending />)}</div>
      {foot && <footer className="pf-sh-foot">{foot}</footer>}
    </aside>
  );
}

/** The file an address names isn't here (404), or didn't load: said in the sheet's place, with the way back. */
function Missing({ error, onClose, onRetry }: { error: Error; onClose: () => void; onRetry: () => void }) {
  const gone = error instanceof ApiError && error.status === 404;
  return (
    <EmptyState
      art={gone ? 'filter' : 'error'}
      size="sm"
      title={gone ? t('This file isn’t here') : t('The file didn’t load')}
      testId="file-sheet-missing"
      action={
        <Button onClick={onClose} data-testid="file-sheet-back">
          {t('Back to the files')}
        </Button>
      }
      secondary={
        gone ? undefined : (
          <Button variant="ghost" icon="refresh" onClick={onRetry}>
            {t('Try again')}
          </Button>
        )
      }
    >
      {gone ? t('It may have been moved, renamed or put in the trash, or it belongs to another workspace.') : error.message}
    </EmptyState>
  );
}
