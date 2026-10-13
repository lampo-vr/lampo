// The team's project files for agents (docs/files.md "Agents"): footage, music, fonts and project files of a project,
// a folder and the House, so an agent works from the same material as the team and saves what it makes back as a
// version of its own. list_files reads what applies where (a summary, or one line per file); get_file hands out one
// file — over HTTP a download URL (signed: never a path on the server, never the bytes in the message), on this machine
// a copy of its own; add_file saves one — over HTTP a one-time upload URL for one PUT (as request_upload), on this
// machine from a file here. Every write is a version, attributed and recoverable: nothing is overwritten.
import fs from 'node:fs';
import path from 'node:path';
import { z } from 'zod';
import { cacheRoot } from '../../lib/backend/credentials.ts';
import { FilesConflict } from '../../lib/backend/types.ts';
import { areaName, fileLine, madeBy, summaryLines } from '../../lib/fileLines.ts';
import { hashCache } from '../../lib/filesLocal.ts';
import { areaOf, areaWord, copyOut } from '../../lib/filesSync.ts';
import { caseKey, FILE_KINDS, FILE_LIMITS, fileSize, nameOf } from '../../lib/fileText.ts';
import { folderName, quiet } from '../../lib/inputs.ts';
import { oneLine } from '../../lib/time.ts';
import type { FileCommitItem, FileConflict, FileKind } from '../../lib/types.ts';
import { ok, text } from '../format.ts';
import type { ToolKit } from '../toolkit.ts';

/** A page of one folder's files in list_files. */
const PAGE = 100;

/** A file's path in an area as a tool takes it (checked by the store as a path inside the area). */
const filePath = quiet(z.string().min(1).max(4096));

/** Who is in the way of a write, and the two ways on. */
const conflictText = (c: FileConflict[]): string =>
  `${c
    .slice(0, 5)
    .map((x) => oneLine(`${x.path} is V${x.v} by ${madeBy(x)} (${x.at.slice(0, 16)})${x.base ? `, yours is based on V${x.base}` : ''}`))
    .join('; ')}: add_file with base (the version there now) makes yours its next version, or copy: true keeps both`;

const doneLine = (f: FileCommitItem, area: string): string =>
  oneLine(
    f.state === 'same'
      ? `${f.path} has these bytes already: V${f.v} in ${areaName(area)}`
      : f.state === 'copy'
        ? `${f.asked ?? f.path} changed meanwhile: yours is kept beside it as ${f.path} V${f.v} in ${areaName(area)}`
        : `${f.state === 'added' ? 'added' : 'new version'}: ${f.id} ${f.path} V${f.v} in ${areaName(area)}`,
  );

