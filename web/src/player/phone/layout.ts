// Where each app draws its interface on a phone, in the phone's points: the top bar, the column of buttons on the right
// (the rail), the name/caption/audio block bottom left, the tab bar, Stories' reply field. One source for the drawing
// (PhoneArt.tsx places every row and button at these numbers) and for the check that the safe-zone presets cover it
// (test/unit/phone-layout.test.ts maps the boxes into the preset's 1080 × 1920 frame).
//
// The layouts are the apps' own as of late 2026, measured in points on an iPhone 15 (393 × 852) and anchored the way
// the apps anchor them: the rail and the caption to the bottom of the picture (the tab bar's top), the top bar under
// the status bar, the rail a fixed distance from the right edge.
import { type AppId, type Box, type Device, REPLY_H, tabBarOf, videoArea } from './devices.ts';

export interface Slot {
  id: string;
  y: number;
  h: number;
}

interface Column {
  /** The rail's centre, from the screen's right edge. */
  right: number;
  /** Its width (the widest button or count). */
  w: number;
  /** From the picture's bottom edge to the lowest item. */
  bottom: number;
  /** Top to bottom: each item's height, then the gap below it. */
  items: [id: string, h: number, gap: number][];
}

// A rail item with a count is the icon, 3 pt, then a 15 pt line of 12–13 pt text.
const RAIL: Record<Exclude<AppId, 'stories'>, Column> = {
  // heart, comment, repost, send, ⋯, the audio's cover
  reels: {
    right: 27,
    w: 44,
    bottom: 16,
    items: [
      ['like', 44, 14],
      ['comment', 44, 14],
      ['repost', 44, 14],
      ['send', 44, 16],
      ['more', 22, 18],
      ['audio', 30, 0],
    ],
  },
  // the poster's avatar with its + (follow), heart, comment, bookmark, share, the spinning record
  tiktok: {
    right: 30,
    w: 50,
    bottom: 14,
    items: [
      ['avatar', 58, 14],
      ['like', 54, 12],
      ['comment', 54, 12],
      ['save', 54, 12],
      ['share', 54, 16],
      ['disc', 46, 0],
    ],
  },
  // like, dislike, comments, share, remix — each a round button with its word — and the sound's cover
  shorts: {
    right: 32,
    w: 52,
    bottom: 14,
    items: [
      ['like', 64, 8],
      ['dislike', 64, 8],
      ['comment', 64, 8],
      ['share', 64, 8],
      ['remix', 64, 16],
      ['audio', 40, 0],
    ],
  },
};

interface Block {
  left: number;
  /** Room kept free for the rail, from the right edge. */
  right: number;
  bottom: number;
  rows: [id: string, h: number, gap: number][];
}

// Bottom left: who posted it (avatar, name, Follow/Subscribe), two lines of caption ending in "more", the audio.
const CAPTION: Record<Exclude<AppId, 'stories'>, Block> = {
  reels: {
    left: 14,
    right: 72,
    bottom: 16,
    rows: [
      ['user', 32, 10],
      ['text', 36, 8],
      ['audio', 16, 0],
    ],
  },
  tiktok: {
    left: 12,
    right: 86,
    bottom: 14,
    rows: [
      ['user', 22, 4],
      ['text', 38, 8],
      ['audio', 18, 0],
    ],
  },
  shorts: {
    left: 12,
    right: 90,
    bottom: 14,
    rows: [
      ['user', 32, 8],
      ['text', 38, 8],
      ['audio', 18, 0],
    ],
  },
};

/** The top bar: a 44 pt row under the status bar, its title, tabs and buttons in the middle 32. */
export const TOP_H = 32;

export interface AppLayout {
  app: AppId;
  /** Where the picture is (devices.ts videoArea). */
  area: Box & { r: number };
  /** The app's top bar: title and camera, the feed tabs and search, search and ⋯; Stories' progress and header. */
  top: Box;
  rail: Box | null;
  railItems: Slot[];
  caption: Box | null;
  captionRows: Slot[];
  /** The tab bar, below the picture (from its top to the screen's bottom edge). */
  tabs: Box | null;
  /** Its row of tabs, above the home indicator / gesture bar: 49 pt on iOS, 56 dp on Android. */
  bar: number;
  /** Stories: the reply field. */
  reply: Box | null;
}

const stack = (top: number, rows: [string, number, number][]): Slot[] => {
  let y = top;
  return rows.map(([id, h, gap]) => {
    const s = { id, y, h };
    y += h + gap;
    return s;
  });
};
const height = (rows: [string, number, number][]) => rows.reduce((n, [, h, gap]) => n + h + gap, 0);

export function appLayout(app: AppId, d: Device): AppLayout {
  const area = videoArea(app, d);
  if (app === 'stories') {
    // over the card's top: the progress segments 8 pt down, then avatar, name and time, ⋯ and ×
    const top = { x: 8, y: area.y + 8, w: d.w - 16, h: 44 };
    const below = area.y + area.h + 8;
    const fits = below + REPLY_H + 8 + d.safeBottom <= d.h;
    const reply = { x: 12, y: fits ? below : d.h - d.safeBottom - 8 - REPLY_H, w: d.w - 24, h: REPLY_H };
    return { app, area, top, rail: null, railItems: [], caption: null, captionRows: [], tabs: null, bar: 0, reply };
  }
  const floor = area.y + area.h;
  const col = RAIL[app];
  const railH = height(col.items);
  const railTop = floor - col.bottom - railH;
  const rail = { x: d.w - col.right - col.w / 2, y: railTop, w: col.w, h: railH };
  const block = CAPTION[app];
  const capH = height(block.rows);
  const caption = { x: block.left, y: floor - block.bottom - capH, w: d.w - block.left - block.right, h: capH };
  return {
    app,
    area,
    top: { x: 12, y: d.safeTop + 6, w: d.w - 24, h: TOP_H },
    rail,
    railItems: stack(railTop, col.items),
    caption,
    captionRows: stack(caption.y, block.rows),
    tabs: { x: 0, y: floor, w: d.w, h: tabBarOf(d) },
    bar: tabBarOf(d) - d.safeBottom,
    reply: null,
  };
}
