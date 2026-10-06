// An Embed link (docs/sharing.md, "Embedding a video"): one video's player alone at /e/<token>, for an <iframe> on
// another site. What the kind may be (one video, watch only, never a password), what the player is told (the newest
// version, its media, chapters and captions, the badge, nothing about people or folders), which answers another site
// may frame (the player's page alone), that it sets no cookie, that revoking or expiry ends it, that its visits count
// like a Watch only link's without ever marking the video "out for review", and oEmbed (answers and refusals).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo, slugOf, tmpdir, until } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const { renderKey } = await import('../../lib/renderKey.ts');
const { transcriptFile } = await import('../../lib/transcripts.ts');
const { TRANSCRIPT_VERSION } = await import('../../lib/transcript.ts');
const { flushShareStats } = await import('../../lib/shares.ts');
const { stageForReview } = await import('../../lib/stageContext.ts');
const { DATA } = await import('../../lib/paths.ts');
const { staticUi } = await import('../../server/app.ts');
const { loggedPath } = await import('../../server/http.ts');
const { embedOptions, tokenFromPath } = await import('../../web/src/embed/options.ts');
const { embedCode, embedSrc, ratioOf } = await import('../../web/src/share/embedCode.ts');

// a build with both pages, as web/dist has them
const dist = tmpdir('vr-embed-dist-');
fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><html><head><title>app</title></head><body></body></html>');
fs.writeFileSync(path.join(dist, 'embed.html'), '<!doctype html><html><head><title>player</title></head><body class="em-body"></body></html>');

/** A render with two chapter markers (as an editor writes them), at 30 fps. */
function withChapters(file: string): string {
  const plain = makeVideo(path.join(dir, 'in/plain.mp4'), { w: 320, h: 180, fps: 30, dur: 3 });
  const meta = path.join(dir, 'in/chapters.txt');
  fs.writeFileSync(
    meta,
    ';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1000\ntitle=Opening\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=1000\nEND=2000\ntitle=The\tproduct\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=2000\nEND=3000\ntitle=\n',
  );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-i', plain, '-i', meta, '-map', '0', '-map_metadata', '1', '-map_chapters', '1', '-c', 'copy', '-y', file]);
  return file;
}

const film = withChapters(path.join(dir, 'Clients/Acme/export/launch-film.mp4'));
age(film);
store.createOrGetReview(film, { by: 'tester' });
const slug = slugOf(film);
const enc = encodeURIComponent(slug);
// what is said in it, heard before (the embed never starts hearing it)
const ver = store.loadReview(slug)?.versions[0];
assert.ok(ver);
fs.mkdirSync(path.dirname(transcriptFile(renderKey(ver))), { recursive: true });
fs.writeFileSync(
  transcriptFile(renderKey(ver)),
  JSON.stringify({
    transcript_version: TRANSCRIPT_VERSION,
    hash: ver.hash,
    language: 'en',
    engine: 'local:secret-engine-name',
    timing: 'line',
    fps: 30,
    frames: 90,
    words: [],
    lines: [{ text: 'Meet the new launch.', t0: 0.2, t1: 1.4, f0: 6, f1: 41, w0: 0, n: 4 }],
    created: '2026-10-06T10:00:00+02:00',
  }),
);
const quiet = makeVideo(path.join(dir, 'Clients/Acme/export/quiet.mp4'), { w: 180, h: 320, fps: 25, dur: 1 });
age(quiet);
store.createOrGetReview(quiet, { by: 'tester' });

const { request, base } = await startApp({ token: 'test-token', loadSessions: async () => [], ui: staticUi(dist) });
const visitor = { 'x-forwarded-for': '203.0.113.9' };

const make = async (body: object, at = enc) => request('POST', `/api/review/${at}/shares`, { body });
const embedLink = async (body: object = {}) => {
  const r = await make({ label: 'Website hero', embed: true, ...body });
  assert.equal(r.status, 200, r.text);
  return r.json();
};
/** The player's answer once its copy is made (the page asks again while it is being made, like this). */
const ready = (token: string) =>
  until(async () => {
    const r = await request('GET', `/api/g/${token}/embed`, { headers: visitor });
    assert.equal(r.status, 200, r.text);
    return r.json().media ? r.json() : null;
  }, 'the embed’s media');

