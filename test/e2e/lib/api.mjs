// A browser suite's own calls to its server, for setting up what the page then shows: JSON in, JSON out. (Waiting for a
// state is `until` in test/lib/helpers.ts.)

/**
 * `api(path, method = 'GET', body, headers)` against `base`: the answer's JSON (null when empty). A refusal throws
 * "METHOD path: status error" with `status` on the error, so a suite can assert what the server said.
 */
export const jsonApi =
  (base) =>
  async (p, method = 'GET', body, headers = {}) => {
    const r = await fetch(base + p, {
      method,
      headers: { ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await r.text();
    let out = null;
    try {
      out = text ? JSON.parse(text) : null;
    } catch {
      out = text;
    }
    if (!r.ok) throw Object.assign(new Error(`${method} ${p}: ${r.status} ${out?.error ?? text}`), { status: r.status });
    return out;
  };
