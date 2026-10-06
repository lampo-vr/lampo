// "Download all" in a folder link's review room: every video as one zip, the originals or the previews, whatever the
// link offers. The archive's size is known before anyone clicks; on iPhone and iPad it lands in Files › Downloads.
import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client.ts';
import { keys } from '../api/queries.ts';
import type { ArchiveInfo, GuestLink } from '../api/types.ts';
import { bytes } from '../lib/format.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import '../styles/downloads.css';
import { t } from '../i18n/index.ts';

// The room lives at /g/<token>; the token is all this button needs.
const tokenOf = () => /^\/g\/([A-Za-z0-9_-]+)/.exec(location.pathname)?.[1] || '';
const isIos = () => /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

export function DownloadAll({ link, name }: { link: GuestLink; name: string }) {
  const token = tokenOf();
  const offered = link.kind === 'folder' && link.perms.download !== 'off' && !!token;
  const info = useQuery({
    queryKey: [...keys.guest(token), 'archive'],
    queryFn: () => api<ArchiveInfo>(`/api/g/${token}/archive/info`),
    enabled: offered,
    // Previews still being made (ProRes & co.): look again until they are ready.
    refetchInterval: (q) => (q.state.data?.preparing ? 10_000 : false),
  });
  const d = info.data;
  if (!offered || !d?.files) return null;
  const href = `${d.url}${name ? `&name=${encodeURIComponent(name)}` : ''}`;
  const what = `${t('client::{n} video|{n} videos', { n: d.files })} · ${bytes(d.bytes)}`;
  return (
    <div className="g-download">
      {d.preparing ? (
        <button type="button" className="btn" disabled>
          <Spinner /> {t('client::Preparing {n} preview…|Preparing {n} previews…', { n: d.preparing })}
        </button>
      ) : (
        <a className="btn primary" href={href} download>
          <I name="download" size={15} /> {t('client::Download all')} <span className="g-download-size">{what}</span>
        </a>
      )}
      <span className="g-download-hint">
        {d.kind === 'original'
          ? isIos()
            ? t('client::The original files as one .zip, saved to Files › Downloads.')
            : t('client::The original files as one .zip.')
          : isIos()
            ? t('client::Preview files as one .zip, saved to Files › Downloads.')
            : t('client::Preview files as one .zip.')}
        {d.resumable ? ` ${t('client::It picks up where it stopped if the connection drops.')}` : ''}
      </span>
    </div>
  );
}