test('an Embed link is one video, watch only, never a password; a folder has none', async () => {
  const s = await embedLink({ comment: true, approve: true, versions: 'all', download: 'original', notes: 'all' });
  assert.equal(s.embed, true);
  assert.deepEqual(
    [s.comment, s.approve, s.notes, s.versions, s.download],
    [false, false, 'own', 'latest', 'off'],
    'whatever was asked, it only plays the newest',
  );
  assert.equal(s.kind, 'video');
  assert.deepEqual([s.width, s.height], [320, 180], 'the owner learns its shape, for the code');

  const locked = await make({ label: 'x', embed: true, password: 'open sesame' });
  assert.equal(locked.status, 400, locked.text);
  assert.match(locked.json().error, /password/);
  const filed = await request('PUT', `/api/review/${encodeURIComponent(slugOf(quiet))}/folder`, { body: { folder: 'Acme' } });
  assert.equal(filed.status, 200, filed.text);
  const folder = await request('POST', '/api/folder-shares', { body: { folder: 'Acme', embed: true } });
  assert.equal(folder.status, 400, folder.text);
  assert.match(folder.json().error, /one video/);

  // a review link with a password becomes an embed only without it; back again, it is a review link
  const review = (await make({ label: 'Mia', password: 'letmein1' })).json();
  const keep = await request('PATCH', `/api/shares/${review.token}`, { body: { embed: true } });
  assert.equal(keep.status, 400, keep.text);
  const dropped = await request('PATCH', `/api/shares/${review.token}`, { body: { embed: true, password: null } });
  assert.equal(dropped.status, 200, dropped.text);
  assert.equal(dropped.json().embed, true);
  assert.equal(dropped.json().password, false);
  const back = await request('PATCH', `/api/shares/${review.token}`, { body: { embed: false, comment: true, approve: true } });
  assert.equal(back.json().embed, undefined);
  assert.equal(back.json().comment, true);
  assert.equal((await request('GET', `/api/g/${review.token}/embed`, { headers: visitor })).status, 404, 'a review link opens no player');
});

test('the player is told what it plays and nothing about people, folders or notes', async () => {
  const s = await embedLink();
  const d = await ready(s.token);
  assert.deepEqual(
    Object.keys(d).sort(),
    ['badge', 'captions', 'captions_lang', 'chapters', 'duration', 'fps', 'frames', 'height', 'media', 'poster', 'slug', 'sprite', 'title', 'v', 'width'],
    JSON.stringify(d),
  );
  assert.equal(d.title, 'launch-film.mp4', 'the video’s name, as a Watch only visitor reads it');
  assert.match(d.slug, /^v_[A-Za-z0-9_-]{16}$/);
  assert.deepEqual([d.v, d.fps, d.frames, d.width, d.height], [1, 30, 90, 320, 180]);
  assert.deepEqual(
    d.chapters,
    [
      { frame: 0, title: 'Opening' },
      { frame: 30, title: 'The product' },
    ],
    'the render’s own markers, one line each; one without a title left out',
  );
  assert.equal(d.badge, true);
  assert.match(d.media, new RegExp(`^/media/g/${s.token}/${d.slug}/v1\\?`));
  const media = await request('GET', d.media, { headers: { ...visitor, Range: 'bytes=0-1023' } });
  assert.ok(media.status === 206 || media.status === 200, `it plays (${media.status})`);
  assert.equal((await request('GET', d.poster, { headers: visitor })).status, 200, 'its poster');

  assert.equal(d.captions_lang, 'en');
  const vtt = await request('GET', d.captions, { headers: visitor });
  assert.equal(vtt.status, 200, vtt.text);
  assert.match(String(vtt.headers['content-type']), /^text\/vtt/);
  assert.match(vtt.text, /^WEBVTT\n\n00:00:00\.200 --> 00:00:01\.400\nMeet the new launch\./);
  assert.ok(!vtt.text.includes('secret-engine-name'));
  for (const secret of [dir, 'Clients', 'Acme', slug, 'Website hero', 'tester', 'reviewer', 'org']) assert.ok(!JSON.stringify(d).includes(secret), secret);

  // a video without a transcript or chapters: none of either, never a hearing started for it
  const other = (await make({ label: 'Quiet', embed: true }, encodeURIComponent(slugOf(quiet)))).json();
  const q = await ready(other.token);
  assert.deepEqual([q.chapters, q.captions, q.width, q.height], [[], null, 180, 320]);
  assert.equal((await request('GET', `/api/g/${other.token}/captions/${q.slug}`, { headers: visitor })).status, 404);
});

