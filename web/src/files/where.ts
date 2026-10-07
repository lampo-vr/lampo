// The Files tab's address, without the DOM (route.ts follows it in the page): the area — a folder's files at
// #/files/<folder>, the House's in Settings → Files —, the folder inside it, its trash, the file opened beside the list.

export interface FilesAt {
  path: string;
  trash: boolean;
  open: string | null;
}

export function filesHref(area: string, at: Partial<FilesAt> = {}): string {
  const q = new URLSearchParams();
  if (at.path) q.set('path', at.path);
  if (at.trash) q.set('trash', '1');
  if (at.open) q.set('open', at.open);
  const qs = q.toString().replace(/\+/g, '%20');
  return `${area ? `#/files/${encodeURIComponent(area)}` : '#/settings/files'}${qs ? `?${qs}` : ''}`;
}

export function readFilesAt(hash: string): FilesAt {
  const q = new URLSearchParams(hash.split('?')[1] ?? '');
  return { path: (q.get('path') ?? '').replace(/^\/+|\/+$/g, ''), trash: q.get('trash') === '1', open: q.get('open') };
}
