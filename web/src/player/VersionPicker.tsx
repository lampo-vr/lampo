// "V9 ▾": which render you are looking at, and every other one a click away, newest first, one short line each —
// "V4 · 8 min ago · 3 fixed" — with a quiet mark for the current, the newest and an approved one, and a shortcut to
// compare it with the one on screen. The rest (who made it and from which notes, how long it runs, a part's stretch and
// seams, the playbook it was made under) is the row's details: its tooltip on a desk, a tap on its ⌄ on a touch screen.
// What a part's seams or the next full render found wrong stays in the row itself. How an agent made a version is the
// Agent tab's (its runs). A partial render says so in the button — "V8 · part (00:04–00:07)" (lib/part.ts).
import { useState } from 'react';
import { agentShown } from '../../../lib/agentKind.ts';
import { partWhere } from '../../../lib/part.ts';
import type { PlaybookStamp as Stamp } from '../../../lib/types.ts';
import type { Run, Version } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { isOpen, type RunLike, shortLine } from '../sessions/runState.ts';
import { madeBy } from '../sessions/runWords.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Popover, Tip } from '../ui/primitives.tsx';
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
}

const timeOf = (iso: string) => new Date(iso).toLocaleTimeString(locale(), { hour: 'numeric', minute: '2-digit' });
/** A version's length as a length reads ("0:41"), never like a timecode. */
const lengthOf = (x: Version) => {
  const s = Math.round(x.frames / (x.fps || 25));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** The row's one short line after its number: when, then what an agent fixed, the part it is, or who uploaded it. */
function ShortLine({ x, by }: { x: Version; by: Run | undefined }) {
  const what = x.part
    ? null
    : by?.result?.fixed
      ? t('{n} fixed', { n: by.result.fixed })
      : by
        ? (agentShown(by.agent.name, by.agent.kind).split(' · ')[0] ?? '')
        : x.by
          ? t('by {name}', { name: x.by })
          : '';
  return (
    <span className="vpick-line">
      {ago(x.registered)}
      {x.part ? (
        <>
          {' · '}
          <span data-testid="version-part-tag">{partTag(x.part, x.fps)}</span>
        </>
      ) : (
        what && ` · ${what}`
      )}
    </span>
  );
}

/** Everything else about a version: its tooltip on a desk, the row opened on a touch screen. */
function VersionDetails({ x, before, by, said }: { x: Version; before: Version | null; by: Run | undefined; said: PartSaid[] }) {
  const length = lengthOf(x);
  const was = before && lengthOf(before) !== length ? lengthOf(before) : null;
  return (
    <span className="vpick-details" data-testid="version-details">
      {by ? (
        <span data-testid="version-by">
          {madeBy({ ...by, agent: { ...by.agent, name: agentShown(by.agent.name, by.agent.kind) } })}
          {by.plan.length > 0 && (
            <>
              {' · '}
              {t('from your {n} note of {time}|from your {n} notes of {time}', { n: by.plan.length, time: timeOf(by.started) })}
            </>
          )}
        </span>
      ) : (
        x.by && <span data-testid="version-by">{t('uploaded by {name}', { name: x.by })}</span>
      )}
      {said
        .filter((s) => s.ok)
        .map((s) => (
          <span key={s.text} data-testid="version-said">
            {s.text}
          </span>
        ))}
      <span>{was ? t('{now}, was {before}', { now: length, before: was }) : length}</span>
      {!!x.playbook?.length && <PlaybookStamp stamp={x.playbook} />}
    </span>
  );
}

export function VersionPicker({ versions, v, latestV, approved, onVersion, onCompare, runs, coming = null }: VersionPickerProps) {
  const [open, setOpen] = useState(false);
  // a touch screen's opened rows (no tooltip there): their details under them
  const [shown, setShown] = useState<ReadonlySet<number>>(new Set());
  const made = new Map((runs ?? []).map((r) => [r.id, r]));
  // the version on its way: "V4 · rendering 42 %", quiet and not to be picked, until it lands
  const ghost = coming && isOpen(coming) && coming.state === 'working' && coming.progress && coming.progress.what !== 'check' ? coming : null;
  const newestFirst = [...versions].reverse();
  const onScreen = versions.find((x) => x.v === v);
  const part = onScreen?.part ? partTag(onScreen.part, onScreen.fps) : null;
  const jumps = !!onScreen?.part?.seam && onScreen.part.seam !== 'clean';
  const openChange = (o: boolean) => {
    setOpen(o);
    if (!o) setShown(new Set());
  };
  return (
    <Popover
      open={open}
      onOpenChange={openChange}
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
              <span className="vpick-when"> ({onScreen?.part ? partWhere(onScreen.part, onScreen.fps) : ''})</span>
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
              <span className="vpick-coming">
                <KeyGlyph shape="ease" className="nav-kg live" />
                {shortLine(ghost)} · {agentShown(ghost.agent.name, ghost.agent.kind)}
              </span>
            </span>
          </li>
        )}
        {newestFirst.map((x) => {
          const i = versions.indexOf(x);
          const before = i > 0 ? versions[i - 1] : null;
          const said = [...(x.part ? [seamSaid(x.part, x.fps), checkSaid(x.part, x.fps)] : []), ...fullSaid(versions, x.v)].filter((s): s is PartSaid => !!s);
          const by = x.run ? made.get(x.run) : undefined;
          const current = x.v === v;
          const details = <VersionDetails x={x} before={before} by={by} said={said} />;
          const opened = shown.has(x.v);
          return (
            <li key={x.v} className={current ? 'on' : ''}>
              <Tip content={details} side="right">
                <button
                  type="button"
                  className="vpick-row"
                  aria-current={current}
                  onClick={() => {
                    onVersion(x.v);
                    openChange(false);
                  }}
                >
                  <span className="vpick-num">V{x.v}</span>
                  <span className="vpick-text">
                    <span className="vpick-short">
                      <ShortLine x={x} by={by} />
                      {current && <span className="vpick-tag on">{t('current')}</span>}
                      {x.v === latestV && <span className="vpick-tag">{t('newest')}</span>}
                      {approved.has(x.v) && <span className="vpick-tag ok">{t('approved')}</span>}
                    </span>
                    {/* what a part's seams or the next full render found wrong: in the row, not behind its details */}
                    {said
                      .filter((s) => !s.ok)
                      .map((s) => (
                        <span key={s.text} className="vpick-said ask" data-testid="version-said">
                          {s.text}
                        </span>
                      ))}
                  </span>
                </button>
              </Tip>
              <span className="vpick-acts">
                <IconButton
                  className="btn sm ghost icon-only vpick-more"
                  label={t('Details of V{v}', { v: x.v })}
                  icon="down"
                  size={14}
                  aria-expanded={opened}
                  onClick={() =>
                    setShown((was) => {
                      const next = new Set(was);
                      if (!next.delete(x.v)) next.add(x.v);
                      return next;
                    })
                  }
                />
                {!current && (
                  <IconButton
                    className="btn sm ghost icon-only"
                    label={t('Compare V{v} with V{v2}', { v, v2: x.v })}
                    icon="columns"
                    size={14}
                    onClick={() => {
                      onCompare(x.v);
                      openChange(false);
                    }}
                  />
                )}
              </span>
              {opened && <span className="vpick-open">{details}</span>}
            </li>
          );
        })}
      </ul>
    </Popover>
  );
}

/** The playbook revision a render arrived under: the deepest one (the folder's own), all of them in its title. */
function PlaybookStamp({ stamp }: { stamp: Stamp[] }) {
  const name = (scope: string) => scope.split('/').at(-1) || t('House');
  const own = stamp[stamp.length - 1];
  const all = stamp.map((s) => `${s.scope || t('House')} r${s.rev}`).join(' · ');
  return (
    <span className="vpick-pb" title={t('Made under {revs}', { revs: all })} data-testid="version-playbook">
      <I name="playbook" size={11} />
      {name(own.scope)} r{own.rev}
    </span>
  );
}
