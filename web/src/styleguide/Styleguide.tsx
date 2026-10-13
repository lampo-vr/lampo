// #/styleguide: every building block of the design system, in every variant and state, on one page — the place to
// look before adding a class, and what test/e2e/styleguide.mjs photographs in both themes. Only in dev and test builds
// (LAMPO_STYLEGUIDE=0 leaves it out: the Dockerfile does). No data, no sign-in. A tool page for people building the
// app, so its words are plain English, not translated. States that can't be held still (hover, pressed, keyboard
// focus) are the app's own rules, copied onto classes the samples carry (pseudo.ts); colours and the raised material
// show both themes side by side in theme islands (base.css .theme-dark / .theme-light).
import { type CSSProperties, type ReactNode, useState } from 'react';
import { AGENT_KIND_LABELS, AGENT_KINDS } from '../../../lib/agentKind.ts';
import type { Stage } from '../../../lib/types.ts';
import { toast, toastUndo } from '../lib/toast.ts';
import { RunStrip, RunStripPending } from '../player/RunStrip.tsx';
import { say } from '../sessions/activityWords.ts';
import { RunLine } from '../sessions/RunLine.tsx';
import { Code } from '../settings/parts.tsx';
import '../styles/styleguide.css';
import '../styles/toasts.css';
import { Badge, type Tone } from '../ui/Badge.tsx';
import { AutoTextarea, Avatar, Checkbox, Progress, Slider, Switch } from '../ui/controls.tsx';
import type { EmptyArtName } from '../ui/emptyArt.tsx';
import { Spinner } from '../ui/feedback.tsx';
import type { Shape } from '../ui/glyphs.ts';
import { AgentMark, BrandMark, I, Wordmark } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { LangSwitch } from '../ui/LangSwitch.tsx';
import { Drawer, HoverCard, IconButton, Kbd, Menu, Modal, Popover, Segmented, useConfirm } from '../ui/primitives.tsx';
import { RowsSkeleton, Skeleton, SkeletonRegion, SkeletonText, SkLine } from '../ui/Skeleton.tsx';
import { Select } from '../ui/select.tsx';
import { Button, Chip, EmptyState, ListRow, PageHeader, Panel, SectionHeader } from '../ui/system.tsx';
import { ThemeSwitch } from '../ui/ThemeSwitch.tsx';
import { Colours } from './Colours.tsx';
import { usePseudoStates } from './pseudo.ts';
import { RUN_STATES, runFixtures } from './runStates.ts';

const TONES: Tone[] = ['neutral', 'must', 'should', 'nice', 'idea', 'ok', 'agent'];
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
/** The type scale: token, px, what it is for. */
const SIZES = [
  ['4xl', 56, 'display: a title that is the page (a review link’s invitation)'],
  ['3xl', 36, 'page titles'],
  ['2xl', 24, 'dialog and empty-state titles, big numbers'],
  ['xl', 18, 'small empty-state titles, a dialog’s question'],
  ['lg', 15, 'section titles, an empty state’s sentence'],
  ['md', 13, 'body, controls'],
  ['sm', 12, 'secondary text, small controls, chips that filter'],
  ['xs', 11, 'chips, badges, captions, counts, key caps'],
  ['2xs', 10, 'only type drawn inside a picture at its own scale'],
  ['touch', 16, 'only text fields on touch screens (iOS zooms into anything smaller)'],
] as const;
const SPACE = [
  ['0_5', 2],
  ['1', 4],
  ['2', 8],
  ['3', 12],
  ['4', 16],
  ['6', 24],
  ['8', 32],
  ['12', 48],
  ['16', 64],
  ['20', 80],
] as const;
const HEIGHTS = [
  ['h-xs', 20, 'chips, badges'],
  ['h-sm', 26, 'small controls, toolbars'],
  ['h', 30, 'controls'],
  ['h-lg', 40, 'a large control, a page’s one action'],
  ['h-touch', 44, 'what a finger hits'],
  ['h-xl', 52, 'the one way into a page'],
] as const;
const SHADOWS = [
  ['raise', 'the raised material: a primary, what is on'],
  ['press', 'pressed while held'],
  ['sunk', 'a track: segments, tabs, the timecode'],
  ['shadow-float', 'what floats: menus, popovers, dialogs'],
  ['shadow-raise', 'lifted: a hovered card, a dragged one'],
  ['shadow-small', 'a card a little off the page'],
  ['shadow-hair', 'a card that barely lifts'],
  ['shadow-brand', 'the orange primary’s glow on hover'],
  ['shadow-danger', 'the danger button’s glow on hover'],
  ['focus-ring', 'a field’s soft halo while you type'],
] as const;
const LAYERS = [
  ['z-top', 90, 'tooltips'],
  ['z-toast', 80, 'toasts'],
  ['z-uploads', 70, 'the upload tray'],
  ['z-palette', 61, 'the ⌘K palette'],
  ['z-layer', 55, 'dialogs, menus, popovers, hover cards (--z-dialog, --z-menu, --z-float): one layer, the one opened last on top'],
  ['z-sheet', 51, 'sheets and the drawer'],
  ['z-overlay', 50, 'a drawer’s scrim'],
  ['z-inbox', 45, 'the inbox layer'],
  ['z-topbar', 30, 'the top bar'],
] as const;
const MOTION = [
  ['dur-fast', '120 ms', 'menus, hovers, leaving'],
  ['dur', '180 ms', 'most things'],
  ['dur-slow', '280 ms', 'dialogs and sheets arriving'],
  ['ease-out', 'entering', ''],
  ['ease-in', 'leaving (faster than entering)', ''],
  ['ease-in-out', 'moving across', ''],
  ['ease-spring', 'small things that snap: a switch, a toast', ''],
] as const;
const SHAPES: [Shape, string][] = [
  ['outline', 'open, not decided'],
  ['half', 'half done: fixed, to check'],
  ['diamond', 'settled, decided'],
  ['circle', 'optional: an idea'],
  ['ease', 'someone on it, time passing'],
  ['hold', 'nothing moves any more'],
];
const KG_TONES = ['', 'must', 'should', 'nice', 'idea', 'ok', 'agent'] as const;
const SEVERITIES = ['must', 'should', 'nice', 'idea', 'question', 'info', 'agent'] as const;
/** A picture for an avatar that has one (drawn here: no request). */
const PICTURE = `data:image/svg+xml,${encodeURIComponent(
  "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'><defs><linearGradient id='g' x2='1' y2='1'><stop offset='0' stop-color='#6b5b95'/><stop offset='1' stop-color='#d98e73'/></linearGradient></defs><rect width='40' height='40' fill='url(#g)'/><circle cx='20' cy='16' r='7' fill='#f4ede4'/><path d='M6 40c2-9 8-13 14-13s12 4 14 13Z' fill='#f4ede4'/></svg>",
)}`;
const TOC: [string, string][] = [
  ['brand', 'Brand'],
  ['colour', 'Colour'],
  ['type', 'Type'],
  ['scales', 'Scales'],
  ['raised', 'The raised material'],
  ['buttons', 'Buttons'],
  ['fields', 'Fields'],
  ['choosing', 'Choosing'],
  ['chips', 'Chips, badges and labels'],
  ['glyphs', 'Keyframe glyphs'],
  ['keys', 'Keys, avatars and code'],
  ['progress', 'Progress and steps'],
  ['surfaces', 'Surfaces'],
  ['floating', 'Floating'],
  ['rows', 'Rows and headers'],
  ['loading', 'Loading'],
  ['marks', 'Agent marks'],
  ['agents', 'Agent at work'],
  ['empty', 'Empty states'],
];

