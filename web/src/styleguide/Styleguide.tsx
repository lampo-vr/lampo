// #/styleguide: every building block of the design system, in every variant and state, on one page — the place to
// look before adding a class, and what test/e2e/styleguide.mjs photographs in both themes. Only in dev and test builds
// (LAMPO_STYLEGUIDE=0 leaves it out: the Dockerfile does). A tool page for people building the app, so its words are plain
// English, not translated.
import { type CSSProperties, type ReactNode, useState } from 'react';
import { AGENT_KIND_LABELS, AGENT_KINDS } from '../../../lib/agentKind.ts';
import type { RunPlanItem, Stage } from '../../../lib/types.ts';
import { RunStrip } from '../player/RunStrip.tsx';
import { say } from '../sessions/activityWords.ts';
import { RunLine } from '../sessions/RunLine.tsx';
import { planSaid } from '../sessions/runWords.ts';
import '../styles/styleguide.css';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { Avatar, Checkbox, Progress, Slider, Switch } from '../ui/controls.tsx';
import type { EmptyArtName } from '../ui/emptyArt.tsx';
import { AgentMark, BrandMark, I, Wordmark } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Kbd, Segmented } from '../ui/primitives.tsx';
import { Select } from '../ui/select.tsx';
import { Button, Chip, EmptyState, ListRow, PageHeader, Panel, SectionHeader } from '../ui/system.tsx';
import { ThemeSwitch } from '../ui/ThemeSwitch.tsx';
import { RUN_STATES, runFixtures } from './runStates.ts';

const TONES: Tone[] = ['neutral', 'must', 'should', 'nice', 'idea', 'ok', 'claude'];
const STAGES: [Stage, string][] = [
  ['to_review', 'To review'],
  ['changes', 'Changes'],
  ['in_progress', 'In progress'],
  ['check_fixes', 'Check fixes'],
  ['team_approved', 'Team approved'],
  ['with_client', 'Out for review'],
  ['client_approved', 'Approved via link'],
  ['final', 'Final'],
];
/** Every scene, with where it's used. */
const ARTS: [EmptyArtName, string, string][] = [
  ['library', 'Nothing to review yet', 'The empty library: the first render drops onto an empty layer.'],
  ['folder', 'This folder is empty', 'A folder view with no videos in it.'],
  ['filed', 'Everything is filed', 'Unsorted, once every video has a project.'],
  ['filter', 'Nothing matches', 'Filters and the filter field: a scrubber over empty frames.'],
  ['search', 'No results', 'The ⌘K palette finds nothing.'],
  ['clear', 'No open notes', 'Every note settled: all keyframes ticked.'],
  ['check', 'Nothing to check', 'No fixes waiting: a before/after pair, settled.'],
  ['inbox', 'All caught up', 'The inbox and For you: each waiting item is set and filed; the tray rests, done.'],
  ['note', 'No notes yet', 'The player’s notes, before the first one.'],
  ['list', 'Nothing closed yet', 'A list of notes still to come.'],
  ['insights', 'No notes in this period', 'Insights with too little to show.'],
  ['agents', 'No agent connected', 'Agents and connected apps.'],
  ['suggest', 'No suggestions waiting', 'A playbook’s suggestions: a rule slides in under the rules, marked for you.'],
  ['token', 'No tokens yet', 'API tokens.'],
  ['webhook', 'No webhooks yet', 'Webhooks under Notifications.'],
  ['client', 'No links yet', 'Review links, before the first one: the frame lights, the links reach out.'],
  ['error', 'This didn’t load', 'Anything that failed to load.'],
];
const SIZES = [
  ['3xl', '36 · page titles'],
  ['2xl', '24 · dialog titles, big numbers'],
  ['xl', '18 · empty-state headlines'],
  ['lg', '15 · section titles'],
  ['md', '13 · body, controls'],
  ['sm', '12 · secondary text'],
  ['xs', '11 · chips, captions'],
] as const;
const SPACE = ['0_5', '1', '2', '3', '4', '6', '8', '12'] as const;

