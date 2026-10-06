// covers: server/routes/shares/guest.ts lib/store.ts
// Approve / Request changes through a review link had one bound: 20 a minute per link. One visitor gave 4,800 in four
// hours (each an event, a webhook and a push), review.json grew from 1.2 KB to 3.4 MB, and the real client got 429 in
// every minute the flood used up (A13 LINK-1). Now a visitor (link + address) has 20 a minute and 50 a day, they count
// in the day's writes of the visitor and the link like notes, and a link keeps at most 20 of its verdicts per version.
import assert from 'node:assert/strict';
import path from 'node:path';
import { mock, test } from 'node:test';
import { age, isolatedEnv, makeVideo, slugOf } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
// the limits read the clock they were made with: Date is a stand-in from before the app starts
mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-10-06T09:00:00Z') });
const { startApp } = await import('../lib/app.ts');
const store = await import('../../lib/store.ts');
const folders = await import('../../lib/folders.ts');

const file = makeVideo(path.join(dir, 'home/C/verdicts.mp4'), { w: 160, h: 90, dur: 1 });
age(file);
store.createOrGetReview(file, { by: 'tester' });
const slug = slugOf(file);
folders.moveVideo(slug, 'Verdicts', 'tester');
const { request } = await startApp({ token: 'test-token', loadSessions: async () => [] });

const made = await request('POST', '/api/folder-shares', { body: { folder: 'Verdicts', label: 'Spring' } });
assert.equal(made.status, 200, made.text);
const token = made.json().token as string;
// a visitor through the machine's tunnel: Cloudflare names the address, so visitors are told apart (ipOf)
const from = (ip: string) => ({ headers: { 'cf-ray': '8f00000000000000-AMS', 'cf-connecting-ip': ip } });
const id = (await request('GET', `/api/g/${token}`, from('203.0.113.7'))).json().videos[0].slug as string;
const v = (await request('GET', `/api/g/${token}/review/${id}`, from('203.0.113.7'))).json().v as number;
let n = 0;
const verdict = (ip: string) =>
  request('POST', `/api/g/${token}/approval`, {
    body: { name: `Visitor ${n}`, slug: id, v, status: n++ % 2 ? 'approved' : 'changes', note: 'n'.repeat(500) },
    ...from(ip),
  });
const linkVerdicts = () => (store.loadReview(slug)?.approvals ?? []).filter((e) => e.party === 'client' && e.v === v);

test('a visitor has 20 a minute: the 21st waits, and another visitor of the link still may', async () => {
  for (let i = 0; i < 20; i++) assert.equal((await verdict('203.0.113.7')).status, 200);
  assert.equal((await verdict('203.0.113.7')).status, 429);
  const client = await verdict('198.51.100.20');
  assert.equal(client.status, 200, `the client, from elsewhere, in the same minute: ${client.text}`);
});

test('a visitor has 50 a day; a link keeps at most 20 of its verdicts per version', async () => {
  let given = 20;
  let refused: { status: number; text: string } | null = null;
  for (let minute = 0; minute < 10 && !refused; minute++) {
    mock.timers.tick(61_000);
    for (let i = 0; i < 20; i++) {
      const r = await verdict('203.0.113.7');
      if (r.status !== 200) {
        refused = r;
        break;
      }
      given++;
    }
  }
  assert.equal(given, 50, 'the day ends at 50');
  assert.equal(refused?.status, 429);
  assert.match(refused?.text ?? '', /today/);
  assert.ok(linkVerdicts().length <= 20, `${linkVerdicts().length} of the link's verdicts on V${v} kept`);
  assert.equal(store.loadReview(slug)?.approval?.by, `guest:Visitor ${n - 2}`, 'the newest still stands');
  mock.timers.tick(24 * 3600_000);
  assert.equal((await verdict('203.0.113.7')).status, 200, 'a day later, again');
});
