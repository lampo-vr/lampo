// "V9 ▾": which render you are looking at, and every other one a click away (newest first, with when it came, how
// long it runs, whether someone approved it and the playbook it was made under), plus a shortcut to compare any of
// them with the one on screen. A partial render says so — "V8 · part (00:04–00:07)" — and how its seams fit; a full
// render after approved parts says whether it matches them (lib/part.ts).
import { useState } from 'react';
import { partWhere } from '../../../lib/part.ts';
import { timecode } from '../../../lib/time.ts';
import type { PlaybookStamp as Stamp } from '../../../lib/types.ts';
import type { Run, Version } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { isOpen, type RunLike, shortLine } from '../sessions/runState.ts';
import { madeBy } from '../sessions/runWords.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
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
  /** The video's agent work: who made each version, in how long, what it fixed (design §5.7). */
  runs?: Run[];
  /** Work going on: a version on its way shows as a ghost while it renders or uploads. */
  coming?: RunLike | null;
  /** "Steps": the Agent view on the work that made a version. */
  onSteps?: (id: string) => void;
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });

export function VersionPicker({ versions, v, latestV, approved, onVersion, onCompare, runs, coming = null, onSteps }: VersionPickerProps) {
  const [open, setOpen] = useState(false);
  const made = new Map((runs ?? []).map((r) => [r.id, r]));
  // the version on its way: "V4 · rendering 42 %", quiet and not to be picked, until it lands
  const ghost = coming && isOpen(coming) && coming.state === 'working' && coming.progress && coming.progress.what !== 'check' ? coming : null;
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
        {ghost && (
          <li className="vpick-ghost" aria-disabled="true" data-testid="version-ghost">
            <span className="vpick-row">
              <span className="vpick-num">V{ghost.progress?.v ?? latestV + 1}</span>
              <span className="vpick-meta">
                <span className="vpick-coming">
                  <KeyGlyph shape="ease" className="nav-kg live" />
                  {shortLine(ghost)} · {ghost.agent.name}
                </span>
              </span>
            </span>
          </li>
        )}
        {newestFirst.map((x) => {
          const said = [...(x.part ? [seamSaid(x.part, x.fps), checkSaid(x.part, x.fps)] : []), ...fullSaid(versions, x.v)].filter((s): s is PartSaid => !!s);
          // who made it: the agent's work (in how long, what it fixed), else who uploaded it
          const by = x.run ? made.get(x.run) : undefined;
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
                  {by ? (
                    <span className="vpick-by" data-testid="version-by">
                      <KeyGlyph
                        shape={by.state === 'done' ? 'half' : 'diamond'}
                        className="nav-kg run-kg ok"
                        pop={Date.now() - Date.parse(x.registered) < 60_000}
                      />
                      {madeBy(by)}
                      {by.plan.length > 0 && (
                        <span className="vpick-from">
                          {' · '}
                          {t('from your {n} note of {time}|from your {n} notes of {time}', { n: by.plan.length, time: timeOf(by.started) })}
                        </span>
                      )}
                    </span>
                  ) : (
                    x.by && <span className="vpick-by">{t('uploaded by {name}', { name: x.by })}</span>
                  )}
                </span>
                {x.v === v && <I name="check" size={14} className="vpick-check" />}
              </button>
              {by && onSteps && (
                <button
                  type="button"
                  className="btn sm ghost vpick-steps"
                  onClick={() => {
                    onSteps(by.id);
                    setOpen(false);
                  }}
                  data-testid="version-steps"
                >
                  {t('Steps')}
                </button>
              )}
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
