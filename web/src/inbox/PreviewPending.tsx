// The preview's boxes before there is anything to show in them: while the item's video loads (Preview.tsx), and while
// the preview's own code does (LazyPreview.tsx) — the loaded layout, nothing named: the picture's band above the side.
import { t } from '../i18n/index.ts';
import { Skeleton, SkeletonRegion, SkeletonText, SkLine } from '../ui/Skeleton.tsx';

const Player = () => (
  <div className="inbox-player">
    <div className="inbox-stage-box">
      <Skeleton className="inbox-pv-sk-stage" r={0} />
    </div>
    <div className="inbox-pv-sk-controls" />
  </div>
);

/** The player's boxes and the lines while it loads: one layout for every kind (a conversation's answer box at the
 * bottom, where its action goes). */
export const PreviewLoading = ({ talk = false }: { talk?: boolean }) => (
  <SkeletonRegion label={t('Loading the preview')} className="inbox-pv-main">
    <Player />
    <div className="inbox-pv-side">
      <div className="inbox-pv-body">
        <Skeleton w="40%" h={8} />
        <SkeletonText lines={2} />
      </div>
      {talk && (
        <div className="inbox-pv-act">
          <Skeleton w="100%" h={64} r={8} />
        </div>
      )}
    </div>
  </SkeletonRegion>
);

/** The whole preview, head included, before it can say what it shows. */
export function PreviewPending({ talk = false }: { talk?: boolean }) {
  return (
    <section className="inbox-preview" aria-hidden="true">
      <header className="inbox-pv-head">
        <div className="inbox-pv-title grow">
          <b>
            <SkLine w="40%" />
          </b>
          <span className="inbox-pv-sub">
            <SkLine w="24%" />
          </span>
        </div>
      </header>
      <PreviewLoading talk={talk} />
    </section>
  );
}
