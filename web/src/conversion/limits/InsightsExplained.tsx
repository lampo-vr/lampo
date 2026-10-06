// Insights on a plan without them: the page stays a page (never locked, never broken). It says what Insights would show
// from the workspace's own work — its videos, notes and checked fixes, counted from the library — beside an illustration
// marked as one, and one neutral way on: See Team, which opens the limit's sheet (the feature's sheet, billed for two
// while someone works alone). Rendered in Insights' place (library/Insights.tsx); its words and numbers, no data of
// Insights is asked for.

import { useEffect } from 'react';
import type { BillingInfo } from '../../../../lib/types.ts';
import { useAuthStatus } from '../../api/auth.ts';
import { useLibrary } from '../../api/queries.ts';
import { t } from '../../i18n/index.ts';
import { openLimit } from '../../lib/toast.ts';
import { I } from '../../ui/icons.tsx';
import { KeyGlyph } from '../../ui/KeyGlyph.tsx';
import { currencyOf, monthTotal, offerOf } from '../facts.ts';
import { momentEvent } from '../moments.ts';
import { money } from './model.ts';
import '../../styles/limits.css';

// a picture of the kind of thing Insights draws, never the workspace's data (it says so on it)
const BARS = [38, 52, 31, 66, 44, 72, 58, 81, 63, 49, 70, 54];
const ROWS = [72, 48, 30];

export function InsightsExplained({ b }: { b: BillingInfo }) {
  const lib = useLibrary().data;
  const workspace = useAuthStatus().data?.workspace?.name ?? '';
  const team = offerOf(b, 'team');
  const currency = currencyOf(b, team);
  const two = team ? monthTotal(team, 'year', Math.max(2, b.usage.members), currency) : null;
  const n = team ? Math.max(team.members.min, b.usage.members) : 2;
  const videos = lib?.videos.filter((v) => !v.archived && !v.sample) ?? null;
  const notes = videos?.reduce((s, v) => s + v.counts.total, 0) ?? 0;
  const checked = videos?.reduce((s, v) => s + v.counts.verified, 0) ?? 0;
  const counts = { workspace, videos: videos?.length ?? 0, notes, checked };
  useEffect(() => {
    momentEvent('shown', 'limit_sheet', 'insights_page');
  }, []);
  // the sidebar's Insights row names the plan that brings them while this page shows (limits.css)
  const plan = team?.name ?? 'Team';
  useEffect(() => {
    document.documentElement.style.setProperty('--lim-ins-plan', JSON.stringify(plan));
    return () => {
      document.documentElement.style.removeProperty('--lim-ins-plan');
    };
  }, [plan]);
  const see = () => {
    momentEvent('used', 'limit_sheet', 'insights_page');
    openLimit({ feature: 'insights', fits: team ? 'team' : undefined });
  };
  return (
    <section className="lim-ins" data-testid="insights-explained" aria-labelledby="lim-ins-h">
      <div className="lim-ins-txt">
        <p className="lim-k">{t('Insights come with {plan}', { plan: team?.name ?? 'Team' })}</p>
        <h2 id="lim-ins-h">{t('See where review time goes')}</h2>
        <p className="lim-ins-lede">
          {videos
            ? // "Costa Cuts’ own work", "Northwind’s own work": a name ending in s takes the apostrophe alone
              /s$/i.test(workspace)
              ? t('From {workspace}’ own work — {videos} videos, {notes} notes, {checked} checked fixes — Insights shows:', counts)
              : t('From {workspace}’s own work — {videos} videos, {notes} notes, {checked} checked fixes — Insights shows:', counts)
            : /s$/i.test(workspace)
              ? t('From {workspace}’ own work, Insights shows:', { workspace })
              : t('From {workspace}’s own work, Insights shows:', { workspace })}
        </p>
        <ul className="lim-ins-list">
          <li>
            <KeyGlyph shape="outline" size={10} />
            {t('how long a round takes, from V1 to approved')}
          </li>
          <li>
            <KeyGlyph shape="half" size={10} className="lim-ok" />
            {t('which fixes were right the first time, and which came back “Still wrong”')}
          </li>
          <li>
            <KeyGlyph shape="ease" size={10} className="lim-ins-agent" />
            {t('what each agent fixed, and how fast')}
          </li>
          <li>
            <I name="link" size={12} />
            {t('when review links were opened, and what came back')}
          </li>
        </ul>
        <div className="lim-ins-acts">
          <button type="button" className="btn" onClick={see} data-testid="insights-see-team">
            {t('See {plan}', { plan: team?.name ?? 'Team' })}
          </button>
          {team && two !== null && (
            <span className="lim-ins-fine">{t('{plan}: {amount} a month for {n}, billed yearly', { plan: team.name, amount: money(two, currency), n })}</span>
          )}
        </div>
      </div>
      <figure className="lim-ins-fig" aria-label={t('An illustration, not your data')}>
        <figcaption>{t('Illustration · not your data')}</figcaption>
        <div className="lim-ins-bars">
          {BARS.map((h, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a drawing's bars have no identity
            <i key={i} style={{ height: `${h}%` }} />
          ))}
        </div>
        <div className="lim-ins-rows">
          {ROWS.map((w) => (
            <span key={w}>
              <i style={{ width: `${w}%` }} />
            </span>
          ))}
        </div>
      </figure>
    </section>
  );
}
