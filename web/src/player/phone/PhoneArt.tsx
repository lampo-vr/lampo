// The phone view's drawings, a chunk of its own (Stage.tsx loads it when the phone view first opens): the phone's own
// chrome (status bar, Dynamic Island or punch hole, home indicator or gesture bar, the SE's home button, the side
// buttons) and each app's interface over the picture. Everything is drawn here from public dimensions — no artwork,
// logos or font files of Apple, Google or the apps; text is the system's own font. Sizes are the phone's points: the
// frame is scaled as a whole. Positions come from layout.ts (the same numbers the safe-zone test checks).
import type { CSSProperties, ReactNode } from 'react';
import { t } from '../../i18n/index.ts';
import '../../styles/phone.css';
import type { AppId, Device } from './devices.ts';
import { Glyph, type GlyphName } from './glyphs.tsx';
import { type AppLayout, appLayout, type Slot } from './layout.ts';

const box = (b: { x: number; y: number; w: number; h: number }): CSSProperties => ({ left: b.x, top: b.y, width: b.w, height: b.h });

// ---------------------------------------------------------------- the phone's own chrome

function Signal() {
  // four bars, bottom-aligned, 3 pt wide
  return (
    <svg width="17" height="11" viewBox="0 0 17 11" aria-hidden="true">
      {[4, 6.2, 8.5, 11].map((h, i) => (
        <rect key={h} x={i * 4.6} y={11 - h} width="3.2" height={h} rx="1" fill="currentColor" />
      ))}
    </svg>
  );
}

function Wifi({ w = 16, h = 11.5 }: { w?: number; h?: number }) {
  // the iOS fan: a wedge and two arcs on one centre, round ends
  const cx = 8;
  const cy = 11;
  const arc = (r: number) => `M${cx - r * Math.SQRT1_2} ${cy - r * Math.SQRT1_2}A${r} ${r} 0 0 1 ${cx + r * Math.SQRT1_2} ${cy - r * Math.SQRT1_2}`;
  return (
    <svg width={w} height={h} viewBox="0 0 16 11.5" aria-hidden="true">
      <path d={`M${cx} ${cy}L${cx - 2.6} ${cy - 2.6}A3.7 3.7 0 0 1 ${cx + 2.6} ${cy - 2.6}z`} fill="currentColor" />
      <path d={`${arc(6.4)}${arc(9.9)}`} fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" />
    </svg>
  );
}

function Battery() {
  return (
    <svg width="27" height="13" viewBox="0 0 27 13" aria-hidden="true">
      <rect x="0.5" y="0.5" width="23.5" height="12" rx="3.8" fill="none" stroke="currentColor" strokeOpacity="0.4" />
      <rect x="2.5" y="2.5" width="19.5" height="8" rx="2.2" fill="currentColor" />
      <path d="M25.3 4.4v4.2c.8-.3 1.3-1.1 1.3-2.1s-.5-1.8-1.3-2.1z" fill="currentColor" fillOpacity="0.45" />
    </svg>
  );
}

/** The SE's bars and battery: the status bar before the notch. */
function ClassicStatus({ d }: { d: Device }) {
  return (
    <div className="phone-status classic" style={{ height: d.safeTop }}>
      <span className="ps-left">
        <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true">
          {[3.4, 5.4, 7.6, 10].map((h, i) => (
            <rect key={h} x={i * 4.7} y={10 - h} width="3.4" height={h} rx="0.8" fill="currentColor" />
          ))}
        </svg>
        <Wifi w={14} h={10} />
      </span>
      <span className="ps-time">{t('phone::9:41 AM')}</span>
      <span className="ps-right">
        <span>100%</span>
        <svg width="25" height="11" viewBox="0 0 25 11" aria-hidden="true">
          <rect x="0.5" y="0.5" width="21.5" height="10" rx="2.6" fill="none" stroke="currentColor" strokeOpacity="0.5" />
          <rect x="2" y="2" width="18.5" height="7" rx="1.4" fill="currentColor" />
          <path d="M23.4 3.6v3.8c.7-.2 1.2-1 1.2-1.9s-.5-1.7-1.2-1.9z" fill="currentColor" fillOpacity="0.5" />
        </svg>
      </span>
    </div>
  );
}

