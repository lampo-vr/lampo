---
paths:
  - "web/**"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### UI: speed
- Never import `radix-ui` in a module the first paint needs; budget 183 KB (`BUNDLE_BUDGET_KB`).
- On-demand code goes through `lib/lazy.ts` (`loader`, `useLoaded`, `screen`), not `lazy()` + Suspense.
- A new dynamic import in the first paint costs its preload entry: ride an existing chunk, measure a build.
- A lazy chunk (the styleguide) that imports a library module (`library/Film.tsx`) makes the build split the library's first chunk into shared pieces: +2 KB in the first paint. Show such parts some other way, and measure.
- Measure the budget with a Node that bundles its own zlib, as CI's does: Homebrew's links macOS zlib and reads ~0.2 KB low.
- Loading states use the real layout (`pending` props, `SkLine`, `…Pending` rows); never a separate skeleton tree.
- What follows playback subscribes to `player/frameStore.ts` (`pb.live`, `useFrame`), never `pb.frame`.
- Every `usePlayback` is `quiet`: only a small component that shows the frame subscribes, and a button reads `pb.live.get()` when pressed (the review link ran without it and redrew its whole page per frame; a row with the timecode in it renders with the timecode).
- Writes are optimistic (`guess()` + rollback); SSE events patch their video, never refetch the library.
- A video's change may reach the page only as its `event` line (an agent writing through `/mcp` outside workspace #1:
  no route, no watcher), so live.ts refetches that review from it; never wait for a `review` event alone.
- One tab holds the stream for all (`api/events.ts`, the `vr-sse` lock): it hands the lock on at `freeze` and asks
  again at `resume`. A frozen holder kept every event to itself, and the tab in front went deaf.
- An action with Undo waits behind `later()` and is sent on `beforeunload` too, not only `pagehide`.
- A jump to another version goes through `pb.jumpTo(frame, target.frames)`: `seek` clamps by the version on
  screen and seeks its source (V1's 90 frames held V2's frame 250 at 89); the target's source puts the frame up.
