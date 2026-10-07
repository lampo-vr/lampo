// A project's material, the shape a real one has, put into a suite's server through the project files API (one-time
// upload URLs, one PUT each): a campaign folder with camera footage by day, music, an After Effects and a Cinema 4D
// project, Photoshop files, fonts, LUTs and a brief; an agent's music bed and its second version of the project file;
// the project's brand files and the House's fonts above it (inherited); a file in the trash. The bytes are small and
// made here (pictures, a clip, a PDF and a text file real enough for the browser to show); `SHOWN` is the size each
// would have in a real project, for suites that look at the page with real-shaped numbers (files.mjs scales the
// answers with it).

import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { FFMPEG, makeVideo } from '../../lib/helpers.ts';

export const PROJECT = 'Acme';
export const CAMPAIGN = 'Acme/Spring sale';

const GB = 1e9;
const MB = 1e6;
const KB = 1e3;

/** What each file would weigh in a real project (by its area and path). */
export const SHOWN = {
  [CAMPAIGN]: {
    'Footage/Day 1/A001C003.mov': 4.2 * GB,
    'Footage/Day 1/A001C004.mov': 2.9 * GB,
    'Footage/Day 1/A001C005.mov': 3.1 * GB,
    'Footage/Day 1/A002C001.mov': 5.6 * GB,
    'Footage/Day 2/B001C001.mov': 6.3 * GB,
    'Footage/Day 2/B001C002.mov': 1.8 * GB,
    'Footage/Day 2/B001C007_drone.mp4': 912 * MB,
    'Music/bed_warm.wav': 48.2 * MB,
    'Music/stinger_sting.wav': 6.1 * MB,
    'Project/spot.aep': 184 * MB,
    'Project/endcard.c4d': 62 * MB,
    'Project/Spring sale key visual.psd': 412 * MB,
    'Graphics/Logo lockup.svg': 18 * KB,
    'Graphics/Spring_Teal.cube': 1.1 * MB,
    'Graphics/still_hero.png': 7.4 * MB,
    'Brief/Brief v3.pdf': 2.3 * MB,
    'Brief/voiceover script.txt': 4 * KB,
    'subtitles_de.srt': 3 * KB,
  },
  [PROJECT]: {
    'Brand/Acme Sans Bold.otf': 182 * KB,
    'Brand/Acme Sans Regular.otf': 176 * KB,
    'Brand/Logo primary.ai': 3.4 * MB,
    'Brand/Brand guide 2026.pdf': 21 * MB,
  },
  '': {
    'Fonts/Inter Display.ttf': 840 * KB,
    'Fonts/JetBrains Mono.ttf': 270 * KB,
    'LUTs/Studio Rec709.cube': 1.1 * MB,
  },
};

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');

