// Light · Dark · System wherever the theme can be chosen: a small segmented switch (library sidebar, settings,
// sign-in and setup, the client gate) or a menu group (the account menu, the client's player and room). Signed in on
// a hosted server the choice is saved on the account too, so the person's other devices follow (AuthGate adopts it).
import { t } from '../i18n/index.ts';
import { type ThemePref, useTheme, useThemePref } from '../lib/theme.ts';
import { I } from './icons.tsx';
import { IconButton, Menu, Tip } from './primitives.tsx';
import { OPTIONS, useChooseTheme, useThemeChoice } from './themeChoice.ts';
import { ToggleGroup, ToggleItem } from './toggle.tsx';

export { useChooseTheme, useThemeChoice };

/** Three small buttons; `labels` adds the words next to the icons. */
export function ThemeSwitch({ labels = false, className = '' }: { labels?: boolean; className?: string }) {
  const pref = useThemePref();
  const choose = useChooseTheme();
  return (
    <ToggleGroup
      className={`seg theme-switch ${labels ? '' : 'icons'} ${className}`}
      value={pref}
      onValueChange={(v) => choose(v as ThemePref)}
      aria-label={t('Theme')}
    >
      {OPTIONS().map((o) =>
        labels ? (
          <ToggleItem key={o.value} value={o.value} className={pref === o.value ? 'on' : ''}>
            <I name={o.icon} size={13} />
            {o.label}
          </ToggleItem>
        ) : (
          // The item outside, the tooltip inside: the item's data-state (on/off) must win.
          <ToggleItem key={o.value} value={o.value} asChild>
            <Tip content={o.label}>
              <button type="button" className={pref === o.value ? 'on' : ''} aria-label={o.label} data-tip="">
                <I name={o.icon} size={13} />
              </button>
            </Tip>
          </ToggleItem>
        ),
      )}
    </ToggleGroup>
  );
}

/** One icon button (showing what is on screen) that opens the choice: for crowded top bars. */
export function ThemeButton({ className = 'btn ghost icon-only sm' }: { className?: string }) {
  const theme = useTheme();
  const choice = useThemeChoice();
  return (
    <Menu
      sideOffset={6}
      trigger={<IconButton className={`${className} theme-button`} label={t('Theme')} icon={theme === 'light' ? 'sun' : 'moon'} size={15} />}
      items={[choice]}
    />
  );
}
