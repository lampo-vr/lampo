// Upload progress, bottom left, on every screen: one float in the app's float material — a head with the whole
// upload's progress as a ring and its share in numbers (a click folds it), then a row per video with a progress line,
// what is sent of what at which speed, what happens after the last byte (the server checks the file and prepares a
// smooth-scrub copy), and a way in. Project files on their way follow, per batch (files/FileTray.tsx).
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { useReview } from '../api/queries.ts';
import { FileTrayRows, useFileTally } from '../files/FileTray.tsx';
import { bindFileUploads, clearFileUploads } from '../files/uploadStore.ts';
import { bytes } from '../lib/format.ts';
import { crumbs, go } from '../lib/nav.ts';
import { Progress } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Tip } from '../ui/primitives.tsx';
import {
  bindUploads,
  cancelUpload,
  clearFinished,
  dismiss,
  forget,
  type Interrupted,
  loadInterrupted,
  retryRoom,
  showRoom,
  type UploadItem,
  useInterrupted,
  useUploads,
} from './uploads.ts';
import '../styles/uploads.css';
import { t } from '../i18n/index.ts';

const eta = (x: UploadItem) => {
  if (!x.rate || x.sent >= x.size) return '';
  const s = Math.round((x.size - x.sent) / x.rate);
  return s >= 3600 ? `${Math.floor(s / 3600)} h ${Math.round((s % 3600) / 60)} min` : s >= 60 ? `${Math.round(s / 60)} min` : `${s} s`;
};

/** The whole upload's share as a ring (0–100); null: no share to show (the server is checking), a turning ring. */
function Ring({ pct }: { pct: number | null }) {
  if (pct === null) return <span className="spinner up-ring-spin" />;
  // r = 6.5 in a 16 × 16 box: 2π · 6.5 ≈ 40.84
  const C = 40.84;
  return (
    <svg className="up-ring" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
      <circle className="up-ring-track" cx="8" cy="8" r="6.5" />
      <circle className="up-ring-fill" cx="8" cy="8" r="6.5" strokeDasharray={`${(C * pct) / 100} ${C}`} />
    </svg>
  );
}

// After the last byte: the render is registered, then the server makes its smooth-scrub copy (poster, analysis and
// Auto-check follow in the background). The review query is shared with the player and kept live by SSE.
function Processing({ slug, v }: { slug: string; v: number }) {
  const { data } = useReview(slug);
  const scrub = data?.media[v]?.scrub;
  if (!data) return <span className="up-sub">{t('registered as V{v}', { v })}</span>;
  return scrub === 'building' ? (
    <span className="up-sub">
      <span className="spinner" /> {t('V{v} · preparing smooth scrubbing', { v })}
    </span>
  ) : (
    <span className="up-sub ok">{t('V{v} · ready', { v })}</span>
  );
}

function Row({ x }: { x: UploadItem }) {
  const pct = x.size ? Math.min(100, (x.sent / x.size) * 100) : 0;
  const live = x.state === 'uploading';
  const left = live ? eta(x) : '';
  return (
    <div className={`up-row ${x.state}`}>
      <span className="up-tile">
        {x.state === 'room' ? (
          <KeyGlyph shape="outline" className="up-room-k" />
        ) : (
          <I name={x.state === 'failed' ? 'x' : x.state === 'done' ? 'check' : 'film'} size={15} />
        )}
      </span>
      <div className="up-main">
        <div className="up-line">
          <span className="up-name ellipsis" title={x.name}>
            {x.name}
          </span>
          <span className="up-num">
            {live ? `${Math.floor(pct)}%` : x.state === 'processing' ? t('checking') : x.state === 'canceled' ? t('canceled') : ''}
          </span>
        </div>
        {(live || x.state === 'processing') && (
          <Progress
            className="up-bar"
            value={live ? pct : null}
            label={live ? t('Uploading {name}', { name: x.name }) : t('Checking {name}', { name: x.name })}
          />
        )}
        {live && x.waiting && (
          <span className="up-sub" data-testid="upload-waiting">
            {t('No connection: it goes on by itself when you’re back online')}
          </span>
        )}
        {live && !x.waiting && (
          <span className="up-sub up-stats">
            {t('{sent} of {size}', { sent: bytes(x.sent), size: bytes(x.size) })}
            {x.rate ? ` · ${bytes(x.rate)}/s` : ''}
            {left ? ` · ${t('{time} left', { time: left })}` : ''}
            {x.resumed ? t(' · resumed') : ''}
          </span>
        )}
        {x.state === 'processing' && <span className="up-sub">{t('checking the file on the server…')}</span>}
        {x.state === 'failed' && <span className="up-sub err">{x.error}</span>}
        {x.state === 'room' && (
          // calm: nothing failed, it waits for the plan to have room (the sheet says what fits)
          <span className="up-sub up-room" data-testid="upload-room">
            {t('Waiting for room · {size}', { size: bytes(x.size) })}
            <span className="up-room-acts">
              <button type="button" className="btn ghost sm" onClick={() => showRoom(x.id)} data-testid="upload-room-plans">
                {t('See what fits')}
              </button>
              <button type="button" className="btn ghost sm" onClick={() => retryRoom(x.id)}>
                {t('Try again')}
              </button>
            </span>
          </span>
        )}
        {x.state === 'done' &&
          (x.result?.duplicate ? (
            <span className="up-sub">{t('same bytes as V{v}: nothing new', { v: x.result.v })}</span>
          ) : x.result ? (
            <Processing slug={x.result.slug} v={x.result.v} />
          ) : (
            <span className="up-sub ok">{t('uploaded')}</span>
          ))}
      </div>
      {x.state === 'done' && x.result ? (
        <button type="button" className="btn sm" onClick={() => x.result && go(x.result.slug)}>
          {t('Open')}
        </button>
      ) : live || x.state === 'room' ? (
        <IconButton
          className="btn ghost sm icon-only"
          label={t('Cancel {name}', { name: x.name })}
          tip={t('Cancel the upload')}
          icon="x"
          size={14}
          onClick={() => cancelUpload(x.id)}
        />
      ) : x.state !== 'processing' ? (
        <IconButton className="btn ghost sm icon-only" label={t('Dismiss')} icon="x" size={14} onClick={() => dismiss(x.id)} />
      ) : null}
    </div>
  );
}