const noop = () => {};
const still = { stop: async () => {}, retry: async () => {}, nudge: async () => {}, busy: false };
const SESSION = { name: 'Claude Code', id: 'mcp-sg', cwd: null, assigned: '2026-10-07T09:00:00.000Z', by: 'Sam', agent: 'claude-code' as const };
/** A note row's state on its right (player/CommentCard.tsx): a small label in the system's Badge, green only as its mark. */
const NOTE_STATES: [string, Tone][] = [
  ['Fixed in V2', 'ok'],
  ['Question', 'agent'],
  ['Agent on it', 'agent'],
  ['Fixed · waiting for V3', 'neutral'],
  ['Check again', 'should'],
  ['Checked', 'neutral'],
];

/** An agent at work on a video, in every state (design §5.2): the agent's line, the library's line, a note row's state. */
function AgentAtWork() {
  const [now] = useState(() => Date.now());
  const runs = runFixtures('sg', ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7'], 3, now);
  const strip = (key: string, run: (typeof runs)[keyof typeof runs]['run'] | null, stalled = false) => (
    <div key={key} className="sg-strip" data-state={key}>
      <span className="sg-label">{key}</span>
      <div className="sg-strip-box">
        <RunStrip
          slug="sg"
          run={run}
          asOf={now}
          session={SESSION}
          stalled={stalled}
          toCheck={run?.state === 'done' ? 5 : 0}
          nextV={4}
          canSteer
          say={(w) => say(w)}
          onOpen={noop}
          onAnswer={noop}
          still={now}
          act={still}
        />
      </div>
    </div>
  );
  return (
    <>
      <div className="sg-strips" data-testid="sg-strips">
        {/* ready and unreachable say nothing: the line is there only while something goes on or needs the person */}
        {/* it asked, then stopped listening, and the person answered: the line says to tell it "go on" */}
        {strip('not listening', runs.working.run, true)}
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
      <Row label="note states" note="At the end of a note row's second line, one small label: never green words, the green is the mark's.">
        {NOTE_STATES.map(([words, tone]) => (
          <Badge key={words} tone={tone} size="sm" className="nr-state">
            {words}
          </Badge>
        ))}
      </Row>
    </>
  );
}

function Block({ id, title, note, children }: { id: string; title: string; note?: string; children: ReactNode }) {
  return (
    <section className="sg-block" id={`sg-${id}`} aria-label={title}>
      <SectionHeader title={title} />
      {note && <p className="sg-note">{note}</p>}
      {children}
    </section>
  );
}

function Row({ label, children, note }: { label: string; children: ReactNode; note?: string }) {
  return (
    <div className="sg-row">
      <span className="sg-label">{label}</span>
      <div className="sg-items">
        {children}
        {note && <span className="sg-row-note">{note}</span>}
      </div>
    </div>
  );
}

/** A grid of samples: a header row of column names, then a label and one sample per column. */
function Matrix({ cols, rows, testId }: { cols: string[]; rows: [string, ReactNode[]][]; testId?: string }) {
  return (
    <div className="sg-matrix" style={{ '--cols': cols.length } as CSSProperties} data-testid={testId}>
      <span />
      {cols.map((c) => (
        <span key={c} className="sg-label sg-col">
          {c}
        </span>
      ))}
      {rows.map(([label, cells]) => (
        <div key={label} className="sg-matrix-row">
          <span className="sg-label">{label}</span>
          {cells.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: a fixed grid, one cell per column
            <div key={i} className="sg-cell" data-col={cols[i]}>
              {c}
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

const STATES = ['default', 'hover', 'pressed', 'focus', 'disabled', 'busy'] as const;
const stateProps = (s: (typeof STATES)[number]) => ({
  className: s === 'hover' ? 'sg-hover' : s === 'pressed' ? 'sg-active' : s === 'focus' ? 'sg-focus' : '',
  disabled: s === 'disabled',
  busy: s === 'busy',
});

/** The raised material's samples (shown in each theme's island). */
function RaisedSamples() {
  const [seg, setSeg] = useState('grid');
  const [period, setPeriod] = useState('30d');
  return (
    <>
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
        label="Order"
        value={period}
        onChange={setPeriod}
        options={[
          { value: '30d', label: 'Last active' },
          { value: 'new', label: 'Newest' },
        ]}
      />
      <button type="button" className="chip on" aria-pressed>
        logo
      </button>
      <Button pressed icon="compare">
        Compare
      </Button>
      <Switch checked label="On" onCheckedChange={() => {}} />
      <Button variant="danger">Delete</Button>
    </>
  );
}

/** Live layers: the real dialog, question, menu, popover, drawer and toasts (sheets from the bottom edge on a phone). */
function LiveLayers() {
  const [dialog, setDialog] = useState(false);
  const [pop, setPop] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const [checked, setChecked] = useState(true);
  const [ask, confirmation] = useConfirm();
  return (
    <div className="sg-items" data-testid="sg-live">
      <Button onClick={() => setDialog(true)}>Open a dialog</Button>
      <Button
        onClick={async () => {
          if (
            await ask({
              title: 'Delete the folder “Teasers”?',
              body: 'Only the folder goes: 3 videos move up to Northwind.',
              action: 'Delete folder',
              danger: true,
            })
          )
            toast('Deleted “Teasers”', 'ok');
        }}
      >
        Ask before deleting
      </Button>
      <Menu
        trigger={
          <button type="button" className="btn">
            Open a menu <I name="down" size={12} />
          </button>
        }
        align="start"
        items={[
          { heading: 'Video' },
          { label: 'Open', icon: 'play', shortcut: '↵', onClick: noop },
          { label: 'Move to…', icon: 'moveTo', onClick: noop },
          { label: 'Show it on the board', checked, keep: true, onClick: () => setChecked((c) => !c) },
          {
            sub: {
              label: 'Download another version',
              icon: 'download',
              items: [
                { label: 'V2', onClick: noop },
                { label: 'V1', onClick: noop },
              ],
            },
          },
          'sep',
          { label: 'Remove from library…', icon: 'trash', danger: true, onClick: noop },
        ]}
      />
      <Popover
        open={pop}
        onOpenChange={setPop}
        align="start"
        trigger={
          <button type="button" className="btn">
            Open a popover
          </button>
        }
      >
        <SectionHeader title="A popover" as="h3" />
        <p className="sg-p">Grows out of what opened it; Esc or a click away closes it.</p>
      </Popover>
      <HoverCard
        trigger={
          <button type="button" className="btn ghost">
            Hover for a card
          </button>
        }
      >
        <div className="hc-head">
          <Avatar name="Sam Keller" />
          <b>Sam Keller</b>
        </div>
        <dl className="hc-rows">
          <dt>Role</dt>
          <dd>Owner</dd>
          <dt>Last here</dt>
          <dd>2 minutes ago</dd>
        </dl>
      </HoverCard>
      <Button onClick={() => setDrawer(true)}>Open the drawer</Button>
      <Button onClick={() => toast('Saved', 'ok')}>Toast</Button>
      <Button onClick={() => toastUndo('Archived spot.mp4', noop)}>Toast with Undo</Button>
      <Button onClick={() => toast('Couldn’t reach the server', 'error')}>Error toast</Button>
      {/* the stack: three toasts a beat apart, the newest in front, the two before it tucked behind */}
      <Button
        data-testid="sg-toast-stack"
        onClick={() => {
          toast('Saved', 'ok', undefined, { duration: 12000 });
          setTimeout(() => toast('Archived spot.mp4', 'ok', { label: 'Undo', undo: true, onClick: noop }, { duration: 12000 }), 220);
          setTimeout(() => toast('Couldn’t reach the server', 'error'), 440);
        }}
      >
        Three toasts
      </Button>
      <IconButton label="A tooltip, with its key" icon="search" shortcut="⌘K" className="btn icon-only" />
      {dialog && (
        <Modal
          title="Move spot.mp4"
          onClose={() => setDialog(false)}
          width={480}
          foot={
            <>
              <span className="grow" />
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="primary" onClick={() => setDialog(false)}>
                Move here
              </Button>
            </>
          }
        >
          <p className="sg-p">A dialog: the title, what it’s for, the actions. The primary answers to ⌘↵ from anywhere in it.</p>
        </Modal>
      )}
      <Drawer open={drawer} onOpenChange={setDrawer} title="Folders and views">
        <div className="sg-drawer-body">
          <ListRow dense lead={<I name="inbox" size={16} />} title="Inbox" trail={<Chip kind="count">3</Chip>} onClick={() => setDrawer(false)} />
          <ListRow dense lead={<I name="film" size={16} />} title="All videos" onClick={() => setDrawer(false)} />
        </div>
      </Drawer>
      {confirmation}
    </div>
  );
}

export default function Styleguide() {
  usePseudoStates();
  const [period, setPeriod] = useState('30d');
  const [lane, setLane] = useState('open');
  const [tab, setTab] = useState('notes');
  const [on, setOn] = useState(true);
  const [check, setCheck] = useState(true);
  const [level, setLevel] = useState(60);
  const [select, setSelect] = useState('1');
  const [text, setText] = useState('Logo a touch smaller, and a frame later.');
  const [chips, setChips] = useState(['logo']);
  const toggle = (c: string) => setChips((cs) => (cs.includes(c) ? cs.filter((x) => x !== c) : [...cs, c]));
  const kinds = ['primary', 'secondary', 'ghost', 'danger'] as const;
  return (
    <main className="sg" data-testid="styleguide">
      <div className="sg-page">
        <nav className="sg-toc" aria-label="Sections">
          {TOC.map(([id, name]) => (
            <button key={id} type="button" onClick={() => document.getElementById(`sg-${id}`)?.scrollIntoView({ block: 'start' })}>
              {name}
            </button>
          ))}
        </nav>
        <div className="sg-main">
          <PageHeader eyebrow="Design system" title="Styleguide" meta="Every building block, every variant and state" aside={<ThemeSwitch labels />} />

          <Block
            id="brand"
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
            id="colour"
            title="Colour"
            note="Every colour is a token in base.css; nothing else names one. The chrome is achromatic so it never tints how the video’s colour is seen; colour carries meaning only. Each token in both themes, side by side, with the contrast of text colours on the page (--ink-1)."
          >
            <Colours />
          </Block>

          <Block
            id="type"
            title="Type"
            note="Instrument Sans for everything; titles in its heavier, semi-condensed cut (--display, 87.5 % width); Martian Mono, condensed, for times, frames and counts; key caps in the UI face with the system’s ⌘ ⇧ ⌥ ↵. Ten sizes, three weights, three line heights — test/unit/design-scale.test.ts refuses anything else."
          >
            <div className="sg-type">
              {SIZES.map(([k, size, use]) => (
                <div key={k} className={`sg-type-row ${k === '4xl' ? 'big' : ''}`}>
                  <span className={`sg-fs sg-fs-${k}`}>{k === '2xs' ? 'F 0295 · 00:12:07' : 'Frame-exact review'}</span>
                  <span className="sg-label">
                    <code>--fs-{k}</code> {size} · {use}
                  </span>
                </div>
              ))}
            </div>
            <Row label="weights">
              <span className="sg-fw-400">Text 400</span>
              <span className="sg-fw-500">Interface 500</span>
              <span className="sg-fw-650">Strong 650</span>
            </Row>
            <Row label="faces">
              <span className="sg-face-display">Display, 650 semi-condensed</span>
              <span className="sg-face-wide">The same at full width</span>
              <span className="mono">00:01:12:04 · F 1732 · 24 fps</span>
              <span className="sg-face-keys">⌘ ⇧ ⌥ ↵ Esc O 0</span>
            </Row>
            <Row label="line heights">
              <span className="sg-lh sg-lh-tight">
                Tight 1.1
                <br />
                for titles
              </span>
              <span className="sg-lh sg-lh-ui">
                UI 1.3
                <br />
                for controls and rows
              </span>
              <span className="sg-lh sg-lh-body">
                Body 1.5
                <br />
                for sentences
              </span>
            </Row>
            <Row label="tracking">
              <span className="sg-fs-2xl sg-face-display">Titles −0.02 em</span>
              <span className="eyebrow">Eyebrows +0.06 em</span>
            </Row>
          </Block>

          <Block id="scales" title="Scales" note="Every size is a step of one of these (base.css); the design tests reject anything else.">
            <div className="sg-scales">
              <Row label="spacing">
                {SPACE.map(([s, v]) => (
                  <span key={s} className="sg-space" title={`--sp-${s}`}>
                    <i className={`sg-sp-${s}`} />
                    {v}
                  </span>
                ))}
              </Row>
              <Row label="radius">
                {(
                  [
                    ['sm', 4],
                    ['r', 8],
                    ['lg', 12],
                    ['full', '∞'],
                  ] as const
                ).map(([r, v]) => (
                  <span key={r} className={`sg-radius sg-r-${r}`}>
                    {v}
                  </span>
                ))}
              </Row>
              <Row
                label="nested radius"
                note="Concentric: inset p inside a corner of R, a corner gets R − p, so the gap stays even around the curve (further in than R it is free). A track’s item --r-track-in = 8 − 1 − 2 = 5; a menu’s row --r-menu-in = 8 − 1 − 4 = 3."
              >
                <span className="sg-nest sg-nest-track" data-testid="sg-nest">
                  <span>5</span>
                </span>
                <span className="sg-nest sg-nest-menu">
                  <span>3</span>
                </span>
                <span className="sg-nest sg-nest-card">
                  <span>4</span>
                </span>
              </Row>
              <Row label="control heights">
                {HEIGHTS.map(([h, v, use]) => (
                  <span key={h} className={`sg-height sg-${h}`} title={use}>
                    {v}
                  </span>
                ))}
              </Row>
              <Row
                label="icons"
                note="Follow the type beside them: 12 in chips and as a chevron, 14 beside 12 px, 16 beside 13 px and alone in 26–30 px, 20 alone in 40 px; the stroke a little heavier the smaller."
              >
                {(
                  [
                    ['xs', 12],
                    ['sm', 14],
                    ['md', 16],
                    ['lg', 20],
                  ] as const
                ).map(([k, v]) => (
                  <span key={k} className="sg-icon">
                    <I name="pen" size={v} />
                    {v}
                  </span>
                ))}
              </Row>
              <Row label="shadows">
                {SHADOWS.map(([s, use]) => (
                  <span key={s} className={`sg-shadow sg-sh-${s}`} title={use}>
                    {s}
                  </span>
                ))}
              </Row>
              <Row label="layers">
                <ol className="sg-layers">
                  {LAYERS.map(([z, v, use]) => (
                    <li key={z}>
                      <code>--{z}</code> {v} · {use}
                    </li>
                  ))}
                </ol>
              </Row>
              <Row label="motion">
                <ul className="sg-layers">
                  {MOTION.map(([m, v, use]) => (
                    <li key={m}>
                      <code>--{m}</code> {v}
                      {use && ` · ${use}`}
                    </li>
                  ))}
                </ul>
              </Row>
            </div>
          </Block>

          <Block
            id="raised"
            title="The raised material"
            note="One look for everything you can press that matters and everything that is on: a primary action, a selected item, a pressed toggle. Pressed while held: inset. In both themes, side by side."
          >
            <div className="sg-themes" data-testid="sg-raised">
              <div className="sg-raised theme-dark">
                <RaisedSamples />
              </div>
              <div className="sg-raised theme-light">
                <RaisedSamples />
              </div>
            </div>
          </Block>

          <Block
            id="buttons"
            title="Buttons"
            note="Primary once per view, in the brand’s orange. Secondary is the default; ghost for toolbars and rows; danger only for what can’t be undone. Hover lights a filled button rather than lightening it; pressed sinks; a disabled filled button lies flat and grey; busy keeps its look with a spinner in the icon’s place."
          >
            <Matrix
              testId="sg-button-sizes"
              cols={['small', 'medium', 'large', 'with icon', 'icon only', 'icon only, small']}
              rows={kinds.map((v) => [
                v,
                [
                  <Button key="s" variant={v} size="sm">
                    Small
                  </Button>,
                  <Button key="m" variant={v}>
                    Medium
                  </Button>,
                  <Button key="l" variant={v} size="lg" icon="plus">
                    Large
                  </Button>,
                  <Button key="i" variant={v} icon="plus">
                    With icon
                  </Button>,
                  <Button key="o" variant={v} icon="more" iconOnly aria-label="More" />,
                  <Button key="os" variant={v} size="sm" icon="more" iconOnly aria-label="More" />,
                ],
              ])}
            />
            <Matrix
              testId="sg-button-states"
              cols={[...STATES]}
              rows={[
                ...kinds.map((v): [string, ReactNode[]] => [
                  v,
                  STATES.map((s) => (
                    <Button key={s} variant={v} icon="check" {...stateProps(s)}>
                      Save
                    </Button>
                  )),
                ]),
                [
                  'pressed toggle',
                  STATES.map((s) => (
                    <Button key={s} pressed icon="compare" {...stateProps(s)}>
                      Compare
                    </Button>
                  )),
                ],
                [
                  'link',
                  STATES.map((s) => (
                    <Button key={s} variant="link" className={stateProps(s).className} disabled={s === 'disabled' || s === 'busy'}>
                      Show all
                    </Button>
                  )),
                ],
                [
                  'icon button',
                  STATES.map((s) => (
                    <IconButton
                      key={s}
                      label="Settings"
                      icon="settings"
                      className={`btn ghost icon-only ${stateProps(s).className}`}
                      disabled={s === 'disabled'}
                    />
                  )),
                ],
              ]}
            />
            <Row label="icon buttons" note="IconButton: always named, always a tooltip (hover one).">
              <IconButton label="Search" icon="search" shortcut="⌘K" />
              <IconButton label="Settings" icon="settings" className="btn icon-only" />
              <IconButton label="Close" icon="x" className="btn ghost icon-only sm" />
              <IconButton label="Freehand" icon="pen" className="btn ghost icon-only lg" />
            </Row>
            <Row
              label="keys and chevrons"
              note="A dialog’s primary carries ⌘↵ as a drawn key cap; a button that opens a menu or a choice ends in the small chevron."
            >
              <Button variant="primary" data-keys="⌘↵">
                Send
              </Button>
              <Button data-keys="Esc">Cancel</Button>
              <button type="button" className="btn sm ghost">
                <I name="pen" size={14} /> Change <I name="down" size={12} />
              </button>
              <Button variant="link" icon="external">
                Open the docs
              </Button>
            </Row>
            <Row label="a confirmation" note="Looks right, Got it: the plain button, only its check in green (.btn.ok).">
              <button type="button" className="btn sm ok">
                <I name="check" size={14} /> Looks right <Kbd>Y</Kbd>
              </button>
              <button type="button" className="btn sm">
                <I name="x" size={14} /> Still wrong <Kbd>N</Kbd>
              </button>
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
            id="fields"
            title="Fields"
            note="A field is a well (--ink-0) with a hairline; hover strengthens the line, focus shows where typing goes (the edge in --fg-2 and the soft halo, for mouse and keyboard alike). One height with the buttons beside it; 16 px type on touch screens."
          >
            <Matrix
              testId="sg-field-states"
              cols={['default', 'filled', 'hover', 'focus', 'disabled']}
              rows={[
                [
                  'input',
                  [
                    <input key="d" className="input" placeholder="Filter videos" aria-label="Filter videos" />,
                    <input key="f" className="input" defaultValue="Spring campaign" aria-label="Name" />,
                    <input key="h" className="input sg-hover" placeholder="Filter videos" aria-label="Hovered" />,
                    <input key="o" className="input sg-focus" defaultValue="Spring camp" aria-label="Focused" />,
                    <input key="x" className="input" disabled placeholder="Disabled" aria-label="Disabled" />,
                  ],
                ],
                [
                  'select',
                  [
                    <Select
                      key="d"
                      label="Speed"
                      value={select}
                      onChange={setSelect}
                      options={[
                        { value: '0.5', label: '0.5×' },
                        { value: '1', label: '1×' },
                        { value: '2', label: '2×' },
                      ]}
                    />,
                    <Select
                      key="s"
                      label="Speed (small)"
                      size="sm"
                      value={select}
                      onChange={setSelect}
                      options={[
                        { value: '0.5', label: '0.5×' },
                        { value: '1', label: '1×' },
                        { value: '2', label: '2×' },
                      ]}
                    />,
                    <button key="h" type="button" className="input select sg-hover" aria-label="Hovered select">
                      <span className="select-sizer">1×</span>
                    </button>,
                    <button key="o" type="button" className="input select sg-focus" aria-label="Focused select">
                      <span className="select-sizer">1×</span>
                    </button>,
                    <button key="x" type="button" className="input select" disabled aria-label="Disabled select">
                      <span className="select-sizer">1×</span>
                    </button>,
                  ],
                ],
              ]}
            />
            <Row label="search" note="The library’s and the operator’s search field (.lib-filter): the field with a glass and its key.">
              <label className="lib-filter sg-search">
                <I name="search" size={15} />
                <input className="input" placeholder="Search this view" aria-label="Search this view" />
                <kbd className="kbd">/</kbd>
              </label>
            </Row>
            <Row label="text">
              <div className="sg-w-lg">
                <textarea className="textarea" placeholder="A textarea: grows with what is typed, up to 40 % of the window" aria-label="Textarea" />
              </div>
              <div className="sg-w-lg">
                <AutoTextarea value={text} onChange={(e) => setText(e.target.value)} aria-label="A note" placeholder="Write a note" />
              </div>
            </Row>
            <Matrix
              testId="sg-toggles"
              cols={['off', 'on', 'focus', 'disabled off', 'disabled on']}
              rows={[
                [
                  'switch',
                  [
                    <Switch key="0" checked={!on} onCheckedChange={(v) => setOn(!v)} label="Switch off" />,
                    <Switch key="1" checked={on} onCheckedChange={setOn} label="Switch on" />,
                    <span key="f" className="sg-focus-wrap">
                      <Switch checked onCheckedChange={noop} label="Focused switch" />
                    </span>,
                    <Switch key="d0" checked={false} disabled onCheckedChange={noop} label="Disabled, off" />,
                    <Switch key="d1" checked disabled onCheckedChange={noop} label="Disabled, on" />,
                  ],
                ],
                [
                  'checkbox',
                  [
                    <Checkbox key="0" checked={!check} onCheckedChange={(v) => setCheck(!v)} label="Checkbox off" />,
                    <Checkbox key="1" checked={check} onCheckedChange={setCheck} label="Checkbox on" />,
                    <span key="f" className="sg-focus-wrap">
                      <Checkbox checked onCheckedChange={noop} label="Focused checkbox" />
                    </span>,
                    <Checkbox key="d0" checked={false} disabled onCheckedChange={noop} label="Disabled, off" />,
                    <Checkbox key="d1" checked disabled onCheckedChange={noop} label="Disabled, on" />,
                  ],
                ],
              ]}
            />
            <Row label="radio" note="One of a few: a segmented control (role=radio, arrow keys move it). A long list is a select.">
              <Segmented
                label="Plan"
                value={period}
                onChange={setPeriod}
                options={[
                  { value: '7d', label: 'Monthly' },
                  { value: '30d', label: 'Yearly' },
                ]}
              />
            </Row>
            <Row label="slider">
              <div className="sg-w">
                <Slider value={level} onChange={setLevel} label="Level" />
              </div>
            </Row>
          </Block>

          <Block
            id="choosing"
            title="Choosing"
            note="Segmented for a few exclusive choices, tabs for views of one thing (both a sunken track with the chosen item raised in it, its corners concentric with the track’s), chips for quick views, a select when the list is long."
          >
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
              <Segmented
                label="Order"
                className="sg-sort"
                value={period === '7d' ? 'new' : 'active'}
                onChange={(v) => setPeriod(v === 'new' ? '7d' : '30d')}
                options={[
                  { value: 'active', label: 'Last active' },
                  { value: 'new', label: 'Newest' },
                ]}
              />
            </Row>
            <Row
              label="states"
              note="An item under the pointer, held, focused from the keyboard (the ring fills the gap around it), and one that can’t be chosen now."
            >
              {/* biome-ignore lint/a11y/useSemanticElements: the element Segmented renders (a fieldset brings its own box) */}
              <div className="seg" role="group" aria-label="States">
                <button type="button" className="on">
                  On
                </button>
                <button type="button" className="sg-hover">
                  Hover
                </button>
                <button type="button" className="sg-active">
                  Pressed
                </button>
                <button type="button" className="sg-focus">
                  Focus
                </button>
                <button type="button" disabled>
                  Disabled
                </button>
              </div>
            </Row>
            <Row label="icons, switches">
              <Segmented
                label="Layout"
                value="grid"
                onChange={noop}
                iconOnly
                options={[
                  { value: 'grid', label: 'Grid', icon: 'grid' },
                  { value: 'compact', label: 'Compact', icon: 'compact' },
                  { value: 'list', label: 'List', icon: 'list' },
                  { value: 'board', label: 'Board', icon: 'board' },
                ]}
              />
              <ThemeSwitch />
              <LangSwitch />
            </Row>
            <Row label="tabs">
              <div className="tabs" role="tablist" aria-label="Panel">
                {['notes', 'versions', 'activity'].map((x) => (
                  <button key={x} type="button" role="tab" aria-selected={tab === x} className={tab === x ? 'on' : ''} onClick={() => setTab(x)}>
                    {x === 'notes' && <I name="notes" size={14} />}
                    {x[0].toUpperCase() + x.slice(1)}
                    {x === 'notes' && <span className="n">4</span>}
                    {x === 'versions' && <span className="n ok">2</span>}
                  </button>
                ))}
              </div>
            </Row>
            <Row label="quick views" note="Loose chips (no track); a count on its way holds two digits’ room.">
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
          </Block>

          <Block
            id="chips"
            title="Chips, badges and labels"
            note="Chips and badges are 20 px high pills; key caps keep a key’s corners. Where a video stands is a badge with its keyframe glyph, never a coloured dot. Labels (uppercase: a role, YOU, NEW) are the small square family."
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
              <button type="button" className="chip sg-hover">
                hover
              </button>
              <button type="button" className="chip sg-focus">
                focus
              </button>
              <button type="button" className="chip" disabled>
                disabled
              </button>
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
            <Row label="labels">
              <span className="badge">YOU</span>
              <span className="badge ok">ON THE HOUSE</span>
              <span className="badge warn">TRIAL</span>
              <span className="badge idea">IDEA</span>
              <span className="badge danger">DISABLED</span>
              <span className="badge agent">SUGGESTED</span>
              <span className="badge ok">
                <I name="freeze" size={12} /> no freezes
              </span>
            </Row>
            <Row label="severity" note="A note’s kind: shape and colour, the word beside it.">
              {SEVERITIES.map((s) => (
                <span key={s} className={`sev ${s}`}>
                  {s}
                </span>
              ))}
            </Row>
            <Row label="on a picture" note="Glass chips on a poster, concentric with its corner.">
              <div className="sg-poster sg-poster-sm film-poster">
                <div className="film-over top">
                  <span className="vchip">0:42</span>
                  <span className="grow" />
                  <span className="vchip notes must">3</span>
                </div>
                <div className="film-over bottom">
                  <span className="grow" />
                  <span className="vchip">V4</span>
                </div>
              </div>
            </Row>
          </Block>

          <Block
            id="glyphs"
            title="Keyframe glyphs"
            note="Status is a keyframe glyph (ui/glyphs.ts): the shape carries the meaning, so it survives colour blindness and print; a status colour tints it; nothing glows. A change pops once; an agent at work turns slowly."
          >
            <div className="sg-glyphs" data-testid="sg-glyphs">
              <span />
              {KG_TONES.map((tone) => (
                <span key={tone} className="sg-label">
                  {tone || 'neutral'}
                </span>
              ))}
              {SHAPES.map(([shape, meaning]) => (
                <div key={shape} className="sg-glyph-row">
                  <span className="sg-label">
                    {shape} · {meaning}
                  </span>
                  {KG_TONES.map((tone) => (
                    <span key={tone} className={`sg-kg ${tone}`}>
                      <KeyGlyph shape={shape} size={12} />
                    </span>
                  ))}
                </div>
              ))}
            </div>
            <Row label="sizes, motion">
              <KeyGlyph shape="diamond" size={8} />
              <KeyGlyph shape="diamond" />
              <KeyGlyph shape="diamond" size={12} />
              <KeyGlyph shape="diamond" size={16} />
              <KeyGlyph shape="half" size={12} pop className="sg-kg ok" />
              <KeyGlyph shape="ease" className="nav-kg live" />
            </Row>
          </Block>

          <Block
            id="keys"
            title="Keys, avatars and code"
            note="Key caps in the UI face; a shortcut in a menu is quiet type; Code is a snippet to paste: one Copy, lines broken at spaces only."
          >
            <Row label="key caps">
              <Kbd>⌘</Kbd>
              <Kbd>K</Kbd>
              <Kbd>⇧V</Kbd>
              <Kbd>Esc</Kbd>
              <Kbd>↵</Kbd>
              <Chip kind="key">⌘K</Chip>
              <span className="sg-menu-kbd">
                in a menu <kbd className="menu-kbd">⌘C</kbd>
              </span>
            </Row>
            <Row label="avatars" note="Person, agent, review-link visitor; a picture once it has loaded, never broken.">
              <Avatar name="Sam Keller" size={16} />
              <Avatar name="Sam Keller" />
              <Avatar name="Sam Keller" size={28} />
              <Avatar name="Sam Keller" size={36} />
              <Avatar name="agent:render-bot" size={28} />
              <Avatar name="guest:Client" size={28} />
              <Avatar name="Mia Lang" src={PICTURE} size={28} />
              <Avatar name="" size={28} />
            </Row>
            <div className="sg-codes">
              <Code label="Connect Claude Code">claude mcp add --transport http --scope user lampo https://lampo.example/mcp</Code>
              <Code>lampo login https://lampo.example --token -</Code>
              <Code label="A config keeps its lines" lines>
                {'{\n  "mcpServers": {\n    "lampo": { "url": "https://lampo.example/mcp" }\n  }\n}'}
              </Code>
            </div>
          </Block>

          <Block
            id="progress"
            title="Progress and steps"
            note="A bar for what can be measured, a sweep for what can’t, a spinner only for a button’s own wait; a flow’s steps numbered."
          >
            <Row label="progress">
              <div className="sg-w">
                <Progress value={0} label="Not started" />
              </div>
              <div className="sg-w">
                <Progress value={level} label="Progress" />
              </div>
              <div className="sg-w">
                <Progress value={100} label="Done" tone="ok" />
              </div>
              <div className="sg-w">
                <Progress value={null} label="Working" tone="agent" />
              </div>
              <div className="sg-w">
                <Progress value={64} label="Failed" tone="must" />
              </div>
            </Row>
            <Row label="spinner">
              <Spinner label="Loading" />
              <Button busy icon="check">
                Saving
              </Button>
              <Button variant="primary" size="sm" busy icon="upload">
                Uploading
              </Button>
            </Row>
            <Row label="steps">
              <div className="steps">
                <span>
                  <span className="n">1</span> Pick an agent
                </span>
                <span className="on">
                  <span className="n">2</span> Connect it
                </span>
                <span>
                  <span className="n">3</span> Tell it
                </span>
              </div>
            </Row>
          </Block>

          <Block
            id="surfaces"
            title="Surfaces"
            note="Base: a card on a page. Raised: a card on a card. Floating: menus and dialogs. One padding rule: 16 in a list, dense 12, 24 for a page’s cards and dialogs. Banners are a screen’s own, in its words."
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
            <Row label="banners in use" note="A banner is the neutral surface; green marks a state (a glyph, a dot, one word), never a surface or an outline.">
              <div className="arch-banner" role="status">
                <span className="arch-banner-word">
                  <I name="archive" size={14} />
                  Archived
                </span>
                <span className="arch-banner-dot" aria-hidden="true">
                  ·
                </span>
                <button type="button" className="arch-banner-act">
                  Restore
                </button>
              </div>
            </Row>
          </Block>

          <Block
            id="floating"
            title="Floating"
            note="Everything that floats is one material: the lightest surface, a hairline edge, a lit top edge, the float shadow. Dialogs rise over a dimmed page; menus and popovers grow out of what opened them; tooltips are passing notes (ink on paper); toasts float too, one stack with the newest in front, opening on hover or focus. On a phone, dialogs and menus are sheets from the bottom edge. A question before what can’t be undone names the thing, says in one sentence what happens and carries its keys: Esc keeps things, ⌘↵ goes ahead."
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
                  <IconButton label="Close" icon="x" />
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
                <div className="menu-label">Video</div>
                <button type="button">
                  <I name="play" size={16} />
                  <span className="grow">Open</span>
                  <kbd className="menu-kbd">↵</kbd>
                </button>
                <button type="button" className="sg-hover">
                  <I name="moveTo" size={16} />
                  <span className="grow">Move to…</span>
                </button>
                <button type="button">
                  <span className="menu-icon-gap" />
                  <span className="grow">Show it on the board</span>
                  <I name="check" size={14} className="menu-tick" />
                </button>
                <button type="button" className="menu-sub">
                  <I name="download" size={16} />
                  <span className="grow">Download another version</span>
                  <I name="right" size={14} className="menu-sub-arrow" />
                </button>
                <div className="menu-sep" />
                <button type="button" className="danger">
                  <I name="trash" size={16} />
                  <span className="grow">Remove from library…</span>
                </button>
              </div>
              <div className="popover sg-float sg-popover">
                <SectionHeader title="A popover" as="h3" />
                <p className="sg-p">Grows out of what opened it: settings for a view, a picker, a few facts.</p>
                <div className="sg-items">
                  <Button size="sm">Cancel</Button>
                  <Button size="sm" variant="primary">
                    Apply
                  </Button>
                </div>
              </div>
              <div className="hovercard sg-float">
                <div className="hc-head">
                  <Avatar name="Sam Keller" />
                  <b>Sam Keller</b>
                </div>
                <dl className="hc-rows">
                  <dt>Role</dt>
                  <dd>Owner</dd>
                  <dt>Last here</dt>
                  <dd>2 minutes ago</dd>
                </dl>
              </div>
              <div className="sg-float-col">
                <span className="tip">
                  Display <Kbd>⇧D</Kbd>
                </span>
                <span className="toast ok">
                  <span className="toast-body">
                    <I name="check" size={14} />
                    <span className="toast-title">Archived spot.mp4</span>
                    <button type="button" className="toast-act">
                      <I name="undo" size={14} /> Undo
                    </button>
                  </span>
                </span>
                <span className="toast info">
                  <span className="toast-body">
                    <span className="toast-title">Copied the link</span>
                    <button type="button" className="toast-x" aria-label="Dismiss">
                      <I name="x" size={13} />
                    </button>
                  </span>
                </span>
                <span className="toast error">
                  <span className="toast-body">
                    <I name="x" size={14} />
                    <span className="toast-title">Couldn’t reach the server</span>
                    <button type="button" className="toast-act">
                      Try again
                    </button>
                  </span>
                </span>
              </div>
            </div>
            <Row label="live" note="The real ones (a phone shows dialogs and menus as sheets).">
              <LiveLayers />
            </Row>
          </Block>

          <Block
            id="rows"
            title="Rows and headers"
            note="Rows: 40 px, dense 32 — a leading visual, the text, trailing bits. A selected row is a flat fill (--sel, the current one --sel-on), never raised. A section’s title is 15 / 650 with a count and actions; a page’s is 36 display, an eyebrow above it the one place for capitals."
          >
            <Panel pad="none" className="sg-list">
              <ListRow lead={<Avatar name="Sam Keller" />} title="Sam Keller" sub="Owner · signed in 2 min ago" trail={<Chip>owner</Chip>} />
              <ListRow lead={<I name="key" size={16} />} title="CI deploys" sub="Created 3 days ago" trail={<Button size="sm">Revoke</Button>} />
              <ListRow
                lead={<I name="folder" size={16} />}
                title="A clickable row with a name long enough to be cut short"
                onClick={() => {}}
                trail={<Chip kind="count">12</Chip>}
              />
              <ListRow lead={<I name="folder" size={16} />} title="Hovered" onClick={() => {}} className="sg-hover" />
              <ListRow lead={<I name="folder" size={16} />} title="Selected (--sel)" className="sg-sel" />
              <ListRow lead={<I name="folder" size={16} />} title="The current one (--sel-on)" className="sg-sel-on" />
              <ListRow dense lead={<I name="link" size={14} />} title="Dense row" trail={<Chip kind="version">V4</Chip>} />
            </Panel>
            <div className="sg-heads">
              <SectionHeader
                title="Section title"
                count={12}
                actions={
                  <Button size="sm" icon="plus">
                    Add
                  </Button>
                }
              />
              {/* PageHeader, drawn without its h1 (this page has its own) */}
              <header className="page-head">
                <div className="eyebrow">Project</div>
                <div className="page-head-row">
                  <p className="page-title">Spring campaign</p>
                  <div className="page-meta">12 videos · 3 must-fix</div>
                  <div className="page-aside">
                    <Button variant="primary" icon="upload">
                      Add video
                    </Button>
                  </div>
                </div>
              </header>
            </div>
          </Block>

          <Block
            id="loading"
            title="Loading"
            note="A screen loads as itself: its real layout, with only what the data decides drawn as placeholders at their own size (SkLine keeps a line’s box, …Pending rows and cards), so nothing moves when the data arrives. A busy region fades in after a beat; fast loads show nothing."
          >
            <SkeletonRegion label="Loading the samples" className="sg-loading">
              <Row label="a line on its way">
                <span className="section-title">
                  <SkLine w="9em" />
                </span>
                <span className="sg-p">
                  Edited <SkLine w="5em" /> by <SkLine w="4em" />
                </span>
                <Segmented
                  label="Lanes, loading"
                  className="chips"
                  value="all"
                  onChange={noop}
                  options={[
                    { value: 'all', label: 'All', count: null },
                    { value: 'open', label: 'Open', count: null },
                  ]}
                />
              </Row>
              <Row label="shapes">
                <Skeleton w={120} h={12} />
                <Skeleton w={44} h={44} r={8} />
                <Skeleton w={88} h={20} r={999} />
                <div className="sg-w">
                  <SkeletonText lines={3} />
                </div>
              </Row>
              <Row label="rows">
                <div className="sg-w-xl">
                  <RowsSkeleton n={2} />
                </div>
              </Row>
              {/* (the library's FilmPending stays out: importing library/Film.tsx here split the library's first chunk
                  into shared pieces and cost the first paint 2 KB) */}
              <Row label="a strip" note="RunStripPending: the agent's line in its room, the words on their way.">
                <div className="sg-strip-box sg-w-xl">
                  <RunStripPending />
                </div>
              </Row>
            </SkeletonRegion>
          </Block>

          <Block
            id="marks"
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
            id="agents"
            title="Agent at work"
            note="What an agent's work on a video says, in every state: one line in a fixed slot (states swap words, never heights), a 2 px edge that fills while a render or an upload reports, a keyframe glyph for the state. Only what needs you earns the raised button. No noun for the work: the words say what happens."
          >
            <AgentAtWork />
          </Block>

          <Block
            id="empty"
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
        </div>
      </div>
    </main>
  );
}
