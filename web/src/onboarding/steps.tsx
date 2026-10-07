// The setup's steps (Setup.tsx frames them): Welcome, the workspace's name, who the videos are for, the agent, where
// renders land (the machine), the sample (the machine). The team's invites and a server's health check have files of
// their own (Team.tsx, Health.tsx). Each step stores what it changes as it goes; none blocks the way on.
import { type QueryClient, useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { personaKinds, type SetupVariant } from '../../../lib/onboarding.ts';
import { PERSONAS, type SetupStep, setupStepsFor } from '../../../lib/setupFlow.ts';
import type { AuthStatus, MyWorkspace, Persona as PersonaKind, SetupAgent } from '../../../lib/types.ts';
import { authKeys, useAgents, useAuthStatus } from '../api/auth.ts';
import { api } from '../api/client.ts';
import { useBilling, useBrowse, useInfo, useLibrary } from '../api/queries.ts';
import { useRenameWorkspace, workspacesKey } from '../api/workspaces.ts';
import { perLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { projectsOf } from '../lib/projects.ts';
import { toast, toastError } from '../lib/toast.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { AgentTiles, agentLabel, ConnectBlock, isPick, Mark, setupOf, useConnected, useConnectToast, useWhere } from './connect.tsx';
import { finishSetup, linkVideos, makeProject, useFolders, useOnboarding } from './data.ts';
import { KG, Said, SampleKeys } from './parts.tsx';
import { SceneAgent, SceneJoin, SceneLoop, ScenePersona, SceneProject, SceneRenders, SceneWorkspace, Switcher } from './pictures.tsx';
import type { StepProps } from './Setup.tsx';
import { useFirstRun } from './state.ts';

/** The setup is over: marked done (at once in this page, the server told on the way) and the library opens. */
export function finish(qc: QueryClient, to = '#/') {
  finishSetup(qc).catch(toastError);
  location.hash = to;
}

/** The first name, for a greeting. */
const firstName = (name: string | undefined) => (name || '').trim().split(/\s+/)[0] || '';

/** "Mac" where the browser says it runs on one, else "computer" (the app runs on Linux and Windows too). */
const onMac = () => /Mac/i.test(navigator.platform || navigator.userAgent);

/** The host people see this app at (the public address's, or the page's). */
export function useHost(): string {
  const info = useInfo();
  try {
    return info?.public_url ? new URL(info.public_url).host : location.host;
  } catch {
    return location.host;
  }
}

/** A workspace on a trial: its plan's name and the days left (a billing provider runs here); null otherwise. */
export function useTrial(): { plan: string; days: number } | null {
  const info = useInfo();
  const billing = useBilling(!!info?.billing).data;
  if (billing?.state !== 'trial') return null;
  const days = billing.trialEndsAt ? Math.max(0, Math.ceil((new Date(billing.trialEndsAt).getTime() - Date.now()) / 86_400_000)) : 14;
  return { plan: billing.planName, days };
}

/** Who the workspace's videos are for (owners and admins): the workspace as the server answered goes into the status. */
export async function savePersonas(qc: QueryClient, personas: PersonaKind[], personaOther: string): Promise<void> {
  const r = await api<{ workspace: MyWorkspace }>('/api/workspaces/current/persona', {
    method: 'PUT',
    body: { personas, ...(personas.includes('other') && personaOther.trim() ? { personaOther: personaOther.trim() } : {}) },
  });
  qc.setQueryData<AuthStatus>(authKeys.status, (s) =>
    s ? { ...s, workspace: r.workspace, workspaces: s.workspaces?.map((w) => (w.id === r.workspace.id ? r.workspace : w)) } : s,
  );
  void qc.invalidateQueries({ queryKey: workspacesKey });
}

const roleWord = (r: string) => ({ owner: t('Owner'), admin: t('Admin'), member: t('Member'), reviewer: t('Reviewer') })[r] ?? r;

// ---------------------------------------------------------------- Welcome

export function Welcome({ frame, next, variant, steps, onSkip }: StepProps & { variant: SetupVariant; steps: SetupStep[]; onSkip: () => void }) {
  const status = useAuthStatus().data;
  const user = status?.user;
  const ws = status?.workspace;
  const host = useHost();
  const trial = useTrial();
  const invitedBy = useOnboarding(true).data?.invited_by ?? null;
  const first = firstName(user?.name);
  const inv = variant === 'invited';
  // Enter starts (anywhere but a button or a field: they have their own Enter)
  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (e.key !== 'Enter' || e.metaKey || e.ctrlKey || el?.closest?.('button, a, input, textarea, select, [role=dialog]')) return;
      e.preventDefault();
      next();
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, [next]);

  const lines: ReactNode[] = {
    cloud: [
      <T k="<0>Name</0> your workspace" key="1" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Who</0> the videos are for" key="2" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Your first project</0>, for your agent’s V1" key="3" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Which agent</0> you use" key="4" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Who</0> works with you" key="5" tags={[(c) => <b>{c}</b>]} />,
    ],
    local: [
      <T k="<0>Where</0> your exports land" key="1" tags={[(c) => <b>{c}</b>]} />,
      onMac() ? (
        <T k="<0>Your agent</0>, found on this Mac" key="2" tags={[(c) => <b>{c}</b>]} />
      ) : (
        <T k="<0>Your agent</0>, found on this computer" key="2" tags={[(c) => <b>{c}</b>]} />
      ),
      <T k="<0>The sample</0>: the whole loop" key="3" tags={[(c) => <b>{c}</b>]} />,
    ],
    server: [
      <T k="<0>Name</0> the workspace" key="1" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Check</0> the server" key="2" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Invite</0> the team" key="3" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Your first project</0>, for your agent’s V1" key="4" tags={[(c) => <b>{c}</b>]} />,
      <T k="<0>Connect</0> agents" key="5" tags={[(c) => <b>{c}</b>]} />,
    ],
    invited: [
      <T k="<0>Your agent</0>, connected in a line" key="1" tags={[(c) => <b>{c}</b>]} />,
      invitedBy ? (
        <T k="<0>The library</0>: {name}’s videos and a sample" key="2" values={{ name: firstName(invitedBy.name) }} tags={[(c) => <b>{c}</b>]} />
      ) : (
        <T k="<0>The library</0>: the team’s videos and a sample" key="2" tags={[(c) => <b>{c}</b>]} />
      ),
    ],
  }[variant];
  // cloud with one of the cloud's steps dropped (a channel alone has no team): the list says what is ahead
  const shown = variant === 'cloud' ? lines.slice(0, steps.length) : lines;

  const badges =
    variant === 'cloud' ? (
      trial ? (
        <span className="ob-badge" data-testid="ob-trial">
          <KG shape="hold" />
          <b>{t('{plan} trial', { plan: trial.plan })}</b>
          <span className="ob-sep">·</span>
          {t('{n} day|{n} days', { n: trial.days })}
          <span className="ob-sep">·</span>
          {t('no card')}
        </span>
      ) : (
        <>
          <span className="ob-badge">
            <I name="lock" size={12} />
            <b>{host}</b>
          </span>
          <span className="ob-badge">
            <KG />
            {roleWord(user?.role ?? 'owner')}
          </span>
        </>
      )
    ) : variant === 'invited' ? (
      <span className="ob-badge">
        <KG />
        <b>{roleWord(user?.role ?? 'member')}</b>
        {invitedBy && (
          <>
            <span className="ob-sep">·</span>
            {t('invited by {name}', { name: invitedBy.name })}
          </>
        )}
      </span>
    ) : variant === 'local' ? (
      <>
        <span className="ob-badge">
          <KG shape="hold" />
          <b>{t('On this machine')}</b>
          <span className="ob-sep">·</span>
          {host}
        </span>
        <span className="ob-badge">
          <KG />
          {t('Signed in as you')}
        </span>
      </>
    ) : (
      <>
        <span className="ob-badge">
          <I name="lock" size={12} />
          <b>{host}</b>
        </span>
        <span className="ob-badge">
          <KG />
          {roleWord(user?.role ?? 'owner')}
        </span>
      </>
    );
  const title = inv
    ? t('Welcome to {workspace}, {name}', { workspace: ws?.name ?? '', name: first })
    : variant === 'local'
      ? t('Welcome to {name}', { name: 'Lampo' })
      : variant === 'server'
        ? t('Your server is up, {name}', { name: first })
        : t('Welcome to Lampo, {name}', { name: first });
  const lede = {
    cloud: <T k="Pin a note to the exact frame. Your agent fixes it and renders V2. <0>You check before and after.</0>" tags={[(c) => <span>{c}</span>]} />,
    invited: invitedBy ? (
      <T
        k="{name}’s team reviews its videos here. <0>Notes on exact frames, fixes by agents, checks by people.</0>"
        values={{ name: firstName(invitedBy.name) }}
        tags={[(c) => <span>{c}</span>]}
      />
    ) : (
      <T k="Your team reviews its videos here. <0>Notes on exact frames, fixes by agents, checks by people.</0>" tags={[(c) => <span>{c}</span>]} />
    ),
    local: (
      <T k="It runs on this machine, and you’re signed in already. <0>No account; your videos stay where they are.</0>" tags={[(c) => <span>{c}</span>]} />
    ),
    server: <T k="You’re its owner. A short check, then your team and their agents. <0>Everything here is yours.</0>" tags={[(c) => <span>{c}</span>]} />,
  }[variant];
  const goWord = inv ? t('Connect your agent') : variant === 'cloud' ? t('Set up your workspace') : t('Start');
  const people = usePeopleNames(inv);
  const picture = inv ? (
    <SceneJoin
      workspace={ws?.name ?? ''}
      host={host}
      inviter={invitedBy ? { name: invitedBy.name, role: roleWord(invitedBy.role) } : null}
      people={people}
      me={{ name: user?.name ?? '', email: user?.email ?? '', role: roleWord(user?.role ?? 'member') }}
    />
  ) : (
    <SceneLoop cap={t('A note on a frame, your agent’s fix, your check')} />
  );
  return frame({
    pictureId: inv ? 'join' : 'loop',
    picture,
    caption: inv ? t('The team you’re joining.') : t('Video feedback your AI agent can act on.'),
    cls: 'ob-hello',
    body: (
      <>
        <div className="ob-hello-badges">{badges}</div>
        <div className="ob-su-head">
          <h1>{title}</h1>
          <p className="ob-lede">{lede}</p>
        </div>
        <ol className="ob-hello-steps" aria-label={t('What comes next')}>
          {shown.map((l, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the steps ahead, in order
            <li key={i}>
              <KG shape="outline" />
              <span>{l}</span>
            </li>
          ))}
        </ol>
        <div className="ob-su-acts">
          <button type="button" className="ob-btn ob-go ob-lg ob-block" onClick={next} data-testid="ob-start">
            {goWord}
            <I name="right" size={15} className="ob-chev" />
          </button>
          <div className="ob-row2">
            <span className="ob-fine">{steps.length === 1 ? t('One short step, skippable.') : t('{n} short steps, all skippable.', { n: steps.length })}</span>
            <button type="button" className="ob-lk" onClick={onSkip} data-testid="ob-skip-all">
              {t('Skip to the library')} <I name="right" size={13} />
            </button>
          </div>
        </div>
      </>
    ),
  });
}

/** The names of the workspace's people (for the invited teammate's picture). */
function usePeopleNames(enabled: boolean): string[] {
  const q = useQuery({ queryKey: ['people'], enabled, queryFn: () => api<{ people: { name: string }[] }>('/api/people'), staleTime: 60_000 });
  return (q.data?.people ?? []).map((p) => p.name);
}

// ---------------------------------------------------------------- the workspace's name

export function Workspace({ frame, next, s, set, variant }: StepProps & { variant: SetupVariant }) {
  const status = useAuthStatus().data;
  const user = status?.user;
  const ws = status?.workspace;
  const host = useHost();
  const trial = useTrial();
  const rename = useRenameWorkspace();
  // a sign-up's workspace is named after its person until they name it: offered as "Ana’s workspace"; a server's first
  // workspace starts empty (its placeholder is "Workspace")
  const initial = (() => {
    if (!ws) return '';
    if (variant === 'cloud' && ws.signup && ws.name === user?.name) return t('{name}’s workspace', { name: firstName(user?.name) });
    if (variant === 'server' && ws.name === 'Workspace') return '';
    return ws.name;
  })();
  const value = s.ws ?? initial;
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) {
      input.current?.focus({ preventScroll: true });
      input.current?.select();
    }
  }, []);
  const shown = value.trim() || (variant === 'server' ? t('Your team') : user?.name || '');
  const sub = variant === 'server' ? host : trial ? t('{plan} trial · {n} day left|{plan} trial · {n} days left', { plan: trial.plan, n: trial.days }) : host;
  const from = host === 'app.lampo.video' ? 'hello@lampo.video' : `lampo@${host}`;
  const go = () => {
    if (!value.trim()) {
      setErr(t('Type a name first.'));
      setShake((n) => n + 1);
      input.current?.focus();
      return;
    }
    rename.mutateAsync(value.trim()).catch(toastError);
    next();
  };
  return frame({
    pictureId: 'workspace',
    picture: <SceneWorkspace name={shown} ownerName={user?.name ?? ''} host={host} sub={sub} from={from} />,
    caption: t('Where people will meet the name.'),
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="workspace" />
          <h1>{t('Name your workspace')}</h1>
          <p className="ob-lede">{t('Your team or studio. People see it in invites, on review links and in the switcher.')}</p>
        </div>
        <form
          className={`ob-fld ${err ? 'ob-bad' : ''}`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            go();
          }}
        >
          <label htmlFor="ob-ws-name">{t('Workspace name')}</label>
          <input
            ref={input}
            key={shake}
            className={`ob-inp ob-big ${shake ? 'ob-shake' : ''}`}
            id="ob-ws-name"
            name="workspace"
            value={value}
            placeholder={t('Northwind Studio')}
            autoComplete="organization"
            spellCheck={false}
            aria-describedby="ob-err-ws ob-ws-hint"
            aria-invalid={err ? true : undefined}
            onChange={(e) => {
              set({ ws: e.target.value });
              if (err && e.target.value.trim()) setErr('');
            }}
            data-testid="ob-ws-name"
          />
          <span className="ob-hint" id="ob-ws-hint">
            {variant === 'server' ? t('Shown on everything {host} sends.', { host }) : t('Rename it any time in Settings → Workspace.')}
          </span>
        </form>
        <div className="ob-mini-preview ob-sheet ob-prev-sw">
          <div className="ob-prev-h">{t('How it shows')}</div>
          <Switcher name={shown} sub={sub} />
        </div>
        <div className="ob-su-acts ob-sticky">
          <p className="ob-err" id="ob-err-ws" role="alert">
            {err || ' '}
          </p>
          <button type="button" className="ob-btn ob-go ob-lg ob-block" onClick={go} data-testid="ob-next">
            {t('Continue')}
            <I name="right" size={15} className="ob-chev" />
          </button>
        </div>
      </>
    ),
  });
}

