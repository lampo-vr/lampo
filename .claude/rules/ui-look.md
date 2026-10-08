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
- One layer order: overlay 50 < sheet 51 < dialog 52 < menu 55; never patch a single case.
- No `grain` on a scrolling box; phone bars fit, they don't scroll; a strip that scrolls uses `useScrollEdges`.
- `pre-wrap` still breaks after `-` and `/`: a token, URL or path to copy goes through `Code` (nowrap `.set-code-w`).
- Status is a keyframe glyph (`KeyGlyph`), never a coloured dot; selection never wears the orange.
- List selection is a flat fill (`--sel`, `--sel-on`), never raised; a bar floating over a list keeps its room at the end.
- A popover opened by a pointerdown elsewhere (a timeline pick) opens once the press is over: the focus it moves closes it.
- Empty lists use EmptyState (in a card or lane: `RowEmpty`, `LaneEmpty`); no headline ends with a full stop.
- A box whose content switches (steps, tabs) keeps one height: every panel in one grid cell, the current one shown.
- A lazy screen's styles come with its own code; never lean on a class only another chunk's stylesheet defines.
- A bare `stop`, `close`, `open`, `print`, `find`, `status` or `name` is the window's (`stop()` aborts every request in flight): Biome refuses them, so a lost local helper of that name can't fall through to it.
