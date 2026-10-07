// The setup's left panel, the light table: one picture per step, drawn on a 640 × 520 sheet and fitted to the panel by
// its own content's box (so a small picture fills the panel as well as a wide one). Paper sheets in the light theme,
// glass over a warm lamp in the dark; the frames are stills of Lampo's brand film (the entrance's, 0266–0325 at 24 fps),
// static files the build emits and the browser loads with the picture. Motion only where it says something: the loop's
// slow crossfade (V1 ⇄ V2), the agent's one crossfade when it connects, the team's rows and planes, the health check's
// playhead — all still under reduced motion (lighttable.css). Styles: styles/lighttable.css.
import { type CSSProperties, type ReactNode, useLayoutEffect, useRef } from 'react';
import { t } from '../i18n/index.ts';
import type { Shape } from '../ui/glyphs.ts';
import { BrandMark, I, Wordmark } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import f0266 from './frames/f0266.webp';
import f0281 from './frames/f0281.webp';
import f0295 from './frames/f0295.webp';
import f0311 from './frames/f0311.webp';
import { initialsOf, nameOf, OAv, OIcon } from './parts.tsx';
import '../styles/lighttable.css';

const FRAMES: Record<number, string> = { 266: f0266, 281: f0281, 295: f0295, 311: f0311 };
const bg = (f: number): CSSProperties => ({ backgroundImage: `url("${FRAMES[f] ?? f0295}")` });
const pad4 = (n: number) => String(n).padStart(4, '0');
const tc24 = (f: number) => {
  const s = Math.floor(f / 24);
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(Math.floor(s / 60) % 60)}:${p(s % 60)}:${p(f % 24)}`;
};

/** The film's title, set as the sample sets it (footage, not UI: it stays in English, as burned into the sample). */
export const TITLE = 'Every mile, on the record.';

// ---------------------------------------------------------------- the panel

/** Fits the picture's own content (not the whole 640 × 520 sheet) into the panel, centred. */
function fit(pnl: HTMLElement) {
  const r = pnl.getBoundingClientRect();
  const pic = pnl.querySelector<HTMLElement>('.ob-pic');
  if (!r.width || !r.height || !pic) return;
  let L = 640;
  let T = 520;
  let R = 0;
  let B = 0;
  for (const c of Array.from(pic.children) as HTMLElement[]) {
    if (c.matches('.ob-lt-glow, .ob-lt-svg')) continue;
    if (!c.offsetWidth || !c.offsetHeight) continue;
    L = Math.min(L, c.offsetLeft);
    T = Math.min(T, c.offsetTop);
    R = Math.max(R, c.offsetLeft + c.offsetWidth);
    B = Math.max(B, c.offsetTop + c.offsetHeight);
  }
  if (R <= L) return;
  const band = r.height < 360;
  const availW = band ? r.width - 24 : r.width * 0.84;
  const availH = band ? r.height - 20 : r.height * 0.7;
  // the caps keep a picture from looming on a laptop; a wide panel (1920 and up) lets it grow with the room
  const cap = (pic.querySelector('.ob-wscard') ? 1.2 : 1.5) * Math.max(1, r.width / 1000);
  const s = Math.max(0.3, Math.min(cap, availW / (R - L), availH / (B - T)));
  pnl.style.setProperty('--s', s.toFixed(3));
  pnl.style.setProperty('--dx', `${((320 - (L + R) / 2) * s).toFixed(1)}px`);
  pnl.style.setProperty('--dy', `${((260 - (T + B) / 2) * s).toFixed(1)}px`);
}

/**
 * The light table: the logo, the step's picture, a caption. `id` names the picture: a new one fades in (`fresh`), the
 * same one updates in place (a name typed, an agent connecting).
 */
export function LightTable({ id, caption, fresh, sending, children }: { id: string; caption: string; fresh: boolean; sending?: boolean; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the picture is measured again whenever what it shows changes
  useLayoutEffect(() => {
    const pnl = ref.current;
    if (!pnl) return;
    fit(pnl);
    const ro = new ResizeObserver(() => fit(pnl));
    ro.observe(pnl);
    return () => ro.disconnect();
  }, [id, children]);
  return (
    <aside ref={ref} className="ob-pnl" aria-hidden="true" data-testid="ob-panel" data-picture={id}>
      <span className="ob-pnl-logo">
        <Wordmark />
      </span>
      <div className={`ob-pic ${fresh ? 'ob-in' : ''} ${sending ? 'ob-sending' : ''}`}>{children}</div>
      <p className="ob-pnl-cap">{caption}</p>
    </aside>
  );
}

const Glow = () => <span className="ob-lt-glow" />;

// ---------------------------------------------------------------- the frames

/** A frame on the table: the mat, its number and timecode, a still of the film. */
function Frame({
  x,
  y,
  w,
  h,
  f = 295,
  className = '',
  lit,
  fx,
  style,
  children,
  tag,
}: {
  x: number;
  y: number;
  w: number;
  h: number;
  f?: number;
  className?: string;
  lit?: boolean;
  fx?: number;
  style?: CSSProperties;
  children?: ReactNode;
  tag?: string;
}) {
  return (
    <div className={`ob-fr ${className}`} style={{ left: x, top: y, width: w + 20, height: h + 33, ...style }}>
      <span className="ob-fr-top">
        <span>
          F <b style={lit ? undefined : { color: 'inherit' }}>{pad4(f)}</b>
        </span>
        <span>{tc24(f)}</span>
      </span>
      <span className="ob-fr-img" style={{ ...bg(f), ...(fx != null ? ({ '--fx': `${fx}%` } as CSSProperties) : {}) }}>
        {children}
      </span>
      {tag && <span className="ob-pf-tag">{tag}</span>}
    </div>
  );
}

/** The loop as two clean states of one frame: V1, the title over the car and a note pinned on the car; then the frame
 * breathes over to V2, the title on the hill, and the note becomes "Looks right". mode: `cycle` (V1 ⇄ V2, slowly),
 * `once` (V1, then V2 and rest), `v1`, `v2`. */
export function Loop({
  x = 40,
  y = 70,
  w = 560,
  mode,
  cap,
  mark,
}: {
  x?: number;
  y?: number;
  w?: number;
  mode: 'cycle' | 'once' | 'v1' | 'v2';
  cap?: ReactNode;
  mark?: ReactNode;
}) {
  const vh = Math.round(((w - 24) * 308) / 720);
  const h = vh + 38;
  return (
    <>
      <div className={`ob-lp ob-${mode}`} style={{ left: x, top: y, width: w, height: h }} data-testid="ob-loop" data-mode={mode}>
        <span className="ob-lp-lab">
          <span>
            F <b>0295</b> · 00:12:07
          </span>
          <span className="ob-lp-v">
            <span className="ob-a">V1</span>
            <span className="ob-b">V2</span>
          </span>
        </span>
        <div className="ob-lp-view">
          <span className="ob-lp-a" style={bg(295)}>
            <span className="ob-ttl ob-t1">{TITLE}</span>
          </span>
          <span className="ob-lp-b" style={bg(295)}>
            <span className="ob-ttl ob-t2">
              Every mile,
              <br />
              on the record.
            </span>
          </span>
          <span className="ob-lp-pin">
            <i className="ob-dot" />
            <span className="ob-lp-note ob-a">
              <OAv text="AL" />
              {t('The title covers the car')}
            </span>
            <span className="ob-lp-note ob-b">
              <I name="check" size={12} />
              {t('Looks right')}
            </span>
          </span>
        </div>
      </div>
      {cap && (
        <span className="ob-loop-cap ob-lp-cap" style={{ left: x, width: w, top: y + h + 26 }}>
          {mark && <span className="ob-cap-mark">{mark}</span>}
          {cap}
        </span>
      )}
    </>
  );
}

/** The small loop in Get started's pictures: the two states of one frame (cycling, or held at V1 or V2), the pin
 * without its note. */
export function MiniLoop({ mode = 'cycle' }: { mode?: 'cycle' | 'v1' | 'v2' }) {
  return (
    <div className={`ob-lp ob-mini ob-${mode}`}>
      <div className="ob-lp-view">
        <span className="ob-lp-a" style={bg(295)}>
          <span className="ob-ttl ob-t1">{TITLE}</span>
        </span>
        <span className="ob-lp-b" style={bg(295)}>
          <span className="ob-ttl ob-t2">
            Every mile,
            <br />
            on the record.
          </span>
        </span>
        <span className="ob-lp-pin">
          <i className="ob-dot" />
        </span>
      </div>
      <span className="ob-vb ob-lp-v">
        <span className="ob-a">V1</span>
        <span className="ob-b">V2</span>
      </span>
    </div>
  );
}

export type StepPicKind = 'sample' | 'drop' | 'file' | 'project' | 'video' | 'agent' | 'team' | 'share' | 'note' | 'approve';

/** A keyframe on the picture's timeline lane, at a share of its length. */
const Key = ({ at, shape = 'diamond', tone }: { at: number; shape?: Shape; tone?: string }) => (
  <span className="ob-smp-key" style={{ left: `${at}%` }}>
    <KeyGlyph shape={shape} className={tone ? `ob-t-${tone}` : ''} />
  </span>
);

/**
 * Get started's picture beside each step's words: one frame on its timeline lane, the same size for every step, the
 * step told on it — the sample's loop; where a first video lands (then the video itself); the note waiting for an
 * agent, which turns it into V2 once one is connected; a teammate's pin beside yours; the frame as a review link opens
 * it; a note; an approval. Decoration: the words beside it say the same (the pane hides it from assistive tech).
 */
export function StepPic({
  kind,
  poster,
  badge = 'V1',
  on,
  mark,
  me = '',
  done,
  host,
  name,
}: {
  kind: StepPicKind;
  /** The person's own video, where the step is about it. */
  poster?: string | null;
  badge?: string;
  /** agent: connected. */
  on?: boolean;
  /** agent: its mark. */
  mark?: ReactNode;
  /** team: the person's name (their initials pin). */
  me?: string;
  /** team: the invite is out. */
  done?: boolean;
  /** share: the host the link opens on. */
  host?: string;
  /** project: its name, once there is one. */
  name?: string | null;
}) {
  const still = (f: number) => (poster ? <img src={poster} alt="" decoding="async" /> : <span className="ob-smp-still" style={bg(f)} />);
  let thumb: ReactNode = null;
  let lane: ReactNode = null;
  let slot = false;
  switch (kind) {
    case 'sample':
      thumb = <MiniLoop />;
      lane = (
        <>
          <Key at={28} shape="circle" tone="idea" />
          <Key at={77} shape="half" tone="ok" />
          <Key at={88} shape="ease" tone="ask" />
        </>
      );
      break;
    case 'agent':
      thumb = (
        <>
          <MiniLoop mode={on ? 'v2' : 'v1'} />
          {mark && <span className="ob-smp-who">{mark}</span>}
        </>
      );
      lane = on ? <Key at={48.6} shape="half" tone="ok" /> : <Key at={48.6} tone="must" />;
      break;
    case 'note':
      thumb = <MiniLoop mode="v1" />;
      lane = <Key at={48.6} tone="must" />;
      break;
    case 'approve':
      thumb = (
        <>
          <MiniLoop mode="v2" />
          <span className="ob-smp-chip">
            <I name="check" size={12} />
            {t('Approved')}
          </span>
        </>
      );
      lane = (
        <>
          <Key at={28} shape="half" tone="ok" />
          <Key at={48.6} shape="half" tone="ok" />
        </>
      );
      break;
    case 'drop':
      slot = true;
      thumb = (
        <>
          <I name="upload" size={20} />
          <span>{t('Drop a video here')}</span>
        </>
      );
      break;
    case 'project':
      slot = true;
      thumb = (
        <>
          <I name={name ? 'folderOpen' : 'folderPlus'} size={20} />
          <span>{name ?? t('Your project')}</span>
        </>
      );
      break;
    case 'file':
      slot = true;
      thumb = (
        <>
          <OIcon name="file" size={20} />
          <span>{t('Linked where it is')}</span>
        </>
      );
      break;
    case 'video':
      thumb = (
        <>
          {still(295)}
          <span className="ob-smp-vb">{badge}</span>
        </>
      );
      lane = <Key at={40} shape="outline" />;
      break;
    case 'team':
      thumb = (
        <>
          {still(281)}
          <span className="ob-smp-pin ob-at-me">
            <OAv text={initialsOf(me || '?')} />
          </span>
          <span className={`ob-smp-pin ob-at-mate ${done ? '' : 'ob-ghost'}`}>
            <I name={done ? 'check' : 'plus'} size={12} />
          </span>
        </>
      );
      lane = (
        <>
          <Key at={30} tone="must" />
          <Key at={66} shape={done ? 'diamond' : 'outline'} tone={done ? 'should' : undefined} />
        </>
      );
      break;
    case 'share':
      thumb = (
        <>
          {still(266)}
          <span className="ob-smp-go">
            <I name="play" size={12} />
            {t('Review')}
          </span>
        </>
      );
      lane = (
        <>
          <I name="link" size={12} />
          <span>{host ? `${host}/g/…` : '/g/…'}</span>
        </>
      );
      break;
  }
  return (
    <div className={`ob-smp-card ob-pic-${kind}`} data-pic={kind}>
      <div className={`ob-smp-thumb ${slot ? 'ob-slot' : ''}`}>{thumb}</div>
      <div className={`ob-smp-lane ${kind === 'share' ? 'ob-url' : ''} ${slot ? 'ob-slot' : ''}`}>{lane}</div>
    </div>
  );
}

// ---------------------------------------------------------------- the pictures

/** Welcome and Try it: the loop, cycling. */
export const SceneLoop = ({ cap }: { cap: string }) => (
  <>
    <Glow />
    <Loop mode="cycle" cap={cap} />
  </>
);

/** The agent step: the loop held at V1, "Waiting for X"; once X connects it plays over to V2 once. */
export function SceneAgent({
  label,
  mark,
  state,
}: {
  label: string | null;
  mark: ReactNode;
  /** none: nothing picked; none-yet: "None yet"; offline/blocked: it can't show up here; waiting; connected. */
  state: 'none' | 'none-yet' | 'offline' | 'blocked' | 'waiting' | 'connected' | 'just';
}) {
  const mode = state === 'just' ? 'once' : state === 'connected' ? 'v2' : 'v1';
  const cap =
    state === 'none' ? (
      t('Your agent turns the note into V2')
    ) : state === 'none-yet' ? (
      t('Any agent, when you’re ready')
    ) : state === 'blocked' ? (
      t('{name} needs an https address', { name: label ?? '' })
    ) : state === 'offline' ? (
      t('{name} starts its own server here', { name: label ?? '' })
    ) : state === 'waiting' ? (
      t('Waiting for {name}', { name: label ?? '' })
    ) : (
      <span className="ob-ok">{t('{name} connected', { name: label ?? '' })}</span>
    );
  return (
    <>
      <Glow />
      <Loop mode={mode} cap={cap} mark={state === 'none' || state === 'none-yet' ? undefined : mark} />
    </>
  );
}

/** The workspace step: the name where people will meet it — the invite, a review link, the switcher. */
export function SceneWorkspace({ name, ownerName, host, sub, from }: { name: string; ownerName: string; host: string; sub: string; from: string }) {
  return (
    <>
      <Glow />
      <div className="ob-sheet ob-prev-mail" style={{ left: 176, top: 44, transform: 'rotate(-1.5deg)' }}>
        <span className="ob-from">
          <BrandMark size={16} />
          <span>Lampo &lt;{from}&gt;</span>
        </span>
        <h4>{t('You’re invited')}</h4>
        <p>{t('You’re invited to {host} as a member: review, upload, organise, share and hand work to agents.', { host })}</p>
        <p>
          {t('From an account named “{name}”, for a workspace named', { name: ownerName })} “
          <span className="ob-bound" data-bind="ws">
            {name}
          </span>
          ”.
        </p>
        <span className="ob-ink">{t('Accept the invite')}</span>
      </div>
      <div className="ob-sheet ob-prev-link" style={{ left: 372, top: 236, transform: 'rotate(2deg)' }}>
        <span className="ob-who">
          <OAv text={initialsOf(ownerName)} />
          <span>
            <b className="ob-bound" data-bind="ws">
              {name}
            </b>{' '}
            {t('shared')}
            <br />
            {t('Coast film · director’s cut')}
          </span>
        </span>
        <span className="ob-frame" style={{ ...bg(311), backgroundSize: 'cover', backgroundPosition: 'center' }} />
        <span className="ob-go-s">
          {t('Open the review')} <I name="right" size={12} />
        </span>
      </div>
      <div className="ob-sheet ob-prev-sw" style={{ left: 44, top: 282, transform: 'rotate(-1deg)' }}>
        <div className="ob-prev-h">{t('Workspaces')}</div>
        <Switcher name={name} sub={sub} />
        <div className="ob-prev-row ob-add">
          <span className="ob-ws-mark">
            <I name="plus" size={13} />
          </span>
          <span>{t('New workspace')}</span>
        </div>
      </div>
    </>
  );
}

/** One row of the switcher: the workspace's mark, its name, the check, the line under it (also under the field on a
 * phone, where the light table is a slim band). */
export function Switcher({ name, sub }: { name: string; sub: string }) {
  return (
    <div className="ob-prev-row ob-on">
      <span className="ob-ws-mark" data-bind="wsi">
        {initialsOf(name)}
      </span>
      <b className="ob-bound" data-bind="ws">
        {name}
      </b>
      <I name="check" size={14} />
      <small>{sub}</small>
    </div>
  );
}

/** Who the videos are for: three frames, the picked ones forward. */
export function ScenePersona({ picked, other }: { picked: string[]; other: string | null }) {
  const any = picked.length > 0 || other !== null;
  const cls = (k: string) => `ob-pf ${any ? (picked.includes(k) ? 'ob-on' : 'ob-dim') : ''}`;
  const lift = (k: string): CSSProperties | undefined => (picked.includes(k) ? { transform: 'translateY(-12px) scale(1.04)' } : undefined);
  return (
    <>
      <Glow />
      <Frame x={20} y={196} w={200} h={112} f={295} className={cls('agency')} style={lift('agency')} lit={picked.includes('agency')} tag={t('Link review')}>
        <span className="ob-ov-chip" style={{ left: 8, bottom: 8 }}>
          <span className="ob-av" aria-hidden="true">
            <I name="link" size={10} />
          </span>
          {t('Review link · 2 notes')}
        </span>
      </Frame>
      <Frame
        x={256}
        y={196}
        w={200}
        h={112}
        f={311}
        className={cls('inhouse')}
        style={lift('inhouse')}
        lit={picked.includes('inhouse')}
        tag={t('Team approval')}
      >
        <span className="ob-ov-chip" style={{ left: 8, bottom: 8 }}>
          <KeyGlyph shape="diamond" className="ob-t-ok" />
          {t('Approved · Legal')}
        </span>
      </Frame>
      <Frame
        x={492}
        y={116}
        w={108}
        h={192}
        f={281}
        fx={47}
        className={cls('creator')}
        style={lift('creator')}
        lit={picked.includes('creator')}
        tag={t('Shorts · 9:16')}
      >
        <span className="ob-safe" />
        <span className="ob-ov-chip" style={{ left: 6, top: 6 }}>
          9:16
        </span>
      </Frame>
      {other !== null && (
        <span className="ob-loop-cap" style={{ left: 20, width: 580, top: 400 }}>
          {t('And')} <b>{other.trim() || t('something else')}</b>
        </span>
      )}
    </>
  );
}

export interface TeamRow {
  email: string;
  role: string;
}

/** The team step: the workspace as a card of a stable height — you, three invitee slots (empty ones are ghosts) and a
 * footer that counts the rest as a stack of faces. Each invite carries a paper plane; on Send the planes fly. */
export function SceneTeam({
  name,
  sub,
  me,
  invitees,
  mailless,
}: {
  name: string;
  sub: string;
  me: { name: string; email: string };
  invitees: TeamRow[];
  mailless: boolean;
}) {
  const n = invitees.length;
  const shown = invitees.slice(0, 3);
  const rest = invitees.slice(3);
  return (
    <>
      <Glow />
      <div className="ob-sheet ob-wscard ob-team" style={{ left: 140, top: 70, width: 360 }} data-testid="ob-team-card">
        <div className="ob-wsc-h">
          <span className="ob-ws-mark">{initialsOf(name)}</span>
          <b>{name}</b>
          <span className="ob-cnt-s">{t('{n} person|{n} people', { n: n + 1 })}</span>
          <small>{sub}</small>
        </div>
        <ul className="ob-wsc-list">
          <li className="ob-wsc-row ob-owner">
            <OAv text={initialsOf(me.name)} />
            <span className="ob-wsc-n">
              <b>{me.name}</b>
              <small>{me.email}</small>
            </span>
            <span className="ob-wsc-role">
              {t('Owner')}
              <i>{t('you')}</i>
            </span>
          </li>
          {shown.map((r, i) => (
            <li key={r.email} className="ob-wsc-row ob-arrive" style={{ animationDelay: `${60 + i * 60}ms` }}>
              <OAv text={initialsOf(r.email)} />
              <span className="ob-wsc-n">
                <b>{nameOf(r.email) || r.email}</b>
                <small>{r.email}</small>
              </span>
              <span className="ob-wsc-role">
                {r.role}
                <i className="ob-plane">
                  <I name="send" size={11} />
                  {t('ready')}
                </i>
              </span>
            </li>
          ))}
          {Array.from({ length: 3 - shown.length }, (_, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the empty slots hold their places
            <li key={`g${i}`} className="ob-wsc-row ob-ghost">
              <span className="ob-av ob-ghost" />
              <span className="ob-wsc-n">
                <b className="ob-gbar" />
                <small className="ob-gbar" />
              </span>
              <span className="ob-wsc-role" />
            </li>
          ))}
        </ul>
        <div className="ob-wsc-foot">
          {n ? (
            <>
              {rest.length ? (
                <span className="ob-stack">
                  {rest.slice(0, 3).map((r) => (
                    <OAv key={r.email} text={initialsOf(r.email)} />
                  ))}
                  {rest.length > 3 && <span className="ob-av ob-more">+{rest.length - 3}</span>}
                </span>
              ) : (
                <I name="send" size={12} />
              )}
              <span>
                {rest.length > 0 && (
                  <>
                    <b>{t('{n} more', { n: rest.length })}</b> ·{' '}
                  </>
                )}
                {t('{n} invite ready to send|{n} invites ready to send', { n })}
              </span>
            </>
          ) : (
            <>
              <KeyGlyph shape="outline" />
              <span>{mailless ? t('Invites become links you send') : t('Invites go out by email')}</span>
            </>
          )}
        </div>
      </div>
    </>
  );
}

/** The invited teammate's Welcome: the workspace they joined, who invited them, the team's faces. */
export function SceneJoin({
  workspace,
  host,
  inviter,
  people,
  me,
}: {
  workspace: string;
  host: string;
  inviter: { name: string; role: string } | null;
  people: string[];
  me: { name: string; email: string; role: string };
}) {
  const rows: { name: string; email: string; role: string; state?: ReactNode; cls?: string }[] = [
    ...(inviter ? [{ name: inviter.name, email: '', role: inviter.role, state: t('invited you'), cls: 'ob-owner' }] : []),
    ...people
      .filter((p) => p !== inviter?.name && p !== me.name)
      .slice(0, 2)
      .map((p) => ({ name: p, email: '', role: '' })),
    {
      name: me.name,
      email: me.email,
      role: me.role,
      state: (
        <>
          <KeyGlyph shape="diamond" className="ob-t-ok" />
          {t('joined')}
        </>
      ),
      cls: 'ob-you ob-arrive',
    },
  ];
  const count = people.length || rows.length;
  return (
    <>
      <Glow />
      <div className="ob-sheet ob-wscard" style={{ left: 148, top: 96, width: 344 }}>
        <div className="ob-wsc-h">
          <span className="ob-ws-mark">{initialsOf(workspace)}</span>
          <b>{workspace}</b>
          <span className="ob-cnt-s">{t('{n} person|{n} people', { n: count })}</span>
          <small>{host}</small>
        </div>
        <ul className="ob-wsc-list">
          {rows.map((r) => (
            <li key={`${r.name}-${r.cls ?? ''}`} className={`ob-wsc-row ${r.cls ?? ''}`}>
              <OAv text={initialsOf(r.name)} />
              <span className="ob-wsc-n">
                <b>{r.name}</b>
                {r.email && <small>{r.email}</small>}
              </span>
              <span className="ob-wsc-role">
                {r.role}
                {r.state && <i>{r.state}</i>}
              </span>
            </li>
          ))}
        </ul>
      </div>
      {inviter && (
        <span className="ob-lt-l" style={{ left: 148, top: 66 }}>
          {t('Invited by')} <b>{inviter.name}</b> · {t('as a {role}', { role: me.role.toLowerCase() })}
        </span>
      )}
    </>
  );
}

/** The renders step: a folder on this machine, a file linked where it is, its next version waiting dashed. */
export function SceneRenders({ path, files, picked }: { path: string; files: { name: string; meta: string }[]; picked: boolean }) {
  const first = files[0];
  return (
    <>
      <Glow />
      <svg className="ob-lt-svg" viewBox="0 0 640 520" aria-hidden="true">
        <path className={`ob-wire ${picked ? 'ob-on' : ''}`} d="M344 170 C380 170 372 214 404 214" />
        <path className={`ob-arrow ${picked ? 'ob-on' : ''}`} d="M402 209 l7 5 -7 5z" />
      </svg>
      <div className="ob-sheet ob-prev-dir" style={{ left: 40, top: 104, ...(picked ? {} : { opacity: 0.7 }) }}>
        <div className="ob-dh">
          <I name="folder" size={14} />
          {path}
        </div>
        <ul>
          {files.slice(0, 6).map((x, i) => (
            <li key={x.name} className={picked && i < 4 ? 'ob-on' : ''}>
              <OIcon name="file" size={13} />
              <span>{x.name}</span>
              <small>{x.meta}</small>
            </li>
          ))}
        </ul>
      </div>
      <div className="ob-fr ob-dashed" style={{ left: 436, top: 150, width: 160, height: 110 }} />
      <Frame x={412} y={172} w={160} h={69} f={311} lit />
      <span className="ob-lt-l" style={{ left: 412, top: 290 }}>
        <b>V1</b> · {first?.name ?? 'film.mp4'}
      </span>
      <span className="ob-lt-l" style={{ left: 448, top: 132 }}>
        {t('V2 · export to the same path')}
      </span>
      <span className="ob-lt-l" style={{ left: 40, top: 104 + 46 + Math.min(6, files.length) * 26 + 22 }}>
        {t('Linked where it is · nothing copied')}
      </span>
    </>
  );
}

/**
 * The project step: the project as a folder on the table — its playbook and its notes — and the place its V1 lands,
 * still empty: the agent puts it there.
 */
export function SceneProject({ name, agent }: { name: string; agent: string | null }) {
  return (
    <>
      <Glow />
      <svg className="ob-lt-svg" viewBox="0 0 640 520" aria-hidden="true">
        <path className="ob-wire ob-on" d="M344 190 C380 190 372 234 404 234" />
        <path className="ob-arrow ob-on" d="M402 229 l7 5 -7 5z" />
      </svg>
      <div className="ob-sheet ob-prev-dir" style={{ left: 40, top: 124 }}>
        <div className="ob-dh">
          <I name="folder" size={14} />
          {name}
        </div>
        <ul>
          <li className="ob-on">
            <I name="film" size={13} />
            <span>V1</span>
            <small>{agent ? t('from {name}', { name: agent }) : t('from your agent')}</small>
          </li>
          <li>
            <I name="playbook" size={13} />
            <span>{t('Playbook')}</span>
            <small>{t('brief · rules')}</small>
          </li>
          <li>
            <I name="notes" size={13} />
            <span>{t('Notes')}</span>
            <small>{t('on exact frames')}</small>
          </li>
        </ul>
      </div>
      <div className="ob-fr ob-dashed" style={{ left: 412, top: 192, width: 180, height: 102 }} />
      <span className="ob-lt-l" style={{ left: 412, top: 306 }}>
        <b>V1</b> · {agent ? t('{name} puts it here', { name: agent }) : t('your agent puts it here')}
      </span>
    </>
  );
}

export type CheckState = 'idle' | 'run' | 'ok' | 'warn';
export const CHECKS = [
  { id: 'url', icon: 'globe', at: 18 },
  { id: 'storage', icon: 'disk', at: 40 },
  { id: 'mail', icon: 'mail', at: 62 },
  { id: 'speech', icon: 'mic', at: 84 },
] as const;
export type CheckId = (typeof CHECKS)[number]['id'];

/** The server's checks as channels in a graph editor: a lane per check, its keyframe filling as the playhead passes. */
export function SceneHealth({
  host,
  states,
  names,
  speechPct,
}: {
  host: string;
  states: Record<CheckId, CheckState>;
  names: Record<CheckId, string>;
  speechPct: number;
}) {
  const finished = CHECKS.filter((c) => states[c.id] === 'ok' || states[c.id] === 'warn');
  const last = finished.length ? finished[finished.length - 1].at + 6 : 0;
  const phx = 150 + (last / 100) * 410;
  return (
    <>
      <Glow />
      <span className="ob-ch-host">
        <I name="lock" size={14} />
        {host}
      </span>
      <span className="ob-ch-ruler" />
      <div className="ob-ch">
        {CHECKS.map((c) => {
          const s = states[c.id];
          const fill = c.id === 'speech' && s === 'run' ? speechPct : s === 'ok' || s === 'warn' ? 100 : 0;
          return (
            <div key={c.id} className="ob-ch-row">
              <span className="ob-ch-name">
                <OIcon name={c.icon} size={14} />
                {names[c.id]}
              </span>
              <span className="ob-ch-lane">
                <span className="ob-fill" style={{ '--p': `${c.id === 'speech' ? fill : s === 'idle' ? 0 : c.at}%` } as CSSProperties} />
                <span className={`ob-ch-key ${s === 'ok' ? 'ob-ok' : s === 'warn' ? 'ob-warn' : ''}`} style={{ left: `${c.at}%` }}>
                  <KeyGlyph shape={s === 'ok' ? 'diamond' : s === 'warn' ? 'half' : 'outline'} size={14} />
                </span>
              </span>
            </div>
          );
        })}
        <span className="ob-ch-ph" style={{ left: phx }} />
      </div>
    </>
  );
}
