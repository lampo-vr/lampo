# web/ — the review UI

React 19 + TypeScript, built with Vite. The server serves `web/dist` (or runs Vite as middleware with `--dev`). Two
pages: `index.html`, the app, and `embed.html`, an Embed link's player at `/e/<token>`, an entry of its own.

```
src/
  main.tsx, boot.tsx,    the start (boot.tsx asks for the first screen's code while the kept
  App.tsx                data loads), hash routes; each screen is its own chunk
  api/                   the only place that talks to the server
    client.ts            fetch wrapper (ApiError with status)
    types.ts             what the server sends: review.json data contract + API envelopes
    queries.ts           TanStack Query: one query key per resource
    mutations.ts         writes; invalidate what they change, optimistic where the UI must
                         not wait
    events.ts            server-sent events → query updates (one tab holds the stream, the
                         others listen)
    auth.ts              accounts: status, sign-in/out, setup, profile, tokens, users, agents
  lib/                   small helpers: navigation, formatting, toasts, prefs, seek
                         coalescing, a11y, code on demand (lazy.ts)
  i18n/                  English and German: t('…'), <T k>, words for values (terms.ts)
  ui/                    the building blocks every screen uses ("UI primitives" below)
  library/               the library in four layouts (model.ts decides what goes where:
                         scope, filters, order, sections, lanes), cards, list, board,
                         poster + hover scrub, sidebar tree, folder picker, add-video,
                         Insights
  palette/               ⌘K: search (videos, folders, notes) and actions, anywhere
  player/                the player: hooks (usePlayback, useDiff, useQa, useVerify,
                         useShortcuts, useWalkie) and components (Stage, Timeline,
                         Transport, NotesPanel, CommentCard, …)
  refs/                  a note's references: a frame of any version, files, links
  options/               an agent's options side by side (the audition), one answer back
  status/                where a video stands: the stage, approvals, final and reopen
  inbox/, foryou/        the Inbox: the bell, its list and preview, its cards on a phone,
                         what pings a device
  sessions/              agents: picking the one a video's feedback goes to, what it is
                         doing right now, starting it on this machine
  playbook/              playbooks: the document, what agents read, their suggestions
  publish/               publishing a final version: the composer, the publish kit
  guest/                 the review link's pages behind /g/<token>
  embed/                 an Embed link's player (/e/<token>, embed.html): the video alone,
                         frame-exact, on another site's page; no notes, names or cookies
  share/                 review links: the dialog, their activity; the printable notes sheet
  auth/                  sign-in: the gate (setup / sign-in before anything else, 401 →
                         sign-in over the same route), its screens, the account menu,
                         workspaces
  onboarding/            the first run: the setup, Get started, the health check
  uploads/               resumable tus uploads (tray, drop-anywhere, folder dialog, new
                         versions)
  settings/              Settings, on a machine and on a hosted server alike; a section
                         shows when the role may use it (workspace and billing: hosted)
  billing/, conversion/  where a billing provider runs: the plan, checkout, the trial and
                         the limits as they come up
  consent/               the cookie settings, asked before a billing provider's payment form
  operator/              the server operator's pages: workspaces, accounts, the funnel
  pwa/                   the installed app: the service worker, push, the app icon's badge
  styleguide/            #/styleguide (dev and test builds only)
  assets/                the entrance's brand film frames
  styles/                the design system, split by area; index.css imports them in
                         cascade order
  vendor/                third-party code kept as it was released, with its licence
```

Frame accuracy lives in `player/usePlayback.ts` and `lib/seek.ts`: seeks go to the middle of a frame
(`(N + 0.5) / fps`), the frame on screen comes from `requestVideoFrameCallback`, and seeks that arrive while the
decoder is busy replace each other. Timecodes and drawings use the same code as the server (`lib/time`,
`lib/drawing` at the repo root), so what you see is what the agent gets.

One app: the same screens on a person's own machine (signed in there automatically) and on a hosted server
(`VR_MODE=server`, behind an account). What only some visits need is its own chunk, asked for when it is needed: the
sign-in and account screens, Settings, the upload tray (after the first paint), billing where a billing provider runs,
the operator's pages. `/api/info` says which features and capabilities exist, and the UI shows only those.

Checks: `npx tsc -p web` and `npx biome check web`. The browser end-to-end tests (`npm run test:e2e`: local mode, then
server mode from setup to sign-out) need a build.

## UI primitives (`src/ui/`)