export function registerFileTools({ b, o, tool, author, byArg }: ToolKit): void {
  const chat = o.way === 'chat';
  const here = o.principal.via === 'local';

  /** The area a call names: a video's folder, else the folder ("" or "House" = the House's; a project called so: "House/"). */
  async function areaFor(folder: string | undefined, video: string | undefined): Promise<string> {
    if (video) {
      const { slug } = await b.resolve(video);
      return (await b.review(slug)).folder || '';
    }
    return areaOf(folder);
  }

  tool(
    'list_files',
    {
      title: 'List the project files',
      description:
        'The team\'s files (footage, music, fonts, project files) of a project or folder ("House": the workspace\'s), inherited ones too: a summary; with path or query, one line per file.',
      // a video's folder, a kind and a page are accepted, not announced (mcp/lean.ts)
      inputSchema: z.object({
        folder: folderName.optional(),
        video: z.string().optional().meta({ hidden: true }),
        path: filePath.optional(),
        query: quiet(z.string().max(200)).optional(),
        kind: z
          .enum(FILE_KINDS as [FileKind, ...FileKind[]])
          .optional()
          .meta({ hidden: true }),
        cursor: z
          .string()
          .regex(/^\d{1,7}$/)
          .optional()
          .meta({ hidden: true }),
      }),
    },
    async ({ folder, video, path: p, query, kind, cursor }) => {
      const area = await areaFor(folder, video);
      if (p === undefined && !query && !kind) {
        const lines = summaryLines(await b.filesSummary(area));
        if (!lines) return ok(text(`no files for ${areaName(area)} yet${chat ? '' : `: add_file, or lampo files push <folder> --to ${areaWord(area)}`}`));
        const how = chat
          ? 'list_files with path for a folder’s files; get_file for one'
          : `list_files with path for a folder’s files; get_file for one; a shell fetches many with lampo files pull ${areaWord(area)} --to <dir> --only '<glob>'`;
        return ok(text([...lines, how].join('\n')));
      }
      const dir = p?.replace(/\/+$/, '') || undefined;
      const page = await b.listFiles(area, {
        deep: true,
        limit: PAGE,
        ...(dir ? { path: dir } : {}),
        ...(query ? { q: query } : {}),
        ...(kind ? { kind } : {}),
        ...(cursor ? { cursor } : {}),
      });
      const head = oneLine(`${areaName(area)}${dir ? ` ${dir}/` : ''}${query ? ` "${query}"` : ''} · ${page.total} file${page.total === 1 ? '' : 's'}`);
      const more = page.cursor ? [`more: list_files again with cursor "${page.cursor}"`] : [];
      return ok(text([head, ...page.files.map((f) => fileLine(f, area)), ...more].join('\n')));
    },
  );

  /** The file a call names: by its id, or by its path in what applies to a folder (the deepest one with it). */
  async function fileIdOf(a: { id?: string | undefined; path?: string | undefined; folder?: string | undefined; video?: string | undefined }): Promise<string> {
    if (a.id) return a.id;
    if (!a.path) throw new Error('name the file: id (from list_files), or path with folder');
    const area = await areaFor(a.folder, a.video);
    const want = a.path.replace(/^\/+/, '');
    const page = await b.listFiles(area, { deep: true, q: nameOf(want), limit: FILE_LIMITS.pageMax });
    const hit = page.files.find((f) => f.path === want) ?? page.files.find((f) => caseKey(f.path) === caseKey(want));
    if (!hit) throw new Error(`no file ${oneLine(want)} in ${areaName(area)}: list_files shows what is there`);
    return hit.id;
  }

  // checked, not announced: what list_files names it
  const fileId = quiet(z.string().regex(/^fl_[0-9a-f]{12}$/, 'a file id (fl_…, from list_files)')).optional();

  tool(
    'get_file',
    {
      title: 'Get a project file',
      description: `A project file (id from list_files, or path and folder) as ${here ? 'a copy here, yours to change' : 'a download URL'}; v: an older version.`,
      inputSchema: z.object({
        id: fileId,
        path: filePath.optional(),
        folder: folderName.optional(),
        video: z.string().optional().meta({ hidden: true }),
        v: quiet(z.number().int().min(1)).optional(),
      }),
    },
    async ({ id, path: p, folder, video, v }) => {
      const fid = await fileIdOf({ id, path: p, folder, video });
      if (!here) {
        // over HTTP: what the server signs for whoever asked, never where the bytes lie on its disk
        if (!o.fileUrls) throw new Error('this server hands out no files');
        const got = o.fileUrls([fid], v);
        const u = got.urls[0];
        if (!u) throw new Error(v ? `no V${v} of ${fid} is kept` : `no file ${fid}`);
        const own = /\/api\/files\/fl_[0-9a-f]{12}\/download/.test(new URL(u.url).pathname);
        const name = nameOf(u.path);
        const fetch = chat
          ? ''
          : own
            ? `\nThis server signs no links: the URL takes your Lampo token (Authorization: Bearer), or fetch it with lampo files pull ${areaWord(u.area)} --to <dir> --only '${u.path.replaceAll("'", "'\\''")}'`
            : `\ncurl -fLo '${name.replaceAll("'", "'\\''")}' '${u.url}'`;
        return ok(text(`${oneLine(`${u.id} ${u.path} V${u.v} · ${fileSize(u.size)} · sha256 ${u.sha256}`)} · valid until ${u.expires}\n${u.url}${fetch}`));
      }
      const { sources } = await b.fileSources([fid], v);
      const src = sources[0];
      if (!src) throw new Error(v ? `no V${v} of ${fid} is kept` : `no file ${fid}`);
      // a signed URL is its own credential: handed on; anything else becomes a copy here
      if (src.url && !src.headers)
        return ok(
          text(
            `${oneLine(`${src.id} ${src.path} V${src.v} · ${fileSize(src.size)}`)}\n${src.url}\ncurl -fLo '${nameOf(src.path).replaceAll("'", "'\\''")}' '${src.url}'`,
          ),
        );
      const copy = await copyOut(src, path.join(cacheRoot(), 'files'), hashCache(path.join(cacheRoot(), 'hashes.json')));
      return ok(text(`${oneLine(`${src.id} ${src.path} V${src.v} · ${fileSize(src.size)}`)}\na copy on this machine: ${copy}`));
    },
  );

  tool(
    'add_file',
    {
      title: 'Save a project file',
      description: `Save a file${here ? ' here (file: its absolute path)' : ''} at path in a project's or folder's files: new, or with base (the version there now) its next version${here ? '' : '. Answers a one-time URL (15 min) for one PUT of its size bytes'}. Every version is kept.`,
      inputSchema: z.object({
        folder: folderName.optional(),
        video: z.string().optional().meta({ hidden: true }),
        path: filePath,
        ...(here
          ? { file: quiet(z.string().min(1).max(4096)) }
          : {
              size: quiet(z.number().int().min(0).max(FILE_LIMITS.fileBytes)),
              sha256: z
                .string()
                .regex(/^[0-9a-f]{64}$/)
                .optional()
                .meta({ hidden: true }),
            }),
        base: quiet(z.number().int().min(1)).optional(),
        copy: z.boolean().optional().meta({ hidden: true }),
        by: byArg,
      }),
    },
    async (args, ctx) => {
      const a = args as typeof args & { file?: string; size?: number; sha256?: string };
      const area = await areaFor(a.folder, a.video);
      const who = author(a.by, ctx);
      const agent = who.startsWith('agent:') ? who.slice(6) : null;
      if (!here) {
        if (!o.requestFileUpload) throw new Error('this server takes no files');
        const got = await o
          .requestFileUpload({
            folder: area,
            path: a.path,
            size: a.size ?? 0,
            ...(a.sha256 ? { sha256: a.sha256 } : {}),
            base: a.base ?? null,
            copy: !!a.copy,
            agent,
          })
          .catch((e: unknown) => {
            // refused before any byte moves: who is in the way, and the two ways on
            const c = (e as { details?: { conflicts?: FileConflict[] } }).details?.conflicts;
            throw c?.length ? Object.assign(new Error(conflictText(c)), { status: 409 }) : e;
          });
        if ('committed' in got) return ok(text(got.committed.files.map((f) => doneLine(f, got.committed.folder)).join('\n')));
        const put = chat ? '' : `\ncurl -fT '${nameOf(a.path).replaceAll("'", "'\\''")}' '${got.url}'`;
        return ok(text(`PUT the file's ${a.size} bytes to this URL once (valid until ${got.expires}); its answer says what it became:\n${got.url}${put}`));
      }
      // on this machine: the file is read here (only the one named), its bytes kept once, then committed
      const file = path.resolve(a.file as string);
      const st = fs.statSync(file);
      if (!st.isFile()) throw new Error(`${file} is not a file`);
      const hashes = hashCache(path.join(cacheRoot(), 'hashes.json'));
      const sha256 = await hashes.sha256({ abs: file, size: st.size, mtimeMs: st.mtimeMs, dev: st.dev, ino: st.ino });
      hashes.save();
      try {
        const r = await b.pushFiles(area, [{ file, path: a.path, size: st.size, sha256, base: a.base ?? null }], {
          conflict: a.copy ? 'copy' : 'refuse',
          by: who,
          via: 'mcp',
        });
        const c = r.commits.at(-1);
        return ok(text(c ? c.files.map((f) => doneLine(f, c.folder)).join('\n') : 'nothing was saved'));
      } catch (e) {
        if (e instanceof FilesConflict) throw new Error(conflictText(e.conflicts));
        throw e;
      }
    },
  );
}
