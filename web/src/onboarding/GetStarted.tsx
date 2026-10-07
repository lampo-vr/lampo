// Get started, its own chunk (onboarding/state.ts decides when it loads): a compact card above All videos — the steps
// on a keyframe track on the left, the selected step at work on the right (an accordion on a phone). Steps tick from
// what the server finds done (lib/onboarding.ts, GET /api/onboarding), never from a click here, and the card follows
// as it happens (the library, notes, agents connecting). Fold it to one line; × puts it away with Undo (the sidebar's
// row stays, onboarding/Row.tsx; the account menu's "Get started" brings the card back). Everything done: "You're set",
// a light sweeps the track once, it folds away. The sidebar's panel (Panel.tsx, this chunk too) shows the same panes.
//
// Nothing below the card moves while it's used: every step's pane is built the same way (its words, at most a measure
// wide, beside the step's picture) and all of them stand in one grid cell, only the selected one visible, so the pane
// is as tall as the tallest step at any width or language — and the room the card keeps while this chunk arrives
// (onboarding.css, .ob-pending) is that height by design. Its controls are the app's own (.input, ui/select.tsx) and
// its styles come with it (styles/getstarted.css): it never leans on another chunk's stylesheet.
import { type QueryClient, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { lampoFor } from '../../../lib/mcpConfig.ts';
import { compareTime } from '../../../lib/time.ts';
import type { OnboardingResponse, OnboardingStep, Role, SetupAgent, ShareInfo } from '../../../lib/types.ts';
import { pageLang, useAuthStatus, useCan } from '../api/auth.ts';
import { api, enc } from '../api/client.ts';
import { on } from '../api/events.ts';
import { useBilling, useInfo, useLibrary } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { loader, useLoaded } from '../lib/lazy.ts';
import { posterUrl } from '../lib/posterUrl.ts';
import { projectsOf } from '../lib/projects.ts';
import { toast, toastError } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { AGENTS, agentLabel, ConnectBlock, Mark, PickIcon, seenLine, useConnected, useWhere } from './connect.tsx';
import { linkVideos, makeProject, makeSample, onboardingKey, pickAgent, removeSample, setHidden, useFolders, useOnboarding } from './data.ts';
import { fromMenu, SideRow } from './Panel.tsx';
import { Cmd, CopyButton, isEmail, KG, Live, OIcon, SampleKeys, Track } from './parts.tsx';
import { StepPic } from './pictures.tsx';
import { connecting, type FirstRun, FOLD, readFold, useFirstRun } from './state.ts';
import '../styles/getstarted.css';

// for the account menu and the video menu, which load this chunk when they're used; the sidebar's row and its panel
export { fromMenu, removeSample, SideRow, setHidden };

export interface GetStartedProps {
  /** Adds a video the way the library does (the add dialog at the machine, else the file picker); null: may not. */
  add: (() => void) | null;
  /** Videos are uploaded here (not linked where they live: not at the machine). */
  upload: boolean;
}

type Named = OnboardingResponse['sample'];

/** The card and the sidebar's row follow what happens elsewhere: a video added, a note, an agent connecting, a return to
 * the tab. Listened to once, however many of them are on screen. */
let following = 0;
let unfollow: (() => void) | null = null;
export function useLive() {
  const qc = useQueryClient();
  useEffect(() => {
    if (following++ === 0) unfollow = follow(qc);
    return () => {
      if (--following > 0) return;
      unfollow?.();
      unfollow = null;
    };
  }, [qc]);
}

function follow(qc: QueryClient): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const soon = () => {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void qc.invalidateQueries({ queryKey: onboardingKey });
    }, 600);
  };
  const offs = [on('library', soon), on('review', soon), on('sessions', soon)];
  const back = () => document.visibilityState === 'visible' && soon();
  document.addEventListener('visibilitychange', back);
  return () => {
    for (const off of offs) off();
    document.removeEventListener('visibilitychange', back);
    if (timer) {
      clearTimeout(timer);
      void qc.invalidateQueries({ queryKey: onboardingKey });
    }
  };
}

/**
 * Whether focus came to a step by the keyboard. Chrome counts any key pressed after a click (Shift, as in ⌘⇧4 for a
 * screenshot) as keyboard use and rings the row the pointer picked; the ring belongs to moving through the steps by
 * keys, so it shows only once Tab or an arrow key moved focus (the list's data-keys).
 */
export function useKeysMoved(list: React.RefObject<HTMLOListElement | null>) {
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const keys = (e: KeyboardEvent) => {
      if (/^(Tab|Arrow|Home|End|PageUp|PageDown)/.test(e.key)) el.dataset.keys = '';
    };
    const pointer = () => delete el.dataset.keys;
    document.addEventListener('keydown', keys, true);
    el.addEventListener('pointerdown', pointer);
    return () => {
      document.removeEventListener('keydown', keys, true);
      el.removeEventListener('pointerdown', pointer);
    };
  }, [list]);
}