/** Bytes for a path: a real picture, clip, PDF or text where the browser shows one, else a few made-up kilobytes. */
function bytesFor(dir, p, i) {
  const ext = p.split('.').pop().toLowerCase();
  if (ext === 'png') {
    const out = path.join(dir, `still-${i}.png`);
    execFileSync(FFMPEG, ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=640x360', '-frames:v', '1', out]);
    return fs.readFileSync(out);
  }
  if (ext === 'mp4' || ext === 'mov')
    return fs.readFileSync(
      makeVideo(path.join(dir, `clip-${i}.mp4`), { w: 320, h: 180, fps: 25, dur: 2, pattern: i % 2 ? 'smptebars' : 'testsrc2', freq: 300 + i * 40 }),
    );
  if (ext === 'pdf') return Buffer.from(PDF);
  if (ext === 'txt' || ext === 'srt')
    return Buffer.from(
      ext === 'srt'
        ? '1\n00:00:01,000 --> 00:00:03,000\nFrühling bei Acme\n\n2\n00:00:03,500 --> 00:00:06,000\nJetzt im Laden\n'
        : 'VO, 30 s cut\n\n[0:00] Spring is here.\n[0:04] New colours, the same Acme.\n[0:09] Out now, in every store.\n',
    );
  // binary, as a project file, a font or a camera original is (never read as text)
  const block = crypto.createHash('sha512').update(`${p}#${i}`).digest();
  return Buffer.concat(Array.from({ length: 40 + i }, (_, k) => Buffer.from(block.map((b) => (b + k) & 0xff)))).subarray(0, 2048 + i * 97);
}

// A one-page PDF a browser can show.
const PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 595 842]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 28 Tf 72 760 Td (Spring sale - brief v3) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF
`;

/** Puts `files` ({path: bytes}) into `area` through the API, as `who` (agent fields: an agent writing with the account). */
export async function push(base, area, files, { agent, agent_kind, base: bases = {} } = {}) {
  const items = Object.entries(files).map(([p, b]) => ({ path: p, size: b.length, sha256: sha(b), base: bases[p] ?? null }));
  const r = await fetch(`${base}/api/files/uploads`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ folder: area, files: items, ...(agent ? { agent, agent_kind, via: 'mcp' } : {}) }),
  });
  const answer = await r.json();
  if (!r.ok) throw Object.assign(new Error(`uploads: ${r.status} ${answer.error}`), { status: r.status, body: answer });
  const stored = [];
  for (const slot of answer.uploads) {
    const b = files[slot.path];
    if (slot.stored) {
      stored.push({ path: slot.path, sha256: sha(b), size: b.length, base: bases[slot.path] ?? null });
      continue;
    }
    const put = await fetch(slot.url, { method: 'PUT', body: b, headers: { 'Content-Length': String(b.length) } });
    if (!put.ok) throw new Error(`PUT ${slot.path}: ${put.status} ${await put.text()}`);
  }
  if (stored.length) {
    const c = await fetch(`${base}/api/files/commit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ folder: area, add: stored, ...(agent ? { agent, agent_kind, via: 'mcp' } : {}) }),
    });
    if (!c.ok) throw new Error(`commit: ${c.status} ${await c.text()}`);
  }
}

/** The whole project, into the server at `base` (its folders made first). Returns the ids of a few files by path. */
export async function seedProject(base, dir) {
  const api = async (p, method = 'GET', body) => {
    const r = await fetch(base + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${text}`);
    return text ? JSON.parse(text) : null;
  };
  await api('/api/folders', 'POST', { path: PROJECT }).catch(() => {});
  await api('/api/folders', 'POST', { path: CAMPAIGN }).catch(() => {});
  let i = 0;
  const made = (names) => Object.fromEntries(names.map((p) => [p, bytesFor(dir, p, i++)]));
  const own = Object.keys(SHOWN[CAMPAIGN]).filter((p) => !p.startsWith('Music/') && p !== 'Project/spot.aep');
  await push(base, '', made(Object.keys(SHOWN[''])));
  await push(base, PROJECT, made(Object.keys(SHOWN[PROJECT])));
  await push(base, CAMPAIGN, made(own));
  await push(base, CAMPAIGN, made(['Project/spot.aep']));
  // an agent's music bed and its next version of the project file (V2)
  await push(base, CAMPAIGN, made(['Music/bed_warm.wav', 'Music/stinger_sting.wav']), { agent: 'promo-edit', agent_kind: 'claude-code' });
  await push(
    base,
    CAMPAIGN,
    { 'Project/spot.aep': Buffer.from(`spot v2 by the agent ${'x'.repeat(4096)}`) },
    { agent: 'promo-edit', agent_kind: 'claude-code', base: { 'Project/spot.aep': 1 } },
  );
  // a folder made on purpose, still empty
  await api('/api/files/dirs', 'POST', { folder: CAMPAIGN, path: 'Renders for review' });
  // a file in the trash
  await push(base, CAMPAIGN, { 'Footage/Day 1/A001C003_old.mov': Buffer.from(`old take ${'y'.repeat(3000)}`) });
  const listing = await api(`/api/files?folder=${encodeURIComponent(CAMPAIGN)}&own=1&deep=1&limit=1000`);
  const ids = Object.fromEntries(listing.files.map((f) => [f.path, f.id]));
  await api(`/api/files/${ids['Footage/Day 1/A001C003_old.mov']}`, 'DELETE');
  return ids;
}
