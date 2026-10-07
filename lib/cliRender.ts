// `lampo render [--to <video> | --folder <project>] [--out <file>] [--detach] -- <command> [args…]`: the agent's own
// render command, run here on its machine (an argument list, never a shell: nothing in it comes from a server), with
// its progress shown in Lampo and its result put up as the next version, or as a new video's V1 (lib/render/). The model reads two lines, not the tool's output.
// `lampo render wait <id>`: a detached render, at most 9 minutes at a time.
import fs from 'node:fs';
import path from 'node:path';
import { cliAgent, openActivitySink } from './activity.ts';
import { archivedIn, archivedWords } from './archived.ts';
import { readCredentials } from './backend/credentials.ts';
import type { Backend } from './backend/types.ts';
import { settings } from './env.ts';
import { newRenderId, RENDER_ID, startDetached, WAIT_MAX_MS, waitFor } from './render/detach.ts';
import { executeRender, type RenderJob } from './render/job.ts';
import type { ToolRun } from './render/run.ts';
import { currentSession } from './sessions.ts';
import { isUpload } from './store.ts';
import { oneLine } from './time.ts';

export interface RenderArgs {
  pos: string[];
  opt: Record<string, string | true | string[] | undefined>;
  /** Everything after `--`: the command, as it was given. */
  cmd: string[];
}

export interface RenderIo {
  out(line: string): void;
  /** Stops the command with a usage error. */
  fail(msg: string): never;
  /** Who the version is by (`--by`, LAMPO_BY, the session). */
  by: string;
}

const USAGE = 'usage: lampo render [--to <video> | --folder <project>] [--out <file>] [--detach] -- <command> [args…] · lampo render wait <id>';

/** Progress to Lampo at most this often: every 500 ms on this machine, every 2 s to a server. */
const everyMs = (): number => (readCredentials() ? 2000 : 500);

/** The same file, through links in its folders too (the output may not be there yet: its folder is). */
function samePath(a: string, b: string): boolean {
  if (a === b) return true;
  const real = (p: string) => {
    try {
      return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
    } catch {
      return p;
    }
  };
  return real(a) === real(b);
}

/** How long `lampo render wait` may block: 9 minutes, or less where a test says so (LAMPO_RENDER_WAIT_MS). */
function waitBound(): number {
  const n = Number(settings.LAMPO_RENDER_WAIT_MS);
  return Number.isFinite(n) && n >= 0 ? Math.min(n, WAIT_MAX_MS) : WAIT_MAX_MS;
}

export async function render({ pos, opt, cmd }: RenderArgs, b: Backend, io: RenderIo): Promise<void> {
  const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
  if (pos[0] === 'wait') {
    const id = pos[1] ?? '';
    if (!RENDER_ID.test(id)) io.fail(`say which render: lampo render wait r_… (as lampo render --detach printed it)\n${USAGE}`);
    const r = await waitFor(id, waitBound());
    for (const l of r.lines) io.out(l);
    process.exitCode = r.code;
    return;
  }
  if (pos.length) io.fail(`the command goes after --: lampo render --to ${oneLine(pos[0])} --out <file> -- <command> …\n${USAGE}`);
  if (!cmd.length) io.fail(`what to run? lampo render --to <video> --out <file> -- npx remotion render …\n${USAGE}`);
  if (opt.to === true || opt.out === true || opt.folder === true) io.fail(`--to, --folder and --out each name something: --to <video> --out <file>\n${USAGE}`);
  const shownOut = str(opt.out) ?? null;
  const out = shownOut ? path.resolve(shownOut) : null;
  const toArg = str(opt.to);
  if (toArg && !out) io.fail(`--to needs --out <file>: the file your command writes, put up as the next version\n${USAGE}`);
  // A new video's V1 into a project (made with it when it's new): the render, then the file put up there.
  const folderArg = str(opt.folder)
    ?.trim()
    .replace(/^\/+|\/+$/g, '');
  if (folderArg !== undefined && toArg) io.fail(`--to puts up a next version, --folder a new video's V1: name one of them\n${USAGE}`);
  if (folderArg !== undefined && !folderArg) io.fail(`--folder names the project: --folder "Acme/Launch"\n${USAGE}`);
  if (folderArg && !out) io.fail(`--folder needs --out <file>: the file your command writes, put up as V1\n${USAGE}`);
  if (folderArg) {
    const project = archivedIn(folderArg, await b.archivedProjects());
    if (project) io.fail(`${archivedWords(project)}: nothing new goes in until then`);
  }

  // The video it becomes the next version of, checked before a frame is rendered.
  let to: RenderJob['to'] = null;
  if (toArg) {
    const { slug } = await b.resolve(toArg);
    const review = await b.review(slug);
    const project = archivedIn(review.folder, await b.archivedProjects());
    if (project) io.fail(`${archivedWords(project)}: nothing to render for it until then`);
    if (review.archived) io.fail(`${oneLine(path.basename(review.video))} is archived: nothing to render for it until a person takes it back`);
    const latest = review.versions.at(-1)?.v ?? 0;
    const same = b.kind === 'local' && samePath(review.video, out as string);
    // A video linked to its file on this machine takes its next version from that file: another file put up beside it
    // would leave the linked one looking new, and it would come in again as a version of its own.
    if (b.kind === 'local' && !isUpload(review) && !same)
      io.fail(`${oneLine(path.basename(review.video))} is linked to its file on this machine: render to it (--out ${oneLine(review.video)})`);
    to = { slug, next: latest + 1, same };
  }

  // Who it reports as: the agent running lampo (its session, LAMPO_BY, LAMPO_RUN); a person's own render records nothing.
  const agent = cliAgent();
  // inside a Claude Code session the new video is that session's, as `lampo track --me` makes it
  const own = currentSession();
  const into = folderArg ? { folder: folderArg, session: own?.name ? { name: own.name, sessionId: own.sessionId, cwd: own.cwd } : null } : null;
  const job: RenderJob = { argv: cmd, cwd: process.cwd(), out, outShown: shownOut, to, into, agent, by: io.by };
  const label = to ? `V${to.next}` : into ? 'V1' : '';

  if (opt.detach) {
    const id = newRenderId();
    const s = await startDetached({ id, job, every: everyMs() }, label);
    if (s.state === 'done' || s.state === 'failed') {
      for (const l of s.lines ?? []) io.out(l);
      process.exitCode = s.code ?? (s.state === 'done' ? 0 : 1);
      return;
    }
    io.out(`Rendering${label ? ` ${label}` : ''} (render ${id}): run lampo render wait ${id} now.`);
    return;
  }

  // In the foreground: Ctrl-C and a stop reach the whole render (its own process group); a second one kills it.
  const sink = agent ? openActivitySink() : null;
  let run: ToolRun | null = null;
  let stops = 0;
  const onSignal = (sig: NodeJS.Signals) => {
    stops++;
    run?.signal(stops > 1 ? 'SIGKILL' : sig);
  };
  const signals = ['SIGINT', 'SIGTERM', 'SIGHUP'] as const;
  for (const s of signals) process.on(s, onSignal);
  try {
    const outcome = await executeRender(job, {
      backend: b,
      sink,
      every: everyMs(),
      ...(opt.verbose ? { echo: (c: Buffer) => process.stderr.write(c) } : {}),
      onStart: (r) => {
        run = r;
      },
      stopped: () => stops > 0,
    });
    await sink?.flush();
    for (const l of outcome.lines) io.out(l);
    process.exitCode = outcome.code;
  } finally {
    for (const s of signals) process.off(s, onSignal);
  }
}