const keepFold = (v: boolean) => {
  try {
    if (v) localStorage.setItem(FOLD, '1');
    else localStorage.removeItem(FOLD);
  } catch {}
};

/** A step's title, named after the agent picked when there is one. */
export function titleOf(id: OnboardingStep, agent: SetupAgent | null | undefined, upload: boolean): string {
  switch (id) {
    case 'sample':
      return t('Try the sample');
    case 'agent':
      return agentLabel(agent) ? t('Connect {name}', { name: agentLabel(agent) ?? '' }) : t('Connect your agent');
    case 'video':
      return upload ? t('Add your first video') : t('Link your first video');
    case 'share':
      return t('Share a review link');
    case 'invite':
      return t('Invite a teammate');
    case 'note':
      return t('Leave a note on a frame');
    case 'check':
      return t('Check a fix');
    case 'approve':
      return t('Approve a version');
    case 'workspace':
      return t('Name your workspace');
    case 'project':
      return t('Start your first project');
    case 'agent_video':
      return agentLabel(agent) ? t('{name} puts up V1', { name: agentLabel(agent) ?? '' }) : t('Your agent puts up V1');
  }
}

/** The plan picked on the website before signing up, while the workspace pays nothing yet. */
function PlanLine({ plan }: { plan: string | null | undefined }) {
  const info = useInfo();
  const billing = useBilling(!!info?.billing && !!plan).data;
  if (!plan || !info?.billing || !billing || billing.state === 'paid') return null;
  const name =
    billing.offers?.find((o) => `cloud-${o.plan}` === plan || o.plan === plan)?.name ??
    { 'cloud-solo': 'Solo', 'cloud-team': 'Team', 'cloud-business': 'Business' }[plan];
  if (!name) return null;
  return (
    <a className="ob-gs-plan" href={`#/settings/billing?plan=${encodeURIComponent(plan)}`} data-testid="ob-plan">
      <KG shape="hold" />
      <span>{t('You picked {plan} · add a card any time', { plan: name })}</span>
    </a>
  );
}

/** Folds the card away for good once everything is done: its height eases to nothing, so the library rises once,
 * smoothly, instead of jumping (at once under reduced motion). */
function foldAway(el: HTMLElement | null): Promise<void> {
  if (!el) return Promise.resolve();
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const s = getComputedStyle(el);
  const a = el.animate(
    [
      { height: `${el.offsetHeight}px`, marginTop: s.marginTop, marginBottom: s.marginBottom, opacity: 1 },
      { height: '0px', marginTop: '0px', marginBottom: '0px', opacity: 0 },
    ],
    { duration: still ? 0 : 320, easing: 'cubic-bezier(0.65, 0, 0.35, 1)', fill: 'forwards' },
  );
  return a.finished.then(
    () => {},
    () => {},
  );
}

/** What the panes read, in the card and in the sidebar's panel alike: the sample and the newest real video (from the
 * library the page already has, the server's answer before it), the agent picked, what this account may do. */
export function usePaneCtx(props: GetStartedProps, data: OnboardingResponse | undefined): Omit<PaneCtx, 'where' | 'done'> {
  const run = useFirstRun();
  const can = useCan();
  const videos = useLibrary().data?.videos;
  const named = (v: { slug: string; name: string } | undefined) => (v ? { slug: v.slug, name: v.name } : null);
  const sampleV = videos?.find((v) => v.sample);
  const real = videos?.filter((v) => !v.sample && !v.archived).sort((a, b) => compareTime(b.added, a.added))[0];
  return {
    ...props,
    sample: data?.sample ?? (sampleV ? named(sampleV) : null),
    video: named(real),
    poster: real?.hash ? posterUrl(real) : null,
    badge: real ? `V${real.v}` : 'V1',
    agent: run.o?.agent ?? null,
    canSample: can('upload'),
    data: data ?? null,
  };
}

/** Where the sidebar's Get started row is, for what the card's × says: at a desk's sidebar foot, in the drawer's
 * (phones, tablets), or nowhere (an empty library has no sidebar: the account menu brings the card back). */
const rowPlace = (): 'sidebar' | 'menu' | null => {
  const nav = document.querySelector('.lib > .nav');
  return !nav ? null : nav.getClientRects().length ? 'sidebar' : 'menu';
};

