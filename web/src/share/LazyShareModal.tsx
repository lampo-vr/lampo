// The share dialog loads on demand: most library visits never open it.
import { lazy, Suspense } from 'react';

const ShareModal = lazy(() => import('./ShareModal.tsx').then((m) => ({ default: m.ShareModal })));

export function LazyShareModal(props: {
  slug?: string;
  name?: string;
  folder?: string;
  /** Several videos picked in the library: one link for exactly these. */
  videos?: { slug: string; name: string }[];
  edit?: string;
  top?: number;
  onClose: () => void;
}) {
  return (
    <Suspense fallback={null}>
      <ShareModal {...props} />
    </Suspense>
  );
}
