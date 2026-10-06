// What every screen shares, mounted once in App: the tooltips and the toasts. Both live in the Radix layer
// (ui/layers.tsx), which loads right after the first paint — so a menu, dialog or drawer opened a moment later opens
// in the same frame as the tap — or at once, when a toast is asked for before that.
import { type ReactNode, useEffect, useState } from 'react';
import { afterPaint, useLoaded } from '../lib/lazy.ts';
import { layerCode } from './layerCode.ts';

function Layers() {
  const [want, setWant] = useState(false);
  const L = useLoaded(layerCode, want);
  useEffect(() => {
    const now = () => setWant(true);
    const cancel = afterPaint(now);
    window.addEventListener('vr-toast', now);
    return () => {
      cancel();
      window.removeEventListener('vr-toast', now);
    };
  }, []);
  return L ? (
    <>
      <L.TooltipLayer />
      <L.Toaster />
    </>
  ) : null;
}

export function Shell({ children }: { children: ReactNode }) {
  return (
    <>
      {children}
      <Layers />
    </>
  );
}
