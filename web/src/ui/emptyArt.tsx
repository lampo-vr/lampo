// Scenes for empty states, in the app's own language (ui/emptyScenes.tsx draws them, ui/emptyMotion.ts moves them).
// Here is the frame they show in: a 240 × 144 box that holds its place from the first paint, so nothing moves when the
// drawing arrives with its chunk; the loop runs unless motion is reduced, and a hidden tab pauses it. Decorative:
// hidden from assistive tech.

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';

export type EmptyArtName =
  | 'library'
  | 'filter'
  | 'search'
  | 'folder'
  | 'filed'
  | 'clear'
  | 'check'
  | 'inbox'
  | 'insights'
  | 'list'
  | 'note'
  | 'agents'
  | 'suggest'
  | 'client'
  | 'token'
  | 'webhook'
  | 'error';

const onVisibility = (cb: () => void) => {
  document.addEventListener('visibilitychange', cb);
  return () => document.removeEventListener('visibilitychange', cb);
};
const REDUCE = '(prefers-reduced-motion: reduce)';
const onReduce = (cb: () => void) => {
  const q = matchMedia(REDUCE);
  q.addEventListener('change', cb);
  return () => q.removeEventListener('change', cb);
};

type Scenes = typeof import('./emptyScenes.tsx');
let scenes: Scenes | null = null;
let loading: Promise<Scenes> | null = null;
const loadScenes = () => {
  loading ??= import('./emptyScenes.tsx').then((m) => {
    scenes = m;
    return m;
  });
  return loading;
};

export function EmptyArt({ name }: { name: EmptyArtName }) {
  const [mod, setMod] = useState(scenes);
  const id = `ea${useId().replace(/[^\w-]/g, '')}`;
  const ref = useRef<SVGSVGElement>(null);
  const anims = useRef<Animation[]>([]);
  const hidden = useSyncExternalStore(
    onVisibility,
    () => document.hidden,
    () => false,
  );
  const still = useSyncExternalStore(
    onReduce,
    () => matchMedia(REDUCE).matches,
    () => true,
  );
  useEffect(() => {
    if (mod) return;
    let gone = false;
    void loadScenes().then((m) => !gone && setMod(m));
    return () => {
      gone = true;
    };
  }, [mod]);
  // the scene's timeline once the drawing is there; nothing moves under reduced motion
  useEffect(() => {
    const svg = ref.current;
    if (still || !mod || !svg) return;
    anims.current = mod.playScene(svg, name);
    if (document.hidden) for (const a of anims.current) a.pause();
    return () => {
      for (const a of anims.current) a.cancel();
      anims.current = [];
    };
  }, [mod, name, still]);
  const Art = mod?.ART[name];
  // a hidden tab holds the loop where it is
  useEffect(() => {
    for (const a of anims.current) hidden ? a.pause() : a.play();
  }, [hidden]);
  return (
    <svg ref={ref} className="empty-art" viewBox="0 0 240 144" width="240" height="144" aria-hidden="true" focusable="false" data-art={name}>
      <defs>
        <radialGradient id={`${id}-glow`}>
          <stop className="ea-glow-in" offset="0" />
          <stop className="ea-glow-out" offset="1" />
        </radialGradient>
      </defs>
      {Art && <Art id={id} />}
    </svg>
  );
}