export function GetStarted(props: GetStartedProps) {
  const qc = useQueryClient();
  const run: FirstRun = useFirstRun();
  const { data } = useOnboarding(run.shown);
  useLive();
  const card = useRef<HTMLElement>(null);
  const list = useRef<HTMLOListElement>(null);
  useKeysMoved(list);
  const steps = data?.onboarding ? data.steps : run.steps;
  const next = steps.find((s) => !s.done)?.id ?? null;
  const all = steps.length > 0 && !next;
  const [sel, setSel] = useState<OnboardingStep | null>(null);
  const [fold, setFold] = useState(readFold);
  const [ticked, setTicked] = useState<OnboardingStep | null>(null);
  const [paneIn, setPaneIn] = useState(false);
  const base = usePaneCtx(props, data);
  const agent = base.agent;
  // a step that ticks pops; the selection moves on to the next a moment later
  const doneKey = steps
    .filter((s) => s.done)
    .map((s) => s.id)
    .join(',');
  const prevDone = useRef(doneKey);
  useEffect(() => {
    if (prevDone.current === doneKey) return;
    const before = new Set(prevDone.current.split(','));
    prevDone.current = doneKey;
    const fresh = steps.find((s) => s.done && !before.has(s.id));
    if (!fresh) return;
    setTicked(fresh.id);
    // the last one keeps its pane through "You're set"
    const last = steps.every((s) => s.done);
    const tm = setTimeout(() => {
      setTicked(null);
      if (last) setSel((cur) => cur ?? fresh.id);
      else {
        setSel((cur) => (cur === fresh.id || !cur ? null : cur));
        setPaneIn(true);
      }
    }, 1100);
    return () => clearTimeout(tm);
  }, [doneKey, steps]);
  // everything done: "You're set" (the card keeps its size), the light sweeps once, then it folds away for good
  useEffect(() => {
    if (!all || !data?.onboarding) return;
    let live = true;
    const tm = setTimeout(() => {
      void foldAway(card.current).then(() => {
        if (!live) return;
        setHidden(qc, true).catch(toastError);
        toast(t('Get started is done. Everything it set up is in Settings.'), 'ok');
      });
    }, 3200);
    return () => {
      live = false;
      clearTimeout(tm);
    };
  }, [all, data?.onboarding, qc]);

  if (!steps.length) return null;
  const current = sel && steps.some((s) => s.id === sel) ? sel : (next ?? steps[steps.length - 1].id);
  const n = steps.length;
  const doneN = steps.filter((s) => s.done).length;
  const folded = fold && !all;
  const hide = async () => {
    const place = rowPlace();
    try {
      await setHidden(qc, true);
      // the sidebar's row stays (onboarding/Row.tsx): said where it is; without a sidebar the account menu has it
      const said =
        place === 'sidebar'
          ? t('Get started is put away. It stays at the foot of the sidebar.')
          : place === 'menu'
            ? t('Get started is put away. It stays at the foot of the menu.')
            : t('Get started is put away: your account menu brings it back.');
      toast(said, 'ok', {
        label: t('Undo'),
        undo: true,
        onClick: () => void setHidden(qc, false).catch(toastError),
      });
    } catch (e) {
      toastError(e);
    }
  };
  const pick = (id: OnboardingStep) => {
    if (id === current) return;
    setSel(id);
    setPaneIn(true);
  };
  const ctx: Omit<PaneCtx, 'where'> = { ...base, done: false };
  // every step's pane in one cell, the selected one shown: the cell is as tall as the tallest (onboarding.css)
  const panes = (where: string) =>
    steps.map((s) => {
      const on = s.id === current;
      return (
        <div
          key={s.id}
          className={`ob-gs-slot ${on ? 'ob-on' : ''} ${on && paneIn ? 'ob-in' : ''}`}
          inert={!on}
          aria-hidden={on ? undefined : true}
          data-slot={s.id}
          onAnimationEnd={on ? (e) => e.target === e.currentTarget && setPaneIn(false) : undefined}
        >
          <Pane id={s.id} ctx={{ ...ctx, done: s.done, where }} />
        </div>
      );
    });
  return (
    <section
      ref={card}
      className={`ob-gs ${folded ? 'ob-fold' : ''} ${all ? 'ob-all' : ''} ${connecting(agent, steps) ? 'ob-tall' : ''}`}
      aria-label={t('Get started')}
      data-testid="ob-gs"
    >
      <div className="ob-gs-head">
        <h2 className="ob-gs-title">
          {all ? t('You’re set') : t('Get started')}
          <small data-testid="ob-count">{t('{done} of {n}', { done: doneN, n })}</small>
        </h2>
        <Track items={steps.map((s) => ({ done: s.done, now: s.id === next }))} />
        <span className="ob-grow">
          {next && folded && (
            <span className="ob-gs-next">
              {t('Next:')} <b>{titleOf(next, agent, props.upload)}</b>
            </span>
          )}
          <span className="ob-gs-set">{t('Notes on frames, agents that fix them, links for anyone: the loop is yours.')}</span>
          {!folded && !all && <PlanLine plan={run.o?.plan} />}
        </span>
        {!all && (
          <button
            type="button"
            className="ob-ibtn"
            onClick={() => {
              setFold(!folded);
              keepFold(!folded);
            }}
            aria-expanded={!folded}
            aria-label={folded ? t('Open Get started') : t('Fold Get started')}
            data-testid="ob-fold"
          >
            <I name="down" size={16} className={folded ? '' : 'ob-flip'} />
          </button>
        )}
        <button type="button" className="ob-ibtn" onClick={hide} aria-label={t('Put Get started away')} data-testid="ob-hide">
          <I name="x" size={16} />
        </button>
      </div>
      <div className="ob-gs-body">
        <ol className="ob-gs-list" ref={list}>
          {steps.map((s) => (
            <li key={s.id}>
              <button
                type="button"
                className={`ob-gs-row ${s.done ? 'ob-done' : ''} ${ticked === s.id ? 'ob-ticked' : ''}`}
                onClick={() => pick(s.id)}
                aria-current={current === s.id ? 'step' : undefined}
                data-step={s.id}
                data-done={s.done || undefined}
                data-testid="ob-step"
              >
                <KG shape={s.done ? 'diamond' : 'outline'} />
                <span>{titleOf(s.id, agent, props.upload)}</span>
                <span className="ob-when">{s.done ? t('Done') : ''}</span>
              </button>
              {current === s.id && <div className="ob-gs-acc">{panes('acc')}</div>}
            </li>
          ))}
        </ol>
        <div className="ob-gs-pane" data-testid="ob-pane" data-pane={current}>
          {panes('pane')}
        </div>
      </div>
      {!props.upload && run.variant === 'local' && (
        <div className="ob-gs-later">
          <OIcon name="package" size={16} />
          <span>
            <b>{t('Later: take it to a server or Lampo Cloud.')}</b>{' '}
            <T k="<0>vr export</0> packs every review into one file, with its notes, frames and versions." tags={[(c) => <code>{c}</code>]} />
          </span>
          <CopyButton text="vr export ~/lampo-move.tar" />
        </div>
      )}
    </section>
  );
}

