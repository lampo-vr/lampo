// covers: web/src/files/model.ts web/src/files/sha256.ts web/src/files/where.ts
// The Files tab's thinking without a browser: the check before an upload (what is new, what replaces which version,
// what is left out and why, names that differ only in case), what the plan holds after it, the commands an agent gets,
// who made a version, the list's order, the address — and the browser's SHA-256, a piece at a time, against Node's.
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { test } from 'node:test';
import type { Existing } from '../../web/src/files/model.ts';
import {
  againAt,
  between,
  crumbsOf,
  mcpCall,
  planDrop,
  pullCommand,
  pushCommand,
  roomAfter,
  settlePlan,
  shellWord,
  size,
  sortFiles,
  trayGroup,
  typeLabel,
  whoOf,
} from '../../web/src/files/model.ts';
import { Sha256 } from '../../web/src/files/sha256.ts';
import { filesHref, readFilesAt } from '../../web/src/files/where.ts';

const f = (size: number, name = 'x') => ({ size, name });
const there = (entries: [string, number, string, number][]): Existing =>
  new Map(entries.map(([path, v, sha256, s]) => [path, { id: `fl_${path.length.toString(16).padStart(12, '0')}`, v, sha256, size: s, path }]));

test('the check: new files, new versions of what is there, case clashes and refused names, the top folders', () => {
  const existing = there([['Footage/Day 1/A001.mov', 2, 'aa', 100]]);
  const plan = planDrop(
    [
      { file: f(10), rel: 'Day 1/A001.mov' },
      { file: f(20), rel: 'Day 1/A002.mov' },
      { file: f(30), rel: 'Day 2/B001.mov' },
      { file: f(5), rel: 'Day 2/b001.MOV' },
      { file: f(1), rel: 'Day 2/ bad.mov' },
    ],
    'Footage',
    existing,
    ['.DS_Store'],
  );
  assert.deepEqual(
    plan.add.map((x) => [x.path, x.base]),
    [
      ['Footage/Day 1/A001.mov', 2],
      ['Footage/Day 1/A002.mov', null],
      ['Footage/Day 2/B001.mov', null],
    ],
  );
  assert.deepEqual(plan.clash, [{ path: 'Day 2/b001.MOV', with: 'Day 2/B001.mov' }]);
  assert.equal(plan.bad.length, 1);
  assert.match(plan.bad[0]?.why ?? '', /space/);
  assert.deepEqual(plan.junk, ['.DS_Store']);
  assert.deepEqual(plan.tops, ['Day 1', 'Day 2']);
  assert.equal(plan.bytes, 60);
});

test('a name that differs only in case from a file there is refused, the same path is a version', () => {
  const existing = there([['Brand/Logo.svg', 1, 'aa', 10]]);
  const plan = planDrop(
    [
      { file: f(3), rel: 'logo.svg' },
      { file: f(4), rel: 'Logo.svg' },
    ],
    'Brand',
    existing,
  );
  assert.deepEqual(
    plan.add.map((x) => x.path),
    ['Brand/Logo.svg'],
  );
  assert.equal(plan.clash.length, 1);
});

test('a Mac’s decomposed names go in as the server keeps them (NFC), so its answers find them', () => {
  const nfd = 'Fu\u0308ße.wav';
  const plan = planDrop([{ file: f(1), rel: nfd }], 'Musik', there([]));
  assert.equal(plan.add[0]?.path, 'Musik/Füße.wav'.normalize('NFC'));
  assert.notEqual(plan.add[0]?.path, `Musik/${nfd}`);
});

test('what the plan comes to once hashes are known: the same bytes need nothing, held bytes go without a byte sent', () => {
  const a = f(100, 'a');
  const b = f(200, 'b');
  const c = f(300, 'c');
  const plan = planDrop(
    [
      { file: a, rel: 'a.wav' },
      { file: b, rel: 'b.wav' },
      { file: c, rel: 'c.wav' },
    ],
    '',
    there([
      ['a.wav', 1, 'ha', 100],
      ['b.wav', 3, 'old', 150],
    ]),
  );
  const hashes = new Map([
    [a, 'ha'],
    [b, 'hb'],
    [c, 'hc'],
  ]);
  const s = settlePlan(plan, (x) => hashes.get(x), new Set(['hc']));
  assert.deepEqual({ same: s.same, known: s.known, send: s.send, freed: s.freed }, { same: 1, known: 1, send: 200, freed: 150 });
  // the replaced version is kept, not counted: room after = limit − used − sent + freed
  assert.equal(roomAfter(1000, 600, s.send, s.freed), 350);
  assert.equal(roomAfter(null, 600, s.send, s.freed), null);
});

test('what an agent gets: one pull with exactly these, the MCP call under it, the push for a big folder', () => {
  assert.equal(
    pullCommand('Acme/Spring sale', ['Footage/Day 1/A001C003.mov'], ['Music']),
    'lampo files pull "Acme/Spring sale" --to public/ --only "Music/**" --only "Footage/Day 1/A001C003.mov"',
  );
  assert.equal(pullCommand('', ['Fonts/Inter.ttf']), 'lampo files pull House --to public/ --only Fonts/Inter.ttf');
  assert.equal(mcpCall('Acme', 'Brand'), 'list_files({folder: "Acme", path: "Brand"})');
  assert.equal(pushCommand('Acme/Spring sale', 'Footage', './Shoot'), 'lampo files push ./Shoot --to "Acme/Spring sale" --path Footage/');
  assert.equal(shellWord('a "b" $c'), '"a \\"b\\" \\$c"');
});

