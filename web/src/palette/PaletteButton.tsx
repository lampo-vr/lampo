// The way into the command palette from a top bar: "Search ⌘K" on wide screens, a magnifier on phones. The palette
// itself (PaletteHost) loads on first use.
import { I } from '../ui/icons.tsx';
import { Tip } from '../ui/primitives.tsx';
import '../styles/palette.css';
import { t } from '../i18n/index.ts';

export const OPEN_PALETTE = 'vr-palette';
export const openPalette = () => window.dispatchEvent(new Event(OPEN_PALETTE));
/** ⌘K on a Mac, Ctrl K elsewhere. */
export const PALETTE_KEY = typeof navigator !== 'undefined' && /Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘K' : 'Ctrl K';

export function PaletteButton() {
  return (
    <Tip content={t('Videos, folders, notes and actions')} shortcut={PALETTE_KEY}>
      <button type="button" className="btn ghost sm palette-btn" onClick={openPalette} aria-label={t('Search')} data-testid="palette-button">
        <I name="search" size={15} />
        <span className="palette-btn-label">{t('Search')}</span>
        <kbd className="kbd palette-btn-key">{PALETTE_KEY}</kbd>
      </button>
    </Tip>
  );
}
