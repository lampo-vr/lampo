// The phones the player shows a video on, at their real size in points (dp on the Pixel), and where each app puts the
// picture on them. Only numbers: the drawings (status bar, Dynamic Island, the apps' interfaces) are a chunk of their
// own (PhoneArt.tsx) that loads when the phone view first opens, so this is all the player needs to lay the frame out —
// its box and the video in it are final before a single glyph has arrived.
//
// Sizes are the public ones: the screen in points (Apple's "Human Interface Guidelines → Layout" device table, Google's
// Pixel 8 spec: 1080 × 2400 px at 420 dpi = 412 × 915 dp), the safe areas iOS reports (59/62 pt under the Dynamic
// Island, 20 pt on the SE, 34 pt above the home indicator), the island 126 × 37 pt, display corners 55 pt (iPhone 15/16)
// and 62 pt (16 Pro / Pro Max). Bezels follow the bodies' millimetres at the screens' points per millimetre.
import { t } from '../../i18n/index.ts';

export type DeviceKind = 'island' | 'home' | 'android';

export interface Device {
  id: string;
  label: string;
  kind: DeviceKind;
  /** The screen, in points. */
  w: number;
  h: number;
  /** The screen's corner radius. */
  radius: number;
  /** The body around the screen. */
  bezel: { top: number; side: number; bottom: number };
  /** The body's outer corner radius. */
  bodyRadius: number;
  /** Where an app's own bars begin: under the status bar (the safe area's top). */
  safeTop: number;
  /** Kept free at the bottom for the home indicator or the gesture bar. */
  safeBottom: number;
  /** The front camera in the screen: the Dynamic Island, or the Pixel's punch hole (w = h). */
  camera?: { w: number; h: number; top: number };
}

// The labels are getters: words in the language on screen, also after a switch (i18n/index.ts).
export const DEVICES: Device[] = [
  {
    id: 'iphone',
    get label() {
      return t('iPhone 15 / 16');
    },
    kind: 'island',
    w: 393,
    h: 852,
    radius: 55,
    bezel: { top: 13, side: 13, bottom: 13 },
    bodyRadius: 68,
    safeTop: 59,
    safeBottom: 34,
    camera: { w: 126, h: 37, top: 11 },
  },
  {
    id: 'iphone-pro',
    get label() {
      return t('iPhone 16 Pro');
    },
    kind: 'island',
    w: 402,
    h: 874,
    radius: 62,
    bezel: { top: 11, side: 11, bottom: 11 },
    bodyRadius: 73,
    safeTop: 62,
    safeBottom: 34,
    camera: { w: 126, h: 37, top: 14 },
  },
  {
    id: 'iphone-max',
    get label() {
      return t('iPhone 16 Pro Max');
    },
    kind: 'island',
    w: 440,
    h: 956,
    radius: 62,
    bezel: { top: 11, side: 11, bottom: 11 },
    bodyRadius: 73,
    safeTop: 62,
    safeBottom: 34,
    camera: { w: 126, h: 37, top: 14 },
  },
  {
    // 67.3 × 138.4 mm around a 4.7" 16:9 screen (58.5 mm wide: 6.4 pt/mm): a chin above and below, the home button
    id: 'iphone-se',
    get label() {
      return t('iPhone SE');
    },
    kind: 'home',
    w: 375,
    h: 667,
    radius: 0,
    bezel: { top: 104, side: 26, bottom: 108 },
    bodyRadius: 60,
    safeTop: 20,
    safeBottom: 0,
  },
  {
    id: 'pixel',
    get label() {
      return t('Pixel 8');
    },
    kind: 'android',
    w: 412,
    h: 915,
    radius: 44,
    bezel: { top: 14, side: 14, bottom: 14 },
    bodyRadius: 58,
    safeTop: 44,
    safeBottom: 24,
    camera: { w: 24, h: 24, top: 12 },
  },
];

export const deviceById = (id: unknown): Device => DEVICES.find((d) => d.id === id) || DEVICES[0];

/** The apps the phone view can show around the picture: each one is a safe-zone preset (overlays.tsx `app`). */
export type AppId = 'reels' | 'tiktok' | 'shorts' | 'stories';

export interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** The body, and the screen inside it, as the phone lies (a landscape video turns it a quarter to the left). */
export function bodyOf(d: Device, landscape: boolean): { w: number; h: number; r: number; screen: Box & { r: number } } {
  const { top, side, bottom } = d.bezel;
  if (!landscape) return { w: d.w + side * 2, h: d.h + top + bottom, r: d.bodyRadius, screen: { x: side, y: top, w: d.w, h: d.h, r: d.radius } };
  // turned anticlockwise: the top of the phone (camera, earpiece) on the left, the SE's home button on the right
  return { w: d.h + top + bottom, h: d.w + side * 2, r: d.bodyRadius, screen: { x: top, y: side, w: d.h, h: d.w, r: d.radius } };
}

/** An app's tab bar: 49 pt on iOS, 56 dp on Android, above the home indicator / gesture bar. */
export const tabBarOf = (d: Device) => (d.kind === 'android' ? 56 : 49) + d.safeBottom;
/** Stories: the reply field under the card, and the room it needs there (8 above, 44 tall, 8 below). */
export const REPLY_H = 44;
const REPLY_ROOM = REPLY_H + 16;

/**
 * Where the picture goes on the screen (portrait): an app with a tab bar shows it above the bar (Reels, TikTok and
 * Shorts all draw it opaque now), Stories on a card under the status bar with the reply field below it where the screen
 * is tall enough (on the SE the card is the screen and the field lies over it), and Full height on the whole screen.
 * The 9:16 frame fills that area (cover): what's taller than 9:16 crops the sides, as the apps do.
 */
export function videoArea(app: AppId | null, d: Device): Box & { r: number } {
  if (app === 'reels' || app === 'tiktok' || app === 'shorts') return { x: 0, y: 0, w: d.w, h: d.h - tabBarOf(d), r: 0 };
  if (app === 'stories') {
    const h = (d.w * 16) / 9;
    if (d.safeTop + h + REPLY_ROOM + d.safeBottom <= d.h) return { x: 0, y: d.safeTop, w: d.w, h, r: 10 };
  }
  return { x: 0, y: 0, w: d.w, h: d.h, r: 0 };
}

/** A box of `aspect` (w / h) that covers w × h, centred: the overflow is cropped. */
export function cover(aspect: number, w: number, h: number): Box {
  const c = w / h > aspect ? { w, h: w / aspect } : { w: h * aspect, h };
  return { x: (w - c.w) / 2, y: (h - c.h) / 2, w: c.w, h: c.h };
}
