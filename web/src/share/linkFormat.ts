// Time in a link's activity, in the viewer's language: "45 sec", "2 min" / "2 Min.".
import { locale } from '../i18n/index.ts';

/** Time watched: seconds under a minute, minutes under an hour, then hours. */
export function watchTime(secs: number): string {
  const unit = (n: number, u: 'second' | 'minute' | 'hour') => new Intl.NumberFormat(locale(), { style: 'unit', unit: u, unitDisplay: 'short' }).format(n);
  if (secs < 60) return unit(Math.max(1, Math.round(secs)), 'second');
  if (secs < 3600) return unit(Math.round(secs / 60), 'minute');
  return unit(Math.round((secs / 3600) * 10) / 10, 'hour');
}
