// Quick Look (Space, or a click on a picture): a file large, in the one float layer, the way Finder's does it. A clip
// plays, a picture fills the room, a sound shows its waveform under its player, anything else its kind, its name and
// its size. ← → go through the folder's files, Space or Esc closes; Download, Copy for an agent and Details (the file
// beside the list, with its versions) stand at its foot.
import { useEffect, useRef, useState } from 'react';
import type { FileMedia } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { usePhone } from '../lib/media.ts';
import { KindIcon } from '../ui/kindIcons.tsx';
import { IconButton, Modal } from '../ui/primitives.tsx';
import { Button } from '../ui/system.tsx';
import { download, inlineUrl } from './api.ts';
import { lookOf } from './FileSheet.tsx';
import { type FileRow, lengthOf, nameOf, size, typeLabel, whoOf } from './model.ts';

/** A sound's waveform, read in the browser from its bytes (small files only: a long one shows its player alone). */
function Waveform({ url, bytes }: { url: string; bytes: number }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<'wait' | 'ok' | 'none'>(bytes > 40e6 ? 'none' : 'wait');
  useEffect(() => {
    if (bytes > 40e6) return;
    const ctl = new AbortController();
    (async () => {
      try {
        const buf = await (await fetch(url, { signal: ctl.signal })).arrayBuffer();
        const ac = new AudioContext();
        const audio = await ac.decodeAudioData(buf);
        void ac.close();
        const c = canvas.current;
        if (!c || ctl.signal.aborted) return;
        const w = c.clientWidth * devicePixelRatio;
        const h = c.clientHeight * devicePixelRatio;
        c.width = w;
        c.height = h;
        const g = c.getContext('2d');
        if (!g) return;
        const data = audio.getChannelData(0);
        const bars = Math.floor(w / (4 * devicePixelRatio));
        const per = Math.max(1, Math.floor(data.length / bars));
        g.fillStyle = getComputedStyle(c).color;
        for (let i = 0; i < bars; i++) {
          let peak = 0;
          for (let j = i * per; j < (i + 1) * per && j < data.length; j++) peak = Math.max(peak, Math.abs(data[j] ?? 0));
          const bh = Math.max(2 * devicePixelRatio, peak * h * 0.9);
          g.fillRect(i * 4 * devicePixelRatio, (h - bh) / 2, 2.5 * devicePixelRatio, bh);
        }
        setState('ok');
      } catch {
        if (!ctl.signal.aborted) setState('none');
      }
    })();
    return () => ctl.abort();
  }, [url, bytes]);
  return state === 'none' ? null : <canvas ref={canvas} className={`pf-ql-wave ${state}`} />;
}

export function QuickLook({
  files,
  at,
  media,
  onMove,
  onClose,
  onCopy,
  onDetails,
}: {
  files: FileRow[];
  at: number;
  media: Record<string, FileMedia> | undefined;
  onMove: (to: number) => void;
  onClose: () => void;
  onCopy: (f: FileRow) => void;
  onDetails: (f: FileRow) => void;
}) {
  const f = files[at];
  const phone = usePhone();
  // ← → through the folder, Space closes (as Finder's Quick Look does)
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      if ((e.target as Element | null)?.closest?.('input, textarea, [role=menu]')) return;
      if (e.key === 'ArrowRight') {
        e.preventDefault();
        onMove(Math.min(files.length - 1, at + 1));
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        onMove(Math.max(0, at - 1));
      } else if (e.key === ' ' && !(e.target as Element | null)?.closest?.('video, audio')) {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', k, true);
    return () => window.removeEventListener('keydown', k, true);
  }, [at, files.length, onMove, onClose]);
  if (!f) return null;
  const look = lookOf(f.type, f.kind);
  const url = inlineUrl(f.id, f.v);
  const m = media?.[f.id];
  const facts = [
    typeLabel(f.path, f.kind),
    size(f.size),
    ...(m?.seconds ? [lengthOf(m.seconds)] : []),
    ...(m?.width ? [`${m.width}×${m.height}`] : []),
    `V${f.v}`,
  ];
  const who = whoOf(f);
  return (
    <Modal
      title={nameOf(f.path)}
      fill
      width={1180}
      onClose={onClose}
      head={
        <span className="pf-ql-count" data-testid="quick-look-count">
          {t('{n} of {total}', { n: at + 1, total: files.length })}
        </span>
      }
      foot={
        <div className="pf-ql-foot">
          <span className="pf-ql-facts">
            {facts.join(' · ')}
            <span className="pf-ql-who">
              {' · '}
              {who.name}, {ago(f.at)}
            </span>
          </span>
          {phone ? (
            <>
              <IconButton className="btn icon-only" label={t('Details')} icon="info" size={16} onClick={() => onDetails(f)} />
              <IconButton className="btn icon-only" label={t('Copy for an agent')} icon="copy" size={16} onClick={() => onCopy(f)} />
            </>
          ) : (
            <>
              <Button icon="info" onClick={() => onDetails(f)}>
                {t('Details')}
              </Button>
              <Button icon="copy" onClick={() => onCopy(f)}>
                {t('Copy for an agent')}
              </Button>
            </>
          )}
          <Button variant="primary" icon="download" onClick={() => download(f.id, f.v)}>
            {t('Download')}
          </Button>
        </div>
      }
    >
      <div className="pf-ql" data-testid="quick-look" data-look={look ?? 'none'}>
        <IconButton
          className="btn ghost icon-only pf-ql-nav prev"
          label={t('Previous')}
          shortcut="←"
          icon="back"
          size={18}
          disabled={at === 0}
          onClick={() => onMove(at - 1)}
        />
        <div className="pf-ql-stage" key={f.id}>
          {look === 'image' ? (
            <img src={url} alt={nameOf(f.path)} />
          ) : look === 'video' ? (
            <video src={url} controls autoPlay muted playsInline preload="auto">
              <track kind="captions" />
            </video>
          ) : look === 'audio' ? (
            <div className="pf-ql-audio">
              <Waveform url={url} bytes={f.size} />
              <audio src={url} controls preload="metadata">
                <track kind="captions" />
              </audio>
            </div>
          ) : (
            <div className="pf-ql-none">
              <KindIcon kind={f.kind} size={56} />
              <span className="pf-ql-none-name">{nameOf(f.path)}</span>
              <span className="pf-ql-none-why">{look ? t('Opens in a tab of its own') : t('No preview in the browser: download it to open it')}</span>
            </div>
          )}
        </div>
        <IconButton
          className="btn ghost icon-only pf-ql-nav next"
          label={t('Next')}
          shortcut="→"
          icon="right"
          size={18}
          disabled={at === files.length - 1}
          onClick={() => onMove(at + 1)}
        />
      </div>
    </Modal>
  );
}
