// What was dropped or picked, as files with their paths: a dropped folder is walked (its paths kept as they are on the
// disk, the folder's own name first), a picked folder comes with its paths from the browser. What a file system or a
// tool leaves behind (.DS_Store, ._A001.mov, .git/, node_modules/ …) is set aside here, never sent, and said once.
import { isJunkPath } from '../../../lib/fileText.ts';

export interface Picked {
  file: File;
  /** Its path from what was dropped or picked ("Spring/Footage/A001C003.mov"; a loose file: its name). */
  rel: string;
}

export interface Gathered {
  picked: Picked[];
  /** What was left out: names of files, and folders with a "/" ("node_modules/"). */
  junk: string[];
}

// The entry API (webkitGetAsEntry) is the only way to read a dropped folder, in every browser.
interface Entry {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (ok: (f: File) => void, fail: (e: unknown) => void) => void;
  createReader?: () => { readEntries: (ok: (es: Entry[]) => void, fail: (e: unknown) => void) => void };
}

/** A folder's whole content: readEntries hands it over a hundred entries at a time, until it answers none. */
async function entriesOf(dir: Entry): Promise<Entry[]> {
  const reader = dir.createReader?.();
  if (!reader) return [];
  const all: Entry[] = [];
  for (;;) {
    const batch = await new Promise<Entry[]>((ok, fail) => reader.readEntries(ok, fail)).catch(() => [] as Entry[]);
    if (!batch.length) return all;
    all.push(...batch);
  }
}

const fileOf = (e: Entry) => new Promise<File | null>((ok) => (e.file ? e.file(ok, () => ok(null)) : ok(null)));

async function walk(e: Entry, path: string, out: Gathered): Promise<void> {
  if (e.isDirectory) {
    // a junk folder is left out whole, without reading it (node_modules can hold a hundred thousand files)
    if (isJunkPath(`${path}/-`)) {
      out.junk.push(`${e.name}/`);
      return;
    }
    for (const child of await entriesOf(e)) await walk(child, `${path}/${child.name}`, out);
    return;
  }
  if (isJunkPath(path)) {
    out.junk.push(e.name);
    return;
  }
  const file = await fileOf(e);
  if (file) out.picked.push({ file, rel: path });
}

/** True when the drag carries files from the desktop (cards dragged inside the app carry our own type). */
export const draggingFiles = (e: DragEvent) => !!e.dataTransfer && [...e.dataTransfer.types].includes('Files');

/** Everything a drop holds, folders walked. The entries are taken synchronously: the drop's data is gone after it. */
export async function fromDrop(dt: DataTransfer): Promise<Gathered> {
  const out: Gathered = { picked: [], junk: [] };
  const entries: Entry[] = [];
  const loose: File[] = [];
  for (const item of [...dt.items]) {
    if (item.kind !== 'file') continue;
    const e = (item as DataTransferItem & { webkitGetAsEntry?: () => Entry | null }).webkitGetAsEntry?.();
    if (e) entries.push(e);
    else {
      const f = item.getAsFile();
      if (f) loose.push(f);
    }
  }
  for (const e of entries) await walk(e, e.name, out);
  for (const f of loose) {
    if (isJunkPath(f.name)) out.junk.push(f.name);
    else out.picked.push({ file: f, rel: f.name });
  }
  return out;
}

/** What a file input picked: loose files, or a folder (`webkitdirectory`) with each file's path inside it. */
export function fromInput(list: FileList | null): Gathered {
  const out: Gathered = { picked: [], junk: [] };
  const junkDirs = new Set<string>();
  for (const file of [...(list ?? [])]) {
    const rel = (file as File & { webkitRelativePath?: string }).webkitRelativePath || file.name;
    if (!isJunkPath(rel)) {
      out.picked.push({ file, rel });
      continue;
    }
    // a file inside a junk folder: the folder is said once
    const names = rel.split('/');
    const dir = names.slice(0, -1).find((_, i) => isJunkPath(`${names.slice(0, i + 1).join('/')}/-`));
    if (dir) junkDirs.add(`${dir}/`);
    else out.junk.push(file.name);
  }
  out.junk.push(...junkDirs);
  return out;
}
