// One reference, large: an image, a clip that plays, or a moment of a render as its frame (a range: its first and last
// frame side by side), with "Open in player" on the owner's side.
import { t } from '../i18n/index.ts';
import { parseRoute } from '../lib/nav.ts';
import { I } from '../ui/icons.tsx';
import { Modal } from '../ui/primitives.tsx';
import { GOTO_FRAME, type ViewRef } from './model.ts';

export function RefViewer({ r, onClose, client = false }: { r: ViewRef; onClose: () => void; client?: boolean }) {
  const title =
    r.caption || (r.kind === 'clip' ? (client ? t('client::Clip') : t('Clip')) : r.kind === 'frame' ? r.where || '' : client ? t('client::Image') : t('Image'));
  return (
    <Modal title={title} onClose={onClose} width={960}>
      <div className="ref-view" data-testid="ref-viewer" data-kind={r.kind}>
        {r.kind === 'clip' && r.src ? (
          // biome-ignore lint/a11y/useMediaCaption: a reference clip someone attached; its caption is the title above
          <video src={r.src} poster={r.still || undefined} controls autoPlay loop playsInline />
        ) : r.kind === 'image' && r.src ? (
          <img src={r.src} alt={r.caption || ''} />
        ) : (
          <div className={`ref-frames ${r.end ? 'two' : ''}`}>
            {r.still && <img src={r.still} alt={r.where || ''} />}
            {r.end && <img src={r.end} alt={client ? t('client::Last frame') : t('Last frame')} />}
          </div>
        )}
        {(r.where || r.open || r.caption) && (
          <div className="ref-view-foot">
            {r.where && <span className="mono">{r.where}</span>}
            <span className="grow" />
            {r.open && (
              <a
                className="btn sm"
                href={r.open}
                onClick={(e) => {
                  const here = parseRoute(location.hash, location.pathname);
                  if (r.goto && here.name === 'player' && here.slug === r.goto.slug) {
                    e.preventDefault();
                    window.dispatchEvent(new CustomEvent(GOTO_FRAME, { detail: r.goto }));
                  }
                  onClose();
                }}
                data-testid="ref-open"
              >
                <I name="play" size={13} /> {t('Open in player')}
              </a>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
}
