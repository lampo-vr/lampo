// Dropped or picked files: check them (a video? small enough?), pick the folder they go into, start the uploads.
// A file with the same name as a video already in that folder becomes its next version.
import { useMemo, useState } from 'react';
import { bytes } from '../lib/format.ts';
import { crumbs } from '../lib/nav.ts';
import { toast } from '../lib/toast.ts';
import { FolderField } from '../library/FolderPicker.tsx';
import { I } from '../ui/icons.tsx';
import { Modal } from '../ui/primitives.tsx';
import { isVideo, VIDEO_EXT } from './formats.ts';
import { startUpload } from './uploads.ts';
import '../styles/uploads.css';
import { t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';

interface UploadDialogProps {
  files: File[];
  folders: string[];
  defaultFolder: string | null;
  maxBytes: number;
  /** Names already in each folder, to say which files become a new version. */
  existing: Map<string | null, Set<string>>;
  onClose: () => void;
}

export function UploadDialog({ files, folders, defaultFolder, maxBytes, existing, onClose }: UploadDialogProps) {
  const [folder, setFolder] = useState<string | null>(defaultFolder);
  const lang = useLang();
  // biome-ignore lint/correctness/useExhaustiveDependencies: the problems are words
  const checked = useMemo(
    () =>
      files.map((f) => ({
        f,
        problem: !isVideo(f)
          ? t('not a supported video ({formats})', { formats: VIDEO_EXT.join(' ') })
          : f.size > maxBytes
            ? t('larger than {size}, this server’s limit', { size: bytes(maxBytes) })
            : f.size === 0
              ? t('empty file')
              : null,
      })),
    [files, maxBytes, lang],
  );
  const ok = checked.filter((x) => !x.problem);
  const inFolder = existing.get(folder) || new Set<string>();
  const start = () => {
    for (const { f } of ok) void startUpload(f, { folder });
    if (ok.length)
      toast(t('Uploading {n} video to {folder}|Uploading {n} videos to {folder}', { n: ok.length, folder: folder ? crumbs(folder) : t('No project') }), 'ok');
    onClose();
  };
  return (
    <Modal
      title={ok.length > 1 ? t('Upload {count} videos', { count: ok.length }) : t('Upload a video')}
      onClose={onClose}
      width={560}
      foot={
        <>
          <span className="grow muted" style={{ fontSize: 12 }}>
            {t('Uploads resume if the connection drops.')}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" onClick={start} disabled={!ok.length}>
            <I name="upload" size={15} /> {t('Upload')}
            {ok.length > 1 ? ` ${ok.length}` : ''}
          </button>
        </>
      }
    >
      <div className="up-files">
        {checked.map(({ f, problem }) => (
          <div key={`${f.name}-${f.size}-${f.lastModified}`} className={`up-file ${problem ? 'bad' : ''}`}>
            <I name={problem ? 'x' : 'film'} size={15} />
            <span className="grow ellipsis" title={f.name}>
              {f.name}
            </span>
            {problem ? (
              <span className="up-why">{problem}</span>
            ) : (
              <>
                {inFolder.has(f.name) && <span className="badge accent">{t('NEW VERSION')}</span>}
                <span className="mono muted">{bytes(f.size)}</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="up-where">
        <div className="label">{t('Project')}</div>
        <FolderField folders={folders} value={folder} onChange={setFolder} />
        <p className="up-where-note">{t('A file named like a video already in this folder becomes its next version; open notes carry over.')}</p>
      </div>
    </Modal>
  );
}
