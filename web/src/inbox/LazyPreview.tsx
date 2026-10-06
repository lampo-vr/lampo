// The preview is a small player (Preview.tsx and what it plays with): its code comes when a preview is first shown, so
// the library's first paint (the inbox view is part of the library) doesn't carry it. Until it is here: the same boxes.
import { loader, useLoaded } from '../lib/lazy.ts';
import { isTalk } from './items.tsx';
import type { PreviewProps } from './Preview.tsx';
import { PreviewPending } from './PreviewPending.tsx';

export const previewCode = loader(() => import('./Preview.tsx'));

export function LazyPreview(props: PreviewProps) {
  const code = useLoaded(previewCode);
  return code ? <code.Preview {...props} /> : <PreviewPending talk={isTalk(props.item)} />;
}
