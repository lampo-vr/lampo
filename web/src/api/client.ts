import { t } from '../i18n/index.ts';

export const enc = encodeURIComponent;

export class ApiError extends Error {
  status: number;
  /** Seconds to wait before trying again (429 with Retry-After). */
  retryAfter: number | null;
  /** The body's other fields next to `error` (e.g. who shared an expired review link). */
  details: Record<string, unknown>;
  constructor(message: string, status: number, retryAfter: number | null = null, details: Record<string, unknown> = {}) {
    super(message);
    this.status = status;
    this.retryAfter = retryAfter;
    this.details = details;
  }
}

interface ApiInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  raw?: BodyInit;
  /** Finishes even when the page is closing (deferred deletions on pagehide). */
  keepalive?: boolean;
}

// A 401 anywhere but the sign-in endpoints means the session is gone (expired, signed out elsewhere, password
// changed): the auth gate hears this and shows the sign-in screen over the current route. Client links (/api/g/…)
// never need an account.
export const UNAUTHORIZED = 'vr-unauthorized';
const signalsSignOut = (url: string) => !url.startsWith('/api/auth/') && !url.startsWith('/api/g/');

export async function api<T = unknown>(url: string, { method = 'GET', body, raw, keepalive }: ApiInit = {}): Promise<T> {
  const init: RequestInit = { method, keepalive };
  if (raw) init.body = raw;
  else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers = { 'Content-Type': 'application/json' };
  }
  const res = await fetch(url, init);
  const ct = res.headers.get('content-type') || '';
  const data: unknown = ct.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const msg =
      typeof data === 'object' && data && 'error' in data
        ? String((data as { error: unknown }).error)
        : typeof data === 'string' && data && !looksLikePage(data)
          ? data
          : sentenceFor(res.status);
    if (res.status === 401 && signalsSignOut(url)) window.dispatchEvent(new Event(UNAUTHORIZED));
    const wait = Number(res.headers.get('retry-after'));
    const { error: _error, ...details } = typeof data === 'object' && data ? (data as Record<string, unknown>) : {};
    throw new ApiError(msg, res.status, Number.isFinite(wait) && wait > 0 ? wait : null, details);
  }
  return data as T;
}

/** An error page someone in between answered with (Cloudflare's 524, a proxy's 502): never shown as it is. */
const looksLikePage = (text: string) => text.length > 300 || /<\s*(!doctype|html|head|body)\b/i.test(text);

/** What a failed request without our own sentence means for the person, by its status. */
function sentenceFor(status: number): string {
  if (status === 408 || status === 504 || status === 524) return t('The server took too long to answer. Try again in a moment.');
  if (status === 502 || status === 503 || (status >= 520 && status <= 523)) return t('The server can’t be reached right now. Try again in a moment.');
  return t('Something went wrong on the server (HTTP {status}). Try again in a moment.', { status });
}
