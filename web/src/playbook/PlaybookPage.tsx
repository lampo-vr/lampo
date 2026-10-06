// A playbook — tell your agents how you work, once, and every render follows it (lib/playbooks.ts, docs/playbooks.md).
// One document and what it gives: a line of where it stands (what it inherits, from the House down; a suggestion
// waiting; its last change), then the playbook itself — brief, rules, skills, references, each written in place
// (Sections.tsx) — beside what agents read, live as you write (AgentPane.tsx); the history opens in that pane. Narrow
// screens stack it: the document, with what agents read and the history a tap away. Beside a folder's videos at
// #/playbook/<folder>; the House's in Settings → Playbook. Reading is for the whole team; editing and deciding for
// people with the `playbook` action.
import { useCallback, useEffect, useRef, useState } from 'react';
import type { PlaybookView, PlaybookWaiting } from '../../../lib/types.ts';
import { useCan } from '../api/auth.ts';
import { playbookHref, usePlaybook, usePlaybooks } from '../api/playbooks.ts';
import { t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Menu } from '../ui/primitives.tsx';
import { EmptyState } from '../ui/system.tsx';
import { AgentDialog, AgentPane, dirtyDrafts } from './AgentPane.tsx';
import type { DraftSection } from './agentText.ts';
import { HistoryDialog, HistoryPane } from './History.tsx';
import { PlaybookSkeleton, suggestionFromHash, tabFromHash } from './PlaybookShell.tsx';
import { BriefSection, factsOf, label, OpenSkill, RefsSection, RulesSection, SkillsSection, shortName, who } from './Sections.tsx';
import '../styles/playbook.css';
import '../styles/refs.css';

export function PlaybookPage({ scope, pending = false }: { scope: string; pending?: boolean }) {
  const q = usePlaybook(scope, !pending);
  const view = q.data;
  if (q.error && !view)
    return (
      <EmptyState art="error" titleAs="h2" title={t('The playbook didn’t load')}>
        {q.error.message}
      </EmptyState>
    );
  return (
    <div className="pb" data-testid="playbook" data-scope={scope} aria-busy={!view}>
      {view ? <Doc key={scope} view={view} scope={scope} /> : <PlaybookSkeleton />}
    </div>
  );
}

type Side = 'agents' | 'history';

