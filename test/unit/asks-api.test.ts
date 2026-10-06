// Questions with options on a hosted server (server/routes/asks.ts): an agent with its person's token asks — on a
// folder before any render, or on a video —, with sounds at three levels, pictures, a link and a file that comes
// later through an upload URL; a reviewer auditions and answers; the answer is an ordinary answer (ANSWERED with the
// PICKED line in the event log, INBOX.md, the inbox). Who may delete, what a review link shows (nothing), and that
// ids, files and picks are checked.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { after, before, test } from 'node:test';
import type { AskCreated, AskView, ForYouItem } from '../../lib/types.ts';
import { FFMPEG, isolatedEnv, makeVideo, must } from '../lib/helpers.ts';
import { client, cookieFrom, type Request, tusUpload } from '../lib/http.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC } });
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const { createApp } = await import('../../server/app.ts');
const auth = await import('../../lib/auth.ts');
const store = await import('../../lib/store.ts');
const { eventLine } = await import('../../lib/eventLine.ts');
const { levelGains } = await import('../../lib/options.ts');

const spot = makeVideo(path.join(dir, 'renders/spot.mp4'), { w: 160, h: 90, fps: 25, dur: 1 });
// Synthetic media only: sines at three levels, a test pattern.
function tone(name: string, amplitude: number): string {
  const file = path.join(dir, `${name}.wav`);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `aevalsrc=${amplitude}*sin(2*PI*880*t):s=48000:d=1.5`, '-y', file]);
  return file;
}
function pattern(name: string): string {
  const file = path.join(dir, `${name}.png`);
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=1', '-frames:v', '1', '-y', file]);
  return file;
}
const b64 = (f: string) => fs.readFileSync(f).toString('base64');

let server: http.Server;
let request: Request;
let port = 0;
const as: Record<'olivia' | 'max' | 'rita' | 'agent', Record<string, string>> = { olivia: {}, max: {}, rita: {}, agent: {} };
let slug = '';
before(async () => {
  server = http.createServer(createApp(createContext({ cfg: loadConfig(), token: 'unused' })));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  port = (server.address() as AddressInfo).port;
  request = client(port, { Connection: 'close' });
  for (const [name, role] of [
    ['olivia', 'owner'],
    ['max', 'member'],
    ['rita', 'reviewer'],
  ] as const) {
    const u = await auth.createUser({ email: `${name}@example.com`, name: name[0].toUpperCase() + name.slice(1), password: `${name}s password 1`, role });
    const login = await request('POST', '/api/auth/login', {
      body: { email: `${name}@example.com`, password: `${name}s password 1` },
      headers: { Origin: PUBLIC },
    });
    assert.equal(login.status, 200, login.text);
    as[name] = { Cookie: cookieFrom(login), Origin: PUBLIC };
    if (name === 'olivia') as.agent = { Authorization: `Bearer ${auth.createToken(u.id, 'agent').token}` };
  }
  const up = await tusUpload(request, spot, { filename: 'spot.mp4', folder: 'Acme' }, as.agent);
  assert.equal(up.status, 200, up.text);
  slug = up.json().slug;
});
after(() => server.close());

const voices = () => [
  { id: 'v1', label: 'Calm', ref: { kind: 'file', data: b64(tone('v1', 0.5)) } },
  { id: 'v2', label: 'Warm', ref: { kind: 'file', data: b64(tone('v2', 0.125)) } },
  { id: 'v3', label: 'Bright', ref: { kind: 'file', data: b64(tone('v3', 0.9)) } },
];
let folderAsk: AskCreated;

