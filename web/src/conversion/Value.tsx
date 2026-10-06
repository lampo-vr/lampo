// Upgrades at the moment of value (conversion spec §2), never in the way of the work: a line that rides on what just
// happened, with the workspace's own numbers, one neutral action (the view's orange stays its own) and "Not now".
// - The loop (2a): the first fix in the workspace checked "Looks right" on a video of its own (not the sample), while
//   the trial runs — under the player's stage, for whoever checked it (who chooses the plan: owners and admins).
// - A review link opened (2b): the workspace's first link, opened for the first time — a card in the library's corner
//   for whoever made the link, live or on their next visit within a day; the video's chip turns "Opened just now".
// Each shows once per workspace (the server keeps that: lib/moments.ts); "Not now" puts it away for 14 days on every
// device, with Undo in the toast. Loaded after the first paint (billing/due.ts billingCode).

import { useEffect, useMemo, useRef, useState } from 'react';
import type { BillingInfo } from '../../../lib/types.ts';
import { avatarSrc, useAuthStatus } from '../api/auth.ts';
import { useBadge } from '../api/badge.ts';
import { useBilling, useLibrary } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { posterUrl } from '../lib/posterUrl.ts';
import { later } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Avatar } from '../ui/plain.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { trialOf } from './facts.ts';
import { hideFor14Days, isHidden, markSeen, momentEvent, useMoments } from './moments.ts';
import { afterLine, BILLING, checkoutHref, dayMonth } from './words.ts';
import '../styles/conversion.css';

/** "Not now": the card goes at once; after the toast's time it is put away for 14 days (Undo brings it back). */
function notNow(id: 'loop' | 'link_open', where: string, setGone: (g: boolean) => void) {
  const away = hideFor14Days(id);
  momentEvent('dismissed', id, where);
  later({
    message: t('Put away for 14 days'),
    apply: () => setGone(true),
    revert: () => setGone(false),
    commit: away.send,
  });
}

/** 2a, under the player's stage: the first loop on a video of the workspace's own, while the trial runs. */
export function LoopMoment({ slug, toCheck }: { slug: string; toCheck: number }) {
  const b = useBilling().data as BillingInfo | undefined;
  const tr = trialOf(b);
  const want = !!b?.manage && !!tr;
  const moments = useMoments(want).data;
  const pending = moments?.pending.find((m) => m.id === 'loop' && (!m.slug || m.slug === slug));
  const [gone, setGone] = useState(false);
  const shown = useRef(false);
  const show = want && !!pending && !gone && !isHidden(moments, 'loop');
  useEffect(() => {
    if (!show || shown.current) return;
    shown.current = true;
    markSeen('loop');
    momentEvent('shown', 'loop', 'player');
  }, [show]);
  if (!show || !b || !tr) return null;
  const n = b.usage.members;
  const after = afterLine(b);
  return (
    <section className="cv-loop" role="status" aria-label={t('Checked: looks right')} data-testid="loop-moment">
      <div className="cv-loop-done">
        <KeyGlyph shape="diamond" size={16} pop className="cv-ok" />
        <span>
          {t('Checked: looks right')}
          <small>
            {toCheck > 0
              ? t('{n} more fix to check on this video.|{n} more fixes to check on this video.', { n: toCheck })
              : t('Nothing left to check on this video.')}
          </small>
        </span>
      </div>
      <div className="cv-loop-line">
        <KeyGlyph shape="hold" size={11} />
        <div className="cv-loop-t">
          <b>{t('That’s the loop, on your own video.')}</b>
          <p>
            {n > 1
              ? t('Your {plan} trial keeps it running for all {n} of you until {date}.', { plan: b.planName, n, date: dayMonth(tr.endsAt) })
              : t('Your {plan} trial keeps it running until {date}.', { plan: b.planName, date: dayMonth(tr.endsAt) })}{' '}
            {after && `${after} `}
            {t('Nothing is charged before {date}.', { date: dayMonth(tr.endsAt) })}
          </p>
        </div>
        <div className="cv-loop-acts">
          <a className="btn sm" href={checkoutHref(b)} onClick={() => momentEvent('used', 'loop', 'player')} data-testid="loop-keep">
            {t('Keep {plan}…', { plan: b.planName })}
          </a>
          <button type="button" className="btn ghost sm" onClick={() => notNow('loop', 'player', setGone)} data-testid="loop-not-now">
            {t('Not now')}
          </button>
        </div>
      </div>
    </section>
  );
}

