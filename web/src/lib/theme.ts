// Light · Dark · System. The choice is stored per device (localStorage) and, signed in on a hosted server, on the
// account (prefs.theme), which is adopted whenever the account loads so the choice follows the person. index.html
// applies the stored choice before the first paint (lib/themeBoot.ts); this keeps <html data-theme> current after
// that, including while System follows a change of the device's setting.
import { useSyncExternalStore } from 'react';
import { THEME_COLOR, THEME_KEY } from '../../../lib/themeBoot.ts';
import type { ThemePref } from '../api/types.ts';

export type Theme = 'light' | 'dark';
export type { ThemePref };

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set<() => void>();
const valid = (v: unknown): v is ThemePref => v === 'light' || v === 'dark' || v === 'system';

function stored(): ThemePref {
  try {
    const v = localStorage.getItem(THEME_KEY);
    if (valid(v)) return v;
  } catch {}
  return 'system';
}

let pref = stored();
export const resolveTheme = (p: ThemePref): Theme => (p === 'system' ? (media?.matches ? 'light' : 'dark') : p);
let theme = resolveTheme(pref);

function apply() {
  theme = resolveTheme(pref);
  const root = document.documentElement;
  if (root.getAttribute('data-theme') !== theme) root.setAttribute('data-theme', theme);
  document.querySelector('meta[name="color-scheme"]')?.setAttribute('content', theme);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_COLOR[theme]);
  for (const l of listeners) l();
}

/** Makes `p` this device's choice (and the page's theme). The account copy is the caller's business (ThemeSwitch). */
export function setThemePref(p: ThemePref) {
  if (!valid(p)) return;
  pref = p;
  try {
    if (p === 'system') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, p);
  } catch {}
  apply();
}

export const themePref = () => pref;
export const currentTheme = () => theme;

if (typeof document !== 'undefined') {
  apply();
  media?.addEventListener('change', () => {
    if (pref === 'system') apply();
  });
  // Another tab of the app changed it.
  addEventListener('storage', (e) => {
    if (e.key !== THEME_KEY && e.key !== null) return;
    pref = stored();
    apply();
  });
}

const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => listeners.delete(l);
};

/** The stored choice: 'light' | 'dark' | 'system'. */
export const useThemePref = () => useSyncExternalStore(subscribe, themePref, () => 'system' as ThemePref);
/** What is on screen: 'light' | 'dark'. Canvas drawings redraw when it changes. */
export const useTheme = () => useSyncExternalStore(subscribe, currentTheme, () => 'dark' as Theme);

/** Reads a colour token (e.g. '--tl-bg') as it applies at `el`. */
export const cssVar = (el: Element, name: string) => getComputedStyle(el).getPropertyValue(name).trim();

/** '#rrggbb' or '#rgb' at `alpha`, for canvas code that needs a see-through version of a token. */
export function withAlpha(hex: string, alpha: number): string {
  const h = hex.replace('#', '');
  const full =
    h.length === 3
      ? h
          .split('')
          .map((c) => c + c)
          .join('')
      : h.slice(0, 6);
  const n = Number.parseInt(full, 16);
  if (Number.isNaN(n) || full.length !== 6) return hex;
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