/** "Step 2 of 4", over the title. */
export function Eyebrow({ id }: { id: SetupStep }) {
  const run = useFirstRun();
  const steps = setupStepsFor(run.variant, run.personas);
  const i = steps.indexOf(id);
  if (i < 0) return null;
  return (
    <span className="ob-su-eyebrow">
      <KG />
      {t('Step {i} of {n}', { i: i + 1, n: steps.length })}
    </span>
  );
}

// ---------------------------------------------------------------- the first project

/**
 * The first project, before the agent: the agent is told to use Lampo for it and puts up V1 there. Made at Continue
 * (POST /api/folders, as the sidebar's New project); a project already there can be kept instead.
 */
export function ProjectStep({ frame, next, s, set, last }: StepProps) {
  const qc = useQueryClient();
  const projects = projectsOf(useLibrary().data);
  const have = projects[0] ?? null;
  const value = s.projectName ?? '';
  const [err, setErr] = useState('');
  const [shake, setShake] = useState(0);
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (matchMedia('(pointer: fine)').matches) input.current?.focus({ preventScroll: true });
  }, []);
  const go = async () => {
    const name = value.trim();
    if (!name) {
      if (have) {
        set({ project: have });
        return next();
      }
      setErr(t('Type a name first.'));
      setShake((n) => n + 1);
      input.current?.focus();
      return;
    }
    setBusy(true);
    try {
      set({ project: await makeProject(qc, name) });
      next();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const shown = value.trim() || have || t('Spring launch');
  return frame({
    pictureId: 'project',
    picture: <SceneProject name={shown} agent={agentLabel(s.agent)} />,
    caption: t('Where your agent puts its versions.'),
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="project" />
          <h1>{t('Start your first project')}</h1>
          <p className="ob-lede">{t('One film, campaign or channel. Your agent puts its versions here, and every note stays on its frame.')}</p>
        </div>
        <form
          className={`ob-fld ${err ? 'ob-bad' : ''}`}
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void go();
          }}
        >
          <label htmlFor="ob-project-name">{t('Project name')}</label>
          <input
            ref={input}
            key={shake}
            className={`ob-inp ob-big ${shake ? 'ob-shake' : ''}`}
            id="ob-project-name"
            name="project"
            value={value}
            placeholder={have ?? t('Spring launch')}
            autoComplete="off"
            spellCheck={false}
            maxLength={120}
            aria-describedby="ob-err-project ob-project-hint"
            aria-invalid={err ? true : undefined}
            onChange={(e) => {
              set({ projectName: e.target.value });
              if (err && e.target.value.trim()) setErr('');
            }}
            data-testid="ob-project-name"
          />
          <span className="ob-hint" id="ob-project-hint">
            {have ? t('Leave it empty to go on with {name}.', { name: have }) : t('Rename it any time in the sidebar.')}
          </span>
        </form>
        <div className="ob-su-acts ob-sticky">
          <p className="ob-err" id="ob-err-project" role="alert">
            {err || ' '}
          </p>
          <div className="ob-row2">
            <button type="button" className="ob-lk" onClick={next} data-testid="ob-project-later">
              {t('Later')}
            </button>
            <button type="button" className="ob-btn ob-go ob-lg" onClick={() => void go()} disabled={busy} data-testid="ob-next">
              {last ? t('Go to the library') : t('Continue')}
              <I name="right" size={15} className="ob-chev" />
            </button>
          </div>
        </div>
      </>
    ),
  });
}

