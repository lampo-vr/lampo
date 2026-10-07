// Files on their way, in the upload tray (uploads/UploadTray.tsx): per batch where it goes, then a row per top folder of
// what was dropped (88 files · 41 % · 1.2 GB/s · 22 min left), what needed nothing sent (already in Lampo), and — when
// someone changed a file since this one was based on it — who and when, with Keep both / Replace; when its account made
// the day's versions of a file already, when the next may come, with Save as a copy. Styles: uploads.css.
import { useEffect, useState } from 'react';
import { FILE_LIMITS, nameOf } from '../../../lib/fileText.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { Progress } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { againAt, size, spaced } from './model.ts';
import { filesHref } from './route.ts';
import {
  cancelFiles,
  type FileBatch,
  type FileUpload,
  resolveConflicts,
  resolveLater,
  retryFailed,
  retryRoom,
  showRoom,
  useFileUploads,
} from './uploadStore.ts';

const live = (u: FileUpload) => u.state === 'waiting' || u.state === 'uploading';

/** How long the rest takes at this speed, in words (nothing before there is a speed). */
export function timeLeft(bytes: number, rate: number): string {
  if (!rate || bytes <= 0) return '';
  const s = Math.round(bytes / rate);
  return s >= 3600
    ? t('{h} h {m} min', { h: Math.floor(s / 3600), m: Math.round((s % 3600) / 60) })
    : s >= 60
      ? t('{n} min', { n: Math.round(s / 60) })
      : t('{n} s', { n: s });
}

/** The tray's numbers for files: what is still on its way, and its share sent. */
export function useFileTally() {
  const { uploads } = useFileUploads();
  const going = uploads.filter(live);
  const sending = uploads.filter((u) => u.state === 'uploading' || u.state === 'waiting');
  const total = sending.reduce((s, u) => s + u.size, 0);
  const sent = sending.reduce((s, u) => s + u.sent, 0);
  return {
    any: uploads.length > 0,
    going: going.length,
    done: uploads.filter((u) => u.state === 'done').length,
    failed: uploads.some((u) => u.state === 'failed'),
    waiting: uploads.some((u) => u.state === 'conflict' || u.state === 'room' || u.state === 'later'),
    pct: going.length && total ? Math.floor((sent / total) * 100) : null,
  };
}

/** Every batch's rows. */
export function FileTrayRows() {
  const { batches, uploads } = useFileUploads();
  return (
    <>
      {batches.map((b) => (
        <Batch key={b.id} b={b} uploads={uploads.filter((u) => u.batch === b.id)} />
      ))}
    </>
  );
}

function Batch({ b, uploads }: { b: FileBatch; uploads: FileUpload[] }) {
  const groups = new Map<string, FileUpload[]>();
  for (const u of uploads) {
    if (u.state === 'canceled' || u.state === 'conflict' || u.state === 'room' || u.state === 'later') continue;
    // nothing was sent for these: they are said on the batch's foot line
    if (u.state === 'done' && u.how === 'same') continue;
    groups.set(u.group, [...(groups.get(u.group) ?? []), u]);
  }
  const same = uploads.filter((u) => u.state === 'done' && u.how === 'same').length;
  const conflicts = uploads.filter((u) => u.state === 'conflict');
  const room = uploads.filter((u) => u.state === 'room');
  const waitDay = uploads.filter((u) => u.state === 'later');
  const where = b.area ? (b.area.split('/').at(-1) as string) : t('House');
  const done = uploads.every((u) => u.state === 'done' || u.state === 'canceled');
  return (
    <div className="up-fb" data-testid="file-batch">
      <div className="up-fb-head">
        <I name="files" size={14} />
        <span className="grow ellipsis">{b.dir ? t('Into {area} · {path}', { area: where, path: spaced(b.dir) }) : t('Into {area}', { area: where })}</span>
        <a className="btn ghost sm" href={filesHref(b.area, { path: b.dir })}>
          {t('Open')}
        </a>
        {!done && (
          <IconButton
            className="btn ghost sm icon-only"
            label={t('Stop these uploads')}
            tip={t('Stop these uploads: what arrived stays')}
            icon="x"
            size={14}
            onClick={() => void cancelFiles(b.id)}
          />
        )}
      </div>
      {[...groups].map(([g, us]) => (
        <Group key={g} name={g} uploads={us} batch={b.id} />
      ))}
      {same > 0 && (
        <p className="up-fb-foot">
          <KeyGlyph shape="diamond" size={10} /> {t('{n} already in Lampo: nothing sent|{n} already in Lampo: nothing sent', { n: same })}
        </p>
      )}
      {room.length > 0 && (
        <div className="up-sub up-room" data-testid="file-upload-room">
          {t('Waiting for room · {n} file · {size}|Waiting for room · {n} files · {size}', {
            n: room.length,
            size: size(room.reduce((s, u) => s + u.size, 0)),
          })}
          <span className="up-room-acts">
            <button type="button" className="btn ghost sm" onClick={() => showRoom(b.id)}>
              {t('See what fits')}
            </button>
            <button type="button" className="btn ghost sm" onClick={() => retryRoom(b.id)}>
              {t('Try again')}
            </button>
          </span>
        </div>
      )}
      {conflicts.length > 0 && <Conflicts batch={b.id} uploads={conflicts} />}
      {waitDay.length > 0 && <PastTheDay batch={b.id} uploads={waitDay} />}
    </div>
  );
}

