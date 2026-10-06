// References on a note: attach files (the paperclip, drag and drop, paste), add a link, reference a frame; what is
// picked waits in a row of tiles (the same boxes the note will show) until the note is saved, with upload progress.
// The composers ask through one paperclip menu (`AttachMenu`, a link in `LinkField` under the text); a note being
// edited keeps the row of buttons (`RefTools`).
import { type ClipboardEvent, type DragEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import { t } from '../i18n/index.ts';
import { toast } from '../lib/toast.ts';
import { Progress } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu, Popover } from '../ui/primitives.tsx';
import { FramePicker } from './FramePicker.tsx';
import { acceptsFile, type PendingRef, pendingKey } from './model.ts';
import '../styles/refs.css';

const MAX = 8;

/** Adds `url` as a pending link; false (and a toast) when it isn't one. */
function linkOf(pending: PendingRefs, url: string, client: boolean): boolean {
  const text = url.trim();
  if (!/^https?:\/\/\S+$/i.test(text)) {
    toast(client ? t('client::A link starts with https://') : t('A link starts with https://'), 'error');
    return false;
  }
  pending.add({ key: pendingKey(), kind: 'link', url: text, caption: '' });
  return true;
}

/** Pending references and the handlers a composer spreads on itself (drop, paste). */
export function usePendingRefs(client = false) {
  const [refs, setRefs] = useState<PendingRef[]>([]);
  const [progress, setProgress] = useState<Record<string, number>>({});
  const [dragging, setDragging] = useState(false);
  const urls = useRef<string[]>([]);
  useEffect(
    () => () => {
      for (const u of urls.current) URL.revokeObjectURL(u);
    },
    [],
  );
  const add = (r: PendingRef) =>
    setRefs((xs) => {
      if (xs.length >= MAX) {
        toast(client ? t('client::At most 8 references per note') : t('At most 8 references per note'), 'error');
        return xs;
      }
      return [...xs, r];
    });
  const addFiles = (files: Iterable<File>) => {
    for (const f of files) {
      if (!acceptsFile(f)) {
        toast(client ? t('client::Only images and videos can be references') : t('Only images and videos can be references'), 'error');
        continue;
      }
      const preview = f.type.startsWith('image/') ? URL.createObjectURL(f) : null;
      if (preview) urls.current.push(preview);
      add({ key: pendingKey(), kind: 'file', file: f, caption: '', preview });
    }
  };
  const drop = {
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return;
      e.preventDefault();
      setDragging(true);
    },
    onDragLeave: () => setDragging(false),
    onDrop: (e: DragEvent) => {
      if (!e.dataTransfer.files.length) return;
      e.preventDefault();
      setDragging(false);
      addFiles(e.dataTransfer.files);
    },
    onPaste: (e: ClipboardEvent) => {
      const files = [...e.clipboardData.files];
      if (!files.length) return;
      e.preventDefault();
      addFiles(files);
    },
  };
  return {
    refs,
    add,
    addFiles,
    remove: (key: string) => setRefs((xs) => xs.filter((x) => x.key !== key)),
    clear: () => setRefs([]),
    progress,
    onProgress: (key: string, share: number) => setProgress((p) => ({ ...p, [key]: share })),
    dragging,
    drop,
  };
}
export type PendingRefs = ReturnType<typeof usePendingRefs>;

interface RefToolsProps {
  pending: PendingRefs;
  /** The note's video (the frame picker starts there); none on client pages. */
  video?: { slug: string; name: string };
  client?: boolean;
  disabled?: boolean;
  /** More controls at the row's far end (the composer's "About the whole video"). */
  aside?: ReactNode;
}

export function RefTools({ pending, video, client = false, disabled, aside }: RefToolsProps) {
  const input = useRef<HTMLInputElement>(null);
  const [linkOpen, setLinkOpen] = useState(false);
  const [url, setUrl] = useState('');
  const [picking, setPicking] = useState(false);
  const addLink = () => {
    if (!linkOf(pending, url, client)) return;
    setUrl('');
    setLinkOpen(false);
  };
  return (
    <>
      <div className="ref-tools">
        <IconButton
          className="btn sm ghost icon-only"
          label={client ? t('client::Attach an image or a clip') : t('Attach an image or a clip')}
          icon="attach"
          size={15}
          onClick={() => input.current?.click()}
          disabled={disabled}
          data-testid="ref-attach"
        />
        <input
          ref={input}
          type="file"
          hidden
          multiple
          accept="image/png,image/jpeg,image/webp,image/gif,video/*"
          onChange={(e) => {
            if (e.target.files) pending.addFiles(e.target.files);
            e.target.value = '';
          }}
          data-testid="ref-file"
        />
        <Popover
          open={linkOpen}
          onOpenChange={setLinkOpen}
          align="start"
          trigger={
            <button type="button" className="btn sm ghost" disabled={disabled} data-testid="ref-link">
              <I name="link" size={14} /> {client ? t('client::Link') : t('Link')}
            </button>
          }
        >
          <form
            className="ref-link-form"
            onSubmit={(e) => {
              e.preventDefault();
              addLink();
            }}
          >
            <input
              className="input"
              type="url"
              placeholder="https://…"
              aria-label={client ? t('client::Link') : t('Link')}
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              autoFocus
            />
            <button type="submit" className="btn sm primary">
              {client ? t('client::Add link') : t('Add link')}
            </button>
          </form>
        </Popover>
        {video && (
          <button type="button" className="btn sm ghost" onClick={() => setPicking(true)} disabled={disabled} data-testid="ref-frame">
            <I name="film" size={14} /> {t('Frame…')}
          </button>
        )}
        {aside && (
          <>
            <span className="grow" />
            {aside}
          </>
        )}
      </div>
      <PendingList pending={pending} client={client} disabled={disabled} />
      {picking && video && <FramePicker slug={video.slug} name={video.name} onPick={pending.add} onClose={() => setPicking(false)} />}
    </>
  );
}