test('an agent asks on a folder before any render: sounds measured, pictures kept, a link, one file through an upload URL', async () => {
  const r = await request('POST', '/api/asks', {
    body: {
      folder: 'Acme',
      text: 'Before I render the launch film: which narrator, and which look?',
      options: [
        { id: 'voice', label: 'Narrator', items: voices() },
        {
          id: 'look',
          label: 'Look',
          items: [
            { id: 'l1', label: 'Test pattern', ref: { kind: 'file', data: b64(pattern('l1')) } },
            { id: 'l2', label: 'Moodboard', ref: { kind: 'link', url: 'https://example.com/board' } },
            { id: 'l3', label: 'Later', ref: { kind: 'file' } },
          ],
        },
      ],
      answer_prompt: 'Anything for the end card?',
      by: 'agent:sound',
    },
    headers: as.agent,
  });
  assert.equal(r.status, 200, r.text);
  folderAsk = r.json();
  assert.equal(folderAsk.folder, 'Acme');
  assert.equal(folderAsk.slug, null);
  const url = must(folderAsk.uploads['look/l3']).url;
  assert.match(url, /^http:\/\/review\.test\/api\/uploads\/direct\/vrup_/);
  // The file arrives later, to that URL.
  const png = fs.readFileSync(pattern('l3'));
  const put = await request('PUT', new URL(url).pathname, { body: png, headers: { 'content-length': String(png.length) } });
  assert.equal(put.status, 200, put.text);
  const view: AskView = (await request('GET', `/api/asks/${folderAsk.id}`, { headers: as.rita })).json();
  assert.equal(view.text, 'Before I render the launch film: which narrator, and which look?');
  assert.equal(view.answer_prompt, 'Anything for the end card?');
  assert.equal(view.author, 'agent:sound');
  const [voice, look] = view.options;
  for (const it of voice.items) {
    assert.equal(it.ref?.kind, 'audio', 'a file without pictures is a sound');
    assert.match(it.ref?.file ?? '', /^r_[0-9a-f]{10}\.m4a$/);
    assert.ok(it.ref?.loudness, 'measured once, when stored');
  }
  // Measured as the levelling needs: the three takes come out level.
  const gains = levelGains(voice.items.map((it) => it.ref?.loudness));
  const played = voice.items.map((it, i) => must(it.ref?.loudness).i + must(gains[i]));
  assert.ok(Math.max(...played) - Math.min(...played) < 0.2, played.join(', '));
  assert.equal(look.items[0].ref?.kind, 'image');
  assert.equal(look.items[1].ref?.kind, 'link');
  assert.equal(look.items[2].ref?.kind, 'image', 'the uploaded file is on its item');
  // Its files are served to the team: a sound in ranges, as audio.
  const sound = must(view.files[must(voice.items[0].ref).id].src);
  const whole = await request('GET', sound, { headers: as.rita });
  assert.equal(whole.status, 200);
  assert.equal(whole.headers['content-type'], 'audio/mp4');
  const part = await request('GET', sound, { headers: { ...as.rita, Range: 'bytes=0-99' } });
  assert.equal(part.status, 206);
  assert.equal((await request('GET', must(view.files[must(look.items[0].ref).id].still), { headers: as.rita })).status, 200);
  // Only the files its items carry: another name of the same shape is nobody's.
  assert.equal((await request('GET', sound.replace(/r_[0-9a-f]{10}/, 'r_0000000000'), { headers: as.rita })).status, 404);
});

test('the question waits in the inbox and on its folder, and the agent hears what it offers', async () => {
  const fy = (await request('GET', '/api/for-you', { headers: as.rita })).json();
  const item = fy.items.find((i: ForYouItem) => i.id === folderAsk.id) as ForYouItem;
  assert.ok(item, JSON.stringify(fy.items.map((i: ForYouItem) => i.key)));
  assert.equal(item.kind, 'question');
  assert.equal(item.slug, '');
  assert.equal(item.folder, 'Acme');
  assert.deepEqual(item.options, [
    { label: 'Narrator', n: 3, kind: 'audio' },
    { label: 'Look', n: 3, kind: 'mixed' },
  ]);
  const strip = (await request('GET', '/api/asks', { headers: as.rita })).json();
  assert.deepEqual(
    strip.asks.map((a: { id: string }) => a.id),
    [folderAsk.id],
  );
  const asked = store.readEvents({ limit: 50 }).find((e) => e.type === 'comment' && e.id === folderAsk.id);
  assert.ok(asked);
  assert.match(
    eventLine(asked),
    new RegExp(`NEW QUESTION ${folderAsk.id} folder Acme by agent:sound — ".*" · options: voice, look \\(the reviewer picks in Lampo\\)`),
  );
});

