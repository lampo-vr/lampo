// A review link's activity, opened from its card (loaded on first open): how far each video was watched — the
// furthest visitor and a heat strip of which hundredths played, darker where more visitors watched —, who came, and
// what they did, newest first. What is and isn't recorded: docs/sharing.md.
import type { ShareActivityInfo, ShareInfo, ShareVideoWatch } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { ago, pct } from '../lib/format.ts';
import { Avatar } from '../ui/controls.tsx';
import { I, type IconName } from '../ui/icons.tsx';
import { watchTime } from './linkFormat.ts';

type Event = ShareActivityInfo['events'][number];

/** Stretches of the strip with the same count of viewers: [start, length, count]. One rect per stretch, so neighbouring
 * hundredths never show a hairline between them. */
function runs(heat: number[]): [number, number, number][] {
  const out: [number, number, number][] = [];
  heat.forEach((n, i) => {
    const last = out.at(-1);
    if (last && last[2] === n && last[0] + last[1] === i) last[1] += 1;
    else out.push([i, 1, n]);
  });
  return out.filter(([, , n]) => n > 0);
}

/** Which hundredths of the version played, stronger where more visitors watched (one hue, sequential). */
function Heat({ v }: { v: ShareVideoWatch }) {
  const max = Math.max(1, ...v.heat);
  return (
    <svg className="link-heat" viewBox="0 0 100 1" preserveAspectRatio="none" role="img" aria-label={t('Watched parts of V{v}', { v: v.v })}>
      <rect className="link-heat-track" x="0" y="0" width="100" height="1" />
      {runs(v.heat).map(([x, w, n]) => (
        <rect key={x} x={x} y="0" width={w} height="1" style={{ opacity: 0.4 + (0.6 * n) / max }} />
      ))}
    </svg>
  );
}

function VideoRow({ v }: { v: ShareVideoWatch }) {
  return (
    <li className="link-watch" data-testid="link-watch">
      <div className="link-watch-head">
        <b className="ellipsis">{v.name}</b>
        <span className="link-watch-v">V{v.v}</span>
        <span className="link-watch-pct">{v.watched === null ? t('opened, not played') : t('{pct} watched', { pct: pct(v.watched) })}</span>
      </div>
      {v.heat.length > 0 && <Heat v={v} />}
      {v.viewers.length > 0 && (
        <div className="link-watch-who">
          {v.viewers
            .slice(0, 4)
            .map((x) => `${x.name ?? t('A visitor')} ${pct(x.watched)}`)
            .join(' · ')}
          {v.viewers.length > 4 ? ` · +${v.viewers.length - 4}` : ''}
        </div>
      )}
    </li>
  );
}

const ICON: Record<Event['kind'], IconName> = {
  open: 'folderOpen',
  view: 'eye',
  note: 'notes',
  reply: 'reply',
  check: 'verified',
  approval: 'check',
  download: 'download',
};

function sentence(e: Event): string {
  const name = e.name || t('Someone');
  const video = e.video ?? t('a video');
  switch (e.kind) {
    case 'open':
      return t('{name} opened the link', { name });
    case 'view':
      return t('{name} opened {video}', { name, video });
    case 'note':
      return e.detail === 'idea' ? t('{name} left an idea on {video}', { name, video }) : t('{name} left a note on {video}', { name, video });
    case 'reply':
      return t('{name} replied on {video}', { name, video });
    case 'check':
      return e.detail === 'reopen' ? t('{name} reopened a fix on {video}', { name, video }) : t('{name} confirmed a fix on {video}', { name, video });
    case 'approval':
      return e.detail === 'changes'
        ? t('{name} asked for changes on {video}', { name, video })
        : t('{name} approved V{v} of {video}', { name, v: e.v ?? 1, video });
    case 'download':
      return t('{name} downloaded {what}', { name, what: e.detail || t('a file') });
  }
}

export default function LinkActivity({ s }: { s: ShareInfo }) {
  const a = s.activity;
  return (
    <div className="link-activity" data-testid="link-activity">
      {a.videos.length > 0 && (
        <section className="link-act-sec">
          <h4>{s.kind === 'folder' ? t('Videos opened') : t('Watched')}</h4>
          <ul className="link-watches">
            {a.videos.map((v) => (
              <VideoRow key={v.slug} v={v} />
            ))}
          </ul>
        </section>
      )}
      {a.visitors.length > 0 && (
        <section className="link-act-sec">
          <h4>{t('Visitors')}</h4>
          <ul className="link-visitors">
            {a.visitors.slice(0, 8).map((v, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: visitors carry no id to the owner (their keys stay on the server); the list is read-only
              <li key={`${v.first}-${i}`}>
                <Avatar name={`guest:${v.name ?? '?'}`} kind="client" size={22} />
                <span className="link-visitor-name ellipsis">{v.name ?? t('A visitor')}</span>
                <span className="link-visitor-facts">
                  {[
                    v.opens ? t('{n} visit|{n} visits', { n: v.opens }) : null,
                    v.secs >= 1 ? t('{time} watched', { time: watchTime(v.secs) }) : null,
                    ago(v.last),
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
      {a.events.length > 0 && (
        <section className="link-act-sec">
          <h4>{t('Activity')}</h4>
          <ol className="link-events">
            {a.events.slice(0, 12).map((e, i) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: events have no id and two can share a second; the log is read-only, newest first
              <li key={`${e.at}-${e.kind}-${i}`} data-kind={e.kind}>
                <span className="link-event-icon">
                  <I
                    name={e.kind === 'approval' && e.detail === 'changes' ? 'undo' : e.kind === 'check' && e.detail === 'reopen' ? 'reopen' : ICON[e.kind]}
                    size={13}
                  />
                </span>
                <span className="link-event-text">{sentence(e)}</span>
                <time dateTime={e.at}>{ago(e.at)}</time>
              </li>
            ))}
          </ol>
        </section>
      )}
      <p className="link-privacy">
        <I name="shield" size={12} />
        <span>{t('Counted without addresses: visitors are told apart by a random id their browser keeps.')}</span>
      </p>
    </div>
  );
}
