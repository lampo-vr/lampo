---
paths:
  - "web/**"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### UI: look and layout
- Every size and colour is a token in `base.css`; stylesheets define only their own classes.
- No `var()` inside a `@keyframes` timing function: Safari ignores it and runs linear.
- Implicit grid and auto columns: `minmax(0, 1fr)`; they grow to their content otherwise.
- One layer order: overlay 50 < sheet 51 < the float layer 55 (`--z-layer`: dialogs, menus, popovers, hover cards alike, so the one opened last is on top) < palette, uploads, toasts, tooltips; never patch a single case. A static sample of a float sets `z-index: auto` (a grid item takes a z-index unpositioned).
- No `grain` on a scrolling box; phone bars fit, they don't scroll; a strip that scrolls uses `useScrollEdges`.
- `pre-wrap` still breaks after `-` and `/`: a token, URL or path to copy goes through `Code` (nowrap `.set-code-w`).
- Status is a keyframe glyph (`KeyGlyph`), never a coloured dot; selection never wears the orange.
- List selection is a flat fill (`--sel`, `--sel-on`), never raised; a bar floating over a list keeps its room at the end.
- A popover opened by a pointerdown elsewhere (a timeline pick) opens once the press is over: the focus it moves closes it.
- Empty lists use EmptyState (in a card or lane: `RowEmpty`, `LaneEmpty`); no headline ends with a full stop.
- A box whose content switches (steps, tabs) keeps one height: every panel in one grid cell, the current one shown.
- A lazy screen's styles come with its own code; never lean on a class only another chunk's stylesheet defines.
- A bare `stop`, `close`, `open`, `print`, `find`, `status` or `name` is the window's (`stop()` aborts every request in flight): Biome refuses them, so a lost local helper of that name can't fall through to it.
- A new component's stylesheet is imported by the component, not added to `styles/index.css`: index.css is under every screen, so `test:e2e -- --changed` would run all suites.
- Every grid template names every area its items use (the phone's sideways one too): an item in an unnamed area gets an implicit column, and the layout shrinks beside it.
- A tap that moves the layout acts on `click`, not the release: a touch's click is aimed after the release re-rendered, at whatever moved under the finger (the notes sheet's handle opened the Agent view).
- On a phone the keyboard shrinks the visual viewport, not the layout: a one-screen layout fits itself to it (`player/phoneSheet.ts` `useKeyboard`), or its field and buttons sit under the keyboard.
- A review link's layout rule goes in `guest.css`, not `mobile.css`: guest.css comes later (with its chunk) and wins at equal specificity (the sideways rows lost to its 820 px block on a 750 px iPhone, and the picture got no height).
- Two buttons that take turns in one place get their own `key`: React keeps the pressed node, and its `:active` scale outlasts the tap (the phone's zoom button measured 42 px).
- A field in a `Modal` is focused by a callback ref, never an effect on mount: the dialog's code (`useLoaded(layerCode)`) can arrive after the component mounted, and the effect finds no field (the Files tab's first rename left the keys outside it).
- A double tap is told by the events' `timeStamp` (when the finger made them), never by `performance.now()` when they are handled: a busy page handles two quick taps far apart (`player/SidewaysBar.tsx` `usePictureTap`).
- A control's waiting state stays on that control: one `busy` that disables every switch and button of a card flashes the whole card on each save (Settings → Notifications' test); switches are optimistic, the button that acts says its own state.
- What arrives after the first paint at the sidebar's foot holds its full height from the start, the room and the real one under one class (`.ob-side` for Get started's box, `.nav-trial` for the trial's, both from tokens), with the foot's one gap between them; Settings is a `.nav-row`.
- A folder's tab (Videos · Files · Playbook) starts with its first row (`data-tab-row`) where the Videos toolbar stands, as tall, two rows where it wraps, and its content (`data-tab-body`) where the first section starts; a loading state keeps both, its boxes unfaded (`test/e2e/folder-tabs.mjs` measures every frame).
- Nested corners are concentric: a surface inset p inside a corner of R gets R − p (`--r-track-in`, `--r-menu-in`, or `calc(var(--r…) - <inset>)`), further in than R it is free; the segmented control's raised item had the track's own 8 px. New pairs go in `design-scale.test.ts` `NESTED`; `concentric()` checks screens.
- A focus rule takes `--focus-width` / `--focus-offset` / `--focus-inset` (0 for an item in a track), never a literal: Chrome rounds an outline down to whole device pixels, so the old 1.5 px ring drew 1 px on a 1× screen beside 2 px ones.
- An icon in a control family gets its size and stroke from `ui.css` (zero specificity), whatever `size` the markup passes; a component that means another size (40 px tools) says so in a rule of its own.
- A hover look is written `:hover:where(:not(:disabled))` (same specificity), so nothing disabled lights up; disabled fades by `--disabled-o`, a filled button lies flat instead, a busy one (`aria-busy`) keeps its look.
- An agent's colour is the tone `agent` and `--agent` / `--agent-bg` / `--agent-2` / `--agent-3` / `--on-agent`: the thing is the Agent; "claude" names only the product and its logo (`agentMarks`, AgentChoice). `--claude*` stay in base.css as the website's aliases until it moves, unused by the app (theme.test.ts).
- Green marks a state (a glyph, a dot, one word), never a surface or an outline: a banner is the neutral one with the green `KeyGlyph`, a confirmation is the plain button with a green check (`.btn.ok`); `theme.test.ts` lists the few green fills allowed (small marks, meters, inserted words).
- A chosen state keeps its colours under hover, focus and press: a generic hover says `:where(:not(:disabled, .on))` and the chosen one gets a hover of its own (`--raise-sheen-hi`). `button.chip:hover` (0,2,1) out-specified `.chip.on` (0,2,0) and wrote `--fg` on the `--fg` fill; styleguide.mjs holds every sample to 3:1 in every state.
- The styleguide shows hover, pressed and focus with `.sg-hover` / `.sg-active` / `.sg-focus` (`styleguide/pseudo.ts` copies the app's own rules onto them); never a look made only for the styleguide.