/** Android's: the time on the left, Wi-Fi, signal and the battery on the right, centred on the camera. */
function AndroidStatus({ d }: { d: Device }) {
  const mid = (d.camera?.top ?? 12) + (d.camera?.h ?? 24) / 2;
  return (
    <div className="phone-status android" style={{ height: mid * 2 }}>
      <span className="ps-time">9:41</span>
      <span className="ps-right">
        <svg width="17" height="13" viewBox="0 0 17 13" aria-hidden="true">
          <path d="M8.5 12.6 0.8 4.4A11 11 0 0 1 16.2 4.4z" fill="currentColor" />
        </svg>
        <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="M13.2 0.8v12.4H0.8z" fill="currentColor" strokeLinejoin="round" stroke="currentColor" strokeWidth="1" />
        </svg>
        <svg width="24" height="12" viewBox="0 0 24 12" aria-hidden="true">
          <rect x="0" y="0.5" width="21" height="11" rx="4" fill="currentColor" />
          <rect x="21.8" y="3.6" width="1.8" height="4.8" rx="0.9" fill="currentColor" fillOpacity="0.6" />
        </svg>
      </span>
    </div>
  );
}

/** Apple's layout under the Dynamic Island: the time centred in the left ear, the glyphs in the right one. */
function IslandStatus({ d }: { d: Device }) {
  const cam = d.camera ?? { w: 126, h: 37, top: 11 };
  const ear = (d.w - cam.w) / 2;
  const mid = cam.top + cam.h / 2;
  return (
    <div className="phone-status island" style={{ height: d.safeTop }}>
      <span className="ps-time" style={{ left: ear / 2 + 4, top: mid }}>
        9:41
      </span>
      <span className="ps-right" style={{ left: d.w - ear / 2 - 4, top: mid }}>
        <Signal />
        <Wifi />
        <Battery />
      </span>
    </div>
  );
}

/** The status bar, the camera in the screen and the home indicator: what the OS draws over any app. */
export function Chrome({ device: d, landscape, status = true }: { device: Device; landscape: boolean; status?: boolean }) {
  const cam = d.camera;
  const W = landscape ? d.h : d.w;
  const H = landscape ? d.w : d.h;
  // a landscape video turns the phone a quarter to the left: the camera on the left, no status bar (iOS and Android
  // both hide it over a full-screen video); Stories hide it too where the card takes the whole screen (the SE)
  const camStyle: CSSProperties | null = !cam
    ? null
    : landscape
      ? { left: cam.top, top: (H - cam.w) / 2, width: cam.h, height: cam.w }
      : { left: (W - cam.w) / 2, top: cam.top, width: cam.w, height: cam.h };
  const handle =
    d.kind === 'island' ? { w: landscape ? Math.round(W / 4) : d.w > 420 ? 144 : 134, h: 5, b: 8 } : d.kind === 'android' ? { w: 108, h: 4, b: 10 } : null;
  return (
    <div className="phone-chrome" aria-hidden="true">
      {!landscape && status && (d.kind === 'island' ? <IslandStatus d={d} /> : d.kind === 'android' ? <AndroidStatus d={d} /> : <ClassicStatus d={d} />)}
      {camStyle && <div className={d.kind === 'android' ? 'phone-hole' : 'phone-island'} style={camStyle} />}
      {handle && <div className="phone-handle" style={{ width: handle.w, height: handle.h, bottom: handle.b, left: (W - handle.w) / 2 }} />}
    </div>
  );
}

// The side buttons, as [side, top, height] on the body standing upright (left = volume side on iPhones).
const BUTTONS: Record<string, [side: 'l' | 'r', y: number, h: number][]> = {
  iphone: [
    ['l', 128, 32],
    ['l', 196, 62],
    ['l', 272, 62],
    ['r', 226, 100],
  ],
  'iphone-pro': [
    ['l', 130, 32],
    ['l', 200, 62],
    ['l', 276, 62],
    ['r', 230, 100],
    ['r', 566, 44],
  ],
  'iphone-max': [
    ['l', 142, 34],
    ['l', 218, 68],
    ['l', 300, 68],
    ['r', 250, 108],
    ['r', 620, 48],
  ],
  'iphone-se': [
    ['l', 104, 26],
    ['l', 166, 46],
    ['l', 228, 46],
    ['r', 174, 58],
  ],
  pixel: [
    ['r', 226, 52],
    ['r', 300, 112],
  ],
};

