// The setup a new account sees first (#/welcome[/<step>]), before the library: Welcome, then a few steps, every one of
// them skippable — Lampo Cloud: name the workspace, who the videos are for, the agent (connected right here, live), the
// team; the machine: where renders land, the agent found on it, the sample; a self-hosted server: name it, check it,
// invite the team, connect agents; an invited teammate: the agent. Split like the entrance: the light table on the
// left (pictures.tsx), one decision on the right, on a keyframe track with Back and "Skip setup". What each step
// changes is stored as it happens (the workspace's name and personas, the agent picked, invites); finishing or skipping
// marks the setup done (PUT /api/onboarding) and opens the library, where Get started takes over.
import { useQueryClient } from '@tanstack/react-query';
import { type JSX, type ReactNode, useEffect, useRef, useState } from 'react';
import { type SetupStep, setupStepsFor } from '../../../lib/setupFlow.ts';
import type { Persona, SetupAgent } from '../../../lib/types.ts';
import { authKeys, useAuthStatus } from '../api/auth.ts';
import { useInfo } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { toastError } from '../lib/toast.ts';
import { I, Wordmark } from '../ui/icons.tsx';
import { pickAgent, useOnboarding } from './data.ts';
import { Health } from './Health.tsx';
import { Track } from './parts.tsx';
import { LightTable } from './pictures.tsx';
import { useFirstRun } from './state.ts';
import { AgentStep, finish, Persona as PersonaStep, Renders, Try, Welcome, Workspace } from './steps.tsx';
import { type InviteRow, Team } from './Team.tsx';
import '../styles/setup.css';

/** What the steps share while the setup runs (Back keeps it): typed, picked, sent. */
export interface SetupState {
  ws: string | null;
  personas: Persona[] | null;
  personaOther: string;
  agent: SetupAgent | null;
  rows: InviteRow[] | null;
  /** The renders folder picked (the machine). */
  folder: string | null;
}

export interface StepProps {
  s: SetupState;
  set: (p: Partial<SetupState>) => void;
  /** On to the next step (or the library after the last). */
  next: () => void;
  /** The step after this one is the library. */
  last: boolean;
  /** Renders the frame around the step: its picture and its column. */
  frame: (f: Frame) => JSX.Element;
}

export interface Frame {
  picture: ReactNode;
  pictureId: string;
  caption: string;
  body: ReactNode;
  wide?: boolean;
  cls?: string;
  sending?: boolean;
}

