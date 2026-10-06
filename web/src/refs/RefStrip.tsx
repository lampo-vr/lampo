// A note's references as a row of thumbnails: the same fixed box for every kind (so nothing moves when a still loads),
// a small mark for what it is (clip length, a moment, a link's site), the caption underneath. A link opens in a new
// tab; everything else in RefViewer. In edit mode each one can lose its caption or itself.
import { useState } from 'react';
import { t } from '../i18n/index.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { IconButton } from '../ui/primitives.tsx';
import type { ViewRef } from './model.ts';
import '../styles/refs.css';

const ICON: Record<ViewRef['kind'], IconName> = { image: 'image', clip: 'play', frame: 'film', link: 'link', audio: 'volume' };

function kindWord(r: ViewRef, client: boolean): string {
  if (r.kind === 'clip') return `${r.duration?.toFixed(1) ?? '?'} s`;
  if (r.kind === 'link') return r.site || (client ? t('client::Link') : t('Link'));
  if (r.kind === 'frame') return client ? t('client::Moment') : t('Moment');
  return client ? t('client::Image') : t('Image');
}

interface RefStripProps {
  refs: ViewRef[];
  onOpen: (r: ViewRef) => void;
  /** Edit mode: remove, and change a caption (owner side). */
  editing?: boolean;
  onRemove?: (r: ViewRef) => void;
  onCaption?: (r: ViewRef, caption: string) => void;
  /** Words from the client pages' dictionary. */
  client?: boolean;
}

export function RefStrip({ refs, onOpen, editing, onRemove, onCaption, client = false }: RefStripProps) {
  if (!refs.length) return null;
  return (
    <ul className="refs" aria-label={client ? t('client::References') : t('References')} data-testid="refs">
      {refs.map((r) => (
        <li key={r.id} className={`ref ref-${r.kind}`} data-testid={`ref-${r.kind}`}>
          {r.kind === 'link' ? (
            <a className="ref-box" href={r.url || undefined} target="_blank" rel="noopener noreferrer" title={r.url || undefined}>
              <I name="link" size={18} />
              <span className="ref-site">{r.site}</span>
            </a>
          ) : (
            <button type="button" className="ref-box" onClick={() => onOpen(r)} aria-label={`${kindWord(r, client)}${r.caption ? `: ${r.caption}` : ''}`}>
              {r.still && <img src={r.still} alt="" loading="lazy" />}
            </button>
          )}
          <span className="ref-mark">
            <I name={ICON[r.kind]} size={11} />
            {r.kind === 'clip' && kindWord(r, client)}
          </span>
          {editing && onCaption ? (
            <Caption r={r} onCaption={onCaption} />
          ) : (
            (r.caption || r.where) && (
              <span className="ref-cap" title={r.caption || r.where || undefined}>
                {r.caption || r.where}
              </span>
            )
          )}
          {editing && onRemove && r.mine && (
            <IconButton
              className="btn ghost icon-only ref-remove"
              label={client ? t('client::Remove reference') : t('Remove reference')}
              icon="x"
              size={12}
              onClick={() => onRemove(r)}
            />
          )}
        </li>
      ))}
    </ul>
  );
}

function Caption({ r, onCaption }: { r: ViewRef; onCaption: (r: ViewRef, caption: string) => void }) {
  const [value, setValue] = useState(r.caption || '');
  return (
    <input
      className="ref-cap-edit"
      aria-label={t('Caption')}
      placeholder={t('Caption')}
      maxLength={300}
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => value !== (r.caption || '') && onCaption(r, value)}
      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
    />
  );
}
