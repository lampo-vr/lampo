// Shared by bin/lampo and bin/lampo-mcp (and bin/vr, bin/vr-mcp, their older names). The CLI and MCP server are
// TypeScript that Node ≥ 22.18 runs directly (type stripping). Agents often call `lampo` from a shell whose default Node is older (nvm), so an old Node re-runs the same
// entry with a capable one instead of failing. Plain JavaScript on purpose: this file must load on any Node.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const MIN = [22, 18];

const parse = (v) => v.replace(/^v/, '').split('.').map(Number);
const newEnough = (v) => {
  const [major, minor] = parse(v);
  return major > MIN[0] || (major === MIN[0] && minor >= MIN[1]);
};
const newestFirst = (a, b) => {
  const [x, y] = [parse(a), parse(b)];
  return y[0] - x[0] || y[1] - x[1] || y[2] - x[2];
};

function candidates() {
  const list = [
    // LAMPO_NODE, else the older VR_NODE: lib/env.ts reads every other setting, but this file must load on any Node.
    process.env.LAMPO_NODE || process.env.VR_NODE,
    '/opt/homebrew/opt/node@24/bin/node',
    '/opt/homebrew/opt/node@22/bin/node',
    '/opt/homebrew/bin/node',
    '/usr/local/bin/node',
    '/usr/bin/node',
  ];
  const nvm = path.join(os.homedir(), '.nvm/versions/node');
  try {
    for (const v of fs.readdirSync(nvm).filter(newEnough).sort(newestFirst)) list.push(path.join(nvm, v, 'bin/node'));
  } catch {}
  return list.filter((p) => p && p !== process.execPath && fs.existsSync(p));
}

// Asks the binary itself: a Homebrew or system node may be anything.
function capable(bin) {
  const r = spawnSync(bin, ['-p', 'process.version'], { encoding: 'utf8', timeout: 5000 });
  return r.status === 0 && newEnough(r.stdout.trim());
}

/** This Node runs the TypeScript sources directly (type stripping, on by default from 22.18). */
export const canRunTypeScript = () => !!process.features?.typescript;

/** A capable Node elsewhere on this machine (Homebrew, nvm, LAMPO_NODE), or null. */
export const capableNode = () => candidates().find(capable) || null;

/** What to tell someone whose Node is too old; `found` is a capable one on this machine, if any. */
export function tooOld(found, command = 'npm start') {
  const hint = found
    ? `A capable one is installed: ${found}\n  e.g. PATH="${path.dirname(found)}:$PATH" ${command}\n`
    : 'Install a current Node (e.g. `brew install node@24` or `nvm install 24`, see .nvmrc), or point LAMPO_NODE at one.\n';
  return `Lampo needs Node.js ${MIN.join('.')} or newer (this is ${process.version}).\n${hint}`;
}

/** Imports `entry` (a file URL) when this Node can run TypeScript; otherwise re-runs this command with one that can. */
export async function launch(entry) {
  if (canRunTypeScript()) return import(entry);
  const bin = capableNode();
  if (!bin) {
    process.stderr.write(tooOld(null));
    process.exit(1);
  }
  const child = spawn(bin, process.argv.slice(1), { stdio: 'inherit' });
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => child.kill(sig));
  const code = await new Promise((resolve) => child.on('exit', (c, sig) => resolve(c ?? (sig ? 128 + (os.constants.signals[sig] || 0) : 1))));
  process.exit(code);
}
