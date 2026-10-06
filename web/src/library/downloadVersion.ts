// "Download V3" for the team: one version's own file, as it was uploaded or linked ("spot V3.mp4"). Asks the server
// first, like a folder's download, so a version whose file is gone or a role without the right is a toast instead of a
// failed download in the browser's list.
import { api, enc } from '../api/client.ts';
import type { VersionDownload } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { bytes } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';

export async function downloadVersion(slug: string, v: number): Promise<void> {
  try {
    const file = await api<VersionDownload>(`/api/review/${enc(slug)}/download/info?v=${v}`);
    const a = document.createElement('a');
    a.href = file.url;
    a.download = file.name;
    document.body.append(a);
    a.click();
    a.remove();
    toast(t('Downloading {name} · {bytes}', { name: file.name, bytes: bytes(file.bytes) }), 'ok');
  } catch (e) {
    toastError(e);
  }
}
