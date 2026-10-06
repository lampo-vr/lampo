// One review link as one line, in the share dialog and in Settings → Review links: its name, what it lets visitors do
// and what came of it under it, then Copy and a menu (change it, revoke it). The line opens the link's activity (who
// came, how far each video was watched, what they did; LinkActivity, loaded on first open) when there is any.
import { lazy, Suspense, useEffect, useState } from 'react';
import type { ShareInfo } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { isProject } from '../lib/folders.ts';
import { ago, pct } from '../lib/format.ts';
import { copyText, toast } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { IconButton, Menu } from '../ui/primitives.tsx';
import { lang } from './dates.ts';
// its styles come with it: Settings → Review links shows these lines without the share dialog having loaded
import '../styles/share-links.css';

const LinkActivity = lazy(() => import('./LinkActivity.tsx'));

/** Who can reach the address: anyone (hosted, or through the tunnel), the local network, or only this computer. */
export type Reach = 'public' | 'lan' | 'local';

function reachText(r: Reach): string {
  return r === 'public' ? t('Anyone with the link can open it.') : r === 'lan' ? t('Reachable on your network only.') : t('Reachable from this computer only.');
}

/** What the link opens, in a few words: its video, the project or folder, or that it opens nothing now. */
export function whatOf(s: ShareInfo): string {
  if (s.gone) return s.kind === 'folder' ? t('Its folder was deleted: it opens nothing') : t('Its video was deleted: it opens nothing');
  if (s.kind === 'folder')
    return isProject(s.folder ?? '') ? t('Project {folder}', { folder: s.folder ?? '' }) : t('Folder {folder}', { folder: s.folder ?? '' });
  return s.name ?? t('This video');
}

/** What visitors may do, in the kind's word where it is one. */
function kindOf(s: ShareInfo): string {
  if (!s.comment) return s.download === 'original' ? t('Delivery') : t('Watch only');
  return s.approve ? t('Notes and approval') : t('Notes');
}

/** What came of it, short enough for one line: who, how often, how far. */
function activityOf(s: ShareInfo): string {
  const a = s.activity;
  const named = a.visitors.map((v) => v.name).filter((n): n is string => !!n);
  const names = [...new Set(named.length ? named : [...s.stats.reviewers].reverse())];
  if (!s.stats.opens && !names.length) return t('Not opened yet');
  const who = names.length ? names.slice(0, 2).join(', ') + (names.length > 2 ? ` +${names.length - 2}` : '') : t('Opened');
  const watched = a.videos.map((v) => v.watched).filter((w): w is number => w !== null);
  const facts = [
    s.stats.opens > 1 && t('{n}×', { n: s.stats.opens }),
    watched.length && t('{pct} watched', { pct: pct(Math.max(...watched)) }),
    s.stats.notes && t('{n} note|{n} notes', { n: s.stats.notes }),
    s.stats.last_opened && ago(s.stats.last_opened),
  ].filter(Boolean);
  return [who, ...facts].join(' · ');
}

interface Props {
  s: ShareInfo;
  url: string;
  reach: Reach;
  /** Where the line is shown: a video's dialog names a folder link's folder; Settings names what every link opens. */
  here: 'video' | 'folder' | 'all';
  /** The system share sheet (phones and tablets). */
  canShare: boolean;
  editing: boolean;
  onEdit: () => void;
  onRevoke: () => void;
}

export function LinkCard({ s, url, reach, here, canShare, editing, onEdit, onRevoke }: Props) {
  const [copied, setCopied] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const id = setTimeout(() => setCopied(false), 1600);
    return () => clearTimeout(id);
  }, [copied]);
  const any = !!(s.stats.opens || s.stats.notes || s.stats.downloads || s.activity.events.length);
  const copy = async () => {
    if (await copyText(url)) {
      setCopied(true);
      toast(t('Copied · {reach}', { reach: reachText(reach) }), 'ok');
    }
  };
  const until =
    s.expires && !s.expired ? t('until {date}', { date: new Date(s.expires).toLocaleDateString(lang(), { day: 'numeric', month: 'short' }) }) : null;
  const line = [(here === 'all' || (here === 'video' && s.kind === 'folder')) && whatOf(s), kindOf(s), until, s.expired || s.gone ? null : activityOf(s)]
    .filter(Boolean)
    .join(' · ');
  const name = (
    <span className="link-name">
      <b className="ellipsis">{s.label}</b>
      {s.password && <I name="lock" size={12} className="link-lock" aria-label={t('Password')} />}
      {s.expired && <span className="link-state off">{t('Expired')}</span>}
    </span>
  );

  return (
    <article className={`link-row ${s.expired ? 'expired' : ''} ${open ? 'open' : ''}`} aria-label={t('Review link “{label}”', { label: s.label })}>
      <div className="link-head">
        <I name={s.kind === 'folder' ? 'folder' : 'link'} size={16} className="link-icon" />
        {any ? (
          <button type="button" className="link-title link-open" aria-expanded={open} onClick={() => setOpen((x) => !x)} data-testid="link-sum">
            {name}
            <span className="link-sub ellipsis">{line}</span>
          </button>
        ) : (
          <div className="link-title">
            {name}
            <span className="link-sub ellipsis">{line}</span>
          </div>
        )}
        <div className="link-acts">
          {canShare && !s.expired && (
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => navigator.share({ title: t('Review: {label}', { label: s.label }), url }).catch(() => {})}
              aria-label={t('Share the link for {label}', { label: s.label })}
            >
              <I name="link" size={14} /> {t('Share…')}
            </button>
          )}
          {!s.expired && !s.gone && (
            <button
              type="button"
              className={`btn sm ghost link-copy ${copied ? 'done' : ''}`}
              onClick={copy}
              aria-label={copied ? t('Copied') : t('Copy link')}
            >
              <I name={copied ? 'check' : 'copy'} size={14} />
              <span className="link-copy-word">{copied ? t('Copied') : t('Copy')}</span>
            </button>
          )}
          <Menu
            trigger={
              <IconButton className={`btn sm ghost icon-only ${editing ? 'on' : ''}`} label={t('More for {label}', { label: s.label })} icon="more" size={15} />
            }
            items={[
              !s.gone && { label: t('Change link'), icon: 'edit', onClick: onEdit },
              any && { label: open ? t('Hide activity') : t('Activity'), icon: 'users', onClick: () => setOpen((x) => !x) },
              'sep',
              { label: t('Revoke'), icon: 'x', danger: true, onClick: onRevoke },
            ]}
          />
        </div>
      </div>

      {open && (
        <Suspense fallback={<div className="link-activity-wait" />}>
          <LinkActivity s={s} />
        </Suspense>
      )}
    </article>
  );
}