// ---------------------------------------------------------------- who the videos are for

const PERSONA_WORDS = perLang(
  (): Record<Exclude<PersonaKind, 'other'>, { title: string; sub: string; icon: IconName; said: [ReactNode, string]; lead: string }> => ({
    agency: {
      title: t('For other brands'),
      sub: t('An agency or studio. The brands you make videos for review through a link.'),
      icon: 'link',
      said: [<b key="b">{t('Review links lead.')}</b>, t('People you share with see your workspace as the sender and leave notes without an account.')],
      lead: t('review links'),
    },
    inhouse: {
      title: t('For our own brand'),
      sub: t('An in-house team. Marketing, product and legal sign off.'),
      icon: 'users',
      said: [<b key="b">{t('Approvals lead.')}</b>, t('Invites come before links, and Approve shows who said yes to which version.')],
      lead: t('approvals'),
    },
    creator: {
      title: t('For my channel'),
      sub: t('A creator. Mostly you, sometimes an editor.'),
      icon: 'phone',
      said: [<b key="b">{t('No team setup.')}</b>, t('The next step is your agent; 9:16 versions are first-class.')],
      lead: t('9:16 versions'),
    },
  }),
);

function PersonaNote({ picks }: { picks: PersonaKind[] }) {
  const ks = personaKinds(picks) as Exclude<PersonaKind, 'other'>[];
  const other = picks.includes('other');
  const W = PERSONA_WORDS();
  if (!ks.length && !other)
    return <Said shape="outline" first={t('Lampo fits its words and first steps to what you pick.')} second={t('Change it any time in Settings.')} />;
  if (ks.length === 1 && !other) return <Said first={W[ks[0]].said[0]} second={W[ks[0]].said[1]} on key={ks[0]} />;
  const leads = ks.map((k) => W[k].lead);
  if (!leads.length)
    return <Said first={<b>{t('Thanks, that helps.')}</b>} second={t('Your first steps stay general; change them any time.')} on key="other" />;
  const list = leads.length === 1 ? leads[0] : t('{list} and {last}', { list: leads.slice(0, -1).join(', '), last: leads[leads.length - 1] });
  return (
    <Said
      first={<b>{leads.length === 1 ? t('{what} leads.', { what: cap(list) }) : t('{what} lead.', { what: cap(list) })}</b>}
      second={t('Your first steps cover all of it; change them any time.')}
      on
      key={list}
    />
  );
}
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export function Persona({ frame, next, s, set }: StepProps) {
  const qc = useQueryClient();
  const run = useFirstRun();
  const picks = s.personas ?? run.personas;
  const otherOpen = picks.includes('other');
  const otherRef = useRef<HTMLInputElement>(null);
  const toggle = (k: PersonaKind, on: boolean) => {
    const nextPicks = on ? [...picks.filter((x) => x !== k), k] : picks.filter((x) => x !== k);
    set({ personas: nextPicks });
    if (k === 'other' && on) setTimeout(() => otherRef.current?.focus({ preventScroll: true }), 40);
  };
  const go = () => {
    if (picks.length) savePersonas(qc, picks, s.personaOther).catch(toastError);
    next();
  };
  const W = PERSONA_WORDS();
  const tile = (k: PersonaKind, icon: ReactNode, title: string, sub: string) => (
    <label key={k} className="ob-tile ob-multi" data-persona={k}>
      <input type="checkbox" value={k} checked={picks.includes(k)} onChange={(e) => toggle(k, e.target.checked)} />
      <span className="ob-tile-ico">{icon}</span>
      <b>{title}</b>
      <span className="ob-sub">{sub}</span>
      <span className="ob-tick">
        <I name="check" size={13} />
      </span>
    </label>
  );
  return frame({
    pictureId: 'persona',
    picture: <ScenePersona picked={personaKinds(picks)} other={otherOpen ? s.personaOther : null} />,
    caption: t('The words and the first steps fit how you work.'),
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="persona" />
          <h1>{t('Who are the videos for?')}</h1>
          <p className="ob-lede">{t('Pick any that fit.')}</p>
        </div>
        <fieldset className="ob-tiles" aria-label={t('Who the videos are for')} data-testid="ob-personas">
          {PERSONAS.filter((k) => k !== 'other').map((k) => {
            const w = W[k as Exclude<PersonaKind, 'other'>];
            return tile(k, <I name={w.icon} size={18} />, w.title, w.sub);
          })}
          {tile('other', <I name="plus" size={18} />, t('Something else'), t('Tell us in a few words.'))}
          <div className={`ob-tile-more ${otherOpen ? 'ob-open' : ''}`}>
            <div>
              <input
                ref={otherRef}
                className="ob-inp"
                id="ob-persona-other"
                value={s.personaOther}
                maxLength={120}
                placeholder={t('Tell us in a few words')}
                aria-label={t('What the videos are for')}
                autoComplete="off"
                tabIndex={otherOpen ? 0 : -1}
                onChange={(e) => set({ personaOther: e.target.value })}
                data-testid="ob-persona-other"
              />
            </div>
          </div>
        </fieldset>
        <PersonaNote picks={picks} />
        <div className="ob-su-acts ob-sticky">
          <div className="ob-row2">
            <button type="button" className="ob-lk" onClick={next} hidden={picks.length > 0}>
              {t('Skip this question')}
            </button>
            <button type="button" className={`ob-btn ob-lg ${picks.length ? 'ob-go' : 'ob-raised'}`} onClick={go} data-testid="ob-next">
              {t('Continue')}
              <I name="right" size={15} className={picks.length ? 'ob-chev' : ''} />
            </button>
          </div>
        </div>
      </>
    ),
  });
}