export interface PaneCtx extends GetStartedProps {
  done: boolean;
  sample: Named;
  video: { slug: string; name: string } | null;
  /** The newest real video's poster (the picture of a step about it), and its version. */
  poster: string | null;
  badge: string;
  agent: SetupAgent | null;
  canSample: boolean;
  data: OnboardingResponse | null;
  /** Which copy of the pane this is: the desk's pane or the phone's accordion (ids inside must differ). */
  where: string;
}

/**
 * One step's pane, built the same way for every step: the headline and the line under it, what the step needs (keys,
 * a status, a list), its actions, what it says back (done, an error), and the step's picture beside the words.
 */
function Step({
  title,
  mark,
  lede,
  children,
  acts,
  said,
  pic,
}: {
  title: ReactNode;
  mark?: ReactNode;
  lede?: ReactNode;
  children?: ReactNode;
  acts?: ReactNode;
  said?: ReactNode;
  pic: ReactNode;
}) {
  return (
    <div className="ob-gs-do">
      <div className="ob-gs-text">
        <h3 className={mark ? 'ob-gs-h ob-with-mark' : 'ob-gs-h'}>
          {mark && <span className="ob-mk">{mark}</span>}
          {title}
        </h3>
        {lede && <p className="ob-gs-lede">{lede}</p>}
        {children}
        {acts && <div className="ob-gs-acts">{acts}</div>}
        {said}
      </div>
      <div className="ob-gs-pic" aria-hidden="true">
        {pic}
      </div>
    </div>
  );
}

const DoneNote = ({ children }: { children: ReactNode }) => (
  <p className="ob-gs-done-note">
    <span className="ob-gs-done-g">
      <KG />
    </span>
    <span>{children}</span>
  </p>
);

/** Where the sample opens: check mode on its fix. */
export const sampleHref = (s: NonNullable<Named>) => `#/v/${encodeURIComponent(s.slug)}${s.check ? `?verify=${encodeURIComponent(s.check)}` : ''}`;

export function Pane({ id, ctx }: { id: OnboardingStep; ctx: PaneCtx }) {
  switch (id) {
    case 'sample':
      return <SamplePane ctx={ctx} />;
    case 'project':
      return <ProjectPane ctx={ctx} />;
    case 'agent':
      return <AgentPane ctx={ctx} />;
    case 'agent_video':
      return <AgentVideoPane ctx={ctx} />;
    case 'video':
      return ctx.upload ? <UploadPane ctx={ctx} /> : <LinkPane ctx={ctx} />;
    case 'share':
      return <SharePane ctx={ctx} />;
    case 'invite':
      return <InvitePane ctx={ctx} />;
    default:
      return <PlainPane id={id} ctx={ctx} />;
  }
}