/** What sits on the body around the screen: the side buttons, and the SE's earpiece, camera and home button. */
export function Body({ device: d, landscape }: { device: Device; landscape: boolean }) {
  const bw = d.w + d.bezel.side * 2;
  const bh = d.h + d.bezel.top + d.bezel.bottom;
  const buttons = (BUTTONS[d.id] ?? []).map(([side, y, h]) => {
    // turned a quarter to the left, the left side becomes the bottom edge and the right side the top
    const style: CSSProperties = landscape
      ? { left: y, width: h, height: 4, top: side === 'l' ? bw - 1 : -3 }
      : { top: y, height: h, width: 4, left: side === 'l' ? -3 : bw - 1 };
    return <div key={`${side}${y}`} className="phone-key" style={style} />;
  });
  let se: ReactNode = null;
  if (d.kind === 'home') {
    const ear = d.bezel.top / 2;
    const home = bh - d.bezel.bottom / 2;
    // upright: earpiece and camera in the top chin, the home button in the bottom one; turned, left and right
    const at = (x: number, y: number, w: number, h: number): CSSProperties =>
      landscape ? { left: y - h / 2, top: bw - x - w / 2, width: h, height: w } : { left: x - w / 2, top: y - h / 2, width: w, height: h };
    se = (
      <>
        <div className="phone-ear" style={at(bw / 2, ear, 52, 6)} />
        <div className="phone-lens" style={at(bw / 2 - 46, ear, 11, 11)} />
        <div className="phone-home" style={at(bw / 2, home, 62, 62)} />
      </>
    );
  }
  return (
    <div className="phone-body-art" aria-hidden="true">
      {buttons}
      {se}
    </div>
  );
}

// ---------------------------------------------------------------- the apps

const Avatar = ({ size, ring = false }: { size: number; ring?: boolean }) => (
  <span className={ring ? 'pu-avatar ring' : 'pu-avatar'} style={{ width: size, height: size, fontSize: size * 0.46 }}>
    y
  </span>
);

const HANDLE = 'yourbrand';

/** A rail button: the icon and, under it, its count or word. */
function RailItem({ slot, rail, children, label, gap = 3 }: { slot: Slot; rail: { x: number; w: number }; children: ReactNode; label?: string; gap?: number }) {
  return (
    <div className="pu-rail-item" data-item={slot.id} style={{ left: rail.x, top: slot.y, width: rail.w, height: slot.h, gap }}>
      {children}
      {label != null && <span className="pu-count">{label}</span>}
    </div>
  );
}

function Rail({ L, render }: { L: AppLayout; render: (slot: Slot, rail: { x: number; w: number }) => ReactNode }) {
  if (!L.rail) return null;
  const rail = L.rail;
  return (
    <div className="pu-rail" data-part="rail" style={box(rail)}>
      {L.railItems.map((s) => render({ ...s, y: s.y - rail.y }, { x: 0, w: rail.w }))}
    </div>
  );
}

function Rows({ L, render }: { L: AppLayout; render: (slot: Slot) => ReactNode }) {
  if (!L.caption) return null;
  const cap = L.caption;
  return (
    <div className="pu-caption" data-part="caption" style={box(cap)}>
      {L.captionRows.map((s) => (
        <div key={s.id} className={`pu-row ${s.id}`} style={{ top: s.y - cap.y, height: s.h }}>
          {render(s)}
        </div>
      ))}
    </div>
  );
}

/** Two lines of caption, the second ending in the app's "more". */
function Caption({ lines, more, size, lh }: { lines: [string, string]; more: string; size: number; lh: number }) {
  return (
    <div className="pu-text" style={{ fontSize: size, lineHeight: `${lh}px` }}>
      <span className="pu-line">{lines[0]}</span>
      <span className="pu-line last">
        <span className="pu-clip">{lines[1]}</span>
        <span className="pu-more">{more}</span>
      </span>
    </div>
  );
}

function Tabs({
  L,
  items,
  labels,
  bg,
}: {
  L: AppLayout;
  items: { icon: GlyphName | 'avatar' | 'create'; label?: string; on?: boolean }[];
  labels: boolean;
  bg: string;
}) {
  if (!L.tabs) return null;
  const bar = L.tabs;
  return (
    <div className="pu-tabs" data-part="tabs" style={{ ...box(bar), background: bg }}>
      {items.map((it, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: a fixed row of five
          key={i}
          className={it.on ? 'pu-tab on' : 'pu-tab'}
          style={{ left: (bar.w / items.length) * i, width: bar.w / items.length, height: L.bar }}
        >
          {it.icon === 'avatar' ? (
            <Avatar size={labels ? 24 : 27} />
          ) : it.icon === 'create' ? (
            <span className="pu-create">
              <Glyph name="plus" size={18} />
            </span>
          ) : (
            <Glyph name={it.icon} size={labels ? 25 : 27} solid={it.on} />
          )}
          {labels && it.label != null && <span className="pu-tab-label">{it.label}</span>}
        </span>
      ))}
    </div>
  );
}

