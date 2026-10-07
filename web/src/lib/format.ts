import { locale, t } from '../i18n/index.ts';

/** How long ago, in words; `now` for a moment other than this one (a still picture, a test). */
export function ago(iso: string | null | undefined, now = Date.now()) {
  if (!iso) return '';
  const s = (now - new Date(iso).getTime()) / 1000;
  if (s < 45) return t('just now');
  if (s < 3600) return t('{n} min ago', { n: Math.round(s / 60) });
  if (s < 86400) return t('{n} h ago', { n: Math.round(s / 3600) });
  if (s < 86400 * 7) return t('{n} d ago|{n} d ago', { n: Math.round(s / 86400) });
  // The date in the UI language's format (de-DE, or the browser's English variant).
  return new Date(iso).toLocaleDateString(locale(), { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export const tilde = (p: string | null | undefined, home?: string | null) => (home && p?.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p || '');

export const pad = (n: number, w = 2) => String(n).padStart(w, '0');

/** A share (0 … 1) as a percentage in the UI's language: "70%", "70 %". */
export const pct = (f: number): string => new Intl.NumberFormat(locale(), { style: 'percent', maximumFractionDigits: 0 }).format(f);

export const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
/** A span of hours in words: 38 min · 3.5 h · 2 d. */
export const hoursWords = (h: number | null | undefined) =>
  h == null
    ? '–'
    : h < 1
      ? t('{n} min', { n: Math.max(1, Math.round(h * 60)) })
      : h < 48
        ? t('{n} h', { n: h < 10 ? Math.round(h * 10) / 10 : Math.round(h) })
        : t('{n} d', { n: Math.round(h / 24) });

/** A span of seconds in words: 45 s · 4 min · 1.5 h. */
export function secsWords(s: number): string {
  if (s < 60) return t('{n} s', { n: Math.max(1, Math.round(s)) });
  if (s < 3600) return t('{n} min', { n: Math.round(s / 60) });
  const h = s / 3600;
  return t('{n} h', { n: h < 10 ? Math.round(h * 10) / 10 : Math.round(h) });
}

export const fileName = (p: string) => p.split('/').pop() || p;

const num = (n: number, digits: number) => n.toLocaleString(locale(), { maximumFractionDigits: digits, minimumFractionDigits: digits });
export const bytes = (n: number) =>
  n >= 1e9 ? `${num(n / 1e9, n >= 1e10 ? 0 : 1)} GB` : n >= 1e6 ? `${num(n / 1e6, 0)} MB` : `${num(Math.max(1, n / 1e3), 0)} kB`;