function Doc({ view, scope }: { view: PlaybookView; scope: string }) {
  const edit = useCan()('playbook');
  const p = view.playbook;
  const [drafts, setDrafts] = useState<Partial<Record<DraftSection, string>>>({});
  const onDraft = useCallback(
    (section: DraftSection, text: string | null) =>
      setDrafts((d) => {
        if ((d[section] ?? null) === text) return d;
        const next = { ...d };
        if (text === null) delete next[section];
        else next[section] = text;
        return next;
      }),
    [],
  );
  const [side, setSide] = useState<Side>(() => (tabFromHash() === 'history' ? 'history' : 'agents'));
  // a narrow screen has no pane: what agents read and the history open as dialogs
  const [dialog, setDialog] = useState<Side | null>(null);
  const [skill, setSkill] = useState<{ name: string | null } | null>(null);
  const pane = useRef<HTMLElement>(null);
  const beside = () => !!pane.current?.offsetParent;
  const show = (what: Side) => {
    if (!beside()) setDialog(what);
    else setSide((s) => (s === what && what === 'history' ? 'agents' : what));
  };
  // Insights' "Make it a rule" arrives as ?rule=<topic>; the address lets go of it, so a reload doesn't start it again.
  const [topic] = useState(() => {
    const m = /[?&]rule=([^&]+)/.exec(location.hash);
    return m ? decodeURIComponent(m[1] as string) : null;
  });
  useEffect(() => {
    if (topic) history.replaceState(null, '', location.hash.replace(/([?&])rule=[^&]+&?/, '$1').replace(/[?&]$/, ''));
  }, [topic]);
  const waiting = p.proposals.filter((x) => x.status === 'pending');
  const of = (section: string) => waiting.filter((x) => (section === 'skills' ? x.section.startsWith('skill:') : x.section === section));
  const toSuggestion = (id?: string | null) => {
    const el = (id && document.getElementById(`pb-suggest-${id}`)) || document.querySelector<HTMLElement>('.pb-suggest');
    el?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    // the decision has the focus: Accept where it can be pressed, else Reject (never Accept anyway). One query per
    // button: a selector list answers whichever comes first in the card, and that is Reject.
    const go = el?.querySelector<HTMLElement>('[data-testid=pb-accept]') ?? el?.querySelector<HTMLElement>('[data-testid=pb-reject]');
    go?.focus({ preventScroll: true });
  };
  // a link that asks for the suggestions shows the one it names (the inbox's), else the first; for the history, on a
  // narrow screen, its dialog
  // biome-ignore lint/correctness/useExhaustiveDependencies: on arrival only
  useEffect(() => {
    const f = tabFromHash();
    if (f === 'suggestions') requestAnimationFrame(() => toSuggestion(suggestionFromHash()));
    if (f === 'history' && !beside()) setDialog('history');
  }, []);
  const ds = dirtyDrafts(view, drafts);
  return (
    <>
      <Lineage
        view={view}
        scope={scope}
        waiting={waiting.length}
        side={side}
        onSuggestions={() => toSuggestion()}
        onAgents={() => show('agents')}
        onHistory={() => show('history')}
      />
      <div className="pb-layout">
        <article className="panel panel-base pad-lg pb-sheet" aria-label={t('{name} playbook', { name: label(scope) })}>
          <BriefSection view={view} scope={scope} edit={edit} waiting={of('brief')} draft={drafts.brief} onDraft={onDraft} />
          <RulesSection view={view} scope={scope} edit={edit} waiting={of('rules')} draft={drafts.rules} onDraft={onDraft} topic={topic} />
          <SkillsSection view={view} scope={scope} edit={edit} waiting={of('skills')} onOpen={(name) => setSkill({ name })} />
          <RefsSection view={view} scope={scope} edit={edit} />
        </article>
        <aside ref={pane} className="pb-pane">
          {side === 'history' && p.rev > 0 ? <HistoryPane playbook={p} onClose={() => setSide('agents')} /> : <AgentPane view={view} drafts={ds} />}
        </aside>
      </div>
      {dialog === 'agents' && <AgentDialog view={view} drafts={ds} onClose={() => setDialog(null)} />}
      {dialog === 'history' && <HistoryDialog playbook={p} onClose={() => setDialog(null)} />}
      {skill && <OpenSkill view={view} scope={scope} name={skill.name} edit={edit} onClose={() => setSkill(null)} />}
    </>
  );
}

/**
 * Where this playbook stands, as a line: the playbooks it inherits, from the House down, each with what it gives and a
 * way to it, this one last (it wins where they disagree); the House says every project inherits it and which folders
 * add their own. At the end, what has something for you: a suggestion waiting, the last change (the history).
 */
