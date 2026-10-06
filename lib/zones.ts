// The safe-zone presets' geometry, one set of numbers for the player and for Auto-check: web/src/player/zones.ts draws
// and names them (the phone view shows the same apps around the picture), lib/qa.ts flags burned-in text under the
// Instagram Reels ones — so a finding and what the phone view shows agree. Browser-safe, no words of the UI.
// Each preset lives in its own coordinate system:
//   vertical presets → 1080×1920 (a 9:16 screen; 4:5 or 1:1 video sits centred in it, as the apps show it)
//   landscape presets → 1920×1080
//   "any" presets → the video's own pixel grid
// Zones: {type:'unsafe', x,y,w,h, label} (hatched), {type:'guide', …} (dashed outline).

/** What Auto-check calls a zone it flags text under (QaItem.zone, a token agents read: never renamed). */
export type ZoneCheck = 'ig-topbar' | 'ig-icons' | 'ig-caption' | 'ig-crop';

export interface ZoneShape {
  type: 'unsafe' | 'guide';
  x: number;
  y: number;
  w: number;
  h: number;
  /** The words on it, in English: the player says them in the UI's language. */
  label?: string;
  labelAt?: 'bottom';
  /** The zone as Auto-check flags it; absent: drawn, not checked. */
  check?: ZoneCheck;
}

// What the 19.5:9 phones (iPhone 15/16, 16 Pro, 16 Pro Max, Pixel 8) cover, in the 1080 × 1920 frame the apps fill
// above their tab bar (cropping its sides: 49–66 px each, by phone). The rails and caption blocks are the apps' current
// layouts (web/src/player/phone/layout.ts) mapped into that frame; phone-layout.test.ts fails when one leaves its zone.
// The SE, the last 16:9 phone, crops the frame's top and bottom instead and its buttons reach higher: these are for
// today's phones.
export const ZONE_SHAPES: Record<string, ZoneShape[]> = {
  // Instagram Reels. Sides: the crop on an iPhone 15/16. Top: Meta's Reels guidance ("leave at least 14% at the top,
  // 35% at the bottom and 6% on each side free of text, logos or other key design elements", Meta Ads Guide, Instagram
  // Reels, 2026) — 14 % = 269 px; the status bar and the Reels / camera row end at 238 px on an iPhone 15/16 (it was
  // 220). The 35 % is the ads' call to action; a post's caption block keeps 1590–1920. The rail gained a button in 2025
  // (repost): heart to the audio's cover now spans 1121–1885 px and 908–1018 across (it was 1165–1750, 905–1000,
  // which left the ⋯ and the audio's cover outside every zone).
  'ig-reels': [
    { type: 'unsafe', x: 0, y: 0, w: 52, h: 1920, check: 'ig-crop' },
    { type: 'unsafe', x: 1028, y: 0, w: 52, h: 1920, label: 'crop', check: 'ig-crop' },
    { type: 'guide', x: 0, y: 0, w: 1080, h: 269, label: 'top bar', check: 'ig-topbar' },
    { type: 'guide', x: 890, y: 1100, w: 138, h: 800, label: 'icons', check: 'ig-icons' },
    { type: 'guide', x: 52, y: 1590, w: 828, h: 330, label: 'caption', check: 'ig-caption' },
  ],
  // TikTok. Top: the status bar and the Following | For You row end 238 px down on an iPhone 15/16 (the old 160 px was
  // the status bar alone). The rail — the poster's avatar and its +, heart, comments, bookmark, share, the record — is
  // 50 pt wide and 30 pt in from the edge: 887–1018 px across from 921 px down (the old 940–1080 cut every button in
  // half). Below 1460 the caption, the audio and an ad's button take the width.
  tiktok: [
    { type: 'unsafe', x: 0, y: 0, w: 1080, h: 260, label: 'tabs' },
    { type: 'unsafe', x: 880, y: 880, w: 200, h: 580, label: 'icons' },
    { type: 'unsafe', x: 0, y: 1460, w: 1080, h: 460, label: 'caption · music' },
  ],
  // YouTube Shorts. Top: search and ⋯ under the status bar, 238 px (was 140). The rail is five round 46 pt buttons with
  // their words and the sound's cover, 866–1889 px down and 880–1016 across: it reaches the bottom, so the bottom zone
  // stops where it starts (the old rail zone ended at 1640, leaving remix and the cover outside every zone).
  'yt-shorts': [
    { type: 'unsafe', x: 0, y: 0, w: 1080, h: 260, label: 'top bar' },
    { type: 'unsafe', x: 870, y: 850, w: 210, h: 1070, label: 'icons' },
    { type: 'unsafe', x: 0, y: 1440, w: 870, h: 480, label: 'title · channel' },
  ],
  stories: [
    { type: 'unsafe', x: 0, y: 0, w: 1080, h: 250, label: 'profile · progress (14%)' },
    { type: 'unsafe', x: 0, y: 1670, w: 1080, h: 250, label: 'reply bar' },
  ],
  broadcast: [
    { type: 'guide', x: 67, y: 38, w: 1786, h: 1004, label: 'action safe 93%' },
    { type: 'guide', x: 96, y: 54, w: 1728, h: 972, label: 'title safe 90%', labelAt: 'bottom' },
  ],
  'center-cut': [
    { type: 'unsafe', x: 0, y: 0, w: 240, h: 1080 },
    { type: 'unsafe', x: 1680, y: 0, w: 240, h: 1080, label: '4:3' },
  ],
};

/** The Instagram Reels zones Auto-check flags text under, by what it calls them, in the 1080 × 1920 frame. */
export const REELS_CHECKS = ZONE_SHAPES['ig-reels'].filter((z): z is ZoneShape & { check: ZoneCheck } => !!z.check && z.check !== 'ig-crop');

/** The px Instagram's feed crops off each side of a reel (its preset's side zones). */
export const REELS_CROP = Math.max(...ZONE_SHAPES['ig-reels'].filter((z) => z.check === 'ig-crop').map((z) => z.w));
