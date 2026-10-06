// Review links through the machine's Cloudflare tunnel ("Make links public"): cloudflared connects from loopback with
// the tunnel's host name and Cloudflare's headers. Clients can do there what they do anywhere else on a link.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { age, FFMPEG, isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const store = await import('../../lib/store.ts');
const shares = await import('../../lib/shares.ts');

const file = makeVideo(path.join(dir, 'proj/export/spot.mp4'), { w: 160, h: 90, dur: 1 });
age(file);
store.createOrGetReview(file, { by: 'tester' });
const slug = path.resolve(file).split('/').join('__');
const png = path.join(dir, 'ref.png');
execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=400x300', '-frames:v', '1', '-y', png]);

const TUNNEL = 'quiet-fox-lamp.trycloudflare.com';
/** What cloudflared sends along for a visitor at `ip`. */
const via = (ip: string) => ({ Host: TUNNEL, Origin: `https://${TUNNEL}`, 'cf-ray': '8c1f2e3d4b5a6978-FRA', 'cf-connecting-ip': ip, 'x-forwarded-for': ip });

const { request } = await startApp({ token: 'test-token', loadSessions: async () => [] });

test('a client attaches a file to their note through the tunnel', async () => {
  const link = shares.createShare(slug, { label: 'Client' });
  const g = (p: string) => `/api/g/${link.token}${p}`;
  const id = (await request('GET', g(''), { headers: via('198.51.100.23') })).json().videos[0].slug;
  const made = await request('POST', g('/comments'), { body: { name: 'Mia', slug: id, frame: 3, text: 'So wie hier?' }, headers: via('198.51.100.23') });
  assert.equal(made.status, 200, made.text);
  const ticket = await request('POST', g(`/comments/${made.json().id}/refs`), { body: { name: 'Mia', kind: 'image' }, headers: via('198.51.100.23') });
  assert.equal(ticket.status, 200, ticket.text);
  const url: string = ticket.json().upload.url;
  assert.ok(!url.startsWith('http://'), `a URL that works on the host the client came in on, not ${url}`);
  const bytes = fs.readFileSync(png);
  const sent = await request('PUT', new URL(url, `https://${TUNNEL}`).pathname, {
    body: bytes,
    headers: { ...via('198.51.100.23'), 'content-length': String(bytes.length) },
  });
  assert.equal(sent.status, 200, sent.text);
  assert.equal(sent.json().ref.kind, 'image');
  // Nothing else answers on the tunnel's host: the upload URL is its own credential, not a way in.
  assert.equal((await request('GET', '/api/library', { headers: via('198.51.100.23') })).status, 421);
});

test('through the tunnel every client has an address of their own: one guessing passwords stops only them', async () => {
  const link = shares.createShare(slug, { label: 'Locked', password: 'rushes-2026' });
  const guess = (headers: Record<string, string>) => request('POST', `/api/g/${link.token}/unlock`, { body: { password: 'wrong' }, headers });
  const codes: number[] = [];
  for (let i = 0; i < 6; i++) codes.push((await guess(via('198.51.100.40'))).status);
  assert.deepEqual(codes, [403, 403, 403, 403, 403, 429], 'five wrong guesses, then a pause for that visitor');
  assert.equal((await guess(via('203.0.113.77'))).status, 403, 'another client through the same tunnel is not stopped');
  assert.equal((await guess(via('2001:db8::7'))).status, 403, 'IPv6 visitors too');
  // Cloudflare's header counts only on requests cloudflared forwarded (cf-ray); anything else is the loopback it came from.
  const plain = { Host: TUNNEL, Origin: `https://${TUNNEL}` };
  for (let i = 0; i < 5; i++) await guess({ ...plain, 'cf-connecting-ip': `192.0.2.${i + 1}` });
  assert.equal((await guess({ ...plain, 'cf-connecting-ip': '192.0.2.99' })).status, 429, 'without cf-ray the header is ignored');
  assert.equal((await guess({ ...via('203.0.113.78'), 'cf-connecting-ip': 'not-an-address' })).status, 429, 'nor one that is no address');
});

test('the tunnel’s visitor address counts only on the machine, from loopback', async () => {
  const { ipOf } = await import('../../server/routes/shares/access.ts');
  const req = (tunnel: boolean, remote = '127.0.0.1') =>
    ({
      app: { locals: { tunnel } },
      ip: remote,
      socket: { remoteAddress: remote },
      headers: { 'cf-ray': '8c1f-FRA', 'cf-connecting-ip': '198.51.100.23' },
    }) as never;
  assert.equal(ipOf(req(true)), '198.51.100.23');
  assert.equal(ipOf(req(false)), '127.0.0.1', 'a hosted server has no tunnel: its trust-proxy setting decides (req.ip)');
  assert.equal(ipOf(req(true, '192.168.1.20')), '192.168.1.20', 'a device on the network sending the header is itself');
});
