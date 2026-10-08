// The safe zones and the phone view are two choices (web/src/player/playerPrefs.ts): prefs kept while they were one —
// the phone's app was the vertical safe-zone preset, `zones` drew its zones over the app — become the two once, and
// each person keeps what they saw.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type KeyValueStore, loadPrefs, savePref } from '../../web/src/lib/prefStore.ts';
import { upgradePlayerPrefs } from '../../web/src/player/playerPrefs.ts';

const after = (kept: Record<string, string | boolean>) => {
  const patch = upgradePlayerPrefs(kept);
  assert.ok(patch, 'prefs from before the split are upgraded');
  return JSON.parse(JSON.stringify({ ...kept, ...patch }));
};

test('the phone view on with an app and its zones hidden: the phone keeps the app, the zones go off', () => {
  assert.deepEqual(after({ phone: true, device: 'pixel', 'preset.vertical': 'tiktok', 'preset.landscape': 'broadcast' }), {
    phone: true,
    device: 'pixel',
    phoneApp: 'tiktok',
    'preset.vertical': 'none',
    'preset.landscape': 'broadcast',
  });
  // `zones` turned off on purpose reads the same, and leaves with the upgrade
  assert.deepEqual(after({ phone: true, 'preset.vertical': 'ig-reels', zones: false }), { phone: true, phoneApp: 'ig-reels', 'preset.vertical': 'none' });
});

test('the phone view on with an app and its zones shown: the phone keeps the app, the zones stay that app’s', () => {
  assert.deepEqual(after({ phone: true, device: 'iphone-pro', 'preset.vertical': 'tiktok', zones: true }), {
    phone: true,
    device: 'iphone-pro',
    phoneApp: 'tiktok',
    'preset.vertical': 'tiktok',
  });
});

test('the phone view off: nothing changes (the zones stay, the phone shows the full height when it comes back)', () => {
  assert.deepEqual(after({ phone: false, 'preset.vertical': 'stories', 'preset.landscape': 'center-cut', zones: false }), {
    phone: false,
    phoneApp: 'full',
    'preset.vertical': 'stories',
    'preset.landscape': 'center-cut',
  });
  assert.deepEqual(after({ 'preset.vertical': 'yt-shorts' }), { phoneApp: 'full', 'preset.vertical': 'yt-shorts' });
  assert.deepEqual(after({}), { phoneApp: 'full' });
});

test('the phone view on at full height: the rule of thirds stays, the phone shows the full height', () => {
  assert.deepEqual(after({ phone: true, 'preset.vertical': 'thirds' }), { phone: true, phoneApp: 'full', 'preset.vertical': 'thirds' });
  assert.deepEqual(after({ phone: true }), { phone: true, phoneApp: 'full' });
});

test('square videos: their app counts where no vertical one was picked, and their zones go off with it', () => {
  assert.deepEqual(after({ phone: true, 'preset.square': 'tiktok' }), { phone: true, phoneApp: 'tiktok', 'preset.square': 'none' });
  // a vertical choice decides the phone's app; a square app without its zones loses them too (none were shown)
  assert.deepEqual(after({ phone: true, 'preset.vertical': 'ig-reels', 'preset.square': 'stories' }), {
    phone: true,
    phoneApp: 'ig-reels',
    'preset.vertical': 'none',
    'preset.square': 'none',
  });
});

test('upgraded once: prefs with a phoneApp are left alone, whatever else they hold', () => {
  assert.equal(upgradePlayerPrefs({ phone: true, phoneApp: 'full', 'preset.vertical': 'tiktok' }), null);
  assert.equal(upgradePlayerPrefs({ phone: true, phoneApp: 'stories', 'preset.vertical': 'none' }), null);
});

test('the old keys still load from the browser’s storage, and the upgrade written there sticks', () => {
  const m = new Map<string, string>();
  const kept: KeyValueStore = { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v) };
  const stores = { kept, tab: { getItem: () => null, setItem: () => {} } };
  m.set('vr.player', JSON.stringify({ phone: true, device: 'pixel', 'preset.vertical': 'tiktok', zones: false, panel: 'x' }));
  const old = loadPrefs(stores, 'vr.player');
  assert.equal(old['preset.vertical'], 'tiktok');
  const patch = upgradePlayerPrefs(old);
  for (const [k, v] of Object.entries(patch ?? {})) savePref(stores, 'vr.player', k, v);
  const now = loadPrefs(stores, 'vr.player');
  assert.deepEqual(now, { phone: true, device: 'pixel', 'preset.vertical': 'none', panel: 'x', phoneApp: 'tiktok' });
  assert.equal(upgradePlayerPrefs(now), null, 'nothing left to upgrade');
});
