// "Reference a frame…": pick a video (this one's other versions first, or any other by searching), a version, and a
// frame (or a range) — the frame shown is ffmpeg's, exactly what the reference will store.
import { useQuery } from '@tanstack/react-query';
import { useEffect, useId, useState } from 'react';
import { timecode } from '../../../lib/time.ts';
import type { SearchResponse } from '../../../lib/types.ts';
import { api, enc } from '../api/client.ts';
import type { ReviewResponse } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { Checkbox, Slider } from '../ui/controls.tsx';
import { Modal } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import type { PendingRef } from './model.ts';
import { pendingKey } from './model.ts';

interface FramePickerProps {
  /** The video the note is on: offered first (its other versions are the usual reference). */
  slug: string;
  name: string;
  onPick: (r: PendingRef) => void;
  onClose: () => void;
}

export function FramePicker({ slug, name, onPick, onClose }: FramePickerProps) {
  const [q, setQ] = useState('');
  const [video, setVideo] = useState({ slug, name });
  const found = useQuery({
    queryKey: ['ref-search', q],
    queryFn: () => api<SearchResponse>(`/api/search?q=${enc(q)}&limit=8`),
    staleTime: 30_000,
  });
  const detail = useQuery({ queryKey: ['review', video.slug], queryFn: () => api<ReviewResponse>(`/api/review/${enc(video.slug)}`) });
  const versions = detail.data?.review.versions || [];
  const [v, setV] = useState<number | null>(null);
  const ver = versions.find((x) => x.v === v) || versions.at(-1);
  const [frame, setFrame] = useState(0);
  const [range, setRange] = useState(false);
  const [to, setTo] = useState(0);
  const [caption, setCaption] = useState('');
  const rangeId = useId();
  const frames = ver?.frames || 1;
  // The picture follows the slider once it rests (a frame grab per position would be wasteful).
  const [shown, setShown] = useState(0);
  useEffect(() => {
    const id = setTimeout(() => setShown(frame), 180);
    return () => clearTimeout(id);
  }, [frame]);

  const results = (found.data?.videos || []).map((x) => ({ slug: x.slug, name: x.name, poster: x.poster }));
  const videos = [results.find((x) => x.slug === slug) || { slug, name, poster: null }, ...results.filter((x) => x.slug !== slug)];
  const fps = ver?.fps || 25;
  const end = Math.max(to, frame + 1);
  const pick = () => {
    if (!ver) return;
    onPick({
      key: pendingKey(),
      kind: 'frame',
      video: video.slug,
      v: ver.v,
      frame,
      ...(range ? { to_frame: Math.min(end, frames - 1) } : {}),
      caption: caption.trim(),
      label: `${video.name} · V${ver.v} · ${timecode(frame, fps)}`,
      still: `/api/review/${enc(video.slug)}/frame?v=${ver.v}&frame=${frame}`,
    });
    onClose();
  };

  return (
    <Modal
      title={t('Reference a frame')}
      onClose={onClose}
      width={620}
      foot={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" className="btn primary" onClick={pick} disabled={!ver} data-testid="fpick-add">
            {t('Add reference')}
          </button>
        </>
      }
    >
      <div className="fpick" data-testid="frame-picker">
        <input
          className="input"
          type="search"
          placeholder={t('Find a video…')}
          aria-label={t('Find a video')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="fpick-list" role="listbox" aria-label={t('Videos')}>
          {videos.map((x) => (
            <button
              key={x.slug}
              type="button"
              role="option"
              aria-selected={x.slug === video.slug}
              className={`fpick-video ${x.slug === video.slug ? 'on' : ''}`}
              onClick={() => {
                setVideo({ slug: x.slug, name: x.name });
                setV(null);
                setFrame(0);
                setTo(0);
              }}
            >
              {x.poster ? <img src={x.poster} alt="" loading="lazy" /> : <span className="fpick-poster" />}
              <span>{x.slug === slug ? t('{name} (this video)', { name: x.name }) : x.name}</span>
            </button>
          ))}
        </div>
        {ver && (
          <>
            <div className="fpick-row">
              {versions.length > 1 && (
                <Select
                  label={t('Version')}
                  value={String(ver.v)}
                  onChange={(x) => setV(Number(x))}
                  options={[...versions].reverse().map((x) => ({ value: String(x.v), label: `V${x.v}` }))}
                />
              )}
              <span className="mono">
                {timecode(frame, fps)} · F{frame}
                {range ? ` → ${timecode(end, fps)} · F${end}` : ''}
              </span>
            </div>
            <div className="fpick-stage">
              <img src={`/api/review/${enc(video.slug)}/frame?v=${ver.v}&frame=${shown}`} alt={t('Frame {frame}', { frame: shown })} />
            </div>
            <Slider label={t('Frame')} value={frame} min={0} max={frames - 1} onChange={setFrame} />
            <div className="fpick-row">
              <Checkbox id={rangeId} checked={range} onCheckedChange={setRange} />
              <label htmlFor={rangeId}>{t('A range, up to')}</label>
            </div>
            {range && <Slider label={t('Last frame')} value={end} min={Math.min(frame + 1, frames - 1)} max={frames - 1} onChange={setTo} />}
          </>
        )}
        <input
          className="input"
          placeholder={t('Caption (what to look at)')}
          aria-label={t('Caption')}
          maxLength={300}
          value={caption}
          onChange={(e) => setCaption(e.target.value)}
        />
      </div>
    </Modal>
  );
}