/** A reviewer's steps (a note, an approval): what to do, and the newest video to do it on. */
function PlainPane({ id, ctx }: { id: OnboardingStep; ctx: PaneCtx }) {
  // (a check and the workspace's name are steps no role has today: their headline alone)
  const lede =
    id === 'note'
      ? t('Press C on the frame where something should change. The note stays on that exact frame, in every version after it.')
      : id === 'approve'
        ? t('When a version is right, approve it. Everyone sees the video move on.')
        : null;
  return (
    <Step
      title={titleOf(id, ctx.agent, ctx.upload)}
      lede={lede}
      acts={
        !ctx.done &&
        ctx.video && (
          <a className="ob-btn ob-raised" href={`#/v/${encodeURIComponent(ctx.video.slug)}`}>
            {t('Open {name}', { name: ctx.video.name })}
          </a>
        )
      }
      said={ctx.done && <DoneNote>{t('Done.')}</DoneNote>}
      pic={<StepPic kind={id === 'approve' || id === 'check' ? 'approve' : 'note'} poster={ctx.poster} />}
    />
  );
}

function SamplePane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const [making, setMaking] = useState(false);
  const name = agentLabel(ctx.agent) ?? t('your agent');
  const make = async () => {
    setMaking(true);
    try {
      const slug = await makeSample(qc);
      location.hash = `#/v/${encodeURIComponent(slug)}`;
    } catch (e) {
      toastError(e);
    } finally {
      setMaking(false);
    }
  };
  return (
    <Step
      title={t('Try the sample')}
      lede={t('A short video already in review. A note asked for a fix, {agent} made it in V2, and it waits for your check. One minute.', { agent: name })}
      acts={
        ctx.sample ? (
          <a className={`ob-btn ${ctx.done ? '' : 'ob-raised'}`} href={sampleHref(ctx.sample)} data-testid="ob-open-sample">
            <I name="play" size={13} />
            {ctx.done ? t('Open it again') : t('Open the sample')}
          </a>
        ) : (
          ctx.canSample && (
            <button type="button" className="ob-btn ob-raised" onClick={make} disabled={making} data-testid="ob-sample-make">
              <I name="play" size={13} />
              {making ? t('Making the sample…') : t('Try it with a sample')}
            </button>
          )
        )
      }
      pic={<StepPic kind="sample" />}
    >
      {ctx.done ? <DoneNote>{t('You checked a fix and answered the agent. That’s the loop.')}</DoneNote> : <SampleKeys />}
    </Step>
  );
}

function AgentPane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const where = useWhere();
  const projects = projectsOf(useLibrary().data);
  const pick = ctx.agent;
  const connected = useConnected(pick);
  const label = agentLabel(pick) ?? '';
  // connected now, or once (the step is done): what it does, and that it's there
  if (pick && pick !== 'none' && (connected || ctx.done))
    return (
      <Step
        title={connected ? t('{name} is connected', { name: label }) : titleOf('agent', pick, ctx.upload)}
        mark={<Mark id={pick} size={16} />}
        lede={t('It reads a note the moment it’s sent, fixes the video and puts up V2. You check.')}
        said={!connected && <DoneNote>{t('{name} connected', { name: label })}</DoneNote>}
        pic={<StepPic kind="agent" on mark={<Mark id={pick} size={12} />} />}
      >
        {connected && <Live on label={label} sub={seenLine(connected, !!where?.atMachine)} />}
      </Step>
    );
  if (!pick || pick === 'none' || !where)
    return (
      <Step
        title={t('Connect your agent')}
        lede={t('Claude Code, Codex, Cursor or any MCP client reads your notes, fixes the video and answers here. Which one?')}
        pic={<StepPic kind="agent" />}
      >
        <fieldset className="ob-picks" aria-label={t('Your agent')}>
          {AGENTS()
            .filter((x) => x.id !== 'none')
            .map((x) => (
              <button key={x.id} type="button" onClick={() => pickAgent(qc, x.id).catch(toastError)} data-agent={x.id}>
                <PickIcon id={x.id} />
                {x.label}
              </button>
            ))}
        </fieldset>
      </Step>
    );
  // picked, not connected yet: the connect block in its compact form, its live status first, under the headline
  return (
    <Step
      title={t('Connect {name}', { name: pick === 'other' ? t('any MCP client') : label })}
      mark={<Mark id={pick} size={16} />}
      pic={<StepPic kind="agent" mark={<Mark id={pick} size={12} />} />}
    >
      <ConnectBlock
        pick={pick}
        where={where}
        connected={connected}
        project={projects[0] ?? null}
        headless
        more={
          <button type="button" className="ob-lk" onClick={() => pickAgent(qc, 'none').catch(toastError)} data-testid="ob-agent-change">
            {t('Another agent')}
          </button>
        }
      />
    </Step>
  );
}