function Shades({ L, top, bottom }: { L: AppLayout; top: number; bottom: number }) {
  const a = L.area;
  return (
    <>
      <div className="pu-shade top" style={{ left: a.x, top: a.y, width: a.w, height: top, borderRadius: `${a.r}px ${a.r}px 0 0` }} />
      {bottom > 0 && <div className="pu-shade bottom" style={{ left: a.x, top: a.y + a.h - bottom, width: a.w, height: bottom }} />}
    </>
  );
}

function Reels({ L }: { L: AppLayout }) {
  return (
    <>
      <Shades L={L} top={150} bottom={300} />
      <div className="pu-top reels" data-part="top" style={box(L.top)}>
        <span className="pu-title">
          {t('phone::Reels')}
          <Glyph name="chevron" size={17} />
        </span>
        <Glyph name="camera" size={28} />
      </div>
      <Rail
        L={L}
        render={(s, rail) => {
          if (s.id === 'like')
            return (
              <RailItem key={s.id} slot={s} rail={rail} label="12.4K">
                <Glyph name="heart" size={28} />
              </RailItem>
            );
          if (s.id === 'comment')
            return (
              <RailItem key={s.id} slot={s} rail={rail} label="318">
                <Glyph name="bubble" size={28} />
              </RailItem>
            );
          if (s.id === 'repost')
            return (
              <RailItem key={s.id} slot={s} rail={rail} label="96">
                <Glyph name="repost" size={28} />
              </RailItem>
            );
          if (s.id === 'send')
            return (
              <RailItem key={s.id} slot={s} rail={rail} label="2,104">
                <Glyph name="plane" size={27} />
              </RailItem>
            );
          if (s.id === 'more')
            return (
              <RailItem key={s.id} slot={s} rail={rail}>
                <Glyph name="dots" size={22} />
              </RailItem>
            );
          return (
            <RailItem key={s.id} slot={s} rail={rail}>
              <span className="pu-cover" style={{ width: 30, height: 30, borderRadius: 7 }} />
            </RailItem>
          );
        }}
      />
      <Rows
        L={L}
        render={(s) =>
          s.id === 'user' ? (
            <>
              <Avatar size={32} />
              <span className="pu-name">{HANDLE}</span>
              <span className="pu-pill outline">{t('phone::Follow')}</span>
            </>
          ) : s.id === 'text' ? (
            <Caption
              lines={[t('phone::Behind the scenes of our new spot. Swipe'), t('phone::through and tell us your favourite frame')]}
              more={t('phone::… more')}
              size={14}
              lh={18}
            />
          ) : (
            <span className="pu-audio">
              <Glyph name="music" size={12} />
              <span className="pu-clip">{t('phone::{name} · Original audio', { name: HANDLE })}</span>
            </span>
          )
        }
      />
      <Tabs
        L={L}
        labels={false}
        bg="#000"
        items={[{ icon: 'home' }, { icon: 'playbox', on: true }, { icon: 'plane' }, { icon: 'search' }, { icon: 'avatar' }]}
      />
    </>
  );
}

function TikTok({ L }: { L: AppLayout }) {
  return (
    <>
      <Shades L={L} top={140} bottom={260} />
      <div className="pu-top tiktok" data-part="top" style={box(L.top)}>
        <span className="pu-live">LIVE</span>
        <span className="pu-feeds">
          <span>{t('phone::Following')}</span>
          <span className="on">{t('phone::For You')}</span>
        </span>
        <Glyph name="search" size={26} />
      </div>
      <Rail
        L={L}
        render={(s, rail) => {
          if (s.id === 'avatar')
            return (
              <RailItem key={s.id} slot={s} rail={rail}>
                <span className="pu-follow">
                  <Avatar size={48} ring />
                  <span className="pu-badge">
                    <Glyph name="plus" size={12} />
                  </span>
                </span>
              </RailItem>
            );
          const items: Record<string, [GlyphName, number, string]> = {
            like: ['heart', 36, '48.2K'],
            comment: ['bubbleFull', 35, '1204'],
            save: ['bookmark', 32, '3918'],
            share: ['share', 34, '2140'],
          };
          const it = items[s.id];
          if (it)
            return (
              <RailItem key={s.id} slot={s} rail={rail} label={it[2]} gap={2}>
                <span className="pu-ico" style={{ width: 38, height: 37 }}>
                  <Glyph name={it[0]} size={it[1]} solid />
                </span>
              </RailItem>
            );
          return (
            <RailItem key={s.id} slot={s} rail={rail}>
              <span className="pu-disc">
                <Avatar size={24} />
              </span>
            </RailItem>
          );
        }}
      />
      <Rows
        L={L}
        render={(s) =>
          s.id === 'user' ? (
            <span className="pu-name big">{HANDLE}</span>
          ) : s.id === 'text' ? (
            <Caption
              lines={[t('phone::The new spot is live. Which frame would'), t('phone::you keep? #motiondesign')]}
              more={t('phone::more')}
              size={15}
              lh={19}
            />
          ) : (
            <span className="pu-audio">
              <Glyph name="music" size={13} />
              <span className="pu-clip">{t('phone::Original audio · {name}', { name: HANDLE })}</span>
            </span>
          )
        }
      />
      <Tabs
        L={L}
        labels
        bg="#000"
        items={[
          { icon: 'home', label: t('phone::Home'), on: true },
          { icon: 'people', label: t('phone::Friends') },
          { icon: 'create' },
          { icon: 'inbox', label: t('phone::Inbox') },
          { icon: 'person', label: t('phone::Profile') },
        ]}
      />
    </>
  );
}

