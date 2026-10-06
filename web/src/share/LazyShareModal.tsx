// The share dialog loads on demand: most library visits never open it.
import { lazy, Suspense } from 'react';

const ShareModal = lazy(() => import('./ShareModal.tsx').then((m) => ({ default: m.ShareModal })));

export function LazyShareModal(props: { slug?: string; name?: string; folder?: string; edit?: string; onClose: () => void }) {
  return (
    <Suspense fallback={null}>
      <ShareModal {...props} />
    </Suspense>
  );
}