test('only the player’s page may be framed by another site; nothing it loads sets a cookie', async () => {
  const s = await embedLink();
  const d = await ready(s.token);
  const page = await request('GET', `/e/${s.token}`, { headers: { ...visitor, 'Sec-Fetch-Site': 'cross-site', 'Sec-Fetch-Dest': 'iframe' } });
  assert.equal(page.status, 200, page.text);
  assert.match(page.text, /class="em-body"/, 'the player’s own page, not the app');
  assert.equal(page.headers['x-frame-options'], undefined, 'no X-Frame-Options on the player');
  const csp = String(page.headers['content-security-policy']);
  assert.match(csp, /frame-ancestors \*/);
  assert.ok(!csp.includes("frame-ancestors 'none'"));
  assert.match(csp, /default-src 'self'/, 'the rest of the policy holds');
  assert.equal(page.headers['referrer-policy'], 'no-referrer', 'its token never leaves in a Referer');
  // an unknown token gets the page too (it says the video isn't there, inside the frame)
  const unknown = await request('GET', '/e/AAAAAAAAAAAAAAAAAAAAAAAA', { headers: visitor });
  assert.equal(unknown.status, 200);
  assert.match(String(unknown.headers['content-security-policy']), /frame-ancestors \*/);

  for (const url of ['/', `/g/${s.token}`, `/api/g/${s.token}`, `/api/g/${s.token}/embed`, d.poster, d.media, '/api/info', `/e/${s.token}/x`, '/oembed']) {
    const r = await request('GET', url, { headers: visitor });
    assert.equal(r.headers['x-frame-options'], 'DENY', url);
    assert.match(String(r.headers['content-security-policy']), /frame-ancestors 'none'/, url);
  }

  const answers = [
    page,
    await request('GET', `/api/g/${s.token}/embed`, { headers: visitor }),
    await request('GET', d.poster, { headers: visitor }),
    await request('GET', d.media, { headers: { ...visitor, Range: 'bytes=0-99' } }),
    await request('GET', d.captions, { headers: visitor }),
    await request('POST', `/api/g/${s.token}/visit`, { body: { visitor: 'embed-visit-0001', slug: d.slug, v: d.v }, headers: visitor }),
    await request('POST', `/api/g/${s.token}/progress`, {
      body: { visitor: 'embed-visit-0001', slug: d.slug, v: d.v, seen: '1'.padEnd(25, '0'), secs: 1 },
      headers: visitor,
    }),
    await request('GET', `/oembed?url=${encodeURIComponent(`${base}/e/${s.token}`)}`, { headers: visitor }),
  ];
  for (const r of answers) assert.equal(r.headers['set-cookie'], undefined, `no cookie: ${r.status} ${r.text.slice(0, 80)}`);
});

test('an Embed link’s pages name their oEmbed; a review link’s never do', async () => {
  const s = await embedLink();
  const review = (await make({ label: 'Mia' })).json();
  const tag = (html: string) => /<link rel="alternate" type="application\/json\+oembed" href="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, '&');
  const onPlayer = tag((await request('GET', `/e/${s.token}`, { headers: visitor })).text);
  const onWatch = tag((await request('GET', `/g/${s.token}`, { headers: visitor })).text);
  assert.ok(onPlayer && onWatch, 'both pages carry it');
  const asked = new URL(onPlayer as string);
  assert.equal(asked.pathname, '/oembed');
  assert.match(asked.searchParams.get('url') ?? '', new RegExp(`/e/${s.token}$`));
  assert.equal(asked.searchParams.get('format'), 'json');
  assert.match(new URL(onWatch as string).searchParams.get('url') ?? '', new RegExp(`/g/${s.token}$`));
  assert.equal(tag((await request('GET', `/g/${review.token}`, { headers: visitor })).text), undefined, 'a review link');
  assert.equal(tag((await request('GET', '/e/AAAAAAAAAAAAAAAAAAAAAAAA', { headers: visitor })).text), undefined, 'no link at all');
});

