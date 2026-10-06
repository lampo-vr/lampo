// "Add video" at the machine the app runs on. First what everyone expects: drop render files or choose them (an upload,
// as anywhere else). The machine's extra, one click away and remembered once used: link a render where it lives (paste a
// path or browse, starting in a recent export folder) — new renders to the same path become new versions — then hand it
// to the agent that should get the feedback. Anyone not at the machine only uploads (see Library).

import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../api/client.ts';
import { keys, useBrowse, useFolderSuggestion, useSessions } from '../api/queries.ts';
import type { Session, VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { tilde } from '../lib/format.ts';
import { go } from '../lib/nav.ts';
import { toast, toastError } from '../lib/toast.ts';
import { pickOf, SessionList, suggested } from '../sessions/Sessions.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Modal } from '../ui/primitives.tsx';
import { Skeleton, SkeletonRegion } from '../ui/Skeleton.tsx';
import { Button } from '../ui/system.tsx';
import { FolderField } from './FolderPicker.tsx';

const LAST_DIR = 'vr.lastDir';
/** Upload or link: the way last used at this browser (a newcomer starts with upload). */
const MODE = 'vr.addMode';
type Mode = 'upload' | 'link';
const readMode = (): Mode => {
  try {
    return localStorage.getItem(MODE) === 'link' ? 'link' : 'upload';
  } catch {
    return 'upload';
  }
};
const keepMode = (m: Mode) => {
  try {
    localStorage.setItem(MODE, m);
  } catch {}
};
const mb = (n?: number) => (n ? `${(n / 1e6).toFixed(n > 1e8 ? 0 : 1)} MB` : '');

interface BrowserProps {
  selected: string;
  onPick: (p: string) => void;
  onOpen: (p: string) => void;
  /** Folders renders were linked from lately, newest first: where the browser starts, and one click away. */
  recent: string[];
  home?: string | null;
}

function Browser({ selected, onPick, onOpen, recent, home }: BrowserProps) {
  const [dir, setDir] = useState(() => {
    try {
      return localStorage.getItem(LAST_DIR) || recent[0] || '';
    } catch {
      return recent[0] || '';
    }
  });
  const { data, error } = useBrowse(dir);
  useEffect(() => {
    if (data)
      try {
        localStorage.setItem(LAST_DIR, data.dir);
      } catch {}
  }, [data]);
  // A remembered folder that is gone: start over at the default.
  useEffect(() => {
    if (error && dir) setDir('');
  }, [error, dir]);
  const crumbList = useMemo(() => {
    if (!data) return [];
    const parts = data.dir.split('/').filter(Boolean);
    return parts.map((p, i) => ({ name: p, path: `/${parts.slice(0, i + 1).join('/')}` }));
  }, [data]);
  return (
    <div className="browser">
      {recent.length > 0 && (
        <div className="browser-recent">
          <span className="muted">{t('Recent')}</span>
          {recent.map((r) => (
            <button type="button" key={r} className={data?.dir === r ? 'on' : ''} onClick={() => setDir(r)} title={tilde(r, home)}>
              <I name="folder" size={13} />
              {r.split('/').filter(Boolean).slice(-2).join(' / ')}
            </button>
          ))}
        </div>
      )}
      <div className="crumbs">
        <button type="button" onClick={() => setDir(data?.dev || '')} title={data ? tilde(data.dev, home) : undefined}>
          <I name="folder" size={14} />
        </button>
        {crumbList.map((c, i) => (
          <span key={c.path} className="row" style={{ gap: 2 }}>
            <span className="sep">/</span>
            <button type="button" onClick={() => setDir(c.path)} style={i === crumbList.length - 1 ? { color: 'var(--fg)' } : undefined}>
              {c.name}
            </button>
          </span>
        ))}
      </div>
      <div className="entries">
        {!data && !error && (
          <SkeletonRegion label={t('Loading the folder')} className="entries-sk">
            {[62, 48, 71, 55, 40].map((w) => (
              <span key={w} className="entries-sk-row">
                <Skeleton w={16} h={16} r={4} />
                <Skeleton w={`${w}%`} h={10} />
              </span>
            ))}
          </SkeletonRegion>
        )}
        {error && <div style={{ padding: 10, color: 'var(--must)' }}>{error.message}</div>}
        {data?.parent && (
          <button type="button" className="entry" onClick={() => data.parent && setDir(data.parent)}>
            <I name="back" size={15} /> ..
          </button>
        )}
        {data?.entries.map((e) =>
          e.type === 'dir' ? (
            <button type="button" key={e.path} className="entry" onClick={() => setDir(e.path)}>
              <I name="folder" size={15} />
              <span className="grow ellipsis">{e.name}</span>
              <I name="right" size={14} className="faint" />
            </button>
          ) : (
            <button
              type="button"
              key={e.path}
              className={`entry video ${selected === e.path ? 'sel' : ''}`}
              onClick={() => onPick(e.path)}
              onDoubleClick={() => onOpen(e.path)}
            >
              <I name="film" size={15} />
              <span className="grow ellipsis">{e.name}</span>
              {e.reviewed && <span className="badge accent">{t('in review')}</span>}
              <span className="muted" style={{ fontSize: 11.5 }}>
                {mb(e.size)}
              </span>
            </button>
          ),
        )}
        {data && !data.entries.length && (
          <div className="muted" style={{ padding: 10 }}>
            {t('No folders or videos here.')}
          </div>
        )}
      </div>
    </div>
  );
}

interface AddVideoProps {
  onClose: () => void;
  /** The file picker (an upload); files dropped anywhere on the page upload too (Library closes this then). */
  onUpload: () => void;
  home?: string | null;
  folders: string[];
  defaultFolder?: string;
  /** Folders renders were linked from lately, newest first (the browser starts in the first). */
  recent?: string[];
}

/** The first way in: drop render files or choose them. */
function DropFiles({ onUpload, onLink }: { onUpload: () => void; onLink: () => void }) {
  const [over, setOver] = useState(false);
  return (
    <>
      {/* the drop itself is the page's (useFileDrop, on the window): this is where to aim, and says so */}
      {/* biome-ignore lint/a11y/noStaticElementInteractions: a drop target; the button inside is the way in without a mouse */}
      <div
        className={`add-drop ${over ? 'over' : ''}`}
        onDragEnter={() => setOver(true)}
        onDragLeave={(e) => !e.currentTarget.contains(e.relatedTarget as Node | null) && setOver(false)}
        onDrop={() => setOver(false)}
      >
        <I name="upload" size={22} />
        <b>{t('Drop video files here')}</b>
        <Button variant="primary" icon="upload" onClick={onUpload} data-testid="add-choose-files" autoFocus>
          {t('Choose files')}
        </Button>
        <span className="muted">{t('A file named like a video already in the project becomes its next version.')}</span>
      </div>
      <button type="button" className="add-alt" onClick={onLink} data-testid="add-link-instead">
        <I name="link" size={15} />
        <span className="grow">
          <b>{t('Link a file on this machine instead')}</b>
          <span className="muted">{t('It stays where it is: rendering again to the same path adds the next version.')}</span>
        </span>
        <I name="right" size={14} className="faint" />
      </button>
    </>
  );
}

export default function AddVideo({ onClose, onUpload, home, folders, defaultFolder, recent = [] }: AddVideoProps) {
  const [mode, setModeState] = useState<Mode>(readMode);
  const setMode = (m: Mode) => {
    keepMode(m);
    setModeState(m);
  };
  const [step, setStep] = useState<1 | 2>(1);
  const [path, setPath] = useState('');
  const [folder, setFolder] = useState<string | null | undefined>(undefined); // undefined = not decided yet, null = Unsorted
  const [sel, setSel] = useState<Session | null | undefined>(undefined);
  const touched = useRef(false);
  const qc = useQueryClient();
  const clean = path.trim().replace(/^["']|["']$/g, '');
  const target = step === 2 && clean ? clean : null;

  const suggestion = useFolderSuggestion(target);
  useEffect(() => {
    if (!target || folder !== undefined) return;
    if (suggestion.data) setFolder(defaultFolder ?? suggestion.data.suggestion?.folder ?? null);
    else if (suggestion.isError) setFolder(defaultFolder ?? null);
  }, [target, folder, suggestion.data, suggestion.isError, defaultFolder]);

  const { sessions, refreshing, refresh } = useSessions(target);
  useEffect(() => {
    if (step === 2 && sessions && !touched.current) setSel(suggested(sessions));
  }, [sessions, step]);

  const add = useMutation({
    mutationFn: () =>
      api<{ created: boolean; video: VideoSummary }>('/api/library', {
        method: 'POST',
        body: { path: clean, session: pickOf(sel ?? null), folder: folder ?? null },
      }),
    onSuccess: (res) => {
      qc.invalidateQueries({ queryKey: keys.library });
      toast(res.created ? t('Added {name}', { name: res.video.name }) : t('{name} is already under review', { name: res.video.name }), 'ok');
      onClose();
      go(res.video.slug);
    },
    onError: toastError,
  });

  const next = (p?: string) => {
    const v = (p ?? clean).trim();
    if (!v) return toast(t('Pick a video or paste its path'), 'error');
    setPath(v);
    touched.current = false;
    setSel(undefined);
    setFolder(undefined);
    setStep(2);
  };

  const foot =
    mode === 'upload' ? null : step === 1 ? (
      <>
        {/* a Finder tip: on a phone or a tablet there is no Finder, only the room it takes */}
        <span className="grow">
          <span className="add-tip muted">
            <T
              k={"Tip: in Finder, <0>⌥</0> <1>⌘</1> <2>C</2> copies a file's path."}
              tags={[(c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>, (c) => <kbd>{c}</kbd>]}
            />
          </span>
        </span>
        <button type="button" className="btn ghost" onClick={() => setMode('upload')} data-testid="add-upload-instead">
          <I name="upload" size={15} /> {t('Upload instead')}
        </button>
        <button type="button" className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn primary" onClick={() => next()} disabled={!clean}>
          {t('Next')} <I name="right" size={15} />
        </button>
      </>
    ) : (
      <>
        <button type="button" className="btn ghost" onClick={() => setStep(1)}>
          <I name="back" size={15} /> {t('Back')}
        </button>
        <span className="grow" />
        <button type="button" className="btn" onClick={onClose}>
          {t('Cancel')}
        </button>
        <button type="button" className="btn primary" onClick={() => add.mutate()} disabled={add.isPending || sessions === null || folder === undefined}>
          {add.isPending ? <Spinner /> : <I name="plus" size={15} />} {t('Add video')}
        </button>
      </>
    );

  if (mode === 'upload')
    return (
      <Modal title={t('Add video')} onClose={onClose} width={520}>
        <DropFiles onUpload={onUpload} onLink={() => setMode('link')} />
      </Modal>
    );

  return (
    <Modal
      title={t('Link a file on this machine')}
      onClose={onClose}
      foot={foot}
      head={
        <div className="steps">
          <span className={step === 1 ? 'on row' : 'row'} style={{ gap: 5 }}>
            <span className="n">1</span> {t('File')}
          </span>
          <span className="faint">—</span>
          <span className={step === 2 ? 'on row' : 'row'} style={{ gap: 5 }}>
            <span className="n">2</span> {t('Agent')}
          </span>
        </div>
      }
    >
      {step === 1 ? (
        <>
          <p className="muted" style={{ margin: 0, fontSize: 12.5 }}>
            {t('The file stays where it is: when it is rendered again to the same path, that becomes the next version.')}
          </p>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="label">{t('Path')}</div>
            <input
              className="input mono"
              autoFocus
              placeholder="/Users/…/export/video.mp4"
              value={path}
              onChange={(e) => setPath(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && !e.metaKey && !e.ctrlKey && next()}
              style={{ fontSize: 12 }}
            />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="label">{t('Or browse')}</div>
            <Browser selected={clean} onPick={setPath} onOpen={(p) => next(p)} recent={recent} home={home} />
          </div>
        </>
      ) : (
        <>
          <div className="row" style={{ padding: '8px 10px', borderRadius: 8, background: 'var(--ink-0)', border: '1px solid var(--line)' }}>
            <I name="film" size={16} style={{ color: 'var(--fg-2)' }} />
            <span className="grow ellipsis-start mono" style={{ fontSize: 12 }}>
              <span>{tilde(clean, home)}</span>
            </span>
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="label">{t('Project')}</div>
            <FolderField
              folders={folders}
              value={folder}
              onChange={setFolder}
              suggestion={suggestion.data?.suggestion}
              note={folder && folder === suggestion.data?.suggestion?.folder ? suggestion.data.suggestion.reason : null}
            />
          </div>
          <div style={{ display: 'grid', gap: 6 }}>
            <div className="label">{t('Which agent should act on the feedback?')}</div>
            <SessionList
              sessions={sessions}
              selected={sel ?? null}
              onSelect={(s) => {
                touched.current = true;
                setSel(s);
              }}
              home={home}
              refreshing={refreshing}
              onRefresh={refresh}
            />
          </div>
        </>
      )}
    </Modal>
  );
}