test('picks are checked against what the question offers', async () => {
  for (const [picks, why] of [
    [{ voice: ['v1', 'v2'] }, /takes one pick/],
    [{ music: ['m1'] }, /no group/],
    [{ voice: ['v9'] }, /no item/],
    [{}, /pick something/],
  ] as const) {
    const r = await request('POST', `/api/asks/${folderAsk.id}/answer`, { body: { picks }, headers: as.rita });
    assert.equal(r.status, 400, r.text);
    assert.match(r.json().error, why);
  }
  assert.equal((await request('POST', '/api/asks/c_000000/answer', { body: { picks: { voice: ['v1'] } }, headers: as.rita })).status, 404);
  assert.equal((await request('POST', '/api/asks/nope/answer', { body: { picks: { voice: ['v1'] } }, headers: as.rita })).status, 400);
});

test('a reviewer’s picks are an ordinary answer: ANSWERED with the PICKED line, in the log, INBOX.md and gone from the inbox', async () => {
  const r = await request('POST', `/api/asks/${folderAsk.id}/answer`, {
    body: { picks: { voice: ['v2'], look: ['l1'] }, note: 'lampo.app on the end card' },
    headers: as.rita,
  });
  assert.equal(r.status, 200, r.text);
  const view: AskView = r.json();
  assert.equal(view.status, 'verified');
  const reply = must(view.replies.at(-1));
  assert.equal(reply.text, 'PICKED voice=v2 look=l1 · note: "lampo.app on the end card"');
  assert.deepEqual(reply.answer, { picks: { voice: ['v2'], look: ['l1'] }, note: 'lampo.app on the end card' });
  const answered = must(store.readEvents({ limit: 50 }).find((e) => e.type === 'status' && e.id === folderAsk.id));
  assert.match(
    eventLine(answered),
    new RegExp(`ANSWERED ${folderAsk.id} folder Acme by Rita — PICKED voice=v2 look=l1 · note: "lampo.app on the end card" · on: "Before I render`),
  );
  const inbox = (await request('GET', '/api/inbox.md', { headers: as.agent })).text;
  assert.match(inbox, /ANSWERED · c_[0-9a-f]{6}\n- folder: Acme \(no video yet\)\n- comment: .*\n- note: PICKED voice=v2 look=l1/);
  const fy = (await request('GET', '/api/for-you', { headers: as.rita })).json();
  assert.ok(!fy.items.some((i: ForYouItem) => i.id === folderAsk.id), 'answered: off the list');
  // Picking again is a reply with the new picks.
  const again = await request('POST', `/api/asks/${folderAsk.id}/answer`, { body: { picks: { voice: ['v3'] } }, headers: as.olivia });
  assert.equal(again.status, 200, again.text);
  const replied = must(store.readEvents({ limit: 50 }).findLast((e) => e.type === 'reply' && e.id === folderAsk.id));
  assert.match(eventLine(replied), /REPLY c_[0-9a-f]{6} folder Acme by Olivia — PICKED voice=v3 look=-/);
});