/** The first project: a name and Create (as the sidebar's New project); the agent is told to use Lampo for it. */
function ProjectPane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const projects = projectsOf(useLibrary().data);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const make = async () => {
    if (!name.trim()) return;
    setBusy(true);
    try {
      const made = await makeProject(qc, name);
      setName('');
      toast(t('{name} is ready for your agent', { name: made }), 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const id = `ob-gs-project-${ctx.where}`;
  return (
    <Step
      title={t('Start your first project')}
      lede={t('One film, campaign or channel. Your agent puts its versions here, and every note stays on its frame.')}
      said={ctx.done && <DoneNote>{projects[0] ? t('{name} is ready: your agent puts its V1 there.', { name: projects[0] }) : t('Done.')}</DoneNote>}
      pic={<StepPic kind="project" name={projects[0] ?? null} />}
    >
      {!ctx.done && (
        <form
          className="ob-gs-inline"
          onSubmit={(e) => {
            e.preventDefault();
            void make();
          }}
        >
          <label className="sr-only" htmlFor={id}>
            {t('Project name')}
          </label>
          <input
            id={id}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('Spring launch')}
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            data-testid="ob-gs-project-name"
          />
          <button type="submit" className="ob-btn ob-raised" disabled={busy || !name.trim()} data-testid="ob-gs-project-make">
            <I name="folderPlus" size={14} />
            {t('Create project')}
          </button>
        </form>
      )}
    </Step>
  );
}

/**
 * The agent puts up V1: the one sentence that sets it to work, for the newest project, and where it stands — connected,
 * waiting for its render — until its version lands (the step ticks). Adding a video yourself is the second choice; the
 * sample fills the wait.
 */
function AgentVideoPane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const where = useWhere();
  const pick = ctx.agent && ctx.agent !== 'none' ? ctx.agent : null;
  const connected = useConnected(pick);
  const project = projectsOf(useLibrary().data)[0] ?? null;
  const name = agentLabel(pick) ?? t('your agent');
  const [making, setMaking] = useState(false);
  const sample = async () => {
    if (ctx.sample) {
      location.hash = sampleHref(ctx.sample);
      return;
    }
    setMaking(true);
    try {
      location.hash = `#/v/${encodeURIComponent(await makeSample(qc))}`;
    } catch (e) {
      toastError(e);
    } finally {
      setMaking(false);
    }
  };
  if (ctx.done)
    return (
      <Step
        title={titleOf('agent_video', pick, ctx.upload)}
        mark={pick ? <Mark id={pick} size={16} /> : undefined}
        lede={t('Pin your notes on its frames and send them: they go to {agent}, and it puts up the next version.', { agent: name })}
        acts={
          ctx.video && (
            <a className="ob-btn ob-raised" href={`#/v/${encodeURIComponent(ctx.video.slug)}`} data-testid="ob-open-v1">
              {t('Open {name}', { name: ctx.video.name })}
            </a>
          )
        }
        said={<DoneNote>{ctx.video ? t('{name} is in review.', { name: ctx.video.name }) : t('Done.')}</DoneNote>}
        pic={
          ctx.poster ? (
            <StepPic kind="video" poster={ctx.poster} badge={ctx.badge} />
          ) : (
            <StepPic kind="agent" on mark={pick ? <Mark id={pick} size={12} /> : null} />
          )
        }
      />
    );
  const state = connected?.state;
  return (
    <Step
      title={titleOf('agent_video', pick, ctx.upload)}
      mark={pick ? <Mark id={pick} size={16} /> : undefined}
      lede={
        project
          ? t('Tell it this. It renders, puts up V1 in {project} and waits for your notes.', { project })
          : t('Tell it this. It renders, puts up V1 in a project and waits for your notes.')
      }
      acts={
        <>
          {ctx.add && (
            <button type="button" className="ob-btn" onClick={ctx.add} data-testid="ob-act-video">
              <I name={ctx.upload ? 'upload' : 'plus'} size={14} />
              {t('Add a video yourself')}
            </button>
          )}
          {(ctx.sample || ctx.canSample) && (
            <button type="button" className="ob-lk" onClick={() => void sample()} disabled={making} data-testid="ob-v1-sample">
              {making ? t('Making the sample…') : t('Meanwhile: try the sample')}
            </button>
          )}
        </>
      }
      pic={<StepPic kind="agent" on={!!connected} mark={pick ? <Mark id={pick} size={12} /> : null} />}
    >
      <Cmd text={lampoFor(project)} testid="ob-v1-tell" />
      {pick && where && (
        <Live
          compact
          on={!!connected}
          label={agentLabel(pick) ?? t('your MCP client')}
          sub={
            !connected
              ? t('connect it first: the step before')
              : state === 'working'
                ? t('working on it')
                : state === 'listening'
                  ? t('waiting for your notes')
                  : seenLine(connected, where.atMachine)
          }
          testid="ob-v1-live"
        />
      )}
    </Step>
  );
}

