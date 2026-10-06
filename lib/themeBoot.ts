// The colour theme and the language before the first paint: index.html carries this script inline (the Vite build puts it there), so
// the page never flashes dark before a light choice or the other way round. The hosted server allows exactly this
// script in its Content-Security-Policy by hash (server/guard.ts), so it must stay byte-for-byte what is hashed.
// Shared with the browser (web/src/lib/theme.ts): no Node imports.

/** localStorage key of the per-device choice: 'light' | 'dark' | 'system' (absent = system). */
export const THEME_KEY = 'vr.theme';

/** The browser chrome colour per theme (<meta name="theme-color">): the page background. */
export const THEME_COLOR = { dark: '#0b0b0c', light: '#f2efe7' } as const;

/** localStorage key of the per-device language: 'de' when German was chosen in Settings; anything else is English. */
export const LANG_KEY = 'vr.lang';

/** The UI languages. English is the source; German is loaded on demand (web/src/i18n). */
export const LANGS = ['en', 'de'] as const;
export type Lang = (typeof LANGS)[number];

/**
 * The language to show: English, unless German was chosen in Settings. The browser's languages don't decide (a German
 * browser still starts in English). THEME_BOOT inlines the same rule; test/unit/i18n.test.ts runs both side by side.
 * `languages` stays in the signature for callers that pass it; it is ignored.
 */
export function pickLang(stored: string | null, _languages: readonly string[] = []): Lang {
  return stored === 'de' ? 'de' : 'en';
}

/**
 * Chrome counts a native <select> focused by a click as :focus-visible (it takes keys), so a mouse click drew the
 * keyboard's ring on it. <html data-pointer> says the last input was a pointer: base.css leaves the ring off a select
 * then, and the next key (Tab, an arrow) brings it back. Set only when it changes, so a click restyles nothing. Here
 * (inline, before the first paint) rather than in the app's start: it costs the first paint's JavaScript nothing.
 */
const POINTER_BOOT = `if(typeof addEventListener=='function'){var r=document.documentElement;addEventListener('pointerdown',function(){if(!r.hasAttribute('data-pointer'))r.setAttribute('data-pointer','')},true);addEventListener('keydown',function(e){if(!e.metaKey&&!e.ctrlKey&&!e.altKey&&r.hasAttribute('data-pointer'))r.removeAttribute('data-pointer')},true)}`;

export const THEME_BOOT = `(function(){var p;try{p=localStorage.getItem(${JSON.stringify(THEME_KEY)})}catch(e){}var t=p==='light'||p==='dark'?p:window.matchMedia&&matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';document.documentElement.setAttribute('data-theme',t);var m=document.querySelector('meta[name="color-scheme"]');if(m)m.content=t;var c=document.querySelector('meta[name="theme-color"]');if(c)c.content=t==='light'?${JSON.stringify(THEME_COLOR.light)}:${JSON.stringify(THEME_COLOR.dark)};var s=null;try{s=localStorage.getItem(${JSON.stringify(LANG_KEY)})}catch(e){}document.documentElement.lang=s==='de'?'de':'en';${POINTER_BOOT}})()`;