export default function Setup({ step }: { step: string | null }) {
  const qc = useQueryClient();
  const status = useAuthStatus().data;
  const info = useInfo();
  const run = useFirstRun();
  const o = run.o;
  const [s, setS] = useState<SetupState>({ ws: null, personas: null, personaOther: '', agent: o?.agent ?? null, rows: null, folder: null });
  const set = (p: Partial<SetupState>) => setS((cur) => ({ ...cur, ...p }));
  // the server's answer: who invited (an invited teammate's Welcome), the sample to open (the machine's last step)
  useOnboarding(!!status?.user);
  const personas = s.personas ?? run.personas;
  const steps = setupStepsFor(run.variant, personas);
  const at: 'welcome' | SetupStep = step && (steps as string[]).includes(step) ? (step as SetupStep) : 'welcome';
  const idx = at === 'welcome' ? -1 : steps.indexOf(at);
  // which way the column comes in: from the side it was asked from
  const prev = useRef<{ at: string; idx: number } | null>(null);
  const dir = prev.current && prev.current.at !== at ? (idx < prev.current.idx ? 'back' : 'next') : null;
  const fresh = !prev.current || prev.current.at !== at;
  useEffect(() => {
    prev.current = { at, idx };
  });
  useEffect(() => {
    document.title = t('Welcome · {name}', { name: 'Lampo' });
  }, []);
  // a new step: when the button that brought it (Back, Continue) went with the old one, focus moves to the new step's
  // headline, so the keyboard goes on from there, not from the top of the page
  const col = useRef<HTMLDivElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a step change is what moves the focus
  useEffect(() => {
    if (!prev.current) return;
    const a = document.activeElement;
    if (a && a !== document.body && a.isConnected) return;
    const h = col.current?.querySelector<HTMLElement>('h1');
    if (!h) return;
    h.tabIndex = -1;
    h.focus({ preventScroll: true });
  }, [at]);

  const go = (to: SetupStep | 'welcome') => {
    location.hash = to === 'welcome' ? '#/welcome' : `#/welcome/${to}`;
  };
  const next = () => {
    if (at === 'welcome') return steps[0] ? go(steps[0]) : finish(qc);
    const after = steps[idx + 1];
    if (after) go(after);
    else finish(qc);
  };
  const back = () => go(idx > 0 ? steps[idx - 1] : 'welcome');
  const skip = () => finish(qc);
  const choose = (agent: SetupAgent) => {
    set({ agent });
    pickAgent(qc, agent).catch(toastError);
  };

  const user = status?.user;
  // a status made from a sign-in's answer doesn't say which workspace the session works in (it decides the variant):
  // the server is asked for the whole one first
  const complete = !!status && (status.mode === 'local' || status.via === 'local' || !!status.workspace);
  useEffect(() => {
    if (status?.user && !complete) void qc.invalidateQueries({ queryKey: authKeys.status });
  }, [status?.user, complete, qc]);
  const host = (() => {
    try {
      return info?.public_url ? new URL(info.public_url).host : location.host;
    } catch {
      return location.host;
    }
  })();
  const foot = run.variant === 'local' ? `${host} · v${info?.version ?? ''} · AGPL-3.0` : run.variant === 'server' ? `${host} · v${info?.version ?? ''}` : host;
  const email = user?.email && !user.email.endsWith('@localhost') ? user.email : null;

  const frame = (f: Frame) => (
    <div className={`ob-scr ${f.cls ?? ''}`} data-testid="ob-setup" data-step={at} data-variant={run.variant}>
      <div className="ob-su">
        <PanelSlot f={f} fresh={fresh && at !== 'welcome'} />
        <section className="ob-su-form">
          <header className="ob-su-top">
            <span className="ob-su-top-l">
              <Wordmark />
              {at !== 'welcome' && (
                <button type="button" className="ob-lk ob-back-l" onClick={back} data-testid="ob-back">
                  <I name="back" size={14} />
                  <span>{t('Back')}</span>
                </button>
              )}
            </span>
            {idx >= 0 ? <Track items={steps.map((_, i) => ({ done: i < idx, now: i === idx }))} /> : <span />}
            {at !== 'welcome' ? (
              <button type="button" className="ob-btn ob-ghost ob-skip" onClick={skip} data-testid="ob-skip">
                {/* one phrase per language (German puts the verb last), the short one where the bar is narrow */}
                <span className="ob-hide-s">{t('Skip setup')}</span>
                <span className="ob-show-s">{t('Skip')}</span>
              </button>
            ) : (
              <span />
            )}
          </header>
          <main className="ob-su-main">
            <div ref={col} className={`ob-su-col ${dir ? (dir === 'back' ? 'ob-in-back' : 'ob-in-next') : ''} ${f.wide ? 'ob-wide' : ''}`} key={at}>
              {f.body}
            </div>
          </main>
          <footer className="ob-su-foot">
            <span>{foot}</span>
            {email && (
              <>
                <i aria-hidden="true">·</i>
                <span>{email}</span>
              </>
            )}
          </footer>
        </section>
      </div>
    </div>
  );

  const props: StepProps = { s, set, next, last: at !== 'welcome' && idx === steps.length - 1, frame };
  if (!user || !complete) return null;
  switch (at) {
    case 'welcome':
      return <Welcome {...props} variant={run.variant} steps={steps} onSkip={skip} />;
    case 'workspace':
      return <Workspace {...props} variant={run.variant} />;
    case 'persona':
      return <PersonaStep {...props} />;
    case 'agent':
    case 'agents':
      return <AgentStep {...props} variant={run.variant} id={at} onPick={choose} />;
    case 'team':
      return <Team {...props} variant={run.variant} personas={personas} />;
    case 'renders':
      return <Renders {...props} />;
    case 'try':
      return <Try {...props} />;
    case 'health':
      return <Health {...props} />;
  }
}

/** The light table: the step's picture (the entrance's panel family; its own drawing until the two share one part). */
function PanelSlot({ f, fresh }: { f: Frame; fresh: boolean }) {
  return (
    <LightTable id={f.pictureId} caption={f.caption} fresh={fresh} sending={f.sending}>
      {f.picture}
    </LightTable>
  );
}
