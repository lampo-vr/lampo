// Who watched this video, under the timeline once anyone has: the chip opens who watched — the team and review-link
// visitors —, how often, how long and when (GET /api/review/:slug/audience, lib/views.ts), and a switch there lays the
// viewers band on the timeline (how much of each part of this version was watched, the stretches watched again
// underlined). One control: a split button's ▾ is too small to tap on a phone.
import { useState } from 'react';
import { usePeople } from '../api/auth.ts';
import type { AudienceViewer, VideoAudience } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago, pct, secsWords } from '../lib/format.ts';
import { I } from '../ui/icons.tsx';
import { Avatar, Switch } from '../ui/plain.tsx';
import { Popover } from '../ui/primitives.tsx';

const nameOf = (x: Pick<AudienceViewer, 'name' | 'kind'>) => x.name || (x.kind === 'client' ? t('Someone with the link') : t('Someone'));

/** "3× · 4 min · 80 % of V2": how often, how long, and how far into the version on screen. */
export function howWatched(x: Pick<AudienceViewer, 'total_sessions' | 'total_secs' | 'v' | 'watched'>, v: number): string {
  const how = `${t('{n}×', { n: x.total_sessions })} · ${secsWords(x.total_secs)}`;
  return x.v === v ? `${how} · ${t('{p} of V{v}', { p: pct(x.watched), v })}` : `${how} · ${t('saw V{v}', { v: x.v })}`;
}

export function ViewersChip({ audience, v, band, onBand }: { audience: VideoAudience; v: number; band: boolean; onBand: () => void }) {
  const [open, setOpen] = useState(false);
  const people = usePeople();
  const n = audience.viewers.length;
  if (!n) return null;
  // the band is about the version on screen: none when nobody watched this one
  const here = audience.v === v && audience.retention.length > 0;
  const on = band && here;
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      className="viewers-pop"
      sideOffset={6}
      align="start"
      trigger={
        <button type="button" className={`badge viewers ${on ? 'on' : ''}`} aria-label={t('Who watched')} data-testid="viewers-chip">
          <I name="eye" size={13} /> {t('{n} viewer|{n} viewers', { n })}
        </button>
      }
    >
      <div className="viewers-head">
        <b>{t('Watched by {n}|Watched by {n}', { n })}</b>
        <span className="muted">{t('the team and review links')}</span>
      </div>
      <div className="viewers-band">
        <span>{here ? t('Show on the timeline how much of V{v} was watched', { v }) : t('Nobody has watched V{v} yet', { v })}</span>
        <Switch checked={on} disabled={!here} onCheckedChange={onBand} label={t('Show on the timeline how much of V{v} was watched', { v })} />
      </div>
      <ul className="viewers-rows" data-testid="viewers-rows">
        {audience.viewers.map((x) => (
          <li key={x.key} className="viewer-row">
            <Avatar name={nameOf(x)} src={x.kind === 'person' && x.name ? people(x.name) : null} size={24} kind={x.kind === 'client' ? 'client' : 'person'} />
            <span className="viewer-who">
              <b>{nameOf(x)}</b>
              <span className="muted">{x.kind === 'client' ? (x.link ? t('via {link}', { link: x.link }) : t('via review link')) : t('team')}</span>
            </span>
            <span className="viewer-how">{howWatched(x, v)}</span>
            <span className="viewer-when muted">{ago(x.last)}</span>
          </li>
        ))}
      </ul>
    </Popover>
  );
}
