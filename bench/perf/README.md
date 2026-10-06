# Performance bench

Numbers for "does it feel native": what a screen downloads, how long the API takes on a big store, what the event
stream costs, and what a person feels in the browser (production build, CPU slowed down 4×). The budgets that must
hold on every run live in `test/e2e/perf.mjs`; this is the deeper look, run by hand before and after perf work.

```sh
npm run build
node bench/perf/synth.ts /tmp/vr-perf/store 1000 20000   # a synthetic store: 1,000 videos, 20,000 notes
cp -Rc /tmp/vr-perf/store /tmp/vr-perf/run                 # the runs add notes: work on a copy
node bench/perf/bundles.mjs                                # JS/CSS per screen, gzip and brotli
node bench/perf/api.ts /tmp/vr-perf/run                    # endpoint timings, sizes, SSE per mutation
node bench/perf/browser.mjs /tmp/vr-perf/run               # loads cold/warm, commits and input latency
```

`test/e2e/perf.mjs` (`npm run test:perf`, part of `test:e2e`) is the short version that runs every time: a 300-video
store, the CPU slowed down 4×, best of three tries per budget.

Load skews every timing: compare runs of one sitting, and only when `sysctl -n vm.loadavg` (or `uptime`) is low.
Servers start on a free port with the store you give them — never a live store.

## Results

### The light start (2026-09-30)

Before = main at `75cc312`, after = this change, measured in one sitting on chrome-headless-shell with the CPU slowed
down 4× (each run started only at a load average below 8). The A/B rows alternate the two, round by round, on copies
of one synthetic 1,000-video store (20,000 notes), six rounds each.

| | before | after |
|---|---:|---:|
| start JavaScript (entry + boot and their imports), gzip | 167.2 KB | 123.6 KB |
| … brotli | 144.8 KB | 107.0 KB |
| start + library chunk, gzip | 225.2 KB | 191.6 KB |
| warm library paint, API held back 2.5 s (A/B, best / median) | 725 / 739 ms | 417 / 475 ms |
| layout switch, slowest input (A/B, best / median) | 184 / 200 ms | 112 / 120 ms |
| typing "logo" in the filter, slowest key (A/B, best / median) | 80 / 80 ms | 56 / 56 ms |
| library warm, content at (`browser.mjs`) | 751 ms | 437 ms |
| player warm, content at / first frame (`browser.mjs`) | 738 / 886 ms | 523 / 695 ms |
| switch layout to list / grid, slowest input (`browser.mjs`) | 192 / 168 ms | 112 / 88 ms |
| clear the filter, slowest input (`browser.mjs`) | 152 ms | 80 ms |

`test/e2e/perf.mjs` (300 videos, best of three) after: warm paint 382–406 ms, layout switch 64–72 ms, slowest key
32 ms. The warm paint's goal is 300 ms; on the shell, which compiles the start's modules afresh on every load (~80 ms
at CPU 4×), about 200 ms more are the first render and layout of the page. Earlier numbers in this file's history
were taken with the Chrome app, which kept compiled code between loads: compare runs of one browser only.