function Leftover({ x }: { x: Interrupted }) {
  const pct = x.sent != null && x.size ? Math.floor((x.sent / x.size) * 100) : null;
  return (
    <div className="up-row interrupted">
      <span className="up-tile">
        <I name="upload" size={15} />
      </span>
      <div className="up-main">
        <div className="up-line">
          <span className="up-name ellipsis" title={x.name}>
            {x.name}
          </span>
          {pct != null && <span className="up-num">{pct}%</span>}
        </div>
        <span className="up-sub">
          {x.folder
            ? t('Interrupted · {folder}. Drop the same file again to continue.', { folder: crumbs(x.folder) })
            : t('Interrupted. Drop the same file again to continue.')}
        </span>
      </div>
      <Tip content={t('Discard the partial upload')}>
        <button type="button" className="btn ghost sm" onClick={() => forget(x)}>
          {t('Discard')}
        </button>
      </Tip>
    </div>
  );
}

export default function UploadTray() {
  const qc = useQueryClient();
  const list = useUploads();
  const leftovers = useInterrupted();
  const [open, setOpen] = useState(true);
  const files = useFileTally();
  useEffect(() => {
    bindUploads(qc);
    bindFileUploads(qc);
    void loadInterrupted();
  }, [qc]);
  // A new upload opens the tray again (and a file that waits for a decision).
  const count = list.length + files.going + (files.waiting ? 1 : 0);
  useEffect(() => {
    if (count) setOpen(true);
  }, [count]);
  // Once everything is through, the tray gets out of the way: folded to its header after a few seconds, finished
  // rows gone after a minute (the videos are in the library by then). Failures stay until dismissed.
  const active = list.filter((x) => x.state === 'uploading' || x.state === 'processing');
  const idle = (list.length > 0 || files.any) && !active.length && !files.going && !files.waiting;
  const failed = list.some((x) => x.state === 'failed') || files.failed;
  useEffect(() => {
    if (!idle) return;
    const fold = setTimeout(() => setOpen(false), 5000);
    const clear = failed
      ? undefined
      : setTimeout(() => {
          clearFinished();
          clearFileUploads();
        }, 60_000);
    return () => {
      clearTimeout(fold);
      clearTimeout(clear);
    };
  }, [idle, failed]);
  if (!list.length && !leftovers.length && !files.any) return null;
  const sending = active.filter((x) => x.state === 'uploading');
  const sent = sending.reduce((s, x) => s + x.sent, 0);
  const total = sending.reduce((s, x) => s + x.size, 0);
  // the videos' share, else the files'
  const pct = sending.length && total ? Math.floor((sent / total) * 100) : files.pct;
  const done = list.filter((x) => x.state === 'done').length;
  const going = active.length + files.going;
  const title = active.length
    ? sending.length
      ? files.going
        ? t('Uploading {n} video and files|Uploading {n} videos and files', { n: active.length })
        : t('Uploading {n} video|Uploading {n} videos', { n: active.length })
      : t('Checking {n} video|Checking {n} videos', { n: active.length })
    : files.going
      ? t('Uploading {n} file|Uploading {n} files', { n: files.going })
      : files.waiting
        ? t('Uploads waiting for you')
        : leftovers.length && !list.length && !files.any
          ? t('Unfinished uploads')
          : done && !failed && !files.any
            ? t('Uploaded {n} video|Uploaded {n} videos', { n: done })
            : files.done && !failed && !list.length
              ? t('Uploaded {n} file|Uploaded {n} files', { n: files.done })
              : t('Uploads');
  return (
    <section className={`up-tray ${open ? 'open' : ''}`} aria-label={t('Uploads')} data-testid="upload-tray">
      <header className="up-head">
        <button
          type="button"
          className="up-title"
          // a click folds it without leaving the focus here: no ring turns up on it later when a key is pressed
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          data-testid="upload-tray-head"
        >
          <span className={`up-state ${going ? '' : failed ? 'err' : done || files.done ? 'ok' : ''}`}>
            {going ? <Ring pct={pct} /> : <I name={failed ? 'x' : done || files.done ? 'check' : 'upload'} size={14} />}
          </span>
          <span className="grow ellipsis">{title}</span>
          {/* the share in numbers where no row says it: folded, or for several videos or files together */}
          {pct !== null && (!open || sending.length > 1 || files.going > 1) && <span className="up-pct">{pct}%</span>}
          <I name="down" size={14} className={`up-chev ${open ? '' : 'up-flip'}`} />
        </button>
        {!going && !files.waiting && (list.length > 0 || files.any) && (
          <button
            type="button"
            className="btn ghost sm up-clear"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => {
              clearFinished();
              clearFileUploads();
            }}
          >
            {t('Clear')}
          </button>
        )}
      </header>
      {open && (
        <div className="up-list">
          {list.map((x) => (
            <Row key={x.id} x={x} />
          ))}
          {leftovers.map((x) => (
            <Leftover key={x.key} x={x} />
          ))}
          <FileTrayRows />
        </div>
      )}
    </section>
  );
}
