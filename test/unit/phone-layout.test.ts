// The phone view's geometry and the safe-zone presets agree: on every phone, each app's interface as the phone view
// draws it (web/src/player/phone/layout.ts) lies inside the zones its preset marks (web/src/player/zones.ts), once both
// are in the same 1080 × 1920 frame — the frame the app fills above its tab bar (cropped at the sides) or on Stories'
// card. A preset that leaves a button or a caption line outside every zone fails here with the app, phone and point.
import assert from 'node:assert/strict';
import test from 'node:test';
import { type AppId, bodyOf, cover, DEVICES, type Device, tabBarOf, videoArea } from '../../web/src/player/phone/devices.ts';
import { appLayout } from '../../web/src/player/phone/layout.ts';
import { PRESETS, presetsFor, ZONES } from '../../web/src/player/zones.ts';

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

const APPS = PRESETS().filter((p) => p.app);
/** The 19.5:9 phones the presets are for; the SE (16:9) crops the frame's top and bottom instead (checked below). */
const TALL = DEVICES.filter((d) => d.kind !== 'home');

/** Screen points → the preset's 1080 × 1920 frame, as Stage.tsx lays the frame over the app's area. */
function frameOf(app: AppId, d: Device) {
  const area = videoArea(app, d);
  const c = cover(9 / 16, area.w, area.h);
  const k = 1080 / c.w;
  return (b: Box): Box => ({ x: (b.x - area.x - c.x) * k, y: (b.y - area.y - c.y) * k, w: b.w * k, h: b.h * k });
}

/** Points of `b` (every 4 px of the frame, edges included) that no zone covers. */
function uncovered(b: Box, zones: Box[]): [number, number][] {
  const out: [number, number][] = [];
  const steps = (from: number, len: number) => {
    const n = Math.max(1, Math.ceil(len / 4));
    return Array.from({ length: n + 1 }, (_, i) => from + (len * i) / n);
  };
  for (const x of steps(b.x, b.w))
    for (const y of steps(b.y, b.h)) if (!zones.some((z) => x >= z.x - 0.5 && x <= z.x + z.w + 0.5 && y >= z.y - 0.5 && y <= z.y + z.h + 0.5)) out.push([x, y]);
  return out;
}

test('every app preset names its app for the phone view, and vertical and square videos list all four', () => {
  assert.deepEqual(
    APPS.map((p) => p.app),
    ['reels', 'tiktok', 'shorts', 'stories'],
  );
  for (const p of APPS) assert.ok(p.name && p.orient === 'vertical', p.id);
  for (const [w, h] of [
    [1080, 1920],
    [1080, 1350],
    [1080, 1080],
  ])
    assert.deepEqual(
      presetsFor(w, h)
        .filter((p) => p.app)
        .map((p) => p.id),
      APPS.map((p) => p.id),
      `${w}×${h}`,
    );
  assert.equal(presetsFor(1920, 1080).filter((p) => p.app).length, 0, 'a landscape video has no app around it');
});

test('the phones: bodies around their screens, turned for a landscape video, the picture where each app puts it', () => {
  for (const d of DEVICES) {
    const up = bodyOf(d, false);
    const turned = bodyOf(d, true);
    assert.deepEqual([turned.w, turned.h], [up.h, up.w], d.id);
    assert.ok(
      up.screen.x > 0 && up.screen.y > 0 && up.screen.x + up.screen.w < up.w && up.screen.y + up.screen.h < up.h,
      `${d.id}: the screen sits inside the body`,
    );
    // Full height: the whole screen, top to bottom
    assert.deepEqual(videoArea(null, d), { x: 0, y: 0, w: d.w, h: d.h, r: 0 }, d.id);
    // Reels, TikTok and Shorts: above the tab bar (49 pt on iOS, 56 dp on Android, then the home indicator's room)
    for (const app of ['reels', 'tiktok', 'shorts'] as const) assert.equal(videoArea(app, d).h, d.h - tabBarOf(d), `${d.id} ${app}`);
    // Stories: a 9:16 card under the status bar with the reply field below it, or the whole screen on the SE
    const card = videoArea('stories', d);
    assert.ok(Math.abs(card.w / card.h - 9 / 16) < 0.01, `${d.id}: the card is 9:16`);
    if (d.kind === 'home') assert.equal(card.y, 0);
    else assert.equal(card.y, d.safeTop);
  }
  assert.equal(tabBarOf(DEVICES[0]), 83, 'iPhone 15/16: a 49 pt tab bar over the 34 pt home indicator');
});

test('on the 19.5:9 phones, every app’s rail, caption and top bar lie inside its preset’s zones', () => {
  const misses: string[] = [];
  for (const preset of APPS) {
    const app = preset.app as AppId;
    const zones = ZONES()[preset.id];
    for (const d of TALL) {
      const L = appLayout(app, d);
      const toFrame = frameOf(app, d);
      // the top bar from the picture's top: where that is the screen's, the status bar over it covers the picture too
      const parts: [string, Box | null][] = [
        ['top', { ...L.top, y: L.area.y, h: L.top.y + L.top.h - L.area.y }],
        ['rail', L.rail],
        ['caption', L.caption],
        // Stories' reply field only counts where it lies over the card
        ['reply', L.reply && L.reply.y < L.area.y + L.area.h ? L.reply : null],
      ];
      for (const [part, b] of parts) {
        if (!b) continue;
        const miss = uncovered(toFrame(b), zones);
        if (miss.length)
          misses.push(`${preset.id} on ${d.id}: the ${part} reaches ${miss.length} points outside every zone, e.g. ${miss[0].map(Math.round).join(', ')}`);
      }
    }
  }
  assert.deepEqual(misses, []);
});

test('the SE: the interface stays on its screen, inside the picture and clear of the tab bar', () => {
  const se = DEVICES.find((d) => d.kind === 'home') as Device;
  for (const preset of APPS) {
    const L = appLayout(preset.app as AppId, se);
    for (const b of [L.top, L.rail, L.caption, L.reply].filter(Boolean) as Box[]) {
      assert.ok(b.x >= 0 && b.y >= 0 && b.x + b.w <= se.w && b.y + b.h <= se.h, `${preset.id}: ${JSON.stringify(b)} on the screen`);
      if (L.tabs) assert.ok(b.y + b.h <= L.tabs.y, `${preset.id}: above the tab bar`);
    }
  }
});

test('the rail and the caption never overlap, and both clear the top bar', () => {
  for (const preset of APPS.filter((p) => p.app !== 'stories'))
    for (const d of DEVICES) {
      const L = appLayout(preset.app as AppId, d);
      const rail = L.rail as Box;
      const cap = L.caption as Box;
      assert.ok(cap.x + cap.w <= rail.x, `${preset.id} on ${d.id}: the caption stops before the rail`);
      assert.ok(rail.y > L.top.y + L.top.h, `${preset.id} on ${d.id}: the rail starts under the top bar`);
      const last = L.railItems[L.railItems.length - 1];
      assert.equal(last.y + last.h, rail.y + rail.h, 'the items fill the rail');
    }
});
