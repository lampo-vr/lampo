// UI preferences: view settings stay per browser (localStorage); filters a screen names as per-tab live in
// sessionStorage, so a filter typed once doesn't greet every later visit with "Nothing matches".
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { type KeyValueStore, loadPrefs, type PrefStores, savePref } from '../../web/src/lib/prefStore.ts';

const memory = (): KeyValueStore & { dump: (k: string) => unknown } => {
  const m = new Map<string, string>();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => void m.set(k, v), dump: (k) => JSON.parse(m.get(k) ?? 'null') };
};
const fresh = () => ({ kept: memory(), tab: memory() });
const PER_TAB = ['q', 'lane'];

test('per-tab keys go to the tab, the rest stay per browser', () => {
  const s = fresh();
  savePref(s, 'vr.library', 'layout', 'list', PER_TAB);
  assert.deepEqual(savePref(s, 'vr.library', 'q', 'logo', PER_TAB), { layout: 'list', q: 'logo' });
  assert.deepEqual(s.kept.dump('vr.library'), { layout: 'list' });
  assert.deepEqual(s.tab.dump('vr.library'), { q: 'logo' });
});

test('a new tab starts unfiltered, with the view settings kept', () => {
  const s = fresh();
  savePref(s, 'vr.library', 'layout', 'board', PER_TAB);
  savePref(s, 'vr.library', 'q', 'zzzz', PER_TAB);
  const otherTab: PrefStores = { kept: s.kept, tab: memory() };
  assert.deepEqual(loadPrefs(otherTab, 'vr.library', PER_TAB), { layout: 'board' });
});

test('a filter an older version kept per browser is ignored', () => {
  const s = fresh();
  s.kept.setItem('vr.library', JSON.stringify({ layout: 'grid', q: 'stale', lane: 'final' }));
  assert.deepEqual(loadPrefs(s, 'vr.library', PER_TAB), { layout: 'grid' });
});

test('without per-tab keys everything stays per browser', () => {
  const s = fresh();
  assert.deepEqual(savePref(s, 'vr.player', 'compare', 'wipe'), { compare: 'wipe' });
  assert.deepEqual(s.kept.dump('vr.player'), { compare: 'wipe' });
});
