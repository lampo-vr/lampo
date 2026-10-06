// Headless Chrome for the browser suites, found and launched in one place: a suite that can't run fails (see
// ../prereq.mjs), and every suite gets the same browser — English, muted, reduced motion, a desktop with a mouse —
// whatever the machine's language, settings or input devices are, so a German Mac and a Linux CI runner see the same UI.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../../lib/helpers.ts';
import { unavailable } from '../prereq.mjs';

const CHROMES = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
];

// `npm run chrome:install` puts chrome-headless-shell and Chrome for Testing here. The shell is the browser the suites
// prefer: a plain headless binary, where the Chrome app on a Mac quits headless instances it thinks are idle ("Target
// closed" mid-suite). Chrome for Testing is the whole browser for what the shell lacks (notifications), apart from the
// Chrome someone uses every day.
const CACHE = 'cache/chrome';

/** The checkouts to look in for downloaded browsers: this one, and the main one when this is a git worktree (they share
 * them). */
export function checkouts() {
  const out = [ROOT];
  try {
    const common = execFileSync('git', ['rev-parse', '--path-format=absolute', '--git-common-dir'], { cwd: ROOT, encoding: 'utf8' }).trim();
    const main = path.dirname(common);
    if (main !== ROOT) out.push(main);
  } catch {}
  return out;
}

/** The newest build of `browser` (chrome-headless-shell or chrome) that `npm run chrome:install` left, or null. */
function findInstalled(browser) {
  const inside =
    browser === 'chrome'
      ? process.platform === 'darwin'
        ? 'Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
        : 'chrome'
      : 'chrome-headless-shell';
  for (const root of checkouts()) {
    const dir = path.join(root, CACHE, browser);
    if (!fs.existsSync(dir)) continue;
    const builds = fs
      .readdirSync(dir)
      .filter((b) => b.startsWith(`${process.platform === 'darwin' ? 'mac' : 'linux'}`))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
    for (const build of builds.reverse()) {
      const sub = fs.readdirSync(path.join(dir, build)).find((d) => d.startsWith(`${browser}-`));
      const bin = sub && path.join(dir, build, sub, inside);
      if (bin && fs.existsSync(bin)) return bin;
    }
  }
  return null;
}

/** CHROME_PATH, else chrome-headless-shell (`npm run chrome:install`), else Chrome/Chromium where it is usually
 * installed; null when there is none. `full`: a whole Chrome first — the shell has no notification system (a push's
 * notification never shows) — Chrome for Testing, else the installed one, else the shell. */
export function findChrome({ full = false } = {}) {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) return process.env.CHROME_PATH;
  const chrome = CHROMES.find((p) => fs.existsSync(p)) || null;
  if (full) return findInstalled('chrome') || chrome || findInstalled('chrome-headless-shell');
  return findInstalled('chrome-headless-shell') || chrome;
}

/** Ends the suite (a failure, or a skip with VR_E2E_SKIP_OK=1) when the built UI is missing. */
export function requireDist(label) {
  if (!fs.existsSync(path.join(ROOT, 'web/dist/index.html'))) unavailable(label, 'web/dist is missing, run `npm run build` first');
}

/** Chrome's path; ends the suite when Chrome or the built UI is missing. */
export function requireChrome(label) {
  const chrome = findChrome();
  if (!chrome) unavailable(label, 'no Chrome/Chromium found (set CHROME_PATH)');
  requireDist(label);
  return chrome;
}

/**
 * The app's own page, not its loading state. Until /api/auth/status answers, a route draws its screen's skeleton, and
 * with an earlier visit's hint (lib/chromeHint.ts) that skeleton already shows data fetched alongside: real cards, the
 * bell's count, a working inbox; only what depends on the role is missing. The real page then replaces it, so a mark
 * set, a click pressed or a role-gated control looked for before then is lost. The account chip in the top bar stays
 * disabled until the server has said who you are, and comes alive in the render that swaps in the real page. A top bar
 * that shows it: desktop widths (a phone with videos has it in the drawer).
 */
export const signedIn = (page, timeout = 20_000) => page.waitForSelector('.topbar .user-chip:not([disabled])', { timeout });

