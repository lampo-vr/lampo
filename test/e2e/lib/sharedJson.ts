// A JSON file two processes share: the stand-in billing module's state (FAKE_BILLING_FILE), which a suite reads and
// sets while the server's module reads and writes it too. A plain writeFileSync empties the file and then fills it, so
// a reader in between gets half of it: a suite's read failed on CI with "Unexpected end of JSON input", and a tight
// loop of the two tore about 1 read in 6. Written whole beside it and renamed over it, a reader sees the old file or the
// new one, never part of one.
import fs from 'node:fs';
import path from 'node:path';

let written = 0;

/** Writes `data` to `file` as JSON in one step: a temp file in the same folder (so the same file system), then a rename. */
export function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${written++}.tmp`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, file);
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * The file's JSON, or `missing()` while there is no file yet. Anything else throws, a file that doesn't parse too: with
 * every writer atomic it can't be half-written, so it is broken, and an empty default would let a check pass or fail
 * for the wrong reason.
 */
export function readJson<T>(file: string, missing: () => T): T {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return missing();
    throw e;
  }
  try {
    return JSON.parse(text) as T;
  } catch (e) {
    throw new Error(`${file} doesn't parse: ${(e as Error).message}`);
  }
}
