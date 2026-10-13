// Project files in the store on this machine (lib/files.ts), for `lampo files` and the MCP tools: what a folder holds,
// where a file's bytes are read from (the store's own, copied out by whoever reads them), and a push from this disk —
// each file's bytes copied in (a clone where the disk can) and kept once by their sha256, then one change of the area
// per batch, as `POST /api/files/commit` makes it. Every write is a version, attributed to the writer and its agent.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { localOwner } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { scopeOf } from '../fileAreas.ts';
import {
  areaRefOf,
  blobKey,
  commitFiles,
  FileConflictError,
  type FileStampIn,
  filesSummary,
  findFile,
  heldBlob,
  heldBlobs,
  listFiles,
  namedFolder,
  storeBlob,
  versionOf,
} from '../files.ts';
import { FILE_LIMITS } from '../fileText.ts';
import { checkNotArchived } from '../folderIds.ts';
import { cleanAgentName } from '../names.ts';
import { cacheDir } from '../paths.ts';
import { filesStorage } from '../storage/index.ts';
import { isAgent } from '../time.ts';
import type { FileCommitAnswer, FileConflict, FileKind } from '../types.ts';
import { type Backend, type FileSource, FilesConflict, StoppedError } from './types.ts';

type FileMethods = Pick<Backend, 'filesSummary' | 'listFiles' | 'fileSources' | 'pushFiles'>;

/** Who writes from this machine: its owner's account, the agent that does it (its name), by `lampo` or an MCP tool. */
export function machineStamp(by: string, via: 'vr' | 'mcp'): FileStampIn {
  const owner = localOwner();
  const agent = isAgent(by) ? cleanAgentName(by.replace(/^agent:?/, '')) : '';
  // the person whose machine it is (a store without accounts: the name it runs as), never the agent's name twice
  const person = owner?.name || cleanAgentName(loadConfig().user || '') || (agent ? 'owner' : by);
  return {
    by: person,
    ...(owner?.id ? { by_id: owner.id } : {}),
    ...(agent ? { agent, agent_kind: via === 'mcp' ? 'mcp' : 'cli' } : {}),
    via,
  };
}

export function localFiles(): FileMethods {
  return {
    filesSummary: async (folder) => filesSummary(namedFolder(folder)),
    listFiles: async (folder, o = {}) => listFiles(namedFolder(folder), { ...o, ...(o.kind ? { kind: o.kind as FileKind } : {}) }),

    async fileSources(ids, v) {
      const sources: FileSource[] = [];
      const missing: string[] = [];
      for (const id of [...new Set(ids)]) {
        const found = findFile(id);
        const version = found && !found.trashed ? versionOf(found.entry, v) : null;
        const file = version && heldBlob(version.hash) ? await filesStorage().ensureLocal(blobKey(version.hash)) : null;
        if (!found || !version || !file) {
          missing.push(id);
          continue;
        }
        sources.push({ id, area: scopeOf(found.area), path: found.entry.path, v: version.v, size: version.size, sha256: version.hash, file });
      }
      return { sources, missing };
    },

    async pushFiles(folder, files, o) {
      const f = namedFolder(folder);
      checkNotArchived(f);
      const ref = areaRefOf(f, { create: true });
      if (!ref) throw new Error(`there is no folder "${f}"`);
      const stamp = machineStamp(o.by, o.via ?? 'vr');
      const total = files.reduce((n, x) => n + x.size, 0);
      const commits: FileCommitAnswer[] = [];
      let sent = 0;
      let held = 0;
      const incoming = path.join(cacheDir(), 'files-in');
      for (let i = 0; i < files.length; i += FILE_LIMITS.batch) {
        const chunk = files.slice(i, i + FILE_LIMITS.batch);
        const have = heldBlobs(chunk.map((x) => x.sha256));
        for (const x of chunk) {
          if (o.signal?.aborted) throw new StoppedError();
          if (have.get(x.sha256)?.size === x.size) {
            held++;
            continue;
          }
          // a copy to take in (storeBlob moves what it is given): a clone where the disk can make one
          fs.mkdirSync(incoming, { recursive: true });
          const tmp = path.join(incoming, `${crypto.randomBytes(8).toString('hex')}.in`);
          fs.copyFileSync(x.file, tmp, fs.constants.COPYFILE_FICLONE);
          await storeBlob(tmp, { size: x.size, sha256: x.sha256 });
          sent += x.size;
          o.onProgress?.(sent, total);
        }
        try {
          commits.push(
            commitFiles(
              ref.id,
              chunk.map(({ path: p, sha256, size, base }) => ({ path: p, sha256, size, base })),
              { conflict: o.conflict, stamp },
            ),
          );
        } catch (e) {
          if (e instanceof FileConflictError) throw new FilesConflict(e.message, (e.details?.conflicts ?? []) as FileConflict[]);
          throw e;
        }
      }
      return { commits, sent, held };
    },
  };
}