function UploadPane({ ctx }: { ctx: PaneCtx }) {
  return (
    <Step
      title={t('Add your first video')}
      lede={t('Every note you pin stays on its exact frame, in every version after it.')}
      acts={
        !ctx.done &&
        ctx.add && (
          <>
            <button type="button" className="ob-btn ob-raised" onClick={ctx.add} data-testid="ob-act-video">
              <I name="upload" size={14} />
              {t('Upload video')}
            </button>
            <span className="ob-fine">{t('or drop a file anywhere on the library')}</span>
          </>
        )
      }
      said={
        ctx.done && (
          <DoneNote>
            {ctx.video
              ? t('{name} is in the library. Pin a note on a frame: press C where something should change.', { name: ctx.video.name })
              : t('Your video is in. Pin a note on a frame: press C where something should change.')}
          </DoneNote>
        )
      }
      pic={ctx.done && ctx.poster ? <StepPic kind="video" poster={ctx.poster} badge={ctx.badge} /> : <StepPic kind="drop" />}
    />
  );
}

function LinkPane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const info = useInfo();
  const folders = useFolders(!ctx.done).data?.folders ?? [];
  const f = folders[0];
  const tilde = (p: string) => (info?.home && p.startsWith(`${info.home}/`) ? `~${p.slice(info.home.length)}` : p);
  const pic = ctx.done && ctx.poster ? <StepPic kind="video" poster={ctx.poster} badge={ctx.badge} /> : <StepPic kind="file" />;
  if (ctx.done)
    return (
      <Step
        title={t('Link your first video')}
        lede={t('Pick a file where it is. Nothing is copied.')}
        said={<DoneNote>{t('Linked where it is. Export to the same path again and it arrives as V2.')}</DoneNote>}
        pic={pic}
      />
    );
  return (
    <Step
      title={t('Link your first video')}
      lede={f ? t('Pick a file where it is, in {folder}. Nothing is copied.', { folder: tilde(f.path) }) : t('Pick a file where it is. Nothing is copied.')}
      acts={
        !f &&
        ctx.add && (
          <button type="button" className="ob-btn ob-raised" onClick={ctx.add} data-testid="ob-act-video">
            <I name="plus" size={14} />
            {t('Add video')}
          </button>
        )
      }
      pic={pic}
    >
      {f && (
        <ul className="ob-gs-files">
          {f.files.slice(0, 3).map((x) => (
            <li key={x.path}>
              <OIcon name="file" size={14} />
              <b>{x.name}</b>
              <button
                type="button"
                className="ob-btn ob-sm ob-raised"
                onClick={() => linkVideos(qc, [x.path]).then(() => toast(t('{name} is linked', { name: x.name }), 'ok'), toastError)}
                data-testid="ob-link-one"
              >
                {t('Link')}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Step>
  );
}

function SharePane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const info = useInfo();
  const ws = useAuthStatus().data?.workspace;
  const [link, setLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const target = ctx.video ?? ctx.sample;
  const base = info?.mode === 'server' ? (info.public_url || location.origin).replace(/\/+$/, '') : (info?.urls?.[0] ?? location.origin).replace(/\/+$/, '');
  const make = async () => {
    if (!target) return;
    setBusy(true);
    try {
      const s = await api<ShareInfo>(`/api/review/${enc(target.slug)}/shares`, { method: 'POST', body: {} });
      setLink(`${base}/g/${s.token}`);
      // the step ticks at once, here and in the sidebar's row
      void qc.invalidateQueries({ queryKey: onboardingKey });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const lede =
    info?.mode === 'server' && ws?.personas?.includes('agency')
      ? t('Send someone a review link. They watch and pin notes to frames, no account needed.')
      : ws?.personas?.includes('inhouse')
        ? t('Send a review link to anyone outside the team: legal, a partner, the CEO. No account needed.')
        : ws?.personas?.length === 1 && ws.personas[0] === 'creator'
          ? t('Send a cut to your editor or a friend. They pin notes to frames, no account needed.')
          : t('Anyone with the link watches and pins notes to frames, no account needed.');
  let host = location.host;
  try {
    host = new URL(base).host;
  } catch {}
  return (
    <Step
      title={t('Share a review link')}
      lede={lede}
      acts={
        !link &&
        !ctx.done &&
        target && (
          <button type="button" className="ob-btn ob-raised" onClick={make} disabled={busy} data-testid="ob-make-link">
            <I name="link" size={14} />
            {t('Create a review link for {name}', { name: target.name })}
          </button>
        )
      }
      said={
        link ? (
          <p className="ob-fine">
            {info?.mode === 'server'
              ? t('They see {name} as the sender. Notes land in your inbox.', { name: ws?.name ?? '' })
              : t('It opens on your network, or anywhere once the tunnel is on.')}
          </p>
        ) : (
          ctx.done && <DoneNote>{t('Link made. When they open it, you’ll see it here.')}</DoneNote>
        )
      }
      pic={<StepPic kind="share" poster={ctx.poster} host={host} />}
    >
      {link && <Cmd text={link} testid="ob-share-link" />}
    </Step>
  );
}

/** The app's select (Radix) comes after the card: the first paint's list of what Get started needs stays short. */
const selectCode = loader(() => import('../ui/select.tsx'));

/** The role: the app's select once its code is here, until then the same trigger, standing still (ui/select.tsx). */
function RoleSelect({ value, onChange }: { value: Role; onChange: (r: Role) => void }) {
  const S = useLoaded(selectCode)?.Select;
  if (S) return <S label={t('Role')} value={value} onChange={(r) => onChange(r as Role)} options={ROLES()} />;
  return (
    <button type="button" className="input select" aria-label={t('Role')} disabled>
      <span className="select-sizer">
        {ROLES().map((o) => (
          <span key={o.value} aria-hidden>
            {o.label}
          </span>
        ))}
        <span>{ROLES().find((o) => o.value === value)?.label}</span>
      </span>
    </button>
  );
}

const ROLES = (): { value: Role; label: string }[] => [
  { value: 'member', label: t('Member') },
  { value: 'reviewer', label: t('Reviewer') },
  { value: 'admin', label: t('Admin') },
];

function InvitePane({ ctx }: { ctx: PaneCtx }) {
  const qc = useQueryClient();
  const run = useFirstRun();
  const me = useAuthStatus().data?.user?.name ?? '';
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>(
    run.variant === 'cloud' && run.personas.includes('inhouse') && !run.personas.includes('agency') ? 'reviewer' : 'member',
  );
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const info = useInfo();
  const mailless = !info?.mail || info.mail_transport === 'log';
  const field = useRef<HTMLInputElement>(null);
  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const v = email.trim();
    if (!isEmail(v)) {
      setErr(v ? t('That doesn’t look like an email address.') : t('Type their email first.'));
      setShake((n) => n + 1);
      field.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await api('/api/admin/invites', { method: 'POST', body: { role, email: v, ...(mailless ? {} : { send: true, lang: pageLang() }) } });
      toast(mailless ? t('Invite made for {email}: Settings → Users has its link', { email: v }) : t('Invite sent to {email}', { email: v }), 'ok');
      setEmail('');
      void qc.invalidateQueries({ queryKey: onboardingKey });
    } catch (er) {
      toastError(er);
    } finally {
      setBusy(false);
    }
  };
  const id = `ob-gs-invite-${ctx.where}`;
  return (
    <Step
      title={t('Invite a teammate')}
      lede={t('They get an account of their own, with the role you choose.')}
      said={
        ctx.done ? (
          <DoneNote>{t('Your invite is out. They get an account of their own.')}</DoneNote>
        ) : (
          <p className="ob-gs-err" id={`${id}-err`} role="alert">
            {err}
          </p>
        )
      }
      pic={<StepPic kind="team" me={me} done={ctx.done} />}
    >
      {!ctx.done && (
        <form className="ob-gs-invite" onSubmit={send} noValidate>
          <input
            ref={field}
            key={shake}
            className={`input ob-gs-email ${shake ? 'ob-gs-shake' : ''}`}
            type="email"
            name="email"
            value={email}
            placeholder={t('jonas@northwind.studio')}
            autoComplete="off"
            spellCheck={false}
            aria-label={t('Their email')}
            aria-invalid={err ? true : undefined}
            aria-describedby={err ? `${id}-err` : undefined}
            onChange={(e) => {
              setEmail(e.target.value);
              if (err) setErr('');
            }}
            data-testid="ob-invite-email"
          />
          <RoleSelect value={role} onChange={setRole} />
          <button type="submit" className="ob-btn ob-raised" disabled={busy} data-testid="ob-invite-send">
            {t('Invite')}
          </button>
        </form>
      )}
    </Step>
  );
}