function Shorts({ L }: { L: AppLayout }) {
  return (
    <>
      <Shades L={L} top={130} bottom={280} />
      <div className="pu-top shorts" data-part="top" style={box(L.top)}>
        <span className="grow" />
        <Glyph name="search" size={25} />
        <Glyph name="dotsV" size={25} />
      </div>
      <Rail
        L={L}
        render={(s, rail) => {
          const items: Record<string, [GlyphName, string]> = {
            like: ['thumb', '24K'],
            dislike: ['thumbDown', t('phone::Dislike')],
            comment: ['square', '312'],
            share: ['share', t('phone::Share')],
            remix: ['remix', t('phone::Remix')],
          };
          const it = items[s.id];
          if (it)
            return (
              <RailItem key={s.id} slot={s} rail={rail} label={it[1]} gap={4}>
                <span className="pu-round">
                  <Glyph name={it[0]} size={24} solid />
                </span>
              </RailItem>
            );
          return (
            <RailItem key={s.id} slot={s} rail={rail}>
              <span className="pu-cover" style={{ width: 40, height: 40, borderRadius: 8 }} />
            </RailItem>
          );
        }}
      />
      <Rows
        L={L}
        render={(s) =>
          s.id === 'user' ? (
            <>
              <Avatar size={30} />
              <span className="pu-name">@{HANDLE}</span>
              <span className="pu-pill solid">{t('phone::Subscribe')}</span>
            </>
          ) : s.id === 'text' ? (
            <Caption
              lines={[t('phone::Every frame of our new spot, one by one.'), t('phone::Which one would you keep? #motiondesign')]}
              more=""
              size={14}
              lh={19}
            />
          ) : (
            <span className="pu-audio boxed">
              <Glyph name="music" size={12} />
              <span className="pu-clip">{t('phone::Original audio · {name}', { name: HANDLE })}</span>
            </span>
          )
        }
      />
      <Tabs
        L={L}
        labels
        bg="#0f0f0f"
        items={[
          { icon: 'home', label: t('phone::Home') },
          { icon: 'vplay', label: t('phone::Shorts'), on: true },
          { icon: 'create' },
          { icon: 'stack', label: t('phone::Subscriptions') },
          { icon: 'avatar', label: t('phone::You') },
        ]}
      />
    </>
  );
}

function Stories({ L }: { L: AppLayout }) {
  const top = L.top;
  return (
    <>
      <Shades L={L} top={120} bottom={0} />
      <div className="pu-top stories" data-part="top" style={box(top)}>
        <div className="pu-progress">
          <i className="done" />
          <i className="now" />
          <i />
        </div>
        <div className="pu-story-head">
          <Avatar size={32} />
          <span className="pu-name">{HANDLE}</span>
          <span className="pu-when">{t('phone::2h')}</span>
          <span className="grow" />
          <Glyph name="dots" size={22} />
          <Glyph name="close" size={24} />
        </div>
      </div>
      {L.reply && (
        <div className="pu-reply" data-part="reply" style={box(L.reply)}>
          <span className="pu-field">{t('phone::Send message')}</span>
          <Glyph name="heart" size={27} />
          <Glyph name="plane" size={26} />
        </div>
      )}
    </>
  );
}

/** An app's interface over the picture, as it looks on this phone. */
export function AppUI({ app, device }: { app: AppId; device: Device }) {
  const L = appLayout(app, device);
  return (
    <div className={`phone-ui ${app} ${device.kind}`} data-app-ui={app} aria-hidden="true">
      {app === 'reels' ? <Reels L={L} /> : app === 'tiktok' ? <TikTok L={L} /> : app === 'shorts' ? <Shorts L={L} /> : <Stories L={L} />}
    </div>
  );
}