test('who made a version: the agent with its kind, the CLI glyph for lampo, else the person', () => {
  assert.deepEqual(whoOf({ by: 'Mia', agent: 'promo-edit', agent_kind: 'codex' }), { name: 'promo-edit', agent: 'codex' });
  assert.deepEqual(whoOf({ by: 'Mia', agent: 'promo-edit', via: 'vr' }), { name: 'promo-edit', agent: 'cli' });
  assert.deepEqual(whoOf({ by: 'Mia', agent: 'Claude Code' }), { name: 'Claude Code', agent: 'claude-code' });
  assert.deepEqual(whoOf({ by: 'Mia' }), { name: 'Mia', agent: null });
  // an MCP client's own id reads as its kind's name; a name someone gave stays
  assert.deepEqual(whoOf({ by: 'Mia', agent: 'claude-code · Mia', agent_kind: 'claude-code' }), { name: 'Claude Code · Mia', agent: 'claude-code' });
});

test('when a file takes its next version again: a time today, tomorrow after midnight', () => {
  const noon = new Date(2026, 9, 8, 12, 0).getTime();
  assert.match(againAt(noon + 2 * 3600_000, noon), /^at \d/);
  assert.match(againAt(noon + 13 * 3600_000, noon), /^tomorrow at \d/);
});

test('sizes as people read them, a kind in words, the list’s order (numbers as numbers)', () => {
  assert.equal(size(0), '0 B');
  assert.equal(size(48_200_000), '48 MB');
  assert.equal(size(4_200_000_000), '4.2 GB');
  assert.equal(size(1_310_000_000_000), '1.31 TB');
  assert.equal(typeLabel('Project/spot.aep', 'project'), 'After Effects project');
  assert.equal(typeLabel('x.weird', 'other'), 'WEIRD · file');
  const rows = [
    { path: 'A001C10.mov', size: 1, at: '2026-10-01T10:00:00Z' },
    { path: 'A001C2.mov', size: 3, at: '2026-10-03T10:00:00Z' },
    { path: 'b.mov', size: 2, at: '2026-10-02T10:00:00Z' },
  ];
  assert.deepEqual(
    sortFiles(rows, 'name').map((r) => r.path),
    ['A001C2.mov', 'A001C10.mov', 'b.mov'],
  );
  assert.deepEqual(
    sortFiles(rows, 'size').map((r) => r.path),
    ['A001C2.mov', 'b.mov', 'A001C10.mov'],
  );
  assert.deepEqual(
    sortFiles(rows, 'changed').map((r) => r.path),
    ['A001C2.mov', 'b.mov', 'A001C10.mov'],
  );
  assert.deepEqual(between(['a', 'b', 'c', 'd'], 'c', 'a'), ['a', 'b', 'c']);
  assert.deepEqual(crumbsOf('Footage/Day 1'), [
    ['Footage', 'Footage'],
    ['Day 1', 'Footage/Day 1'],
  ]);
  assert.equal(trayGroup('Spring/Footage/Day 1/A.mov'), 'Spring/Footage');
  assert.equal(trayGroup('Music/a.wav'), 'Music');
  assert.equal(trayGroup('a.wav'), '');
});

test('the address: a folder inside the area, its trash, the file opened beside the list', () => {
  const h = filesHref('Acme/Spring sale', { path: 'Footage/Day 1', open: 'fl_0123456789ab' });
  assert.equal(h, '#/files/Acme%2FSpring%20sale?path=Footage%2FDay%201&open=fl_0123456789ab');
  assert.deepEqual(readFilesAt(h), { path: 'Footage/Day 1', trash: false, open: 'fl_0123456789ab' });
  assert.equal(filesHref('', { trash: true }), '#/settings/files?trash=1');
  assert.deepEqual(readFilesAt('#/files/Acme'), { path: '', trash: false, open: null });
});

test('the browser’s SHA-256 agrees with Node’s, however the bytes are cut', () => {
  const data = crypto.randomBytes(200_003);
  const want = crypto.createHash('sha256').update(data).digest('hex');
  for (const piece of [1, 63, 64, 65, 1000, 65_536, 200_003]) {
    const h = new Sha256();
    for (let i = 0; i < data.length; i += piece) h.update(data.subarray(i, i + piece));
    assert.equal(h.hex(), want, `pieces of ${piece}`);
  }
  assert.equal(new Sha256().hex(), crypto.createHash('sha256').update('').digest('hex'));
  for (const n of [55, 56, 57, 63, 64, 119, 120])
    assert.equal(new Sha256().update(Buffer.alloc(n, 7)).hex(), crypto.createHash('sha256').update(Buffer.alloc(n, 7)).digest('hex'), `${n} bytes`);
});
