// The way in, for everyone: a review link's password, a link that ended or has nothing yet, and the owner's setup,
// sign-in, sign-up, the emailed links (confirm, reset), an invite and an app asking to connect. One split page: on the
// left a panel with the logo and the brand film, on the right the form — who shared or invites, the title, the fields
// (ui/EntryForm.tsx), the orange way in, one quiet line of fine print — with the theme at the top and a foot. Phones
// and narrow windows stack them: a slim still band of the picture, then the logo and the form. Styles: entrance.css.
//
// The brand film is Lampo's own demo footage (assets/brand-film/README.md), never a review's video: 60 consecutive
// frames playing in slow motion, each dissolving into the next, while their strip glides through a lit gate under a
// fixed playhead and the readout says the frame and the timecode. It is decoration (aria-hidden), calm, and never reacts
// to the form. Its pictures are images, not code: the still (F 0295 and the strip) is asked for once the form has
// painted, the four sheets of frames in an idle moment after that and only where the film plays — a panel tall enough,
// motion allowed, the tab in view — each decoded before anything moves. Phones and reduced motion keep the still.
import { type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import frames0 from '../assets/brand-film/frames-0.webp';
import frames1 from '../assets/brand-film/frames-1.webp';
import frames2 from '../assets/brand-film/frames-2.webp';
import frames3 from '../assets/brand-film/frames-3.webp';
import poster from '../assets/brand-film/poster.webp';
import strip from '../assets/brand-film/strip.webp';
import { t } from '../i18n/index.ts';
import { pad } from '../lib/format.ts';
import { usePainted, whenIdle } from '../lib/lazy.ts';
import { copyText } from '../lib/toast.ts';
import { I, type IconName, Wordmark } from './icons.tsx';
import { KeyGlyph } from './KeyGlyph.tsx';
import { Avatar } from './plain.tsx';
import { Skeleton, SkLine } from './Skeleton.tsx';
import { ThemeButton } from './ThemeSwitch.tsx';
import '../styles/entrance.css';

// ---------------------------------------------------------------- the brand film

/** The film's frames as site/footage.ts numbers them (24 fps): 60 from F 0266, resting on F 0295 (00:12:07). */
const FIRST = 266;
const COUNT = 60;
const REST = 295;
const FPS = 24;
const I0 = REST - FIRST;
/** A thumbnail's step along the strip (104 px and the gap), and how long each frame is on screen. */
const PITCH = 112;
const PERIOD = 1500;
const SHEETS = [frames0, frames1, frames2, frames3];

const tc = (f: number) => {
  const s = Math.floor(f / FPS);
  return `${pad(Math.floor(s / 60) % 60)}:${pad(s % 60)}:${pad(f % FPS)}`;
};
/** Frame i (0–59) on its sheet: fifteen to a sheet, three across and five down. */
const frameStyle = (i: number) => {
  const k = i % 15;
  return { image: `url("${SHEETS[Math.floor(i / 15)]}")`, position: `${(k % 3) * 50}% ${Math.floor(k / 3) * 25}%` };
};
/** Thumbnail i on the strip's sheet: ten across, six down. */
const thumbAt = (i: number) => `${((i % 10) * 100) / 9}% ${Math.floor(i / 10) * 20}%`;
const THUMBS = Array.from({ length: COUNT * 2 }, (_, i) => i);

/** A picture fetched and decoded; kept here, so another screen of the entrance doesn't decode it again. */
const decoded = new Map<string, Promise<HTMLImageElement>>();
function decode(src: string): Promise<HTMLImageElement> {
  let p = decoded.get(src);
  if (!p) {
    const img = new Image();
    img.decoding = 'async';
    img.src = src;
    // a picture that can't be decoded early still shows when it is painted: never hold the film for it
    p = img.decode().then(
      () => img,
      () => img,
    );
    decoded.set(src, p);
  }
  return p;
}

/** The film's largest scale (Film's fit). */
const MAX_SCALE = 1.2;

const reducedMotion = () => window.matchMedia?.('(prefers-reduced-motion: reduce)');
const stacked = () => window.matchMedia?.('(max-width: 820px)');

function Film({ caption }: { caption: string }) {
  const root = useRef<HTMLElement>(null);
  // The 640 × 520 drawing fitted to the panel by one scale: set before the first paint, again when the panel resizes.
  useLayoutEffect(() => {
    const el = root.current;
    if (!el) return;
    const fit = () => {
      const r = el.getBoundingClientRect();
      if (!r.width || !r.height) return;
      const s = r.height < 360 ? Math.min(r.width / 600, (r.height - 16) / 410) : Math.min((r.width * 0.84) / 640, (r.height * 0.8) / 520);
      // never larger than 1.2: its labels (10 px drawn) stay within the form's small type beside it — at 1.5 a wide
      // screen drew them at 15 px over a 13 px form
      el.style.setProperty('--s', Math.max(0.4, Math.min(MAX_SCALE, s)).toFixed(3));
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Nothing of the film is asked for before the form has painted (its first contentful paint, then an idle moment).
  const painted = usePainted();
  useEffect(() => {
    const el = root.current;
    if (!el || !painted) return;
    const reel = el.querySelector<HTMLElement>('.ent-reel');
    const under = el.querySelector<HTMLElement>('.ent-layer:not(.top)');
    const over = el.querySelector<HTMLElement>('.ent-layer.top');
    if (!reel || !under || !over) return;
    const numbers = el.querySelectorAll<HTMLElement>('[data-f]');
    const codes = el.querySelectorAll<HTMLElement>('[data-tc]');
    const paint = (layer: HTMLElement, i: number) => {
      const f = frameStyle(i);
      layer.style.backgroundImage = f.image;
      layer.style.backgroundPosition = f.position;
      layer.style.backgroundSize = '300% 500%';
    };
    const label = (f: number) => {
      for (const n of numbers) n.textContent = pad(f, 4);
      for (const c of codes) c.textContent = tc(f);
    };
    let alive = true;
    let anim: Animation | null = null;
    let raf = 0;
    let stopLoad = () => {};
    let sheets: Promise<unknown> | null = null;
    // the two frames at the gate and the one the readout names, between ticks
    let a = -1;
    let b = -1;
    let shown = I0;
    let hold = 0;

    // The still: F 0295 in the frame, the strip at rest, asked for once the form is on screen.
    const still = () => {
      anim?.cancel();
      anim = null;
      cancelAnimationFrame(raf);
      raf = 0;
      under.style.backgroundImage = `url("${poster}")`;
      under.style.backgroundPosition = '';
      under.style.backgroundSize = '';
      over.style.opacity = '0';
      a = -1;
      b = -1;
      shown = I0;
      label(REST);
    };
    const tick = (now: number) => {
      raf = 0;
      if (!anim || !alive) return;
      const p = Number(anim.currentTime ?? 0) / PERIOD;
      const k = Math.floor(p);
      const i = (I0 + k) % COUNT;
      const at = (I0 + Math.round(p)) % COUNT;
      if (at !== shown) {
        shown = at;
        label(FIRST + at);
      }
      if (a !== i) {
        // the frame on top is whole now: the one below takes it, the top waits a moment, then takes the next
        paint(under, i);
        over.style.opacity = b === i ? '1' : '0';
        a = i;
        hold = now + 50;
      } else if (now >= hold) {
        const j = (i + 1) % COUNT;
        if (b !== j) {
          paint(over, j);
          b = j;
        }
        over.style.opacity = (p - k).toFixed(3);
      }
      raf = requestAnimationFrame(tick);
    };
    // One clock: the strip glides on the compositor (transform only), each frame reads its time for the dissolve.
    const play = () => {
      if (!anim)
        anim = reel.animate([{ transform: 'translate3d(0, 0, 0)' }, { transform: `translate3d(${-COUNT * PITCH}px, 0, 0)` }], {
          duration: COUNT * PERIOD,
          iterations: Number.POSITIVE_INFINITY,
          easing: 'linear',
        });
      else anim.play();
      if (!raf) raf = requestAnimationFrame(tick);
    };
    const pause = () => {
      anim?.pause();
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const tall = () => el.getBoundingClientRect().height >= 360;
    const update = () => {
      if (!alive) return;
      if (reducedMotion()?.matches || stacked()?.matches || !tall()) return still();
      if (document.hidden) return pause();
      // the sheets once, in an idle moment after the still, every one decoded before the film starts
      sheets ??= new Promise<void>((done) => {
        stopLoad = whenIdle(() => void Promise.all(SHEETS.map(decode)).then(() => done()));
      });
      void sheets.then(() => {
        if (alive && !reducedMotion()?.matches && !stacked()?.matches && tall() && !document.hidden) play();
      });
    };
    const motion = reducedMotion();
    const narrow = stacked();
    // the still first: F 0295 and the strip, decoded, then shown (they fade in)
    void Promise.all([decode(poster), decode(strip)]).then(() => {
      if (!alive) return;
      el.style.setProperty('--film-strip', `url("${strip}")`);
      if (!anim) under.style.backgroundImage = `url("${poster}")`;
      el.dataset.still = '';
      update();
    });
    motion?.addEventListener('change', update);
    narrow?.addEventListener('change', update);
    document.addEventListener('visibilitychange', update);
    return () => {
      alive = false;
      stopLoad();
      anim?.cancel();
      cancelAnimationFrame(raf);
      motion?.removeEventListener('change', update);
      narrow?.removeEventListener('change', update);
      document.removeEventListener('visibilitychange', update);
    };
  }, [painted]);

  return (
    <aside ref={root} className="ent-film" aria-hidden="true" data-testid="brand-film">
      <span className="ent-film-logo">
        <Wordmark />
      </span>
      <div className="ent-pic">
        <span className="ent-pic-glow" />
        <div className="ent-frame">
          <span className="ent-frame-labels">
            <span>
              F <b data-f="">{pad(REST, 4)}</b>
            </span>
            <span data-tc="">{tc(REST)}</span>
            <span>
              {FPS} {t('fps')}
            </span>
          </span>
          <div className="ent-view">
            <span className="ent-layer" />
            <span className="ent-layer top" />
          </div>
        </div>
        <span className="ent-link" />
        <div className="ent-strip">
          <div className="ent-reel" style={{ left: 800 - (I0 * PITCH + PITCH / 2), width: COUNT * 2 * PITCH }}>
            {THUMBS.map((i) => (
              <span key={i} className="ent-th" style={{ left: i * PITCH + 4, backgroundPosition: thumbAt(i % COUNT) }} />
            ))}
          </div>
        </div>
        <span className="ent-gate" />
        <span className="ent-readout">
          <span data-tc="">{tc(REST)}</span>
          <span>
            F <b data-f="">{pad(REST, 4)}</b>
          </span>
        </span>
      </div>
      <p className="ent-film-cap">{caption}</p>
    </aside>
  );
}

// ---------------------------------------------------------------- the page

/**
 * The column is centred in its room once — when a screen opens, and again when the window changes size — and then stays
 * where it stood: what arrives or opens in it later (the fine print once the server has said what this server offers,
 * "Sign in an agent", a second line of an error, a form taking its loading state's place) grows downward and moves
 * nothing above it. Centred by the stylesheet alone, all of that lifted the heading and the fields by half of it. Phones
 * keep the column at the top (entrance.css: `--ent-hold: 0`).
 */
function useHeldColumn(main: RefObject<HTMLElement | null>, col: RefObject<HTMLElement | null>, screen: string) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new screen is centred anew
  useLayoutEffect(() => {
    const m = main.current;
    const c = col.current;
    const side = m?.parentElement;
    const root = m?.closest<HTMLElement>('.entrance');
    if (!m || !c || !side || !root) return;
    let width = -1;
    let height = -1;
    const place = () => {
      const s = getComputedStyle(m);
      if (s.getPropertyValue('--ent-hold').trim() === '0') {
        c.style.marginTop = '';
        return;
      }
      // The room: what scrolls (the side beside the film; stacked, the whole page under the film's band) less the top
      // bar, the foot and the main's own padding.
      const stacked = getComputedStyle(side).overflowY === 'visible';
      const film = stacked ? (root.querySelector<HTMLElement>('.ent-film')?.offsetHeight ?? 0) : 0;
      const bars = [...side.children].reduce((h, e) => (e === m ? h : h + (e as HTMLElement).offsetHeight), 0);
      const room = (stacked ? root : side).clientHeight - film - bars;
      const free = room - parseFloat(s.paddingTop) - parseFloat(s.paddingBottom) - c.offsetHeight;
      c.style.marginTop = `${Math.max(0, Math.floor(free / 2))}px`;
    };
    place();
    // the window, not what the column holds: the page's own box follows the window alone
    const ro = new ResizeObserver(() => {
      if (root.clientWidth === width && root.clientHeight === height) return;
      width = root.clientWidth;
      height = root.clientHeight;
      place();
    });
    ro.observe(root);
    return () => ro.disconnect();
  }, [main, col, screen]);
}

interface EntranceProps {
  /** The logo at the form's top (a link home on the owner's screens); shown where the panel isn't (phones). */
  logo: ReactNode;
  /** The quiet line at the foot: the owner's server · version · source, or a review link's "Powered by Lampo". */
  foot?: ReactNode;
  /** The film's caption (a review link's in the visitor's own address). */
  caption: string;
  /** Set once the way in worked: what isn't the form steps back while the next screen comes. */
  opening?: boolean;
  /** Extra class for a page's own styles (guest.css `invite`, auth.css `auth`). */
  className?: string;
  testid?: string;
  /** Which screen this is, where it isn't its testid: a screen's loading state and the screen itself share it, so the
   * column stays where the loading state put it (useHeldColumn). */
  screen?: string;
  /** The column: who shared or invites, the head, the form, the fine print. */
  children: ReactNode;
}

export function Entrance({ logo, foot, caption, opening, className = '', testid, screen, children }: EntranceProps) {
  const main = useRef<HTMLElement>(null);
  const col = useRef<HTMLDivElement>(null);
  useHeldColumn(main, col, screen ?? testid ?? '');
  return (
    <div className={`entrance ${className}`} data-opening={opening || undefined}>
      <Film caption={caption} />
      <div className="ent-side">
        <header className="ent-top">
          <span className="ent-top-logo">{logo}</span>
          <ThemeButton className="btn ghost icon-only ent-theme" />
        </header>
        <main ref={main} className="ent-main">
          <div ref={col} className="ent-col" data-testid={testid}>
            {children}
          </div>
        </main>
        {foot && <footer className="ent-foot">{foot}</footer>}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- the column's parts

/** Who shared the review, or who invites: their picture or initials, their name · the workspace, one line under it. */
export function EntranceFrom({ name, avatar, org, children }: { name: string; avatar?: string | null; org?: string | null; children: ReactNode }) {
  return (
    <p className="ent-from">
      <Avatar name={name} src={avatar} size={36} kind="person" />
      <span className="ent-from-t">
        <b>
          {name}
          {org ? <span> · {org}</span> : null}
        </b>
        <span>{children}</span>
      </span>
    </p>
  );
}

/** EntranceFrom while who it is is on the way: the picture's place and the two lines'. */
export function EntranceFromPending() {
  return (
    <p className="ent-from" aria-hidden="true">
      <Skeleton w={36} h={36} r="var(--r-full)" />
      <span className="ent-from-t">
        <b>
          <SkLine w="9em" />
        </b>
        <span>
          <SkLine w="13em" />
        </span>
      </span>
    </p>
  );
}

/** The title, one sentence under it, and above them a tile with the screen's sign where there is no form to fill. */
export function EntranceHead({ icon, title, children }: { icon?: IconName; title: ReactNode; children?: ReactNode }) {
  return (
    <div className="ent-head">
      {icon && (
        <span className="ent-tile" aria-hidden="true">
          <I name={icon} size={18} />
        </span>
      )}
      <h1>{title}</h1>
      {children && <p className="ent-lede">{children}</p>}
    </div>
  );
}

/** The quiet foot of the form: one short line (and what sits beside it), under a hairline; `after` opens below it. */
export function Fine({ children, after, testid }: { children: ReactNode; after?: ReactNode; testid?: string }) {
  return (
    <div className="ent-fine" data-testid={testid}>
      <div className="ent-fine-row">{children}</div>
      {after}
    </div>
  );
}

/** A "?" beside a short line that opens the one sentence it leaves out; a click elsewhere or Esc closes it. */
export function Qm({ children, side = 'end' }: { children: ReactNode; side?: 'start' | 'end' }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('pointerdown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span ref={ref} className={`ent-qm ${side}`}>
      <button type="button" className="ent-qm-b" aria-expanded={open} aria-controls={id} aria-label={t('More about this')} onClick={() => setOpen((o) => !o)}>
        ?
      </button>
      <span className="ent-qm-p" id={id} role="tooltip" hidden={!open}>
        {children}
      </span>
    </span>
  );
}

/** Each run of non-spaces unbroken (the browser would break after a `-`): a command breaks at its spaces only. */
const unbroken = (s: string) =>
  s.split(/(\s+)/).map((w, i) =>
    i % 2 || !w ? (
      w
    ) : (
      // biome-ignore lint/suspicious/noArrayIndexKey: the words of one command, in order
      <span key={i} className="ent-cmd-w">
        {w}
      </span>
    ),
  );

/**
 * A command to copy, light (a tinted line, never a black block): the command's name in the strong weight, then its
 * arguments, and Copy. One line where it fits; a phone too narrow for it breaks it at its spaces, never inside a word.
 */
export function Cmd({ name, args, label }: { name: string; args: string; label: string }) {
  const [done, setDone] = useState(false);
  const code = useRef<HTMLElement>(null);
  const text = `${name} ${args}`;
  const copy = async () => {
    if (await copyText(text)) {
      setDone(true);
      setTimeout(() => setDone(false), 1600);
      return;
    }
    // no clipboard here: the command selected, for the keyboard's copy
    const range = document.createRange();
    if (!code.current) return;
    range.selectNodeContents(code.current);
    getSelection()?.removeAllRanges();
    getSelection()?.addRange(range);
  };
  return (
    <div className="ent-cmd" title={label}>
      <code ref={code}>
        <b>{unbroken(name)}</b> {unbroken(args)}
      </code>
      <button type="button" className={`ent-copy${done ? ' done' : ''}`} onClick={copy} aria-label={t('Copy {label}', { label })}>
        <I name={done ? 'check' : 'copy'} size={13} />
        <span>{done ? t('Copied') : t('Copy')}</span>
      </button>
    </div>
  );
}

/** A disclosure in the fine print ("Sign in an agent"): its button for the row, its body for below it. */
export function useDisclosure() {
  const [open, setOpen] = useState(false);
  const id = useId();
  return {
    open,
    button: (icon: IconName, label: ReactNode) => (
      <button type="button" className="ent-disc" aria-expanded={open} aria-controls={id} onClick={() => setOpen((o) => !o)}>
        <I name={icon} size={13} />
        {label}
        <I name="down" size={13} className="ent-disc-chev" />
      </button>
    ),
    body: (children: ReactNode) => (
      <div className={`ent-disc-body${open ? ' open' : ''}`} id={id}>
        <div>{children}</div>
      </div>
    ),
  };
}

/** "Sent again" and the like: said once under the button that did it, with a keyframe for done; the line is kept. */
export function StatusLine({ children }: { children?: ReactNode }) {
  return (
    <p className="ent-status" aria-live="polite">
      {children ? (
        <>
          <KeyGlyph shape="diamond" size={10} />
          {children}
        </>
      ) : (
        ' '
      )}
    </p>
  );
}
