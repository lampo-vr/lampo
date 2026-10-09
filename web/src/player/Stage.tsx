// The picture: one or two panes (A/B side by side, or one above the other), each with the video fitted into a canvas
// box, the safe zones in the right coordinate system, the drawing layer (video pixels) and an optional phone frame at
// real CSS size, with an app's interface around the picture. The zones and the app are two choices, drawn apart.
import {
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type Ref,
  type RefObject,
  useLayoutEffect,
  useRef,
  useState,
} from 'react';
import { drawingMarkup, shapeMarkup, simplifyPoints, strokeFor } from '../../../lib/drawing.ts';
import type { Shape, Tool } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { loader, useLoaded } from '../lib/lazy.ts';
import Overlay from './overlays.tsx';
import { type AppId, bodyOf, cover, type Device, videoArea } from './phone/devices.ts';
import { type Preset, presetCanvas } from './zones.ts';

export { DEVICES, type Device } from './phone/devices.ts';

/** The phone's drawings — status bar, island, the apps' interfaces — load when the phone view first opens; until then
 * the frame stands in its final box with the picture in its final place, so nothing moves when they arrive. */
export const phoneArt = loader(() => import('./phone/PhoneArt.tsx'));
const PAD = 36;
/** The note under the phone ("iPhone 15 / 16 · 393×852 pt"): 12 px from the pane's bottom, a line of small text. */
const NOTE_H = 30;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const fit = (aspect: number, w: number, h: number) => (w / h > aspect ? { w: h * aspect, h } : { w, h: w / aspect });

// The stage's box (it has no padding or border: its border box is its content box, measured one way everywhere).
type Size = { w: number; h: number };
const sizeOf = (el: HTMLElement) => (s: Size) => {
  const r = el.getBoundingClientRect();
  return s.w === r.width && s.h === r.height ? s : { w: r.width, h: r.height };
};
function useSize(ref: RefObject<HTMLElement | null>) {
  const [size, setSize] = useState<Size>({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setSize(sizeOf(el)));
    ro.observe(el);
    return () => ro.disconnect();
  }, [ref]);
  // A change made in the same render as the stage's own (a phone's sheet opening, its drawing strip kept free) is
  // measured before it paints: the observer's answer comes a frame later, and that frame showed the picture at the
  // old size in the new room.
  useLayoutEffect(() => {
    if (ref.current) setSize(sizeOf(ref.current));
  });
  return size;
}

// Where the canvas (overlay coordinate box) and the video sit inside an area of aw × ah.
function place(aw: number, ah: number, vw: number, vh: number, canvasSize: [number, number] | null): { canvas: Rect; video: Rect } {
  const vAspect = vw / vh;
  const cAspect = canvasSize ? canvasSize[0] / canvasSize[1] : vAspect;
  const c = fit(cAspect, aw, ah);
  const canvas = { x: (aw - c.w) / 2, y: (ah - c.h) / 2, w: c.w, h: c.h };
  const v = fit(vAspect, c.w, c.h);
  return { canvas, video: { x: (c.w - v.w) / 2, y: (c.h - v.h) / 2, w: v.w, h: v.h } };
}

type Draft =
  | { type: 'box'; x0: number; y0: number; x: number; y: number; w: number; h: number }
  | { type: 'arrow'; x1: number; y1: number; x2: number; y2: number }
  | { type: 'freehand'; points: [number, number][] };

export interface DrawProps {
  tool: Tool;
  shapes: Shape[];
  onAdd: (s: Shape) => void;
}

