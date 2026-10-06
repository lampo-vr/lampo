// The banner, the trial line and its card, the locked Add video's popover and the moments of value (billing/Banner.tsx):
// one chunk after the first paint, asked for by the library, the sidebar, the account menu and the player. Its import()
// rides the UI's layer chunk (ui/layers.tsx), which loads right after the first paint anyway: an import() here would put
// the list of every chunk it needs into the first paint, and the start's budget has no room for it.
import type { Loader } from '../lib/lazy.ts';
import { layerCode } from '../ui/layerCode.ts';

type Billing = typeof import('./Banner.tsx');

export const billingCode: Loader<Billing> = {
  load: () => layerCode.load().then((m) => m.billingCode.load()),
  get ready() {
    return layerCode.ready?.billingCode.ready;
  },
};
