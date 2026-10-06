// The Radix half of the UI primitives (ui/layers.tsx): its own chunk, loaded once the first paint is done (ui/shell.tsx)
// or when a menu, popover or dialog is first used before that.
import { loader } from '../lib/lazy.ts';

export const layerCode = loader(() => import('./layers.tsx'));