function DrawLayer({ W, H, tool, shapes, onAdd }: DrawProps & { W: number; H: number }) {
  const svg = useRef<SVGSVGElement>(null);
  const [cur, setCur] = useState<Draft | null>(null);
  // The draft also lives in a ref: several moves (and the release) can arrive before React renders, and each must
  // build on the one before, not on the last render's copy — a slow machine otherwise drew a short box or lost points.
  const draft = useRef<Draft | null>(null);
  const set = (d: Draft | null) => {
    draft.current = d;
    setCur(d);
  };
  const pt = (e: ReactPointerEvent): [number, number] => {
    const el = svg.current;
    const m = el?.getScreenCTM();
    if (!el || !m) return [0, 0];
    const q = new DOMPoint(e.clientX, e.clientY).matrixTransform(m.inverse());
    return [q.x, q.y];
  };
  const extend = (d: Draft, [x, y]: [number, number]): Draft => {
    if (d.type === 'box') return { ...d, x: Math.min(d.x0, x), y: Math.min(d.y0, y), w: Math.abs(x - d.x0), h: Math.abs(y - d.y0) };
    if (d.type === 'arrow') return { ...d, x2: x, y2: y };
    const last = d.points[d.points.length - 1];
    return last[0] === x && last[1] === y ? d : { ...d, points: [...d.points, [x, y]] };
  };
  const down = (e: ReactPointerEvent<SVGSVGElement>) => {
    if (e.button !== 0 || tool === 'none') return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const [x, y] = pt(e);
    if (tool === 'box') set({ type: 'box', x0: x, y0: y, x, y, w: 0, h: 0 });
    if (tool === 'arrow') set({ type: 'arrow', x1: x, y1: y, x2: x, y2: y });
    if (tool === 'freehand') set({ type: 'freehand', points: [[x, y]] });
  };
  const move = (e: ReactPointerEvent) => {
    if (draft.current) set(extend(draft.current, pt(e)));
  };
  // the release point counts: the shape ends where the pointer let go
  const up = (e: ReactPointerEvent) => {
    if (!draft.current) return;
    const d = extend(draft.current, pt(e));
    const min = Math.min(W, H) / 60;
    const r = Math.round;
    if (d.type === 'box' && d.w > min && d.h > min) onAdd({ type: 'box', x: r(d.x), y: r(d.y), w: r(d.w), h: r(d.h) });
    if (d.type === 'arrow' && Math.hypot(d.x2 - d.x1, d.y2 - d.y1) > min) onAdd({ type: 'arrow', x1: r(d.x1), y1: r(d.y1), x2: r(d.x2), y2: r(d.y2) });
    if (d.type === 'freehand' && d.points.length > 2) onAdd({ type: 'freehand', points: simplifyPoints(d.points, Math.min(W, H) / 400) as [number, number][] });
    set(null);
  };
  const sw = strokeFor(W, H);
  const live = cur ? shapeMarkup(cur.type === 'box' ? { type: 'box', x: cur.x, y: cur.y, w: cur.w, h: cur.h } : cur, sw) : '';
  return (
    <svg
      ref={svg}
      className={`layer ${tool === 'none' ? 'passive' : 'draw'}`}
      viewBox={`0 0 ${W} ${H}`}
      preserveAspectRatio="none"
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={() => set(null)}
      // biome-ignore lint/security/noDangerouslySetInnerHtml: markup comes from lib/drawing (numbers only), shared with the server's _marked.png
      dangerouslySetInnerHTML={{ __html: drawingMarkup(shapes, W, H) + live }}
    />
  );
}

/** B inside A's frame: a wipe (B right of the handle) or an overlay (difference, or B faded over A). */
export interface WipeProps {
  src: string | null;
  label: string;
  videoRef: Ref<HTMLVideoElement>;
  mode: 'wipe' | 'overlay';
  pos: number;
  setPos: (pos: number) => void;
  blend: 'difference' | 'onion';
  opacity: number;
  /** B is a still (a fix preview), not a video. */
  image?: string;
  /** B's name on the picture, top right, cut by the handle as B is (a review link's compare). */
  tag?: ReactNode;
}