function Lineage({
  view,
  scope,
  waiting,
  side,
  onSuggestions,
  onAgents,
  onHistory,
}: {
  view: PlaybookView;
  scope: string;
  waiting: number;
  side: Side;
  onSuggestions: () => void;
  onAgents: () => void;
  onHistory: () => void;
}) {
  const p = view.playbook;
  const books = usePlaybooks(!scope).data?.playbooks;
  const own = factsOf(p);
  const below = !scope ? (books ?? []).filter((b) => b.scope && b.rev > 0) : [];
  return (
    <div className="pb-meta" data-testid="pb-lineage">
      <ol className="pb-lineage" aria-label={t('What agents read here, from the House down')}>
        {scope && !view.layers.length && (
          <li>
            <a className="pb-layer-chip none" href={playbookHref('')} data-testid="pb-layer">
              <KeyGlyph shape="outline" size={10} />
              <b>{t('House')}</b>
              <span className="pb-layer-facts">· {t('nothing yet')}</span>
            </a>
          </li>
        )}
        {view.layers.map((l) => (
          <li key={l.scope}>
            <a className="pb-layer-chip" href={playbookHref(l.scope)} title={`${label(l.scope)} r${l.rev} · ${factsOf(l)}`} data-testid="pb-layer">
              <KeyGlyph shape="diamond" size={10} />
              <b>{shortName(l.scope)}</b>
              <span className="pb-layer-rev mono">r{l.rev}</span>
              <span className="pb-layer-facts">· {factsOf(l)}</span>
            </a>
          </li>
        ))}
        <li>
          <span className="pb-layer-chip here" aria-current="page" data-testid="pb-layer-here">
            <KeyGlyph shape={own ? 'diamond' : 'outline'} size={10} />
            <b>{shortName(scope)}</b>
            {own && <span className="pb-layer-rev mono">r{p.rev}</span>}
            <span className="pb-layer-facts">· {own || t('nothing yet')}</span>
          </span>
        </li>
      </ol>
      <span className={`pb-meta-note ${scope ? 'wins' : ''}`}>
        {!scope ? (
          <>
            {t('Every project inherits it')}
            {below.length > 0 && (
              <>
                {' · '}
                {t('{n} folder adds its own:|{n} folders add their own:', { n: below.length })}{' '}
                {below.slice(0, 3).map((b, i) => (
                  <span key={b.scope}>
                    {i > 0 && ', '}
                    <a href={playbookHref(b.scope)}>{b.scope}</a>
                  </span>
                ))}
                {below.length > 3 && ` +${below.length - 3}`}
              </>
            )}
          </>
        ) : (
          view.layers.length > 0 && t('{name} wins where they disagree', { name: shortName(scope) })
        )}
      </span>
      <span className="pb-meta-links">
        {waiting > 0 && (
          <button type="button" className="pb-meta-link waiting" onClick={onSuggestions} data-testid="pb-suggestions-link">
            <KeyGlyph shape="ease" size={10} />
            {t('{n} suggestion|{n} suggestions', { n: waiting })}
          </button>
        )}
        <Below scope={scope} below={view.below ?? []} />
        <button type="button" className="pb-meta-link narrow" onClick={onAgents} data-testid="pb-agent-view">
          <I name="eye" size={14} />
          {t('What agents read')}
        </button>
        {p.rev > 0 && (
          <button type="button" className="pb-meta-link" aria-pressed={side === 'history'} onClick={onHistory} data-testid="pb-history-link">
            <I name="history" size={14} />
            {t('History')}
            <span className="pb-meta-when">· {t('{name}, {when}', { name: who(p.by), when: ago(p.updated) })}</span>
          </button>
        )}
      </span>
    </div>
  );
}

/**
 * Suggestions waiting in the playbooks of folders inside this one (the House: in any folder's): a quiet link to that
 * playbook, on its suggestions — or, from several, a menu of them. A project's page is where people look first.
 */
function Below({ scope, below }: { scope: string; below: PlaybookWaiting[] }) {
  if (!below.length) return null;
  // the path from here: "Reels" on Acme's page, "Acme/Reels" on the House's
  const name = (b: PlaybookWaiting) => (scope ? b.scope.slice(scope.length + 1) : b.scope);
  const href = (b: PlaybookWaiting) => `${playbookHref(b.scope)}?tab=suggestions`;
  if (below.length === 1) {
    const b = below[0] as PlaybookWaiting;
    return (
      <a className="pb-meta-link waiting below" href={href(b)} data-testid="pb-below">
        <KeyGlyph shape="ease" size={10} />
        <b className="pb-below-name">{name(b)}</b>
        <span className="pb-below-n">· {t('{n} suggestion waiting|{n} suggestions waiting', { n: b.pending })}</span>
        <I name="right" size={12} className="pb-below-go" />
      </a>
    );
  }
  const n = below.reduce((sum, b) => sum + b.pending, 0);
  return (
    <Menu
      trigger={
        <button type="button" className="pb-meta-link waiting below" data-testid="pb-below">
          <KeyGlyph shape="ease" size={10} />
          <span className="pb-below-n">{t('{n} suggestion waiting in folders inside|{n} suggestions waiting in folders inside', { n })}</span>
          <I name="down" size={12} className="pb-below-go" />
        </button>
      }
      items={below.map((b) => ({
        label: `${name(b)} · ${t('{n} suggestion|{n} suggestions', { n: b.pending })}`,
        icon: 'playbook' as const,
        onClick: () => {
          location.hash = href(b);
        },
      }))}
    />
  );
}

export default PlaybookPage;
