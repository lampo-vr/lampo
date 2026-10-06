// Calendar days for link expiry, in the viewer's own time zone and language. A day travels as yyyy-mm-dd (the
// share draft's format); noon keeps date arithmetic clear of daylight-saving edges.
import { locale, t } from '../i18n/index.ts';

export const lang = () => locale();

/** yyyy-mm-dd of a local date. */
export const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** The local day a yyyy-mm-dd names, at noon. */
export const dayOf = (s: string) => {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
};

/** Today plus n days, at noon. */
export const inDays = (n: number, from = new Date()) => new Date(from.getFullYear(), from.getMonth(), from.getDate() + n, 12);

/** Whole days from today to a yyyy-mm-dd (1 = tomorrow). */
export const daysUntil = (s: string, from = new Date()) => Math.round((dayOf(s).getTime() - inDays(0, from).getTime()) / 86_400_000);

/** "Mon, 5 Oct 2026" / "Mo., 5. Okt. 2026", as the browser's language writes it. */
export const longDay = (s: string) => dayOf(s).toLocaleDateString(lang(), { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });

/** "tomorrow", "in 7 days": in the viewer's language (German said "(in 7 days)" in English). */
export const relDays = (n: number) =>
  n === 0 ? t('today') : n === 1 ? t('tomorrow') : n > 1 ? t('in {n} days', { n }) : t('{n} day ago|{n} days ago', { n: -n });

/** "Tue, 13 Oct" / "Di., 13. Okt.": a day this year or next, short, for a button. */
export const shortDay = (s: string) => dayOf(s).toLocaleDateString(lang(), { weekday: 'short', day: 'numeric', month: 'short' });

/** The first day of the week where the viewer lives: Monday in most of the world, Sunday in the US. */
export function weekStart(): 0 | 1 | 2 | 3 | 4 | 5 | 6 {
  try {
    const l = new Intl.Locale(lang()) as Intl.Locale & { getWeekInfo?: () => { firstDay: number }; weekInfo?: { firstDay: number } };
    const first = (l.getWeekInfo?.() ?? l.weekInfo)?.firstDay;
    if (first) return (first % 7) as 0 | 1 | 2 | 3 | 4 | 5 | 6;
  } catch {}
  return /^en(-US)?$/i.test(lang()) ? 0 : 1;
}