function Wipe({ b, aTag }: { b: WipeProps; aTag?: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const drag = (e: ReactPointerEvent) => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    b.setPos(Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)));
  };
  const overlay = b.mode === 'overlay';
  // Difference: identical pixels turn black, so only what changed lights up. Onion skin: B at the chosen opacity.
  const style: CSSProperties = overlay
    ? b.blend === 'difference'
      ? { mixBlendMode: 'difference' }
      : { opacity: b.opacity }
    : { clipPath: `inset(0 0 0 ${b.pos * 100}%)`, background: '#000' };
  return (
    <div className={`wipe ${overlay ? `overlay ${b.blend}` : ''}`} ref={ref}>
      {b.image ? (
        <img className="wipe-still" src={b.image} alt="" style={style} />
      ) : (
        <video ref={b.videoRef} src={b.src || undefined} muted playsInline preload="auto" style={{ objectFit: 'contain', ...style }} />
      )}
      {/* each side's name stays on its side: the handle cuts it as it cuts the pictures */}
      {!overlay && aTag && (
        <div className="pane-tag-layer" style={{ clipPath: `inset(0 ${(1 - b.pos) * 100}% 0 0)` }}>
          <span className="pane-tag">{aTag}</span>
        </div>
      )}
      {!overlay && b.tag && (
        <div className="pane-tag-layer b" style={{ clipPath: `inset(0 0 0 ${b.pos * 100}%)` }}>
          <span className="pane-tag">{b.tag}</span>
        </div>
      )}
      {!overlay && (
        <div
          className="wipe-handle"
          role="slider"
          aria-label={t('A/B wipe')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(b.pos * 100)}
          tabIndex={0}
          style={{ left: `${b.pos * 100}%` }}
          onKeyDown={(e) => {
            const step = e.shiftKey ? 0.1 : 0.02;
            if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
              e.preventDefault();
              e.stopPropagation();
              b.setPos(Math.max(0, Math.min(1, b.pos + (e.key === 'ArrowLeft' ? -step : step))));
            }
          }}
          onPointerDown={(e) => {
            e.stopPropagation();
            e.currentTarget.setPointerCapture(e.pointerId);
            drag(e);
          }}
          onPointerMove={(e) => e.buttons && drag(e)}
        />
      )}
    </div>
  );
}

export interface Pane {
  key: string;
  src: string | null | undefined;
  /** A still instead of a video (a fix preview): shown in the same frame, the same size. */
  image?: string;
  W: number;
  H: number;
  videoRef: Ref<HTMLVideoElement>;
  label?: string | null;
  muted?: boolean;
  marks?: string;
  draw?: DrawProps | null;
  wipe?: WipeProps;
  /** Its name on the picture, top left, readable over any picture (a review link's compare: "A V3"). */
  tag?: ReactNode;
  /** Said in the picture's box while it has no video yet (the other side of a compare getting ready). */
  note?: string | null;
}

interface StageProps {
  panes: Pane[];
  /** The safe zones drawn over the picture (none: null), in the phone view too, on the picture as the phone shows it. */
  preset: Preset | null;
  /** The phone view: the phone the video is shown on, at its real size. */
  phone: Device | null;
  /** The app whose interface the phone view draws around a vertical or square picture; null = Full height. */
  app?: AppId | null;
  message?: string | null;
  // px kept free at the bottom (e.g. for the verify panel) so it never covers the picture.
  reserveBottom?: number;
  /** px kept free at the top (the compare bar floats there). */
  reserveTop?: number;
  /** Space around the picture (the crop marks sit in it). Phones use less. */
  pad?: number;
  /**
   * Phones: the panes lie on top of each other at full width and only this one shows; a horizontal swipe calls
   * onSwipe. Both videos stay mounted, so switching never reloads or loses sync.
   */
  stack?: { show: number; onSwipe: (dir: 1 | -1) => void } | null;
  /** Two panes one above the other instead of side by side (a phone comparing two landscape pictures). */
  arrange?: 'row' | 'column';
  /** A tap on the picture (a phone: play or pause), with the time the finger made it (the event's timeStamp). Not a
   * press on what has its own (a button over the picture, the wipe's handle, a drawing's stroke). */
  onTap?: (at: number) => void;
  /** Laid over the picture, inside the stage's dark ground (a phone held sideways: its bar). */
  children?: ReactNode;
}

/** What a tap on the stage leaves alone: it is theirs. */
const OWN_TAP = 'button, a, input, select, textarea, [role=slider], [role=toolbar], svg.draw';

/** Where the phone stands in the pane and what it shows: its body (scaled to fit), the screen, the picture's area. */
interface PhonePlace {
  device: Device;
  landscape: boolean;
  scale: number;
  left: number;
  top: number;
  body: ReturnType<typeof bodyOf>;
  area: Rect & { r: number };
  app: AppId | null;
  note: string;
}

const at = (r: Rect): CSSProperties => ({ left: r.x, top: r.y, width: r.w, height: r.h });

