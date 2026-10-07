// HTTP plumbing shared by all routes: typed errors, request validation, the one error handler.
import { type NextFunction, type Request, type Response, Router } from 'express';
import { z } from 'zod';
import { ProjectArchivedError } from '../lib/archived.ts';
import { wellFormed } from '../lib/names.ts';
import { type Audience, publicMessage, statusOf } from '../lib/publicError.ts';

/** Review-link paths (also server/guard.ts): nobody on them is identified, so nobody there is the owner. /e/<token> is
 * an Embed link's player, the page another site frames (EMBED_PAGE). */
export const GUEST_PATH = /^\/(g\/|e\/|api\/g\/|media\/g\/|data\/g\/|assets\/)/;

/** An Embed link's player page (/e/<token>): the one answer of the app another site may put in a frame (server/guard.ts). */
export const EMBED_PAGE = /^\/e\/[A-Za-z0-9_-]+$/;

export class HttpError extends Error {
  status: number;
  /** Extra fields for the JSON body next to `error` (4xx only: a client page can say more than the message). */
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    if (details) this.details = details;
  }
}

export const fail = (status: number, message: string, details?: Record<string, unknown>): HttpError => new HttpError(status, message, details);

/**
 * A failure turned into a 4xx for the caller, keeping what caused it: its message is the answer for the machine's owner,
 * and anyone else gets a plain sentence when the cause is a tool's output or names a path (lib/publicError.ts).
 */
export const failFrom = (status: number, e: unknown, message = (e as Error)?.message ?? String(e)): HttpError =>
  // a write into an archived project stays what it is, whatever the route would make of another failure
  e instanceof ProjectArchivedError ? archivedFail(e) : Object.assign(new HttpError(status, message), { cause: e });

/** A refusal for an archived project (lib/archived.ts): 423, with the project beside the sentence. */
const archivedFail = (e: ProjectArchivedError): HttpError => Object.assign(new HttpError(423, e.message, { archived: e.project }), { cause: e });

/**
 * Who a request's answer is for (lib/publicError.ts): the machine's owner at the machine, or anyone else. A review link's
 * visitor never counts as the owner, whoever opens it.
 */
export const audienceOf = (req: Request): Audience => (req.auth?.via === 'local' && !GUEST_PATH.test(req.path) ? 'owner' : 'other');

/**
 * Every router matches paths exactly as written: case-sensitive, and a trailing slash is a different path. Express's
 * default (case-insensitive) once let /API/status past the sign-in check and the role table, which compare the
 * canonical spelling.
 */
export const router = (): Router => Router({ caseSensitive: true, strict: true });

/**
 * Validates `value` against `schema`; bad input is a 400 that says which field and why. Every string in it comes out
 * well-formed (`wellFormed`): a JSON body can carry a lone surrogate, and a name kept with one breaks every URL of it.
 */
export function parse<S extends z.ZodType>(schema: S, value: unknown, what = 'request'): z.output<S> {
  const r = schema.safeParse(wellFormed(value));
  if (r.success) return r.data;
  const issue = r.error.issues[0];
  const where = issue?.path.length ? `${issue.path.join('.')}: ` : '';
  throw fail(400, `invalid ${what}: ${where}${issue?.message || 'malformed'}`);
}

/**
 * Sends a file whose path the server built itself. `dotfiles: 'allow'` because the store may live under a dot folder
 * (~/.video-review) and send() otherwise answers 404 for any path with a dot segment. Never pass request input here
 * unchecked.
 */
export const sendInternal = (res: Response, file: string): void => res.sendFile(file, { dotfiles: 'allow' });

/** The JSON body (Express 5 leaves req.body undefined when nothing was sent). */
export const body = <S extends z.ZodType>(schema: S, req: Request): z.output<S> => parse(schema, req.body ?? {}, 'body');
export const query = <S extends z.ZodType>(schema: S, req: Request): z.output<S> => parse(schema, req.query, 'query');
/** A query read where nothing may be refused for it (the guard, identify, a media answer): what its schema accepts, else
 * nothing — an array or an object where a string belongs is no value at all. */
export const queryOr = <S extends z.ZodType>(schema: S, req: Request): z.output<S> | undefined => schema.safeParse(req.query).data;

/** `?v=`: a version by its number; absent or empty is the newest. Not a positive whole number: 400. */
export const VersionQuery = z.object({ v: z.preprocess((x) => (x === '' ? undefined : x), z.coerce.number().int().positive().optional()) });
/** `?t=`: the LAN link's token, as a phone first opens it (server/guard.ts sets its cookie, server/auth.ts reads it). */
export const LanQuery = z.object({ t: z.string().max(200).optional() });

