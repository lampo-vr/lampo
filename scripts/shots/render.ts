// A stand-in render tool for the pictures: a program called `remotion` that prints what Remotion's CLI prints into a pipe
// (`Bundling 50%`, `Rendered 171/408`), so `lampo render` reads it the way it reads the real one (lib/render/tools.ts)
// and the person sees a render going: the stage, the percent, the time left. It never renders anything. Each run is
// told beforehand what to do: hold at a frame until the pictures are taken, then put a file made beforehand (the
// demo's next version, synthetic) where the command renders; or stop at a frame with the last words a render that
// failed prints. Like the stand-in speech engine (speech.ts), it is only ever started by the pictures' script.
import fs from 'node:fs';
import path from 'node:path';

/** What the next run of the stand-in does. */
export interface RenderPlan {
  /** The frames the composition has. */
  frames: number;
  /** A run that renders: where it holds (until `release()`), the file it puts in place then, and where. */
  hold?: number;
  from?: string;
  to?: string;
  /** A run that fails: the frame it stops at, and what it prints before it exits with 1. */
  failAt?: number;
  error?: string[];
}

export interface RenderStandIn {
  /** The program to run after `lampo render … --` (its name is what tells `lampo render` how to read it). */
  bin: string;
  /** What its next run does. */
  plan(p: RenderPlan): void;
  /** A held run goes on and ends. */
  release(): void;
}

// The program itself: plain JavaScript run by this Node, reading its plan from the JSON file beside it.
const PROGRAM = (planFile: string, releaseFile: string) => `
const fs = require('node:fs');
const path = require('node:path');
const plan = JSON.parse(fs.readFileSync(${JSON.stringify(planFile)}, 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  const total = plan.frames;
  for (const pct of [12, 47, 83, 100]) { console.log('Bundling ' + pct + '%'); await sleep(120); }
  const stop = plan.failAt ?? plan.hold ?? total;
  // a hold: quick through the first third, then about 0.9 % a second for ten seconds and more — steady, so lampo render
  // says the time left (it measures the last ten seconds' rate); a failure goes quick all the way
  const quick = plan.hold !== undefined ? Math.min(stop, Math.round(total * 0.32)) : stop;
  let f = 0;
  while (f < quick) { f = Math.min(quick, f + Math.ceil(total / 40)); console.log('Rendered ' + f + '/' + total); await sleep(100); }
  while (f < stop) { f++; console.log('Rendered ' + f + '/' + total); await sleep(Math.round(111111 / total)); }
  if (plan.failAt !== undefined) {
    for (const line of plan.error ?? []) console.error(line);
    process.exit(1);
  }
  if (plan.hold !== undefined) while (!fs.existsSync(${JSON.stringify(releaseFile)})) await sleep(100);
  while (f < total) { f = Math.min(total, f + Math.ceil(total / 12)); console.log('Rendered ' + f + '/' + total); await sleep(60); }
  for (const pct of [25, 50, 75, 100]) { console.log('Encoded ' + Math.round((total * pct) / 100) + '/' + total); await sleep(60); }
  if (plan.from && plan.to) {
    // in place at once, and settled (a file written seconds ago reads as one still being written)
    const tmp = path.join(path.dirname(plan.to), '.' + path.basename(plan.to) + '.part');
    fs.copyFileSync(plan.from, tmp);
    const then = new Date(Date.now() - 60000);
    fs.utimesSync(tmp, then, then);
    fs.renameSync(tmp, plan.to);
  }
})();
`;

export function renderStandIn(dir: string): RenderStandIn {
  const binDir = path.join(dir, 'bin');
  fs.mkdirSync(binDir, { recursive: true });
  const planFile = path.join(dir, 'plan.json');
  const releaseFile = path.join(dir, 'release');
  const bin = path.join(binDir, 'remotion');
  fs.writeFileSync(bin, `#!${process.execPath}\n${PROGRAM(planFile, releaseFile)}`, { mode: 0o755 });
  return {
    bin,
    plan(p) {
      fs.rmSync(releaseFile, { force: true });
      fs.writeFileSync(planFile, JSON.stringify(p));
    },
    release() {
      fs.writeFileSync(releaseFile, '');
    },
  };
}