// ---------------------------------------------------------------- the agent

/** Grows (or shrinks) the revealed block from its old height instead of jumping, then brings it into view. */
function useGrow(key: string) {
  const ref = useRef<HTMLDivElement>(null);
  const h = useRef<number | null>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: measured again whenever what it holds changes
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const to = el.getBoundingClientRect().height;
    const from = h.current;
    h.current = to;
    if (from == null || Math.abs(to - from) < 2) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    const bring = () => {
      el.style.overflow = '';
      if (to <= from || !el.isConnected) return;
      const box = el.closest('.ob-su-form, .ob-su') as HTMLElement | null;
      if (!box) return;
      const r = el.getBoundingClientRect();
      const b = box.getBoundingClientRect();
      const sticky = box.querySelector<HTMLElement>('.ob-su-acts.ob-sticky');
      const room = b.bottom - (sticky && getComputedStyle(sticky).position === 'sticky' ? sticky.offsetHeight : 0);
      if (r.bottom > room) box.scrollBy({ top: Math.min(r.bottom - room + 16, r.top - b.top - 16), behavior: still ? 'auto' : 'smooth' });
    };
    if (still) return bring();
    el.style.overflow = 'hidden';
    const an = el.animate(
      [
        { height: `${from}px`, opacity: from ? 1 : 0.4 },
        { height: `${to}px`, opacity: 1 },
      ],
      {
        duration: 320,
        easing: 'cubic-bezier(0.16, 1, 0.3, 1)',
      },
    );
    an.onfinish = an.oncancel = bring;
  }, [key]);
  return ref;
}