export { commentId } from '../lib/inputs.ts';

type StatusError = Error & { status?: number; statusCode?: number; retryAfter?: number };

/** A Content-Disposition that downloads as `filename`: an ASCII stand-in for old clients, the real name in filename*. */
export const attachment = (filename: string): string =>
  `attachment; filename="${filename.replace(/[^\x20-\x7e]|"/g, '_')}"; filename*=UTF-8''${encodeURIComponent(filename)}`;

/**
 * Sends a body made as it goes (a zip's bytes, in order) once the headers are set: the folder zips, a publishing kit's,
 * a person's export. A HEAD gets the headers only. A viewer who goes away ends it at once — the bytes stop being read
 * and whatever they came from closes; waiting on 'drain' alone waited for good, with the files open. A failure halfway
 * breaks the connection, so the client sees a failed download rather than one that ends early. `what` names it in the
 * log. True when every byte went out.
 */
export async function sendStreamed(req: Request, res: Response, bytes: () => AsyncIterable<Uint8Array>, what: string): Promise<boolean> {
  if (req.method === 'HEAD') {
    res.end();
    return true;
  }
  let gone = res.destroyed;
  const onClose = () => {
    gone = true;
  };
  res.on('close', onClose);
  try {
    for await (const chunk of bytes()) {
      if (gone) break;
      if (!res.write(chunk)) await drainedOrGone(res);
      // leaving the loop closes the bytes' source: a read stream, its file
      if (gone) break;
    }
    if (gone) return false;
    res.end();
    return true;
  } catch (e) {
    if (!gone) console.error(`${what} failed`, (e as Error).message);
    res.destroy(e as Error);
    return false;
  } finally {
    res.off('close', onClose);
  }
}

/** Waits until `res` takes more, or until it is closed (a viewer gone never drains it). */
function drainedOrGone(res: Response): Promise<void> {
  if (res.destroyed) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const done = () => {
      res.off('drain', done);
      res.off('close', done);
      resolve();
    };
    res.on('drain', done);
    res.on('close', done);
  });
}

/**
 * A path as it may go to the log: review-link tokens, one-time upload tickets and signed media URLs are credentials
 * that sit in the path itself (/g/<token>, /e/<token>, /api/g/<token>/…, /api/uploads/direct/<ticket>, /media/[szf]/<sealed>/…), so
 * they are cut out — whoever reads the log must not be able to open the link.
 */
export const loggedPath = (p: string): string =>
  p
    .replace(/^\/((?:api\/|media\/|data\/)?g|e)\/[^/]+/, '/$1/…')
    .replace(/^\/api\/uploads\/direct\/[^/]+/, '/api/uploads/direct/…')
    .replace(/^\/media\/([szf])\/[^/]+/, '/media/$1/…');

/**
 * Every error ends here as {error: message}. Errors from body parsers carry their own status (400, 413). What the
 * message may say depends on who asked (audienceOf), never on the mode: the machine's owner at the machine gets it as it
 * is; anyone else — a review-link visitor, a session on another device, a token, every caller of a hosted server —
 * gets a 5xx, or a 4xx caused by a tool's output or naming a path, as a plain sentence with a ref to the log line.
 * `hosted` only decides what else goes to the log (a hosted server logs throttling, the machine every error).
 */
export function createErrorHandler({ hosted = false } = {}) {
  return (thrown: StatusError, req: Request, res: Response, next: NextFunction): void => {
    // the store's refusal for an archived project, as a route's own would be (lib/folderIds.ts checkNotArchived)
    const err: StatusError = thrown instanceof ProjectArchivedError ? archivedFail(thrown) : thrown;
    // An internal error's own status is someone else's (an object store's 403): to the caller it is this server's fault.
    const status = err instanceof HttpError ? err.status : statusOf(err);
    if (res.headersSent) {
      next(err);
      return;
    }
    if (err.retryAfter) res.setHeader('Retry-After', String(err.retryAfter));
    const where = `${req.method} ${loggedPath(req.path)}`;
    const message = publicMessage(err, audienceOf(req), { status, where });
    if (message === err.message && (!hosted || status === 429)) console.error(`[${where}]`, err.message);
    const details = err instanceof HttpError && status < 500 && message === err.message ? err.details : undefined;
    res.status(status).json({ ...details, error: message });
  };
}

export const errorHandler = createErrorHandler();
