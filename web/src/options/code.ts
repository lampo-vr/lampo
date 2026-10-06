// The audition's code (Audition.tsx, with options.css): a chunk of its own, asked for when a way into it is pointed at
// or opened. Light on purpose — the library's first paint holds a way in (library/AskLead.tsx) and must not carry the
// options' line or its styles to get it.
import { loader } from '../lib/lazy.ts';

export const auditionCode = loader(() => import('./Audition.tsx'));