/** 2b, the library's corner: the workspace's first review link was opened, for whoever made it. */
export function LinkOpenMoment() {
  const b = useBilling().data as BillingInfo | undefined;
  const status = useAuthStatus().data;
  const moments = useMoments(!!b).data;
  const pending = moments?.pending.find((m) => m.id === 'link_open');
  const videos = useLibrary(!!pending).data?.videos;
  const video = useMemo(() => videos?.find((v) => v.slug === pending?.slug) ?? null, [videos, pending?.slug]);
  const [gone, setGone] = useState(false);
  const shown = useRef(false);
  const show = !!b && !!pending && !gone && !isHidden(moments, 'link_open');
  const badgeSetting = useBadge(show).data;
  useEffect(() => {
    if (!show || shown.current) return;
    shown.current = true;
    markSeen('link_open');
    momentEvent('shown', 'link_open', 'library');
  }, [show]);
  if (!show || !b || !pending) return null;
  const me = status?.user;
  const ws = status?.workspace?.name ?? '';
  // what a person on the link sees: the sender, and a small Lampo badge on every plan unless a paid one hid it (CLOUD-7)
  const badge = badgeSetting?.shown !== false;
  const mayHide = !!badgeSetting?.may;
  const dismiss = () => notNow('link_open', 'library', setGone);
  return (
    <>
      {/* the video's chip says it too, inverted, while the card is up */}
      {pending.slug && (
        <style>{`.film[data-slug="${CSS.escape(pending.slug)}"] .share-state{background:var(--fg);color:var(--ink-0);box-shadow:none}.film[data-slug="${CSS.escape(pending.slug)}"] .share-state .icon{color:var(--ink-0)}`}</style>
      )}
      <aside className="cv-float" aria-label={t('Your review link was opened')} data-testid="link-open-moment">
        <header className="cv-float-h">
          <span className="cv-eye" aria-hidden="true">
            <I name="eye" size={13} />
          </span>
          <span className="cv-float-t">
            <b>{t('Your review link was opened')}</b>
            <small>
              “{pending.link ?? ''}” · {ago(pending.at)}
            </small>
          </span>
          <IconButton className="btn ghost sm icon-only" label={t('Not now')} icon="x" size={14} onClick={dismiss} />
        </header>
        <figure className="cv-mini-page">
          <div className="cv-rl" aria-hidden="true">
            <div className="cv-rl-top">
              <span className="cv-rl-sender">
                <Avatar name={me?.name ?? ''} size={18} kind="person" src={avatarSrc(me?.avatar)} />
                <span>
                  <b>{me?.name}</b>
                  {ws && ` · ${ws}`}
                </span>
              </span>
              <span className="cv-rl-ap">
                <I name="check" size={11} />
                {t('Approve')}
              </span>
            </div>
            <div className="cv-rl-stage">{video?.hash && <img src={posterUrl({ slug: video.slug, hash: video.hash })} alt="" />}</div>
            <div className="cv-rl-foot">
              <span>{video ? `${video.name} · V${video.v ?? video.versions}` : ''}</span>
              <span className="cv-rl-badge">{badge ? t('Lampo badge') : t('Badge hidden')}</span>
            </div>
          </div>
          <figcaption>{t('What people on the link see')}</figcaption>
        </figure>
        <p className="cv-float-p">
          {!badge
            ? t('They see you and {workspace} as the sender.', { workspace: ws })
            : mayHide
              ? t('They see you and {workspace} as the sender, with a small Lampo badge. You can hide it in Settings → Review links.', { workspace: ws })
              : t('They see you and {workspace} as the sender, with a small Lampo badge. A paid plan can hide it.', { workspace: ws })}
        </p>
        <footer className="cv-float-f">
          {b.manage && (
            <a className="btn sm" href={BILLING} onClick={() => momentEvent('used', 'link_open', 'library')} data-testid="link-open-plans">
              {t('See plans')}
            </a>
          )}
          <button type="button" className="btn ghost sm" onClick={dismiss}>
            {t('Not now')}
          </button>
          <span className="grow" />
          <span className="cv-fine">{t('Shown once, for the first link')}</span>
        </footer>
      </aside>
    </>
  );
}