Radix Primitives (unstyled, accessible: focus, keyboard, portals, collision-aware placement) dressed in our CSS
(`styles/ui.css`, `styles/primitives.css`, `styles/overlays.css`, `styles/system.css`; colours are tokens from
`styles/base.css`, never literals). Screens build from these; a screen that needs something new adds it here, once,
not a local variant.

**Radix loads after the first paint.** `primitives.tsx` is what a screen renders before anyone uses a control: a
trigger is the plain element it always was (same role, name, id, `aria-*` and `data-state`), a tooltip is a note on
its element (`tip.tsx`), `Segmented` is a Radix-equivalent toggle group without Radix (`toggle.tsx`), `Switch`,
`Avatar` and `ScrollArea` are plain elements with Radix's DOM (`plain.tsx`, re-exported by `controls.tsx`), `slot.ts` merges
props into a child the way Radix's Slot does. The Radix half (`layers.tsx`: dialogs, menus, popovers, hover cards, the
one tooltip layer, the toasts) is its own chunk, asked for right after the first paint (`shell.tsx`), or at once when
something opens before that. A menu, popover or hover card mounts its Radix part the first time its
trigger is used, with the screen's element as Radix's trigger (`Anchor`), the opening event played on to it, and
keeps it from then on — so a thousand cards mount no menu or tooltip machinery, and a keyboard shortcut still acts on
its first press. Never import `radix-ui` in a module the first paint needs: a new primitive's Radix part goes into
`layers.tsx` (or a module only its screen loads, like `select.tsx`); `test/e2e/quality-load.mjs` holds the start's size.
Code that loads on demand goes through `lib/lazy.ts` (`loader`, `useLoaded`, `screen`), not `lazy()` + Suspense
where the chunk is usually already here: React holds content that replaces a fallback back for up to 300 ms.

**`#/styleguide`** shows every one of them in every variant and state (dev and test builds only: `VR_STYLEGUIDE=0`, as
the Dockerfile sets it, leaves the page and its chunk out); `test/e2e/styleguide.mjs` photographs it in both themes
against `test/e2e/baseline/` (`VR_UPDATE_BASELINE=1` after a deliberate change). One baseline per platform: a
machine without one records it on the first run, CI fails instead and uploads the screenshot
(`new-screenshot-baselines`) to be committed. Until the first Linux baselines are committed, CI reports the
comparison as skipped (`VR_BASELINE_MISSING: skip` in `.github/workflows/ci.yml`), never as passed.

### The design system's families (`system.tsx`, drawn by `styles/system.css`)