test('oEmbed: the iframe, its size, the title and the poster for an Embed link; 404 for anything else', async () => {
  const s = await embedLink();
  const d = await ready(s.token);
  const ask = (url: string, more = '') => request('GET', `/oembed?url=${encodeURIComponent(url)}${more}`, { headers: visitor });
  const r = await ask(`${base}/e/${s.token}`, '&format=json');
  assert.equal(r.status, 200, r.text);
  assert.equal(r.headers['access-control-allow-origin'], '*');
  const o = r.json();
  assert.deepEqual(Object.keys(o).sort(), [
    'height',
    'html',
    'provider_name',
    'provider_url',
    'thumbnail_height',
    'thumbnail_url',
    'thumbnail_width',
    'title',
    'type',
    'version',
    'width',
  ]);
  assert.deepEqual([o.version, o.type, o.title, o.width, o.height], ['1.0', 'video', 'launch-film.mp4', 320, 180]);
  assert.equal(o.provider_name, 'Lampo');
  assert.equal(
    o.html,
    `<iframe src="${base}/e/${s.token}" width="320" height="180" title="launch-film.mp4" frameborder="0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen></iframe>`,
  );
  assert.equal(o.thumbnail_url, `${base}${d.poster}`);
  assert.deepEqual([o.thumbnail_width, o.thumbnail_height], [640, 360]);
  // its watch page's address answers the same; bounds scale it down, never up
  const watch = (await ask(`${base}/g/${s.token}`, '&maxwidth=160')).json();
  assert.deepEqual([watch.width, watch.height], [160, 90]);
  assert.match(watch.html, /width="160" height="90"/);
  assert.deepEqual([(await ask(`${base}/e/${s.token}`, '&maxwidth=2000&maxheight=90')).json().height, 0], [90, 0], 'the tighter bound wins');

  const review = (await make({ label: 'Mia' })).json();
  const revoked = await embedLink();
  await request('DELETE', `/api/shares/${revoked.token}`);
  const expired = await embedLink({ expires: new Date(Date.now() - 60_000).toISOString() });
  for (const [url, why] of [
    [`${base}/g/${review.token}`, 'a review link'],
    [`${base}/e/${revoked.token}`, 'a revoked embed'],
    [`${base}/e/${expired.token}`, 'an expired embed'],
    [`${base}/e/AAAAAAAAAAAAAAAAAAAAAAAA`, 'an unknown token'],
    [`${base}/x/${s.token}`, 'another path'],
    [`ftp://127.0.0.1/e/${s.token}`, 'another scheme'],
    [`https://films.example.test/e/${s.token}`, 'another site’s address: an answer never names it'],
    ['not a url', 'not an address'],
  ] as const)
    assert.equal((await ask(url)).status, 404, why);
  assert.equal((await ask(`${base}/e/${s.token}`, '&format=xml')).status, 501, 'JSON only');
  assert.equal((await request('GET', '/oembed', { headers: visitor })).status, 400, 'no address');
});

test('revoking ends the embed at once, and so does its expiry: its answer and its media', async () => {
  const s = await embedLink();
  const d = await ready(s.token);
  await request('DELETE', `/api/shares/${s.token}`);
  assert.equal((await request('GET', `/api/g/${s.token}/embed`, { headers: visitor })).status, 404);
  assert.equal((await request('GET', d.media, { headers: { ...visitor, Range: 'bytes=0-99' } })).status, 404, 'its media too');
  assert.equal((await request('GET', d.captions, { headers: visitor })).status, 404);

  const soon = await embedLink({ expires: new Date(Date.now() + 1500).toISOString() });
  const e = await ready(soon.token);
  await until(async () => (await request('GET', `/api/g/${soon.token}/embed`, { headers: visitor })).status === 410, 'expired');
  assert.equal((await request('GET', e.media, { headers: { ...visitor, Range: 'bytes=0-99' } })).status, 410);
});