function Group({ name, uploads, batch }: { name: string; uploads: FileUpload[]; batch: string }) {
  const going = uploads.filter(live);
  const total = uploads.reduce((s, u) => s + u.size, 0);
  const sent = uploads.reduce((s, u) => s + (u.state === 'done' ? u.size : u.sent), 0);
  const rate = uploads.reduce((s, u) => s + (u.state === 'uploading' ? u.rate : 0), 0);
  const failed = uploads.filter((u) => u.state === 'failed');
  const started = uploads.some((u) => u.state === 'uploading' || u.state === 'done');
  const pct = total ? Math.min(100, Math.floor((sent / total) * 100)) : 100;
  const offline = uploads.some((u) => u.offline);
  const label = name ? spaced(name) : uploads.length === 1 ? nameOf(uploads[0]?.path ?? '') : t('Files');
  const state = failed.length && !going.length ? 'failed' : going.length ? 'uploading' : 'done';
  return (
    <div className={`up-row ${state}`} data-testid="file-upload-group">
      <span className="up-tile">
        <I name={state === 'failed' ? 'x' : state === 'done' ? 'check' : name ? 'folder' : 'files'} size={15} />
      </span>
      <div className="up-main">
        <div className="up-line">
          <span className="up-name ellipsis" title={name || label}>
            {label}
          </span>
          <span className="up-num">{going.length ? (started ? `${pct}%` : t('waiting')) : ''}</span>
        </div>
        {going.length > 0 && started && <Progress className="up-bar" value={pct} label={t('Uploading {name}', { name: label })} />}
        <span className="up-sub up-stats">
          {t('{n} file|{n} files', { n: uploads.length })}
          {going.length > 0 && started && !offline && ` · ${t('{sent} of {size}', { sent: size(sent), size: size(total) })}`}
          {going.length > 0 && rate > 0 && !offline && ` · ${size(rate)}/s`}
          {going.length > 0 && rate > 0 && !offline && timeLeft(total - sent, rate) && ` · ${t('{time} left', { time: timeLeft(total - sent, rate) })}`}
          {offline && ` · ${t('No connection: it goes on by itself when you’re back online')}`}
          {!going.length && !failed.length && ` · ${t('added')}`}
          {uploads.some((u) => u.resumed) && going.length > 0 && t(' · resumed')}
        </span>
        {failed.length > 0 && (
          <span className="up-sub err">
            {failed.length === 1 ? `${nameOf(failed[0]?.path ?? '')}: ${failed[0]?.error ?? ''}` : t('{n} didn’t arrive', { n: failed.length })}
            <button type="button" className="btn ghost sm" onClick={() => retryFailed(batch)}>
              {t('Try again')}
            </button>
          </span>
        )}
      </div>
    </div>
  );
}

