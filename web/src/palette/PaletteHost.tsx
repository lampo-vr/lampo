// ⌘K (Ctrl K) anywhere in the app, or a top bar's Search button: the command palette. Its code loads on first use.
// ⌘, (Ctrl ,) opens Settings.
import { lazy, Suspense, useEffect, useState } from 'react';
import { OPEN_PALETTE } from './PaletteButton.tsx';

const CommandPalette = lazy(() => import('./CommandPalette.tsx'));

export function PaletteHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === ',') {
        // ⌘, (Ctrl ,): Settings, as in desktop apps (the account menu names it)
        e.preventDefault();
        setOpen(false);
        location.hash = '#/settings';
      }
    };
    const show = () => setOpen(true);
    window.addEventListener('keydown', key);
    window.addEventListener(OPEN_PALETTE, show);
    return () => {
      window.removeEventListener('keydown', key);
      window.removeEventListener(OPEN_PALETTE, show);
    };
  }, []);
  if (!open) return null;
  return (
    <Suspense fallback={null}>
      <CommandPalette onClose={() => setOpen(false)} />
    </Suspense>
  );
}
