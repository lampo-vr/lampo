// "V9 ▾": which render you are looking at, and every other one a click away (newest first, with when it came, how
// long it runs, whether someone approved it and the playbook it was made under), plus a shortcut to compare any of
// them with the one on screen. A partial render says so — "V8 · part (00:04–00:07)" — and how its seams fit; a full
// render after approved parts says whether it matches them (lib/part.ts).
import { useState } from 'react';
import { partWhere } from '../../../lib/part.ts';
import { timecode } from '../../../lib/time.ts';
import type { PlaybookStamp as Stamp } from '../../../lib/types.ts';
import type { Version } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Popover } from '../ui/primitives.tsx';
import { checkSaid, fullSaid, type PartSaid, partTag, seamSaid } from './partWords.ts';

interface VersionPickerProps {
  versions: Version[];
  v: number;
  latestV: number;
  approved: Set<number>;
  onVersion: (v: number) => void;
  /** Compare the version on screen with this one. */
  onCompare: (v: number) => void;
}

export function VersionPicker({ versions, v, latestV, approved, onVersion, onCompare }: VersionPickerProps) {
  const [open, setOpen] = useState(false);
  const newestFirst = [...versions].reverse();
  const shown = versions.find((x) => x.v === v);
  const part = shown?.part ? partTag(shown.part, shown.fps) : null;
  const jumps = !!shown?.part?.seam && shown.part.seam !== 'clean';
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="start"
      sideOffset={6}
      className="vpick-pop"
      trigger={
        <button
          type="button"
          className={`vpick ${v !== latestV ? 'older' : ''}`}
          aria-label={
            part ? t('Version {v} of {latestV}, a {part}, choose another', { v, latestV, part }) : t('Version {v} of {latestV}, choose another', { v, latestV })
          }
          data-testid="version-picker"
          data-part={part ? 'on' : undefined}
        >
          <span className="vpick-v">V{v}</span>
          {part && (
            <span className={`vpick-part ${jumps ? 'jumps' : ''}`} data-testid="version-part">
              <span aria-hidden="true">·</span> {t('part')}
              <span className="vpick-when"> ({shown?.part ? partWhere(shown.part, shown.fps) : ''})</span>
            </span>
          )}
          {v !== latestV && <span className="vpick-note">{t('not the newest')}</span>}
          <I name="down" size={12} />
        </button>
      }
    >
      <div className="label">{t('Versions')}</div>
      <ul className="vpick-list">
        {newestFirst.map((x) => {
          const said = [...(x.part ? [seamSaid(x.part, x.fps), checkSaid(x.part, x.fps)] : []), ...fullSaid(versions, x.v)].filter((s): s is PartSaid => !!s);
          return (
            <li key={x.v} className={x.v === v ? 'on' : ''}>
              <button
                type="button"
                className="vpick-row"
                aria-current={x.v === v}
                onClick={() => {
                  onVersion(x.v);
                  setOpen(false);
                }}
              >
                <span className="vpick-num">V{x.v}</span>
                <span className="vpick-meta">
                  <span>
                    {ago(x.registered)} · {timecode(Math.max(0, x.frames - 1), x.fps)}
                  </span>
                  <span className="vpick-tags">
                    {x.part && (
                      <span className="vpick-tag vpick-pb" data-testid="version-part-tag">
                        <I name="layers" size={11} />
                        {partTag(x.part, x.fps)}
                      </span>
                    )}
                    {x.v === latestV && <span className="vpick-tag">{t('newest')}</span>}
                    {approved.has(x.v) && <span className="vpick-tag ok">{t('approved')}</span>}
                    {!!x.playbook?.length && <PlaybookStamp stamp={x.playbook} />}
                  </span>
                  {said.map((s) => (
                    <span key={s.text} className={`vpick-said ${s.ok ? '' : 'ask'}`} data-testid="version-said">
                      {s.text}
                    </span>
                  ))}
                </span>
                {x.v === v && <I name="check" size={14} className="vpick-check" />}
              </button>
              {x.v !== v && (
                <IconButton
                  className="btn sm ghost icon-only"
                  label={t('Compare V{v} with V{v2}', { v, v2: x.v })}
                  icon="columns"
                  size={14}
                  onClick={() => {
                    onCompare(x.v);
                    setOpen(false);
                  }}
                />
              )}
            </li>
          );
        })}
      </ul>
    </Popover>
  );
}

/** The playbook revision a render arrived under: the deepest one (the folder's own), all of them on hover. */
function PlaybookStamp({ stamp }: { stamp: Stamp[] }) {
  const name = (scope: string) => scope.split('/').at(-1) || t('House');
  const own = stamp[stamp.length - 1];
  const all = stamp.map((s) => `${s.scope || t('House')} r${s.rev}`).join(' · ');
  return (
    <span className="vpick-tag vpick-pb" title={t('Made under {revs}', { revs: all })} data-testid="version-playbook">
      <I name="playbook" size={11} />
      {name(own.scope)} r{own.rev}
    </span>
  );
}