/** Files someone changed since this upload was based on them: who and when, and the two ways on (design: Keep both keeps
 * this one beside theirs, named for whose it is; Replace makes it the next version after theirs). */
function Conflicts({ batch, uploads }: { batch: string; uploads: FileUpload[] }) {
  const shown = uploads.slice(0, 3);
  return (
    <section className="up-fb-conflict" aria-label={t('Changed since you added them')} data-testid="file-conflict">
      <p className="up-fb-conflict-head">
        <KeyGlyph shape="half" size={10} />
        {t('{n} file changed since you added it|{n} files changed since you added them', { n: uploads.length })}
      </p>
      <ul className="up-fb-conflict-list">
        {shown.map((u) => (
          <li key={u.key}>
            <b className="ellipsis" title={u.path}>
              {nameOf(u.path)}
            </b>
            {u.conflict && (
              <span className="up-fb-conflict-who">
                {t('V{v} by {name}, {when}', { v: u.conflict.v, name: u.conflict.agent ?? u.conflict.by, when: ago(u.conflict.at) })}
              </span>
            )}
          </li>
        ))}
        {uploads.length > shown.length && <li className="up-fb-more">{t('and {n} more', { n: uploads.length - shown.length })}</li>}
      </ul>
      <div className="up-fb-conflict-acts">
        <button type="button" className="btn sm" onClick={() => resolveConflicts(batch, 'copy')} data-testid="file-keep-both">
          {t('Keep both')}
        </button>
        <button type="button" className="btn sm" onClick={() => resolveConflicts(batch, 'replace')} data-testid="file-replace">
          {uploads.length === 1 ? t('Replace') : t('Replace all')}
        </button>
      </div>
    </section>
  );
}

/** Files whose account made the day's versions of them already (429): a copy beside the file is never refused for it,
 * or they go again as versions once the first of the day's is a day old (the time the server names). */
function PastTheDay({ batch, uploads }: { batch: string; uploads: FileUpload[] }) {
  const shown = uploads.slice(0, 3);
  const at = Math.max(...uploads.map((u) => u.retryAt ?? 0));
  // Try again comes once the time has (the tray stays open for hours sometimes)
  const [due, setDue] = useState(() => at <= Date.now());
  useEffect(() => {
    setDue(at <= Date.now());
    if (at <= Date.now()) return;
    const timer = setTimeout(() => setDue(true), Math.min(at - Date.now() + 500, 2 ** 31 - 1));
    return () => clearTimeout(timer);
  }, [at]);
  return (
    <section className="up-fb-conflict" aria-label={t('No more versions today')} data-testid="file-later">
      <p className="up-fb-conflict-head">
        <KeyGlyph shape="outline" size={10} />
        {t('{n} file can’t take another version from you today|{n} files can’t take another version from you today', { n: uploads.length })}
      </p>
      <ul className="up-fb-conflict-list">
        {shown.map((u) => (
          <li key={u.key}>
            <b className="ellipsis" title={u.path}>
              {nameOf(u.path)}
            </b>
            {u.retryAt && <span className="up-fb-conflict-who">{t('a new version {when}', { when: againAt(u.retryAt) })}</span>}
          </li>
        ))}
        {uploads.length > shown.length && <li className="up-fb-more">{t('and {n} more', { n: uploads.length - shown.length })}</li>}
      </ul>
      <p className="up-fb-later-why">
        {t('Each of you makes up to {n} versions of a file a day. Save yours beside it as a copy now, or as its next version then.', {
          n: FILE_LIMITS.versionsPerDay,
        })}
      </p>
      <div className="up-fb-conflict-acts">
        <button type="button" className="btn sm" onClick={() => resolveLater(batch, 'copy')} data-testid="file-save-copy">
          {uploads.length === 1 ? t('Save as a copy') : t('Save as copies')}
        </button>
        {due && (
          <button type="button" className="btn sm" onClick={() => resolveLater(batch, 'again')} data-testid="file-later-again">
            {t('Try again')}
          </button>
        )}
      </div>
    </section>
  );
}
