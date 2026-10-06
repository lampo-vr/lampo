// The cards while the list loads: the first group's head — a video's when the inbox reads by video, else a kind's —
// and cards in their own boxes. Light: the inbox view's loading layout draws it before the view's code is here.
import { t } from '../i18n/index.ts';
import { useInboxMode } from '../inbox/mode.ts';
import { SkeletonRegion, SkLine } from '../ui/Skeleton.tsx';
import '../styles/foryou.css';

/** An item card while the list loads: the thumbnail's box and the card's first lines. */
const PendingItem = ({ w, inVideo }: { w: string; inVideo: boolean }) => (
  <div className="fy-item pending">
    <span className="fy-thumb" />
    <div className="fy-body">
      <div className="fy-meta">
        <span className="fy-video">
          <SkLine w="40%" />
        </span>
      </div>
      {!inVideo && (
        <div className="fy-who">
          <SkLine w="30%" />
        </div>
      )}
      <p className="fy-text">
        <SkLine w={w} />
      </p>
    </div>
  </div>
);

export function ForYouPending() {
  const [mode] = useInboxMode();
  return (
    <SkeletonRegion label={t('Loading what waits for you')} className={`fy-group ${mode === 'video' ? 'g-video' : ''}`}>
      {mode === 'video' ? (
        <div className="fy-vhead">
          <span className="fy-vthumb" />
          <div className="fy-vhead-body">
            <span className="fy-vhead-name">
              <SkLine w="45%" />
            </span>
            <span className="fy-vhead-sum">
              <SkLine w="60%" />
            </span>
          </div>
        </div>
      ) : (
        <h2 className="fy-h">
          <SkLine w="8em" />
        </h2>
      )}
      {['72%', '56%', '64%'].map((w) => (
        <PendingItem key={w} w={w} inVideo={mode === 'video'} />
      ))}
    </SkeletonRegion>
  );
}