/** What waits to go with the note: the same tiles the note will show, with upload progress and a remove button. */
export function PendingList({ pending, client = false, disabled }: { pending: PendingRefs; client?: boolean; disabled?: boolean }) {
  if (!pending.refs.length) return null;
  return (
    <ul className="ref-pending" aria-label={client ? t('client::References to send') : t('References to send')}>
      {pending.refs.map((r) => (
        <li key={r.key} className={`ref ref-${r.kind === 'file' ? 'image' : r.kind}`} data-testid="ref-pending">
          <span className="ref-box">
            {r.kind === 'file' && r.preview && <img src={r.preview} alt="" />}
            {r.kind === 'file' && !r.preview && <I name="play" size={18} />}
            {r.kind === 'frame' && <img src={r.still} alt="" />}
            {r.kind === 'link' && <I name="link" size={18} />}
          </span>
          <span className="ref-cap" title={r.kind === 'file' ? r.file.name : r.kind === 'link' ? r.url : r.label}>
            {r.kind === 'file' ? r.file.name : r.kind === 'link' ? r.url.replace(/^https?:\/\/(www\.)?/, '') : r.label}
          </span>
          {pending.progress[r.key] !== undefined && (
            <Progress
              className="ref-progress"
              value={Math.round((pending.progress[r.key] || 0) * 100)}
              label={client ? t('client::Uploading') : t('Uploading')}
            />
          )}
          <IconButton
            className="btn ghost icon-only ref-remove"
            label={client ? t('client::Remove reference') : t('Remove reference')}
            icon="x"
            size={12}
            onClick={() => pending.remove(r.key)}
            disabled={disabled}
          />
        </li>
      ))}
    </ul>
  );
}

interface AttachMenuProps {
  pending: PendingRefs;
  /** The note's video (the frame picker starts there); none on client pages. */
  video?: { slug: string; name: string };
  client?: boolean;
  disabled?: boolean;
  /** "Link…": the composer shows its link field. */
  onLink: () => void;
  className?: string;
}

/** The composer's paperclip: one menu for an image or clip, a link and (in the team's player) another frame. */
export function AttachMenu({ pending, video, client = false, disabled, onLink, className = 'btn sm ghost icon-only' }: AttachMenuProps) {
  const input = useRef<HTMLInputElement>(null);
  const [picking, setPicking] = useState(false);
  const label = client ? t('client::Attach an image, a clip or a link') : t('Attach an image, a clip, a link or a frame');
  return (
    <>
      <Menu
        align="start"
        trigger={<IconButton className={className} label={label} icon="attach" size={15} disabled={disabled} data-testid="ref-attach" />}
        items={[
          { label: client ? t('client::Image or clip…') : t('Image or clip…'), icon: 'image', onClick: () => input.current?.click() },
          { label: client ? t('client::Link…') : t('Link…'), icon: 'link', onClick: onLink },
          video && { label: t('Frame from a video…'), icon: 'film', onClick: () => setPicking(true) },
        ]}
      />
      <input
        ref={input}
        type="file"
        hidden
        multiple
        accept="image/png,image/jpeg,image/webp,image/gif,video/*"
        onChange={(e) => {
          if (e.target.files) pending.addFiles(e.target.files);
          e.target.value = '';
        }}
        data-testid="ref-file"
      />
      {picking && video && <FramePicker slug={video.slug} name={video.name} onPick={pending.add} onClose={() => setPicking(false)} />}
    </>
  );
}

/** A link for the note, typed under its text: ↵ adds it, Esc (or ×) puts the field away without closing the composer. */
export function LinkField({ pending, client = false, onClose }: { pending: PendingRefs; client?: boolean; onClose: () => void }) {
  const [url, setUrl] = useState('');
  return (
    <form
      className="ref-link-row"
      onSubmit={(e) => {
        e.preventDefault();
        if (linkOf(pending, url, client)) onClose();
      }}
    >
      <I name="link" size={14} />
      <input
        className="input sm"
        type="url"
        placeholder="https://…"
        aria-label={client ? t('client::Link') : t('Link')}
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key !== 'Escape') return;
          e.preventDefault();
          e.stopPropagation();
          onClose();
        }}
        autoFocus
      />
      <button type="submit" className="btn sm">
        {client ? t('client::Add link') : t('Add link')}
      </button>
      <IconButton className="btn sm ghost icon-only" label={client ? t('client::Cancel') : t('Cancel')} icon="x" size={13} onClick={onClose} />
    </form>
  );
}