const noop = () => {};
const still = { stop: async () => {}, retry: async () => {}, nudge: async () => {}, busy: false };
const SESSION = { name: 'Claude Code', id: 'mcp-sg', cwd: null, assigned: '2026-10-07T09:00:00.000Z', by: 'Sam', agent: 'claude-code' as const };
const PLAN: RunPlanItem[] = [
  { id: 'a', state: 'doing' },
  { id: 'b', state: 'fixed' },
  { id: 'c', state: 'fixed', v: 3 },
  { id: 'd', state: 'asked' },
  { id: 'e', state: 'wontfix' },
  { id: 'f', state: 'todo', added: true },
];

/** An agent at work on a video, in every state (design §5.2): the player's strip, the library's line, a note's plan line. */
function AgentAtWork() {
  const [now] = useState(() => Date.now());
  const runs = runFixtures('sg', ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'], 3, now);
  const strip = (key: string, run: (typeof runs)[keyof typeof runs]['run'] | null, reachable = true) => (
    <div key={key} className="sg-strip" data-state={key}>
      <span className="sg-label">{key}</span>
      <div className="sg-strip-box">
        <RunStrip
          slug="sg"
          run={run}
          asOf={now}
          session={SESSION}
          reachable={reachable}
          copyable
          toCheck={run?.state === 'done' ? 5 : 0}
          nextV={4}
          canSteer
          canCheck
          say={(w) => say(w)}
          onOpen={noop}
          onAnswer={noop}
          onCheck={noop}
          still={now}
          act={still}
        />
      </div>
    </div>
  );
  return (
    <>
      <div className="sg-strips" data-testid="sg-strips">
        {strip('ready', null)}
        {strip('unreachable', null, false)}
        {RUN_STATES.map((k) => strip(k, runs[k].run))}
      </div>
      <Row label="card line">
        <div className="sg-lines">
          {RUN_STATES.map((k) => (
            <RunLine key={k} run={runs[k].run} say={(w) => say(w)} />
          ))}
        </div>
      </Row>
      <Row label="on a poster">
        <div className="sg-poster film-poster">
          <div className="film-over bottom">
            <RunLine run={runs.rendering.run} chip />
          </div>
          <span className="run-edge" style={{ '--edge': 0.42 } as CSSProperties} />
        </div>
      </Row>
      <Row label="plan lines">
        <div className="sg-lines">
          {PLAN.map((p) => {
            const l = planSaid(p, 'Claude Code', 3);
            return (
              // a row of its own each (in a note's row the line takes the row's second line)
              <div key={p.id}>
                <span className="nr-plan" data-state={p.state}>
                  {l && <KeyGlyph shape={l.shape} className={`nav-kg run-kg ${l.tone}`} />}
                  <span className="nr-plan-words">{l?.words ?? 'not reached yet: its room is kept, empty'}</span>
                </span>
              </div>
            );
          })}
        </div>
      </Row>
    </>
  );
}

function Block({ title, note, children }: { title: string; note?: string; children: ReactNode }) {
  return (
    <section className="sg-block" aria-label={title}>
      <SectionHeader title={title} />
      {note && <p className="sg-note">{note}</p>}
      {children}
    </section>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="sg-row">
      <span className="sg-label">{label}</span>
      <div className="sg-items">{children}</div>
    </div>
  );
}

export default function Styleguide() {
  const [seg, setSeg] = useState('grid');
  const [lane, setLane] = useState('open');
  const [period, setPeriod] = useState('30d');
  const [tab, setTab] = useState('notes');
  const [on, setOn] = useState(true);
  const [check, setCheck] = useState(true);
  const [level, setLevel] = useState(60);
  const [select, setSelect] = useState('1');
  const [chips, setChips] = useState(['logo']);
  const toggle = (c: string) => setChips((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  return (
    <main className="sg" data-testid="styleguide">
      <div className="sg-page">
        <PageHeader eyebrow="Design system" title="Styleguide" meta="Every building block, every variant and state" aside={<ThemeSwitch labels />} />

        <Block
          title="Brand"
          note="Lampo: the logo in the text colour with the frame's window in --brand, the mark (the frame o) alone where the logo doesn't fit. The orange is for brand moments only, never state or severity; text on it is --brand-ink."
        >
          <div className="sg-brand" data-testid="sg-brand">
            <span className="sg-brand-logo">
              <Wordmark />
            </span>
            <BrandMark size={16} />
            <BrandMark size={28} />
            <BrandMark size={48} />
            <span className="sg-brand-chip">brand</span>
          </div>
        </Block>

        <Block
          title="Agent marks"
          note="Which agent works, next to its name: the company's mark (Simple Icons, in the text colour), a monogram tile where there is no mark to use, a glyph for kinds that are not a product."
        >
          <div className="sg-marks" data-testid="sg-marks">
            {AGENT_KINDS.map((k) => (
              <span key={k} className="sg-mark">
                <AgentMark kind={k} size={20} />
                <span className="sg-label">{AGENT_KIND_LABELS[k]}</span>
              </span>
            ))}
          </div>
        </Block>

        <Block
          title="The raised material"
          note="One look for everything you can press that matters and everything that is on: a primary action, a selected item, a pressed toggle. Pressed while held: inset."
        >
          <div className="sg-raised" data-testid="sg-raised">
            <Button variant="primary" icon="upload">
              Add video
            </Button>
            <Segmented
              label="Layout"
              value={seg}
              onChange={setSeg}
              iconOnly
              options={[
                { value: 'grid', label: 'Grid', icon: 'grid' },
                { value: 'compact', label: 'Compact', icon: 'compact' },
                { value: 'list', label: 'List', icon: 'list' },
                { value: 'board', label: 'Board', icon: 'board' },
              ]}
            />
            <Segmented
              label="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
                { value: '90d', label: '90 days' },
              ]}
            />
            <button type="button" className="chip on" aria-pressed>
              logo
            </button>
            <Button pressed icon="compare">
              Compare
            </Button>
            <Switch checked label="On" onCheckedChange={() => {}} />
          </div>
        </Block>

        <Block title="Buttons" note="Primary once per view. Secondary is the default; ghost for toolbars and rows; danger only for what can't be undone.">
          {(['primary', 'secondary', 'ghost', 'danger'] as const).map((v) => (
            <Row key={v} label={v}>
              <Button variant={v} size="sm">
                Small
              </Button>
              <Button variant={v}>Medium</Button>
              <Button variant={v} size="lg">
                Large
              </Button>
              <Button variant={v} icon="plus">
                With icon
              </Button>
              <Button variant={v} icon="more" iconOnly aria-label="More" />
              <Button variant={v} disabled>
                Disabled
              </Button>
            </Row>
          ))}
          <Row label="pressed">
            <Button pressed size="sm" icon="pen">
              Draw
            </Button>
            <Button pressed icon="compare">
              Compare
            </Button>
            <Button variant="ghost" pressed icon="loop" iconOnly aria-label="Loop" />
          </Row>
          <Row label="link">
            <Button variant="link">Show all</Button>
            <Button variant="link" icon="external">
              Open the docs
            </Button>
          </Row>
          <Row label="icon button">
            <IconButton label="Search" icon="search" shortcut="⌘K" />
            <IconButton label="Settings" icon="settings" className="btn icon-only" />
            <IconButton label="Close" icon="x" size={14} className="btn ghost icon-only sm" />
          </Row>
          <Row label="wide (a gate)">
            <div className="sg-gate">
              <input className="input" type="password" placeholder="Password" aria-label="Password" />
              <Button variant="primary" size="lg" wide>
                Open the review
              </Button>
            </div>
          </Row>
        </Block>

        <Block
          title="Chips and badges"
          note="All chips are 20 px high with the same corners. Where a video stands is a badge with its keyframe glyph, never a coloured dot."
        >
          <Row label="chip">
            <Chip>logo</Chip>
            <Chip icon="clock">2 days</Chip>
            <Chip kind="count">12</Chip>
            <Chip kind="version">V9</Chip>
            <Chip kind="key">⌘K</Chip>
          </Row>
          <Row label="filter chip">
            {['logo', 'timing', 'colour', 'love-it'].map((c) => (
              <button
                key={c}
                type="button"
                className={`chip ${chips.includes(c) ? 'on' : ''} ${c === 'love-it' ? 'love' : ''}`}
                aria-pressed={chips.includes(c)}
                onClick={() => toggle(c)}
              >
                {c}
              </button>
            ))}
          </Row>
          <Row label="lane chips">
            <Segmented
              label="Lanes"
              className="chips"
              value={lane}
              onChange={setLane}
              options={[
                { value: 'all', label: 'All', count: 24 },
                { value: 'open', label: 'Open', count: 7 },
                { value: 'verify', label: 'Check fixes', count: 3 },
                { value: 'done', label: 'Done', count: null },
              ]}
            />
          </Row>
          <Row label="badge · tone">
            {TONES.map((tone) => (
              <Badge key={tone} tone={tone}>
                {tone}
              </Badge>
            ))}
          </Row>
          <Row label="badge · stage">
            {STAGES.map(([s, label]) => (
              <Badge key={s} stage={s}>
                {label}
              </Badge>
            ))}
          </Row>
          <Row label="badge · small">
            <Badge stage="changes" size="sm" note="V3">
              Changes
            </Badge>
            <Badge stage="final" size="sm">
              Final
            </Badge>
          </Row>
          <Row label="keys, avatars">
            <Kbd>⌘</Kbd>
            <Kbd>K</Kbd>
            <Avatar name="Sam Keller" />
            <Avatar name="agent:render-bot" />
            <Avatar name="guest:Client" />
          </Row>
        </Block>

        <Block title="Choosing" note="Segmented for a few exclusive choices, tabs for views of one thing, a select when the list is long.">
          <Row label="segmented">
            <Segmented
              label="Period"
              value={period}
              onChange={setPeriod}
              options={[
                { value: '7d', label: '7 days' },
                { value: '30d', label: '30 days' },
                { value: '90d', label: '90 days' },
                { value: 'all', label: 'All time' },
              ]}
            />
          </Row>
          <Row label="tabs">
            <div className="tabs" role="tablist" aria-label="Panel">
              {['notes', 'versions', 'activity'].map((x) => (
                <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                  {x[0].toUpperCase() + x.slice(1)}
                  {x === 'notes' && <span className="n">4</span>}
                </button>
              ))}
            </div>
          </Row>
          <Row label="select">
            <Select
              label="Speed"
              value={select}
              onChange={setSelect}
              options={[
                { value: '0.5', label: '0.5×' },
                { value: '1', label: '1×' },
                { value: '2', label: '2×' },
              ]}
            />
            <Select
              label="Speed (small)"
              size="sm"
              value={select}
              onChange={setSelect}
              options={[
                { value: '0.5', label: '0.5×' },
                { value: '1', label: '1×' },
                { value: '2', label: '2×' },
              ]}
            />
          </Row>
          <Row label="input">
            <input className="input" placeholder="Filter videos" aria-label="Filter videos" />
            <input className="input" defaultValue="Spring campaign" aria-label="Name" />
            <input className="input" disabled placeholder="Disabled" aria-label="Disabled" />
          </Row>
          <Row label="toggles">
            <Switch checked={on} onCheckedChange={setOn} label="Switch" />
            <Switch checked={!on} onCheckedChange={(v) => setOn(!v)} label="Switch off" />
            <Switch checked disabled onCheckedChange={() => {}} label="Disabled" />
            <Checkbox checked={check} onCheckedChange={setCheck} label="Checkbox" />
            <Checkbox checked={!check} onCheckedChange={(v) => setCheck(!v)} label="Checkbox off" />
          </Row>
          <Row label="slider, progress">
            <div className="sg-w">
              <Slider value={level} onChange={setLevel} label="Level" />
            </div>
            <div className="sg-w">
              <Progress value={level} label="Progress" />
            </div>
            <div className="sg-w">
              <Progress value={null} label="Working" tone="claude" />
            </div>
          </Row>
        </Block>

        <Block
          title="Surfaces"
          note="Base: a card on a page. Raised: a card on a card. Floating: menus and dialogs. One padding rule: 16 in a list, dense 12, 24 for a page's cards and dialogs."
        >
          <div className="sg-panels">
            <Panel level="base">
              <SectionHeader title="Base" count={3} actions={<Button size="sm">Action</Button>} />
              <p className="sg-p">A card in a page.</p>
              <Panel level="raised" pad="dense">
                <p className="sg-p">Raised, dense: a card on a card.</p>
              </Panel>
            </Panel>
            <Panel level="floating" pad="lg">
              <SectionHeader title="Floating" />
              <p className="sg-p">Menus, popovers and dialogs cast the one floating shadow.</p>
            </Panel>
          </div>
        </Block>

        <Block
          title="Floating"
          note="Everything that floats is one material: the lightest surface, a hairline edge, a lit top edge, the float shadow. Dialogs rise over a dimmed page; menus and popovers grow out of what opened them; tooltips and toasts are passing messages (ink on paper). A question before what can't be undone names the thing, says in one sentence what happens and carries its keys: Esc keeps things, ⌘↵ goes ahead."
        >
          <div className="sg-floats">
            <div className="modal alert sg-float" data-testid="sg-confirm">
              <div className="alert-body">
                <h3>Delete the folder “Teasers”?</h3>
                <div className="alert-text">Only the folder goes: 3 videos move up to Northwind.</div>
              </div>
              <div className="modal-foot alert-foot">
                <button type="button" className="btn" data-keys="Esc">
                  Cancel
                </button>
                <button type="button" className="btn danger-fill" data-keys="⌘↵">
                  Delete folder
                </button>
              </div>
            </div>
            <div className="modal sg-float sg-dialog">
              <div className="modal-head">
                <h3 className="grow">Move spot.mp4</h3>
                <IconButton label="Close" icon="x" size={18} />
              </div>
              <div className="modal-body">
                <p className="sg-p">A dialog: the title, what it's for, the actions. The primary answers to ⌘↵ from anywhere in it.</p>
              </div>
              <div className="modal-foot">
                <span className="grow" />
                <button type="button" className="btn">
                  Cancel
                </button>
                <button type="button" className="btn primary">
                  Move here
                </button>
              </div>
            </div>
            <div className="menu sg-float sg-menu">
              <button type="button">
                <I name="play" size={15} />
                <span className="grow">Open</span>
                <kbd className="menu-kbd">↵</kbd>
              </button>
              <button type="button">
                <I name="moveTo" size={15} />
                <span className="grow">Move to…</span>
              </button>
              <div className="menu-sep" />
              <button type="button" className="danger">
                <I name="trash" size={15} />
                <span className="grow">Remove from library…</span>
              </button>
            </div>
            <div className="sg-float-col">
              <span className="tip">
                Display <Kbd>⇧D</Kbd>
              </span>
              <span className="toast ok">
                <I name="check" size={15} />
                <span className="toast-title">Archived spot.mp4</span>
                <button type="button" className="toast-act">
                  <I name="undo" size={13} /> Undo
                </button>
              </span>
            </div>
          </div>
        </Block>

        <Block
          title="Agent at work"
          note="What an agent's work on a video says, in every state: one line in a fixed slot (states swap words, never heights), a 2 px edge that fills while a render or an upload reports, a keyframe glyph for the state. Only what needs you earns the raised button. No noun for the work: the words say what happens."
        >
          <AgentAtWork />
        </Block>

        <Block title="Rows" note="40 px, dense 32: a leading visual, the text, trailing bits.">
          <Panel pad="none" className="sg-list">
            <ListRow lead={<Avatar name="Sam Keller" />} title="Sam Keller" sub="Owner · signed in 2 min ago" trail={<Chip>owner</Chip>} />
            <ListRow lead={<I name="key" size={16} />} title="CI deploys" sub="Created 3 days ago" trail={<Button size="sm">Revoke</Button>} />
            <ListRow
              lead={<I name="folder" size={16} />}
              title="A clickable row with a name long enough to be cut short"
              onClick={() => {}}
              trail={<Chip kind="count">12</Chip>}
            />
            <ListRow dense lead={<I name="link" size={14} />} title="Dense row" trail={<Chip kind="version">V4</Chip>} />
          </Panel>
        </Block>

        <Block
          title="Empty states"
          note="A place, not a gap: a soft panel as big as what it stands in for, a scene in the keyframe language with one lit element, a headline without a full stop, one sentence, one raised action (a quiet one beside it), a tip or two."
        >
          <EmptyState
            art="library"
            title="Nothing to review yet"
            action={
              <Button variant="primary" icon="upload">
                Upload video <kbd>U</kbd>
              </Button>
            }
            secondary={<Button variant="ghost">Connect an agent</Button>}
            tips={['Drop render files anywhere on this page']}
          >
            Upload a render and every note you pin reaches the agent that made it, frame-exact.
          </EmptyState>
          <div className="sg-empties">
            {ARTS.map(([art, title, body]) => (
              <Panel key={art} pad="none">
                <EmptyState art={art} title={title} size="sm">
                  {body}
                </EmptyState>
              </Panel>
            ))}
          </div>
        </Block>

        <Block title="Scales" note="Everything is on these steps; test/unit/design-scale.test.ts rejects anything else.">
          <div className="sg-type">
            {SIZES.map(([k, label]) => (
              <div key={k} className="sg-type-row">
                <span className={`sg-fs sg-fs-${k}`}>Frame-exact review</span>
                <span className="sg-label">
                  --fs-{k} · {label}
                </span>
              </div>
            ))}
          </div>
          <Row label="weights">
            <span className="sg-fw-400">Text 400</span>
            <span className="sg-fw-500">Interface 500</span>
            <span className="sg-fw-650">Strong 650</span>
            <span className="mono">00:01:12:04 · mono for times, frames, counts</span>
          </Row>
          <Row label="spacing">
            {SPACE.map((s) => (
              <span key={s} className="sg-space" title={`--sp-${s}`}>
                <i className={`sg-sp-${s}`} />
                {s.replace('_', '.')}
              </span>
            ))}
          </Row>
          <Row label="radius">
            {['sm', 'r', 'lg', 'full'].map((r) => (
              <span key={r} className={`sg-radius sg-r-${r}`}>
                {r}
              </span>
            ))}
          </Row>
          <Row label="heights">
            {['xs', 'sm', 'md', 'lg'].map((h) => (
              <span key={h} className={`sg-height sg-h-${h}`}>
                {h}
              </span>
            ))}
          </Row>
          <Row label="shadows">
            <span className="sg-shadow sg-shadow-raise">raise</span>
            <span className="sg-shadow sg-shadow-press">press</span>
            <span className="sg-shadow sg-shadow-float">floating</span>
            <span className="sg-shadow sg-shadow-focus">focus</span>
          </Row>
        </Block>
      </div>
    </main>
  );
}