| Import | What for |
|---|---|
| `Button` | `variant`: `primary` (the raised brand orange, white label; one per view), `secondary` (the default), `ghost` (toolbars, rows), `danger` (filled, for what can't be undone), `link` (a text action, no box). `size` `sm` 26 · `md` 30 · `lg` 40; `icon`, `iconOnly` (+ `aria-label`; prefer `IconButton` where a tooltip fits), `pressed` (a toggle that is on), `wide` (the one action of a small card, a gate). A disabled primary lies flat: the raised look means "press me". Same classes as before (`btn primary sm` …), so markup that isn't migrated yet looks the same. |
| `Chip` | Small labels, all 20 px high and pill-shaped like the status badge: `tag` (sentence case), `count` and `version` (tabular mono), `key` (a key cap's corners). Where a video stands is a `Badge`, never a chip. Chosen filter chips (`.chip.on`) and lane chips (`Segmented className="chips"`) wear the raised material. |
| `Panel` | A surface: `base` (a card on a page), `raised` (a card on a card), `floating` (menus, popovers, dialogs: the one floating shadow). One padding rule: `md` 16 in a list, `dense` 12, `lg` 24 for a page's cards and dialogs; `none` when rows fill it. Settings cards are `Panel pad="lg"` (16 on phones). |
| `SectionHeader` | A section's title: sentence case, 15 / 650, an optional count (mono) and actions on the right. No eyebrow, no full stop. |
| `PageHeader` | A page's head: the eyebrow (the one place for capitals), the title (36 / 650 display, no full stop), meta and what sits across from it. |
| `ListRow` | One row of a list: 40 px (`dense` 32), a leading visual, title + sub (one line each, cut with an ellipsis), trailing bits; a `button` when it has `onClick`. |
| `EmptyState` | Nothing to show, said well, as a place rather than a gap: a soft panel that takes the room of what it stands in for (`md`: most of the window; `size="sm"` inside cards, lists and popovers keeps to its content). `art` is a 240 × 144 scene in the keyframe language, one per context (`library`, `folder`, `filed`, `filter`, `search`, `clear`, `check`, `inbox`, `note`, `list`, `insights`, `agents`, `suggest`, `token`, `webhook`, `client`, `error` — `emptyArt.tsx`): theme inks, at most one lit element in `--brand`, a loop whose resting pose is the drawing (reduced motion keeps it, a hidden tab pauses it) — the loops are timelines in `emptyMotion.ts`, keyed by the drawing's `data-m` names (see its header). Then a `title` without a full stop, one sentence (≤ 52ch), one `action` (a primary Button, or `<a className="btn primary">` to go somewhere), an optional quiet `secondary`, `tips` (key caps, drag and drop; hidden on touch screens) and a quiet `foot`. `titleAs="h2"` where it stands in for a page's content. Every empty list uses it; never a bare "None yet." |

**The raised material** (`--raise-sheen`, `--raise`, `--press` in `base.css`) is the one 3D look — a sheen from the
top, a light top edge, a darker bottom edge, a soft drop; pressed sinks in — for every primary action *and* every
selected or active state: segmented items, tabs, chosen chips, pressed toggles, the switch's thumb, the layout
switch, the period picker, the settings section you're in, the version you're on. Two tones: brand (a primary:
`--brand-deep` with a white `--on-brand` label, the same orange button the review link's invitation opens with; hover
lights its glow instead of lightening it, disabled lies flat and neutral) and surface (`--ink-3`, lifted out of a
sunken track, `--sunk`) for what is selected — selection never wears the orange. Same in both themes;
`test/e2e/styleguide.mjs` fails when a selected state is flat. Rows of a list are not controls and stay flat: `--sel`
under the pointer or the keys, `--sel-on` (a step deeper) for the current item and rows picked for a bulk action — the
inbox's rows, `inbox.mjs` holds them to it.

**What floats is one family** (`overlays.css`, `ui.css`, `primitives.css`; the styleguide's "Floating" block): menus,
popovers, hover cards, selects, dialogs, the palette, the upload tray and the inbox's selection bar share the float material — `--float-bg` (the lightest
surface), a `--float-line` hairline, `--shadow-float` (a lit top edge and three depths that soften on paper); rows under
the pointer or keys take `--float-sel`, separators `--float-line`. The page behind a dialog dims (`--backdrop`), it
isn't blurred. Tooltips and toasts are passing messages (`--tip-*`): ink on paper, a lifted step in the dark. Motion:
dialogs rise a little and settle (`--dur-slow`, ease-out), menus and popovers grow out of their trigger (`--dur-fast` /
`--dur`), everything leaves faster than it came, all instant under reduced motion. Layers: a dialog (`--z-dialog`)
sits above the sheet or drawer it was opened from, a menu or popover (`--z-menu`) above whatever opened it. On phones
dialogs and menus are sheets from the bottom edge (menus over a `--shadow-scrim`), popovers stay on the screen. Key
caps drawn inside buttons — a dialog's last primary shows ⌘↵, any `.btn[data-keys="Esc"]` its keys — are CSS with
empty alt text, so a button's name stays its words; `--keys` draws ⌘ ⇧ ⌥ ↵ from the system face.

**The scales** (`base.css`; `test/unit/design-scale.test.ts` fails with file:line on anything else, and
`test/e2e/lib/designInventory.mjs` checks what every screen actually renders from `quality.mjs`):

| | Tokens |
|---|---|
| type | `--fs-xs` 11 · `--fs-sm` 12 · `--fs-md` 13 · `--fs-lg` 15 · `--fs-xl` 18 · `--fs-2xl` 24 · `--fs-3xl` 36 · `--fs-4xl` 56 (display: a title that is the whole page, the review link's invitation) (`--fs-touch` 16 only for text fields on touch screens) |
| weight · line height | `--fw-text` 400 · `--fw-ui` 500 · `--fw-strong` 650 (also `b`, `strong`) · `--lh-tight` 1.1 · `--lh-ui` 1.3 · `--lh-body` 1.5 |
| space | `--sp-0_5` 2 · `--sp-1` 4 · `--sp-2` 8 · `--sp-3` 12 · `--sp-4` 16 · `--sp-6` 24 · `--sp-8` 32 · `--sp-12` 48 · `--sp-16` 64 · `--sp-20` 80 |
| radius | `--r-sm` 4 · `--r` 8 · `--r-lg` 12 · `--r-full` |
| control height | `--h-xs` 20 (chips) · `--h-sm` 26 · `--h` 30 · `--h-lg` 40 · `--h-touch` 44 · `--h-xl` 52 (the one field and button a whole page is for: the way into a review) |
| icon | `--ic-sm` 14 · `--ic` 16 · `--ic-lg` 20 |
| shadow | `--shadow-float` (menus, dialogs, floating bars), `--shadow-raise` / `--raise-drop` (lifted cards), `--focus-ring`; rings (`0 0 0 1px …`) are borders, not shadows; on the invitation only: `--shadow-brand` (the orange button's own light), `--focus-ring-brand` |
| layer | `--z-*` (topbar · inbox popover · overlay · sheet · dialog · menu · float · palette · uploads · toast · top); a single digit only for stacking inside one component |

**Brand orange** (`--brand` #f25a1d, its label `--brand-ink`; `--brand-hot`, `--brand-glow`, `--brand-haze` for its
light) is the logo's window, "the frame you review, lit". The working chrome stays achromatic; the orange belongs to the
review link's invitation (`guest/Invite.tsx`: the lit frame, the way in) and the visitor's name prompt, the same in both
themes with ink on it (`theme.test.ts` keeps it at AA).

Mono only for timecodes, frames, versions, counts, keys and code; capitals only in the eyebrow and on key caps;
titles never end with a full stop.

**Stylesheets stay in their lane** (`test/unit/css-scope.test.ts`): the shared sheets (`base`, `controls`,
`primitives`, `system`, `ui`, `layout`, `overlays`, `status`) define the global classes; every other sheet belongs to
one page or component and only styles its own classes (a shared class only in their context: `.lib-toolbar .btn`,
never `.btn` or `.btn.special`), and no two sheets define the same class. A variant of a shared control goes into
`controls.css` or `system.css`.

### Everything else

| Import | What for |
|---|---|
| `I` (`icons.tsx`) | Every icon: `<I name="trash" size={15} />`. Lucide glyphs behind names that say what they are for; the stroke is optically corrected per size. Add a name to `P` rather than importing Lucide in a screen. `BrandMark` is the mark (the frame o; geometry in `brandMark.ts`, also used by `scripts/icons.ts`), `Wordmark` the logo, `lampo` with the frame o. |
| `IconButton` | Any button that is only an icon. `label` is required (accessible name *and* tooltip); `shortcut="⇧V"` shows the key in the tooltip; `tip` for a longer tooltip. `className` defaults to `btn ghost icon-only`. Works as the trigger of a Menu, Popover or Dialog. |
| `Tip`, `Kbd` (`tip.tsx`) | A tooltip on anything focusable (`<Tip content="…" shortcut="D">`); keys as key caps. Buttons with words don't need one unless the tooltip adds something (a shortcut, what happens). Tooltips open under the pointer or with keyboard focus, never on a dialog's programmatic focus. One tooltip layer shows them all (`layers.tsx` `TooltipLayer`); an element only carries its note. Inside an item that has its own `data-state` (a toggle), put the item outside: `<ToggleItem asChild><Tip><button/></Tip></ToggleItem>`. |
| `Menu`, `ContextMenu`, `MenuEntry` | The ⋯ menu and the right-click / long-press menu, from the same `items` array: `{ label, icon, onClick, danger?, shortcut?, disabled? }` (`checked` makes it a ticked on/off item, `keep` keeps the menu open after it — several tags in a row —, `mark` puts a glyph in the icon's place), `'sep'` for a line, `{ heading }` for a quiet word over the items after it (shown only when one follows: a card's *Move to*), `{ choice: { label, value, options, onChange } }` for a one-of-many group that keeps the menu open (the theme: `useThemeChoice()`), falsy entries skipped. On a touch screen an item takes a click only when the press began on the menu (the tap that opened a sheet can't pick what slides in under the finger). Wire both to the same list so they never drift. Text fields, links and media inside a `ContextMenu` keep the browser's menu. The focus goes back to the trigger on close unless an item moved it somewhere (a field it opened). |
| `Confirm`, `useConfirm` | "Are you sure?" (AlertDialog) for what can't be undone: deleting, revoking, removing people. The `title` is the question and names the thing (`Delete the folder “Teasers”?`), the `body` one sentence on what happens (no bold paths, no second paragraph), the `action` its verb. Destructive: focus on Cancel (Esc), ⌘↵ goes ahead; otherwise focus on the action (↵). The keys are drawn beside the words. `const [ask, confirmation] = useConfirm(); if (await ask({ title, body, action, danger: true })) …` |
| `toast`, `toastUndo`, `later` (`lib/toast.ts`) | Feedback after an action (Radix Toast in `layers.tsx`; a toast asked for before the layer arrived waits for it: announced, paused on hover, swipe away; at the bottom on desktop, under the top bar on phones; an Escape meant for an open dialog or popover clears them first). Reversible actions don't ask first: do it, then `toastUndo('Archived x', undo)`. Deletions that can't be undone on the server are deferred with `later({ apply, revert, commit })`: off the screen now, sent when the toast is gone (or the tab closes). |
| `Modal`, `Drawer`, `Popover`, `HoverCard` | Dialogs (sheets on phones; ⌘↵ anywhere in one presses the last primary in its `foot`, whose key cap shows — a field's own Enter must leave ⌘↵ alone), the phone sidebar, anchored panels, and details on hover (pointer only: never the only way to a fact). |
| `Select` (`select.tsx`), `Segmented`, `Switch`, `Checkbox` | Choices. `Switch` for settings that apply at once, `Checkbox` for choices submitted later. `Segmented` options may carry a `count` (filter chips: `className="chips"`); `iconOnly` turns labels into tooltips with the option's `shortcut` (the library's layouts). |
| `Progress` | Determinate (`value` 0–100) or indeterminate (`null`) bar; `tone` = ok / claude / must. |
| `Badge` (`Badge.tsx`) | A calm status label: a keyframe glyph and words, `tone` (must, should, nice, idea, ok, claude) or a workflow `stage`; sizes `sm` / `md`. The glyph pops when the value changes. `StatusPill` (status/) is the stage badge. |
| `KeyGlyph`, `useChanged` (`KeyGlyph.tsx`, shapes in `glyphs.ts`) | Every status mark is a keyframe glyph, never a coloured dot: `<KeyGlyph shape={SEVERITY_SHAPE.must} />` in the current text colour. Shape carries the meaning (`SEVERITY_SHAPE`, `STAGE_SHAPE`, `LANE_SHAPE`, `TONE_SHAPE`, `KIND_SHAPE`), a status token tints it, nothing glows. CSS pseudo-elements use the same shapes through `--kg-*` masks in `base.css`, the timeline canvas through `Path2D`; `test/unit/keyglyph.test.ts` keeps all three identical. |
| `Avatar`, `initials` | People, agents (their mark) and visitors of review links (initials, warm tint) at a glance. |
| `ScrollArea` | Panels that scroll (sidebar, inbox list): native scrolling with a thin scrollbar that shows while the pointer is on the panel. Give the old scroller's class to `viewportClassName`. |
| `Separator` | A line between groups. |
| `Skeleton`, `SkLine`, `SkeletonText`, `SkeletonRegion`, `RowsSkeleton` (`Skeleton.tsx`) | The pieces of a loading state. A screen loads as itself, in its real layout (a `pending` prop, `…Pending` rows such as `FilmPending` or `InboxRowsPending`), with only what the data decides drawn as these placeholders at their own size, so nothing moves when the data arrives (`test/e2e/quality-load.mjs` compares the two); never a separate skeleton tree, a spinner or a blank. A busy region (`SkeletonRegion`) fades in after 120 ms, so fast loads show nothing. `Spinner` (`feedback.tsx`) is only for a button's own pending action. |

Sizes: controls take their height from the scale above; controls side by side in a bar share one step
(`test/e2e/quality.mjs` checks every row, and that hovering moves nothing). Type: titles use `--display`, the UI face
at a heavier, semi-condensed cut (`font: var(--fw-strong) semi-condensed …`); timecodes, frames and counts use
`--mono`. Layout checks (`test/e2e/layout.mjs` `fitsAt`) run every screen at 390, 768, 1024, 1180, 1280, 1440 and
1920: nothing sideways, no clipped glyphs, no badge or chip cut with an ellipsis, card titles on one line.

Motion: `--dur-fast` / `--dur` / `--dur-slow` and `--ease-out` / `--ease-in` / `--ease-in-out` / `--ease-spring` in
`base.css`. Enter with ease-out, leave faster with ease-in, spring only for small things that snap. Screen changes
are View Transitions (`lib/transition.ts`: deeper screens come in from the right, going back from the left).
`prefers-reduced-motion` turns every animation and transition off (spinners keep turning).