export function AgentStep({
  frame,
  next,
  s,
  last,
  variant,
  id,
  onPick,
}: StepProps & { variant: SetupVariant; id: 'agent' | 'agents'; onPick: (a: SetupAgent) => void }) {
  const where = useWhere();
  const pick = s.agent;
  const connected = useConnected(pick);
  useConnectToast(pick, connected);
  const agents = useAgents(120_000).data?.agents ?? [];
  const connectedKinds = new Set<SetupAgent>(
    (['claude-code', 'codex', 'cursor', 'chatgpt', 'claude', 'other'] as SetupAgent[]).filter((k) => agents.some((a) => isPick(k, a.kind))),
  );
  const found = useFound(variant === 'local');
  // the project it is told to use Lampo for: the one just made, else the newest there is
  const projects = projectsOf(useLibrary().data);
  const setup = pick && pick !== 'none' && where ? setupOf(pick, where, null) : null;
  const live = !!setup?.live;
  // the moment it connects the loop plays over to V2 once; afterwards it rests there
  const [just, setJust] = useState<string | null>(null);
  const was = useRef(!!connected);
  useEffect(() => {
    if (connected && !was.current) setJust(pick);
    was.current = !!connected;
  }, [connected, pick]);
  const state = !pick
    ? 'none'
    : pick === 'none'
      ? 'none-yet'
      : setup?.blocked
        ? 'blocked'
        : !live
          ? 'offline'
          : connected
            ? just === pick
              ? 'just'
              : 'connected'
            : 'waiting';
  const words = {
    cloud: [t('Which agent do you use?'), t('It reads your notes, fixes the video and renders the next version. Pick it, and connect it right here.')],
    invited: [t('Which agent do you use?'), t('It reads your notes, fixes the video and renders the next version. Pick it, and connect it right here.')],
    local: [
      t('Connect the agent you have'),
      onMac()
        ? t('Lampo looked on this Mac. Pick one: it gets one line, and nothing to sign in.')
        : t('Lampo looked on this computer. Pick one: it gets one line, and nothing to sign in.'),
    ],
    server: [
      t('Connect your team’s agents'),
      t('Each agent reaches {host} and signs in as a person. Start with yours; your team does the same from Settings.', { host: where?.host ?? '' }),
    ],
  }[variant];
  const word = last ? t('Go to the library') : t('Continue');
  const grow = useGrow(`${pick}:${!!connected}`);
  const label = pick === 'other' ? t('Your MCP client') : agentLabel(pick);
  return frame({
    pictureId: 'agent',
    picture: <SceneAgent label={label} mark={pick ? <Mark id={pick} size={13} /> : null} state={state} />,
    caption: t('A note on a frame, your agent’s fix, your check.'),
    wide: true,
    cls: 'ob-grows',
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id={id} />
          <h1>{words[0]}</h1>
          <p className="ob-lede">{words[1]}</p>
        </div>
        <AgentTiles value={pick} onPick={onPick} found={found} connectedKinds={connectedKinds} atMachine={variant === 'local'} />
        <div className="ob-reveal" ref={grow}>
          {pick && where && <ConnectBlock pick={pick} where={where} connected={connected} project={s.project ?? projects[0] ?? null} />}
        </div>
        <div className="ob-su-acts ob-sticky">
          <div className="ob-row2">
            <button type="button" className="ob-lk" onClick={next} hidden={!!pick}>
              {variant === 'local' ? t('Later') : t('Skip this question')}
            </button>
            {!pick ? (
              <button type="button" className="ob-btn ob-lg ob-raised" disabled>
                {word}
                <I name="right" size={15} />
              </button>
            ) : (
              // both labels in one cell: the button keeps its width when the agent connects (its edge doesn't jump)
              <button type="button" className={`ob-btn ob-lg ${live && !connected ? 'ob-raised' : 'ob-go'}`} onClick={next} data-testid="ob-next">
                <span className="ob-sizer">
                  <span className={live && !connected ? '' : 'ob-held'} aria-hidden={live && !connected ? undefined : true}>
                    {t('{word} — connect later', { word })}
                  </span>
                  <span className={live && !connected ? 'ob-held' : ''} aria-hidden={live && !connected ? true : undefined}>
                    {word}
                  </span>
                  {/* the long label in the primary's weight: the widest it gets, in either state */}
                  <span className="ob-held ob-strong" aria-hidden="true">
                    {t('{word} — connect later', { word })}
                  </span>
                </span>
                <I name="right" size={15} className="ob-chev" />
              </button>
            )}
          </div>
        </div>
      </>
    ),
  });
}