export default function Stage({
  panes,
  preset,
  phone,
  app: phoneApp = null,
  message,
  reserveBottom = 0,
  reserveTop = 0,
  pad = PAD,
  stack = null,
  arrange = 'row',
  onTap,
  children,
}: StageProps) {
  const ref = useRef<HTMLDivElement>(null);
  const size = useSize(ref);
  const Art = useLoaded(phoneArt, !!phone);
  const column = arrange === 'column' && !stack && !phone && panes.length > 1;
  const paneW = stack || column ? size.w : size.w / panes.length;
  // One above the other: the room between the reserved strips, shared out from the top.
  const paneH = column ? (size.h - reserveTop - reserveBottom) / panes.length : size.h;
  const swipe = useRef<{ x: number; y: number; id: number } | null>(null);
  const swipeHandlers = stack
    ? {
        onPointerDown: (e: ReactPointerEvent) => {
          if (e.pointerType !== 'mouse') swipe.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
        },
        onPointerUp: (e: ReactPointerEvent) => {
          const s = swipe.current;
          swipe.current = null;
          if (!s || s.id !== e.pointerId) return;
          const dx = e.clientX - s.x;
          if (Math.abs(dx) > 48 && Math.abs(dx) > Math.abs(e.clientY - s.y) * 1.5) stack.onSwipe(dx < 0 ? 1 : -1);
        },
        onPointerCancel: () => {
          swipe.current = null;
        },
      }
    : {};

  // a click, not the release: a touch's click comes only for a tap, never at the end of a swipe or a drag
  const tap = onTap
    ? (e: ReactMouseEvent) => {
        if (!(e.target as Element).closest(OWN_TAP)) onTap(e.timeStamp);
      }
    : undefined;
  return (
    // biome-ignore lint/a11y/useKeyWithClickEvents: the keyboard plays and pauses with Space; a tap is the touch screen's way
    // biome-ignore lint/a11y/noStaticElementInteractions: as above, the picture itself is what a finger taps
    <div className={stack ? 'stage stacked' : column ? 'stage column' : 'stage'} ref={ref} onClick={tap} {...swipeHandlers}>
      {message && <div className="stage-msg">{message}</div>}
      {size.w > 0 &&
        panes.map((p, i) => {
          const canvasSize = presetCanvas(preset);
          let ph: PhonePlace | null = null;
          let box: { canvas: Rect; video: Rect };
          if (phone) {
            const landscape = p.W > p.H * 1.05;
            const body = bodyOf(phone, landscape);
            // the note under the phone sits in the padding; where that is thin (a real phone's stage) it gets room of its own
            const noteRoom = Math.max(0, NOTE_H - pad);
            const room = size.h - reserveBottom - reserveTop - pad * 2 - noteRoom;
            // the side buttons stand 3 pt off the body
            const scale = Math.min(1, (paneW - pad * 2) / (body.w + 8), room / (body.h + 8));
            const app = landscape ? null : phoneApp;
            const area = landscape ? { x: 0, y: 0, w: body.screen.w, h: body.screen.h, r: 0 } : videoArea(app, phone);
            if (landscape) box = place(area.w, area.h, p.W, p.H, canvasSize);
            else {
              // Portrait: the 9:16 frame fills the picture's area (Full height: the whole screen; an app: above its tab bar,
              // or Stories' card) and is cropped where the area is taller, as the apps do; a 4:5 or 1:1 video sits in it.
              const c = cover(9 / 16, area.w, area.h);
              const v = fit(p.W / p.H, c.w, c.h);
              box = { canvas: c, video: { x: (c.w - v.w) / 2, y: (c.h - v.h) / 2, w: v.w, h: v.h } };
            }
            ph = {
              device: phone,
              landscape,
              scale,
              left: (paneW - body.w * scale) / 2,
              top: reserveTop + pad + (room - body.h * scale) / 2,
              body,
              area,
              app,
              note:
                scale < 0.999
                  ? t('phone scaled to {x}% to fit', { x: Math.round(scale * 100) })
                  : t('{label} · {dw}×{dh} pt', { label: phone.label, dw: body.screen.w, dh: body.screen.h }),
            };
          } else if (column) {
            box = place(paneW - pad * 2, paneH - pad * 2, p.W, p.H, canvasSize);
            box.canvas.x += pad;
            box.canvas.y += pad;
          } else {
            box = place(paneW - pad * 2, size.h - reserveBottom - reserveTop - pad * 2, p.W, p.H, canvasSize);
            box.canvas.x += pad;
            box.canvas.y += pad + reserveTop;
          }
          const { canvas, video } = box;
          // The zones lie on the picture; with an app on the phone they go over its interface instead (below), where
          // they can be read against its buttons.
          const overlay = !ph?.app;
          const content = (
            <div className="canvas" style={at(canvas)}>
              {!phone && (
                <div className="crop" style={at(video)}>
                  <span className="dim">
                    {p.W} × {p.H}
                  </span>
                </div>
              )}
              <div className="vbox" style={at(video)}>
                {p.image ? (
                  <img className="pane-still" src={p.image} alt="" />
                ) : p.src ? (
                  <video ref={p.videoRef} src={p.src} muted={p.muted} playsInline preload="auto" />
                ) : p.note ? (
                  <div className="pane-note">{p.note}</div>
                ) : null}
                {p.wipe && <Wipe b={p.wipe} aTag={p.tag} />}
                {!p.wipe && p.tag && (
                  <div className="pane-tag-layer">
                    <span className="pane-tag">{p.tag}</span>
                  </div>
                )}
                {p.marks && (
                  <svg
                    className="layer passive"
                    viewBox={`0 0 ${p.W} ${p.H}`}
                    preserveAspectRatio="none"
                    // biome-ignore lint/security/noDangerouslySetInnerHtml: built by frameMarks() from numbers and fixed strings
                    dangerouslySetInnerHTML={{ __html: p.marks }}
                  />
                )}
                {p.draw && <DrawLayer W={p.W} H={p.H} {...p.draw} />}
                {overlay && !canvasSize && <Overlay preset={preset} size={[p.W, p.H]} />}
              </div>
              {overlay && canvasSize && <Overlay preset={preset} size={canvasSize} />}
            </div>
          );
          // One tree whether the phone shows or not (the wrappers lie flat over the pane without it), so turning the
          // phone view on or off, or changing the app or the phone, keeps the same video element: nothing reloads.
          const { body, area } = ph ?? {};
          return (
            <div
              className="pane"
              key={p.key}
              style={
                stack
                  ? { left: 0, width: paneW, visibility: i === stack.show ? 'visible' : 'hidden' }
                  : column
                    ? { left: 0, width: paneW, top: reserveTop + i * paneH, height: paneH, bottom: 'auto' }
                    : { left: i * paneW, width: paneW }
              }
            >
              {p.label && <div className="pane-label badge">{p.label}</div>}
              {p.wipe?.label && (
                <div className="pane-label b badge">
                  {p.wipe.mode === 'overlay' ? `${p.wipe.label} · ${p.wipe.blend === 'difference' ? 'difference' : 'onion skin'}` : p.wipe.label}
                </div>
              )}
              <div
                className={ph ? `phone ${ph.device.kind}` : 'unframed'}
                style={
                  ph && body ? { left: ph.left, top: ph.top, width: body.w, height: body.h, borderRadius: body.r, transform: `scale(${ph.scale})` } : undefined
                }
                data-device={ph?.device.id}
                data-app={ph ? (ph.app ?? 'full') : undefined}
                data-art={ph ? (Art ? 'ready' : 'loading') : undefined}
              >
                <div className={ph ? 'phone-screen' : 'unframed'} style={body ? { ...at(body.screen), borderRadius: body.screen.r } : undefined}>
                  <div className={ph ? 'phone-area' : 'unframed'} style={area ? { ...at(area), borderRadius: area.r } : undefined}>
                    {content}
                  </div>
                  {ph?.app && Art ? <Art.AppUI app={ph.app} device={ph.device} /> : null}
                  {ph?.app && area && preset ? (
                    <div className="phone-area phone-zones" style={{ ...at(area), borderRadius: area.r }}>
                      <div className="canvas" style={at(canvas)}>
                        {/* in the frame's coordinates, as Auto-check's are (the rule of thirds in the picture's own); the
                            stripes only: the interface under them says what each zone is for */}
                        {canvasSize ? (
                          <Overlay preset={preset} size={canvasSize} labels={false} />
                        ) : (
                          <div className="phone-zones-v" style={at(video)}>
                            <Overlay preset={preset} size={[p.W, p.H]} labels={false} />
                          </div>
                        )}
                      </div>
                    </div>
                  ) : null}
                  {ph && Art ? <Art.Chrome device={ph.device} landscape={ph.landscape} status={!(ph.app === 'stories' && ph.area.y === 0)} /> : null}
                </div>
                {ph && Art ? <Art.Body device={ph.device} landscape={ph.landscape} /> : null}
              </div>
              {ph ? <div className="phone-note">{ph.note}</div> : null}
            </div>
          );
        })}
      {children}
    </div>
  );
}
