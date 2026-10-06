// The safe-zone presets (overlays.tsx draws them; test/unit/phone-layout.test.ts checks them against the apps'
// interfaces as the phone view draws them, phone/layout.ts). Their numbers live in lib/zones.ts, shared with Auto-check,
// with the coordinate systems they are in. A vertical preset that is an app (`app`) is also what the phone view shows
// around the picture: one choice, one pref.
import { ZONE_SHAPES } from '../../../lib/zones.ts';
import { perLang, t } from '../i18n/index.ts';
import type { AppId } from './phone/devices.ts';

export type Orient = 'any' | 'vertical' | 'landscape';
export interface Preset {
  id: string;
  label: string;
  orient: Orient;
  /** The app whose interface the phone view draws for this preset. */
  app?: AppId;
  /** The app's name in the phone view's menu. */
  name?: string;
}
export interface Zone {
  type: 'unsafe' | 'guide';
  x: number;
  y: number;
  w: number;
  h: number;
  label?: string;
  labelAt?: 'bottom';
}

export const PRESETS = perLang((): Preset[] => [
  { id: 'none', label: t('No overlay'), orient: 'any' },
  { id: 'thirds', label: t('Rule of thirds'), orient: 'any' },
  { id: 'ig-reels', label: t('Instagram Reels'), orient: 'vertical', app: 'reels', name: t('Instagram Reels') },
  { id: 'tiktok', label: t('TikTok'), orient: 'vertical', app: 'tiktok', name: t('TikTok') },
  { id: 'yt-shorts', label: t('YouTube Shorts'), orient: 'vertical', app: 'shorts', name: t('YouTube Shorts') },
  { id: 'stories', label: t('Stories (IG / FB)'), orient: 'vertical', app: 'stories', name: t('Stories (IG / FB)') },
  { id: 'broadcast', label: t('Title / action safe'), orient: 'landscape' },
  { id: 'center-cut', label: t('4:3 centre cut'), orient: 'landscape' },
]);

// The zones' numbers are lib/zones.ts's, the same Auto-check flags text under (lib/qa.ts); here they get their words.
const words = (): Record<string, string> => ({
  crop: t('crop'),
  'top bar': t('top bar'),
  icons: t('icons'),
  caption: t('caption'),
  tabs: t('tabs'),
  'caption · music': t('caption · music'),
  'title · channel': t('title · channel'),
  'profile · progress (14%)': t('profile · progress (14%)'),
  'reply bar': t('reply bar'),
  'action safe 93%': t('action safe 93%'),
  'title safe 90%': t('title safe 90%'),
});

export const ZONES = perLang((): Record<string, Zone[]> => {
  const said = words();
  return Object.fromEntries(
    Object.entries(ZONE_SHAPES).map(([id, shapes]) => [
      id,
      shapes.map(({ check: _check, label, ...zone }): Zone => (label ? { ...zone, label: said[label] ?? label } : zone)),
    ]),
  );
});

export const orientOf = (w: number, h: number) => (h > w * 1.05 ? 'vertical' : w > h * 1.05 ? 'landscape' : 'square');
export const presetsFor = (w: number, h: number) => {
  const o = orientOf(w, h);
  return PRESETS().filter((p) => p.orient === 'any' || p.orient === o || (o === 'square' && p.orient === 'vertical'));
};
export const presetById = (id: unknown) => PRESETS().find((p) => p.id === id) || PRESETS()[0];

// Canvas the preset is drawn in, as [w, h]; null = the video's own box.
export function presetCanvas(preset: Preset | null): [number, number] | null {
  if (!preset || preset.orient === 'any' || preset.id === 'none') return null;
  return preset.orient === 'vertical' ? [1080, 1920] : [1920, 1080];
}