test('on a video: a note about the whole of it, answered the same way, listed with its picks for the next render', async () => {
  const r = await request('POST', '/api/asks', {
    body: {
      video: slug,
      text: 'Which closing line?',
      options: [
        {
          id: 'close',
          label: 'Closing line',
          items: [
            { id: 'c1', label: 'See you there' },
            { id: 'c2', label: 'lampo.app', ref: { kind: 'frame', video: slug, frame: 3 } },
          ],
        },
      ],
      by: 'agent:sound',
    },
    headers: as.agent,
  });
  assert.equal(r.status, 200, r.text);
  const made: AskCreated = r.json();
  assert.equal(made.slug, slug);
  const note = must(store.findComment(made.id)).comment;
  assert.equal(note.kind, 'question');
  assert.equal(note.scope, 'video');
  assert.equal(note.options?.[0].items[1].ref?.kind, 'frame');
  const fy = (await request('GET', '/api/for-you', { headers: as.rita })).json();
  assert.ok(fy.items.some((i: ForYouItem) => i.id === made.id && i.slug === slug && i.options?.[0].n === 2));
  const answered = await request('POST', `/api/asks/${made.id}/answer`, { body: { picks: { close: ['c2'] } }, headers: as.rita });
  assert.equal(answered.status, 200, answered.text);
  const after = must(store.findComment(made.id)).comment;
  assert.equal(after.status, 'verified');
  assert.equal(after.replies.at(-1)?.text, 'PICKED close=c2');
  const md = (await request('GET', `/api/review/${encodeURIComponent(slug)}/md`, { headers: as.agent })).text;
  assert.match(md, /- options close "Closing line" \(pick one\): c1 See you there · c2 lampo\.app/);
  assert.match(md, /- reply Rita \[verified\]: PICKED close=c2/);
  const ev = must(store.readEvents({ limit: 80 }).findLast((e) => e.type === 'status' && e.id === made.id));
  assert.match(eventLine(ev), /ANSWERED c_[0-9a-f]{6} 00:00:00 spot\.mp4 by Rita — PICKED close=c2 · on: "Which closing line\?"/);
});

test('who may ask, make a folder and delete: a reviewer asks but makes no folder, deletes only what is theirs', async () => {
  const options = [{ id: 'x', items: [{ id: 'a' }, { id: 'b' }] }];
  const nowhere = await request('POST', '/api/asks', { body: { folder: 'Brand new', text: 'Which?', options }, headers: as.rita });
  assert.equal(nowhere.status, 422, nowhere.text);
  assert.match(nowhere.json().error, /no project or folder "Brand new"/);
  const made = await request('POST', '/api/asks', { body: { folder: 'Brand new', text: 'Which?', options }, headers: as.agent });
  assert.equal(made.status, 200, made.text);
  assert.equal(made.json().folder, 'Brand new', 'an owner’s token may make the project');
  const id = made.json().id;
  assert.equal((await request('DELETE', `/api/asks/${id}`, { headers: as.rita })).status, 403, 'not the reviewer’s');
  const mine = (await request('POST', '/api/asks', { body: { folder: 'Acme', text: 'Mine?', options }, headers: as.rita })).json().id;
  assert.equal((await request('DELETE', `/api/asks/${mine}`, { headers: as.rita })).status, 200, 'their own');
  assert.equal((await request('DELETE', `/api/asks/${id}`, { headers: as.max })).status, 200, 'a member edits notes');
  assert.equal((await request('GET', `/api/asks/${id}`, { headers: as.olivia })).status, 404);
  // Both or neither of video and folder is no question.
  assert.equal((await request('POST', '/api/asks', { body: { text: 'Which?', options }, headers: as.agent })).status, 400);
  assert.equal((await request('POST', '/api/asks', { body: { video: slug, folder: 'Acme', text: 'Which?', options }, headers: as.agent })).status, 400);
  assert.equal(
    (await request('POST', '/api/asks', { body: { folder: 'Acme', text: 'Which?', options: [{ id: 'x', items: [{ id: 'a' }] }] }, headers: as.agent })).status,
    400,
  );
});

test('a review link on the folder shows none of it', async () => {
  const link = await request('POST', '/api/folder-shares', { body: { folder: 'Acme', comment: true }, headers: as.olivia });
  assert.equal(link.status, 200, link.text);
  const token = link.json().token as string;
  for (const url of [`/api/g/${token}`, `/api/g/${token}/review/${encodeURIComponent(link.json().videos?.[0]?.slug ?? 'x')}`]) {
    const r = await request('GET', url);
    assert.doesNotMatch(r.text, /narrator|closing line|PICKED|lampo\.app on the end card/i, url);
  }
  // The questions' routes are the team's: signed out, nothing.
  assert.equal((await request('GET', `/api/asks/${folderAsk.id}`)).status, 401);
  assert.equal((await request('GET', '/api/asks')).status, 401);
});
