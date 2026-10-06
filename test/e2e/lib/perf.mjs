// Measuring a page the way a person feels it, for test/e2e/perf.mjs and bench/perf/browser.mjs: React commits (a
// stand-in for the DevTools hook, so production builds report them too), input latency from the Event Timing API
// (what INP is made of), when a selector first showed, and every request a page makes (Chrome's network events: sizes
// as they travelled, from the HTTP cache or not, when each started and ended).

/** Runs in the page before any script: counts React commits and records interaction latencies and first paints. */
export function instrument() {
  let commits = 0;
  window.__perf = { commits: () => commits, events: [], seen: {} };
  // React (development and production builds) reports every commit to this hook when it exists.
  window.__REACT_DEVTOOLS_GLOBAL_HOOK__ = {
    renderers: new Map(),
    supportsFiber: true,
    isDisabled: false,
    inject(renderer) {
      const id = this.renderers.size + 1;
      this.renderers.set(id, renderer);
      return id;
    },
    onCommitFiberRoot() {
      commits++;
    },
    onCommitFiberUnmount() {},
    onPostCommitFiberRoot() {},
    onScheduleFiberRoot() {},
    checkDCE() {},
  };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries())
        if (e.interactionId) window.__perf.events.push({ name: e.name, id: e.interactionId, duration: e.duration, start: e.startTime });
    }).observe({ type: 'event', durationThreshold: 16, buffered: true });
  } catch {}
}

/** The time (ms since navigation) `selector` first matched, polled every animation frame from now on. */
export const watchFor = (page, name, selector) =>
  page.evaluate(
    (name, selector) => {
      const tick = () => {
        if (document.querySelector(selector)) window.__perf.seen[name] = performance.now();
        else requestAnimationFrame(tick);
      };
      tick();
    },
    name,
    selector,
  );

/** Same, installed before the page's own scripts run (for first paints). */
export const watchFromStart = (page, name, selector) =>
  page.evaluateOnNewDocument(
    (name, selector) => {
      const tick = () => {
        if (window.__perf && document.querySelector(selector)) window.__perf.seen[name] = performance.now();
        else requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    },
    name,
    selector,
  );

/** The time the player's video first had a frame to show (readyState ≥ 2), polled every animation frame from now on. */
export const watchFrame = (page, name) =>
  page.evaluate((name) => {
    const tick = () => {
      const v = document.querySelector('video');
      if (v && v.readyState >= 2) window.__perf.seen[name] = performance.now();
      else requestAnimationFrame(tick);
    };
    tick();
  }, name);

/** Same for a first load, installed before the page's own scripts run. */
export const watchFrameFromStart = (page, name) =>
  page.evaluateOnNewDocument((name) => {
    const tick = () => {
      const v = document.querySelector('video');
      if (window.__perf && v && v.readyState >= 2) window.__perf.seen[name] = performance.now();
      else requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }, name);

export const seen = (page, name) => page.evaluate((n) => window.__perf.seen[n] ?? null, name);
export const commits = (page) => page.evaluate(() => window.__perf.commits());

/** The slowest interaction since `since` (ms since navigation), in ms; 0 when every one was under 16 ms. */
export const slowest = (page, since = 0) =>
  page.evaluate((since) => {
    const by = new Map();
    for (const e of window.__perf.events) if (e.start >= since) by.set(e.id, Math.max(by.get(e.id) || 0, e.duration));
    return Math.max(0, ...by.values());
  }, since);

export const now = (page) => page.evaluate(() => performance.now());

/** Chrome's own CPU slowdown (4 = a mid-range laptop on battery, roughly). */
export async function throttle(page, rate) {
  const cdp = await page.createCDPSession();
  await cdp.send('Emulation.setCPUThrottlingRate', { rate });
  return cdp;
}

/**
 * Records every request of the page: `take()` returns (and forgets) what finished since the last call, each with its
 * url, type, status, bytes on the wire, whether it came from a cache, and start/end in ms of the recorder's clock.
 */
export async function recordNetwork(page) {
  const cdp = await page.createCDPSession();
  await cdp.send('Network.enable');
  const open = new Map();
  let done = [];
  cdp.on('Network.requestWillBeSent', (e) => open.set(e.requestId, { url: e.request.url, method: e.request.method, type: e.type, start: e.timestamp * 1000 }));
  cdp.on('Network.responseReceived', (e) => {
    const r = open.get(e.requestId);
    if (r)
      Object.assign(r, { status: e.response.status, cached: !!(e.response.fromDiskCache || e.response.fromServiceWorker || e.response.fromPrefetchCache) });
  });
  cdp.on('Network.requestServedFromCache', (e) => {
    const r = open.get(e.requestId);
    if (r) r.cached = true;
  });
  cdp.on('Network.loadingFinished', (e) => {
    const r = open.get(e.requestId);
    if (!r) return;
    open.delete(e.requestId);
    done.push({ ...r, bytes: e.encodedDataLength, end: e.timestamp * 1000 });
  });
  cdp.on('Network.loadingFailed', (e) => {
    const r = open.get(e.requestId);
    if (!r) return;
    open.delete(e.requestId);
    done.push({ ...r, bytes: 0, failed: e.errorText, end: e.timestamp * 1000 });
  });
  return {
    take() {
      const out = done;
      done = [];
      return out;
    },
    /** Waits until nothing but long-lived streams is in flight for `quiet` ms (at most `max`). */
    async idle(quiet = 500, max = 15000) {
      const busy = () => [...open.values()].some((r) => !/\/api\/events$/.test(r.url) && r.type !== 'Media');
      const t0 = Date.now();
      let calm = Date.now();
      while (Date.now() - t0 < max) {
        await new Promise((r) => setTimeout(r, 50));
        if (busy()) calm = Date.now();
        else if (Date.now() - calm >= quiet) return;
      }
    },
  };
}

/** A data call of the app (not a poster, sprite or the video itself, which also live under /api). */
export const isApi = (r) => /\/api\//.test(r.url) && (r.type === 'Fetch' || r.type === 'XHR') && !/\/api\/events$/.test(r.url);

/** Requests grouped for a report line: how many, how many from a cache, bytes on the wire. */
export function summarize(list) {
  const kinds = {};
  for (const r of list) {
    const k = isApi(r) ? 'api' : (r.type || 'other').toLowerCase();
    kinds[k] ??= { n: 0, cached: 0, bytes: 0 };
    const s = kinds[k];
    s.n++;
    if (r.cached || r.status === 304) s.cached++;
    s.bytes += r.bytes || 0;
  }
  return { n: list.length, bytes: list.reduce((s, r) => s + (r.bytes || 0), 0), kinds };
}

/**
 * The longest chain of API calls where each started only after the one before it had finished: 1 = everything asked
 * at once; 3 = a waterfall of three round trips before the page could show its data.
 */
export function apiWaterfall(list, until = Number.POSITIVE_INFINITY) {
  const calls = list.filter((r) => isApi(r) && r.start <= until).sort((a, b) => a.start - b.start);
  const depth = new Map();
  for (const r of calls) depth.set(r, 1 + Math.max(0, ...calls.filter((q) => q.end <= r.start).map((q) => depth.get(q) || 0)));
  const name = (r) => new URL(r.url).pathname.split('/').slice(0, 3).join('/');
  return { depth: Math.max(0, ...depth.values()), calls: calls.map((r) => `${name(r)}@${depth.get(r)}`) };
}