/** The agents installed on this machine (the machine only), as the tiles want them. */
function useFound(atMachine: boolean): Partial<Record<SetupAgent, string | null>> | undefined {
  const q = useQuery({
    queryKey: ['onboarding-agents'],
    enabled: atMachine,
    staleTime: 60_000,
    queryFn: () => api<{ found: { kind: 'claude-code' | 'codex' | 'cursor'; version: string | null }[] }>('/api/onboarding/agents'),
  });
  if (!atMachine || !q.data) return undefined;
  return Object.fromEntries(q.data.found.map((f) => [f.kind, f.version]));
}

// ---------------------------------------------------------------- where renders land (the machine)

const sizeWord = (n: number | null) => (n == null ? '' : n > 1e9 ? `${(n / 1e9).toFixed(1)} GB` : `${Math.max(1, Math.round(n / 1e6))} MB`);
const tildeOf = (p: string, home: string | null | undefined) => (home && p.startsWith(`${home}/`) ? `~${p.slice(home.length)}` : p);

export function Renders({ frame, next, s, set }: StepProps) {
  const qc = useQueryClient();
  const info = useInfo();
  const folders = useFolders(true).data?.folders ?? [];
  const [busy, setBusy] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const pickedFolder = folders.find((f) => f.path === s.folder) ?? null;
  const shown = pickedFolder ?? folders[0] ?? null;
  const n = pickedFolder?.count ?? 0;
  const link = async () => {
    if (!pickedFolder) return;
    setBusy(true);
    try {
      const count = await linkVideos(
        qc,
        pickedFolder.files.map((f) => f.path),
      );
      toast(t('{n} video linked from {folder}|{n} videos linked from {folder}', { n: count, folder: tildeOf(pickedFolder.path, info?.home) }), 'ok');
      next();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return frame({
    pictureId: 'renders',
    picture: (
      <SceneRenders
        path={shown ? tildeOf(shown.path, info?.home) : '~/Movies'}
        files={(shown?.files ?? []).map((f) => ({ name: f.name, meta: sizeWord(f.size) }))}
        picked={!!pickedFolder}
      />
    ),
    caption: t('Linked where they are. Export again: V2.'),
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="renders" />
          <h1>{t('Where do your exports land?')}</h1>
          <p className="ob-lede">{t('Lampo links files where they are. Nothing is copied. Export to the same path again and it arrives as V2.')}</p>
        </div>
        <fieldset className="ob-rows" aria-label={t('Folders with videos')} data-testid="ob-folders">
          {folders.map((f) => (
            <label key={f.path} className="ob-rowc">
              <input type="radio" name="ob-folder" value={f.path} checked={s.folder === f.path} onChange={() => set({ folder: f.path })} />
              <span className="ob-radio" />
              <code>{tildeOf(f.path, info?.home)}</code>
              <span className="ob-n">{t('{n} video|{n} videos', { n: f.count })}</span>
            </label>
          ))}
          <label className="ob-rowc">
            <input type="radio" name="ob-folder" value="" checked={browsing} onChange={() => setBrowsing(true)} />
            <span className="ob-radio" />
            <span>{t('Another folder…')}</span>
            <span className="ob-n" />
          </label>
        </fieldset>
        {browsing && (
          <FolderBrowser
            home={info?.home ?? null}
            onPick={(f) => {
              set({ folder: f.path });
              setBrowsing(false);
              qc.setQueryData(['onboarding-folders'], (d: { folders: typeof folders } | undefined) => ({
                folders: [f, ...(d?.folders ?? []).filter((x) => x.path !== f.path)],
              }));
            }}
          />
        )}
        <p className="ob-fine">{t('Your agent puts its exports up too, once you tell it to use Lampo.')}</p>
        <div className="ob-su-acts ob-sticky">
          <div className="ob-row2">
            <button type="button" className="ob-lk" onClick={next}>
              {t('Later')}
            </button>
            <button type="button" className={`ob-btn ob-lg ${n ? 'ob-go' : 'ob-raised'}`} onClick={link} disabled={!n || busy} data-testid="ob-link">
              {n ? t('Link {n} video|Link {n} videos', { n }) : t('Link videos')}
              <I name="right" size={15} className="ob-chev" />
            </button>
          </div>
        </div>
      </>
    ),
  });
}

type FoundFolder = { path: string; count: number; files: { name: string; path: string; size: number | null; mtime: string | null }[] };
/** "Another folder…": the app's own folder browser, in place (folders and their videos; nothing is scanned). */
function FolderBrowser({ home, onPick }: { home: string | null; onPick: (f: FoundFolder) => void }) {
  const [dir, setDir] = useState(home ?? '');
  const { data } = useBrowse(dir);
  const videos = (data?.entries ?? []).filter((e) => e.type === 'video');
  const dirs = (data?.entries ?? []).filter((e) => e.type === 'dir');
  return (
    <div className="ob-browse" data-testid="ob-browse">
      <div className="ob-browse-h">
        <button type="button" className="ob-lk" disabled={!data?.parent} onClick={() => data?.parent && setDir(data.parent)}>
          <I name="back" size={14} />
        </button>
        <code>{data ? tildeOf(data.dir, home) : '…'}</code>
        <button
          type="button"
          className="ob-btn ob-sm ob-raised"
          disabled={!videos.length}
          onClick={() =>
            data &&
            onPick({
              path: data.dir,
              count: videos.length,
              files: videos.slice(0, 8).map((v) => ({ name: v.name, path: v.path, size: v.size ?? null, mtime: v.mtime ?? null })),
            })
          }
        >
          {videos.length ? t('Use this folder · {n}', { n: videos.length }) : t('No videos here')}
        </button>
      </div>
      <ul>
        {dirs.slice(0, 40).map((d) => (
          <li key={d.path}>
            <button type="button" onClick={() => setDir(d.path)}>
              <I name="folder" size={14} />
              {d.name}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

// ---------------------------------------------------------------- the sample (the machine's last step)

export function Try({ frame }: StepProps) {
  const qc = useQueryClient();
  const sample = useOnboarding(true).data?.sample ?? null;
  const open = () => finish(qc, sample ? `#/v/${encodeURIComponent(sample.slug)}${sample.check ? `?verify=${encodeURIComponent(sample.check)}` : ''}` : '#/');
  return frame({
    pictureId: 'try',
    picture: <SceneLoop cap={t('A note, the agent’s fix, your check')} />,
    caption: t('The whole loop, in a minute.'),
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="try" />
          <h1>{t('See the whole loop in a minute')}</h1>
          <p className="ob-lede">{t('A short sample, already in review: a note on the car, the agent’s fix in V2, and a question for you.')}</p>
        </div>
        <SampleKeys big />
        <p className="ob-fine">{t('Marked as a sample: nothing about it reaches your agent. Remove it in one click.')}</p>
        <div className="ob-su-acts ob-sticky">
          <button type="button" className="ob-btn ob-go ob-lg ob-block" onClick={open} data-testid="ob-open-sample">
            <I name="play" size={14} />
            {t('Open the sample')}
          </button>
          <div className="ob-row2">
            <span />
            <button type="button" className="ob-lk" onClick={() => finish(qc)}>
              {t('Go to my library')} <I name="right" size={13} />
            </button>
          </div>
        </div>
      </>
    ),
  });
}