test('a visit counts on the first play like a Watch only link’s, once per half hour, and never marks the video out for review', async () => {
  const s = await embedLink();
  const d = await ready(s.token);
  const before = store.loadReview(slug);
  assert.ok(before);
  const stage = stageForReview(before);
  // loading the player counts nothing: the page it sits on loads it for everyone
  flushShareStats();
  const stats = () => {
    flushShareStats();
    return JSON.parse(fs.readFileSync(path.join(DATA, 'shares.json'), 'utf8')).shares as Record<
      string,
      { id?: string; stats: { opens: number; videos?: Record<string, { views: number }> } }
    >;
  };
  const mine = () => Object.values(stats()).find((x) => x.id === s.id);
  assert.equal(mine()?.stats.opens, 0);
  for (let i = 0; i < 2; i++) {
    const r = await request('POST', `/api/g/${s.token}/visit`, { body: { visitor: 'embed-visit-0002', slug: d.slug, v: d.v }, headers: visitor });
    assert.equal(r.status, 200, r.text);
  }
  assert.equal(mine()?.stats.opens, 1, 'one visit');
  assert.equal(mine()?.stats.videos?.[slug]?.views, 1, 'one view of the video');
  const after = store.loadReview(slug);
  assert.ok(after);
  assert.equal(stageForReview(after).stage, stage.stage, 'an embed asks nobody for a verdict');
  // a video the link doesn't cover is not part of it
  assert.equal(
    (await request('POST', `/api/g/${s.token}/visit`, { body: { visitor: 'embed-visit-0002', slug: 'v_AAAAAAAAAAAAAAAA', v: 1 }, headers: visitor })).status,
    404,
  );
});

test('Insights never lists an embed among the links nobody opened: there is nobody to remind', async () => {
  const { watchingOf } = await import('../../lib/insightsWatch.ts');
  const quietSlug = slugOf(quiet);
  const watch = (await make({ label: 'Watch, never opened', comment: false, approve: false }, encodeURIComponent(quietSlug))).json();
  await make({ label: 'Embed, never played', embed: true }, encodeURIComponent(quietSlug));
  const review = store.loadReview(quietSlug);
  assert.ok(review);
  const unopened = watchingOf([review], 0, Date.now() + 1).unopened.map((u) => u.label);
  assert.ok(unopened.includes(watch.label), `a watch-only link is listed: ${unopened}`);
  assert.ok(!unopened.includes('Embed, never played'), `an embed isn’t: ${unopened}`);
});

test('the token in the path never reaches the log', () => {
  assert.equal(loggedPath('/e/Abc123secretTokenValue'), '/e/…');
  assert.equal(loggedPath('/api/g/Abc123secret/embed'), '/api/g/…/embed');
  assert.equal(loggedPath('/edit/x'), '/edit/x');
});

test('the player’s address: autoplay is muted, loop, controls off, German; the token’s shape', () => {
  assert.deepEqual(embedOptions(''), { autoplay: false, muted: false, loop: false, controls: true, lang: 'en' });
  assert.deepEqual(embedOptions('?autoplay=1&loop=true&controls=0&lang=de'), { autoplay: true, muted: true, loop: true, controls: false, lang: 'de' });
  assert.deepEqual(embedOptions('?muted=1&lang=fr&autoplay=yes'), { autoplay: false, muted: true, loop: false, controls: true, lang: 'en' });
  assert.equal(tokenFromPath('/e/abcdefghijklmnopqrstuvwx'), 'abcdefghijklmnopqrstuvwx');
  assert.equal(tokenFromPath('/e/short'), null);
  assert.equal(tokenFromPath('/g/abcdefghijklmnopqrstuvwx'), null);
});

test('the code a site pastes keeps the video’s shape and names it', () => {
  assert.equal(ratioOf(1920, 1080), '16/9');
  assert.equal(ratioOf(1080, 1920), '9/16');
  assert.equal(ratioOf(undefined, undefined), '16/9');
  assert.equal(embedSrc('https://app.example.test/g/abcdefghijklmnopqrstuvwx'), 'https://app.example.test/e/abcdefghijklmnopqrstuvwx');
  assert.equal(
    embedCode({ src: 'https://app.example.test/e/abcdefghijklmnopqrstuvwx', title: 'Launch "film" <v2>', width: 1080, height: 1080 }),
    '<iframe src="https://app.example.test/e/abcdefghijklmnopqrstuvwx" title="Launch &quot;film&quot; &lt;v2&gt;" style="display:block;width:100%;aspect-ratio:1/1;border:0" allow="autoplay; fullscreen; picture-in-picture" allowfullscreen loading="lazy"></iframe>',
  );
});
