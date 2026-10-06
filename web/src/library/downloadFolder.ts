// "Download folder" for the team: the folder and its subfolders as one zip of the original renders. Asks for the size
// first, so an empty folder or a failure is a toast instead of a page with an error on it.
import { api, enc } from '../api/client.ts';
import type { ArchiveInfo } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { bytes } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';

export async function downloadFolder(folder: string): Promise<void> {
  try {
    const info = await api<ArchiveInfo>(`/api/folders/download/info?folder=${enc(folder)}`);
    if (!info.files) return toast(t('Nothing to download here yet'), 'error');
    const a = document.createElement('a');
    a.href = info.url;
    a.download = '';
    document.body.append(a);
    a.click();
    a.remove();
    toast(t('Downloading {n} video · {bytes}|Downloading {n} videos · {bytes}', { n: info.files, bytes: bytes(info.bytes) }), 'ok');
  } catch (e) {
    toastError(e);
  }
}