/** Where screenshots go (VR_SHOTS, created here), or null when the suite runs without them. */
export function shotsDir() {
  const dir = process.env.VR_SHOTS || null;
  if (dir) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Switches that set the page's language (navigator.language, Accept-Language, Intl): --lang works on Linux and
 * Windows; on macOS Chrome ignores it and follows the AppleLanguages default, which a launch argument overrides. */
export const localeArgs = (locale) => [`--lang=${locale}`, ...(process.platform === 'darwin' ? ['-AppleLanguages', `(${locale})`] : [])];

/** A desktop with a mouse, whatever the machine has: the suites drive Chrome with one. Headless Chrome on a Mac reports
 * `hover: hover` and `pointer: fine`; on a Linux server with no input devices (CI) it reports `hover: none` and
 * `pointer: none`, and the app rightly shows what it shows where nothing can hover (the inbox's ⋯ instead of row
 * actions, a folder's mark beside its buttons). Values from ui::HoverType (2 = hover) and ui::PointerType (4 = fine);
 * a page that emulates touch (setViewport hasTouch) still gets `hover: none` and `pointer: coarse`. A renderer applies
 * these when a page loads; see keepTheMouse for what would undo them after that. */
export const MOUSE_ARGS = ['--blink-settings=primaryHoverType=2,availableHoverTypes=2,primaryPointerType=4,availablePointerTypes=4'];

/** Whether touch emulation is on, per CDP session (off when a session starts). */
const touchOn = new WeakMap();
const kept = new WeakSet();
/**
 * Setting touch emulation, on or off, makes Chrome work a page's hover and pointer out again from the machine's input
 * devices: on a Linux server none, and MOUSE_ARGS' mouse is gone until the next load. Puppeteer's setViewport sets it
 * every time — to off when it is off already — so a plain resize (fitsAt, layoutMatrix, a suite's own) would leave a
 * desktop page without hover. Only a call that changes it is sent; one that does makes puppeteer reload the page, which
 * applies MOUSE_ARGS again. On a Mac nothing changes: there the machine has a mouse anyway.
 */
function keepTheMouse(session) {
  const proto = Object.getPrototypeOf(session);
  if (kept.has(proto)) return;
  kept.add(proto);
  const send = proto.send;
  proto.send = function (method, params, ...rest) {
    if (method === 'Emulation.setTouchEmulationEnabled') {
      const on = !!params?.enabled;
      if ((touchOn.get(this) ?? false) === on) return Promise.resolve({});
      touchOn.set(this, on);
    }
    return send.call(this, method, params, ...rest);
  };
}

/**
 * Launches headless Chrome.
 * @param {{ locale?: string, reducedMotion?: boolean, args?: string[], notifications?: boolean }} [o]
 *   locale: the page's language (default en-US); reducedMotion: `prefers-reduced-motion: reduce` (default on — a
 *   View Transition holds clicks for its duration, and most suites click right after navigating); args: more switches;
 *   notifications: the suite checks shown notifications, so a whole Chrome where there is one (see findChrome).
 */
export async function launch({ locale = 'en-US', reducedMotion = true, args = [], notifications = false } = {}) {
  const chrome = findChrome({ full: notifications });
  if (!chrome) throw new Error('no Chrome/Chromium found (set CHROME_PATH)');
  const puppeteer = (await import('puppeteer-core')).default;
  const lang = locale.replace('-', '_');
  const browser = await puppeteer.launch({
    executablePath: chrome,
    headless: path.basename(chrome) === 'chrome-headless-shell' ? 'shell' : true,
    args: [
      '--no-sandbox',
      '--no-first-run',
      '--mute-audio',
      ...MOUSE_ARGS,
      ...(reducedMotion ? ['--force-prefers-reduced-motion'] : []),
      ...localeArgs(locale),
      ...args,
    ],
    env: { ...process.env, LANG: `${lang}.UTF-8`, LANGUAGE: lang },
  });
  // A whole Chrome (new headless) treats pages as tabs of one window: the one opened last is in front and every other
  // goes hidden — no animation frames at all, timers about once a second (measured: 0 frames in 5 s, 6 timeouts in
  // 6 s), so a settle there can only time out. Each page in a window of its own stays visible. chrome-headless-shell
  // keeps every page visible anyway.
  if (path.basename(chrome) !== 'chrome-headless-shell') {
    const inWindows = (target) => {
      const newPage = target.newPage.bind(target);
      target.newPage = (o) => newPage({ type: 'window', ...o });
      return target;
    };
    inWindows(browser);
    const createContext = browser.createBrowserContext.bind(browser);
    browser.createBrowserContext = async (...a) => inWindows(await createContext(...a));
  }
  // every page's session is of the class the browser's own is
  const session = await browser.target().createCDPSession();
  keepTheMouse(session);
  await session.detach();
  // VR_E2E_CPU=<n>: every page runs its scripts n times slower (Chrome's CPU throttling), a busy CI runner on a quiet
  // machine, for the races only CI shows. perf.mjs sets its own rate on the pages it measures.
  const cpu = Number(process.env.VR_E2E_CPU) || 0;
  if (cpu > 1)
    browser.on('targetcreated', async (target) => {
      if (target.type() !== 'page') return;
      const page = await target.page().catch(() => null);
      await page
        ?.createCDPSession()
        .then((s) => s.send('Emulation.setCPUThrottlingRate', { rate: cpu }))
        .catch(() => {});
    });
  return browser;
}
