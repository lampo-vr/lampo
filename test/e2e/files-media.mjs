#!/usr/bin/env node
// covers: web/src/files/FileSheet.tsx server/routes/files.ts server/guard.ts lib/storage/mediaHost.ts
// The Files tab on a hosted server with its own media host (LAMPO_MEDIA_ORIGIN): the app answers on one host name
// (127.0.0.1), the media on another (localhost), as on Cloud. A file opened in the tab shows its picture (from the app
// host, as posters come: the page's img-src is the app's own), its text (from the media host, which the page may ask),
// and a PDF opens in a tab of its own from the app's route, where Chrome's viewer shows it under the bytes' own policy;
// nothing on the way is refused (no CSP error in the console).
// Without Chrome or web/dist it fails (see prereq.mjs).
import path from 'node:path';
import { client } from '../lib/http.ts';
import { launch, requireChrome, requireDist, shotsDir, signedIn } from './lib/browser.mjs';
import { assert, check, crashed, finish } from './lib/checks.mjs';
import { bytesFor, pdfShown, push } from './lib/filesStore.mjs';
import { startServer } from './lib/server.mjs';

const LABEL = 'files media host e2e';
requireChrome(LABEL);
requireDist(LABEL);
const SHOTS = shotsDir();
let media = '';
const srv = await startServer({
  prefix: 'vr-e2e-files-media-',
  mode: 'server',
  publicUrl: true,
  env: ({ port }) => {
    media = `http://localhost:${port}`;
    return { LAMPO_MEDIA_ORIGIN: media };
  },
});
const { dir, base: BASE } = srv;
const request = client(srv.port);
const e = encodeURIComponent;

let browser;
try {
  const token = await srv.setupToken();
  assert(token, `no setup token in the server log:\n${srv.log()}`);
  const origin = { Origin: BASE };
  const setup = await request('POST', '/api/auth/setup', {
    body: { token, email: 'olivia@e2e.test', name: 'Olivia', password: 'a long enough password' },
    headers: origin,
  });
  assert(setup.status === 200, setup.text);
  const cookie = String([setup.headers['set-cookie']].flat().find((c) => String(c).startsWith('vr_session=')) || '').split(';')[0];
  const session = { name: 'vr_session', value: cookie.split('=').slice(1).join('=') };
  const headers = { Cookie: cookie, ...origin };
  const made = await request('POST', '/api/folders', { body: { path: 'Acme' }, headers });
  assert(made.status === 200, made.text);
  await push(
    BASE,
    'Acme',
    {
      'Brief/still.png': bytesFor(dir, 'still.png', 1),
      'Brief/Brief v3.pdf': bytesFor(dir, 'Brief v3.pdf', 2),
      'Brief/voiceover script.txt': bytesFor(dir, 'voiceover script.txt', 3),
    },
    { headers },
  );

  browser = await launch();
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 900 });
  await page.setCookie({ ...session, url: BASE });
  const errors = [];
  page.on('pageerror', (x) => errors.push(x.message));
  // a CSP refusal ("Refused to load the image …") or a blocked cross-origin answer is a console error
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  const openFile = async (name) => {
    await page.goto('about:blank');
    await page.goto(`${BASE}/#/files/Acme?path=${e('Brief')}`);
    await signedIn(page);
    await page.waitForSelector('[data-testid=files][aria-busy=false] [data-testid=file-row]', { timeout: 20_000 });
    await page.$$eval('[data-testid=file-row]', (rows, n) => rows.find((r) => r.querySelector('.pf-name')?.textContent === n)?.click(), name);
    await page.waitForSelector('[data-testid=file-sheet] [data-testid=file-version]', { timeout: 20_000 });
  };

  await check('a picture’s preview shows, from the app host (the page’s img-src stays its own)', async () => {
    await openFile('still.png');
    await page.waitForFunction(() => (document.querySelector('[data-testid=file-preview] img')?.naturalWidth ?? 0) > 0, { timeout: 15_000 });
    const src = await page.$eval('[data-testid=file-preview] img', (x) => x.currentSrc);
    assert(new URL(src).origin === BASE, `the picture from ${src}`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'files-media-picture-1440.png') });
  });

  await check('a text file’s first lines show, fetched from the media host', async () => {
    await openFile('voiceover script.txt');
    await page.waitForFunction(() => /Spring is here/.test(document.querySelector('[data-testid=file-preview-text]')?.textContent ?? ''), {
      timeout: 15_000,
    });
  });

  await check('a PDF: Open (the app’s route, a tab of its own) and Download, never a frame; Chrome’s viewer shows it there', async () => {
    await openFile('Brief v3.pdf');
    const pdf = await page.$eval('[data-testid=file-preview]', (x) => ({
      frame: !!x.querySelector('iframe, embed, object'),
      href: x.querySelector('[data-testid=file-pdf-open]')?.getAttribute('href'),
      download: !!x.querySelector('[data-testid=file-pdf-download]'),
    }));
    assert(!pdf.frame && pdf.download && /^\/api\/files\/fl_[0-9a-f]{12}\/download\?v=\d+&inline=1$/.test(pdf.href ?? ''), JSON.stringify(pdf));
    // the route hands out a fresh sealed URL on the media host, whose answer carries `sandbox; default-src 'none'`
    const shown = await pdfShown(`${BASE}${pdf.href}`, { cookie: session });
    assert(shown.viewer && shown.contentType === 'application/pdf' && shown.at === media, `the PDF in its tab: ${JSON.stringify(shown)}`);
    if (SHOTS) await page.screenshot({ path: path.join(SHOTS, 'files-media-pdf-1440.png') });
  });

  await check('nothing on the way was refused: no CSP error, no page error', async () => {
    assert(!errors.length, errors.join(' | '));
  });
} catch (x) {
  crashed(x, srv);
} finally {
  await finish(LABEL, { browser, servers: [srv] });
}
