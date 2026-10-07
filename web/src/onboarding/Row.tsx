// Get started at the sidebar's foot, above the trial's line, while the first run has steps open. This is the first
// paint's part, and all of it: the row's room, held from the start when this browser saw the row last time
// (lib/chromeHint.ts), as the trial line holds its own. The row itself — "Get started 2 of 5", its keyframe and its line
// of the steps — and the panel above it come with Get started's code right after the first paint (Panel.tsx SideRow).
import { useEffect } from 'react';
import { useAuthStatus } from '../api/auth.ts';
import { rememberStart } from '../lib/chromeHint.ts';
import { useLoaded, usePainted } from '../lib/lazy.ts';
import type { GetStartedProps } from './GetStarted.tsx';
import { getStartedCode, useFirstRun } from './state.ts';

export function StartRow(props: GetStartedProps) {
  const known = !!useAuthStatus().data;
  const { side } = useFirstRun();
  // what the next first paint holds room for
  useEffect(() => {
    if (known) rememberStart(side);
  }, [known, side]);
  const Ob = useLoaded(getStartedCode, usePainted(side) && side);
  if (Ob) return <Ob.SideRow {...props} />;
  // its room: the row's box, empty (Panel.tsx draws the same while it waits for the account)
  return side ? <div className="ob-side ob-side-room" aria-hidden="true" data-testid="ob-row-wrap" /> : null;
}
