// `npm run link`: puts `lampo` on this machine's PATH as ~/.local/bin/lampo, a link to this checkout's bin/lampo
// (bin/lampo finds a Node that runs it by itself), and `vr` beside it, its older name, for setups that still call it.
// A stock Mac has no ~/.local/bin, so it is made; when the shell doesn't look there, this says what to add. What is
// there already is replaced only when it is Lampo's (a link into a Lampo checkout, or a link to nothing): another
// program of that name, a file or a folder stays as it is, and this says so. Plain JavaScript, like node-check.mjs: it
// runs on whatever Node npm found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(os.homedir(), '.local', 'bin');

/** Whether `folder` is a checkout of Lampo (by the name in its package.json, now or before the rename). */
const isLampo = (folder) => {
  try {
    const name = JSON.parse(fs.readFileSync(path.join(folder, 'package.json'), 'utf8')).name;
    return name === '@lampo-vr/lampo' || name === 'video-review';
  } catch {
    return false;
  }
};

/** What is at `target` now: nothing, Lampo's own link (replaced, like ln -sf), or something else (left alone). */
function what(target) {
  let st;
  try {
    st = fs.lstatSync(target);
  } catch {
    return 'free';
  }
  if (!st.isSymbolicLink()) return 'other';
  const to = path.resolve(path.dirname(target), fs.readlinkSync(target));
  if (!fs.existsSync(to)) return 'ours'; // a link to nothing: a checkout that moved or went
  return isLampo(path.dirname(path.dirname(to))) ? 'ours' : 'other';
}

fs.mkdirSync(dir, { recursive: true });
const kept = [];
for (const name of ['lampo', 'vr']) {
  const target = path.join(dir, name);
  const now = what(target);
  if (now === 'other') {
    kept.push(target);
    continue;
  }
  if (now === 'ours') fs.rmSync(target);
  fs.symlinkSync(path.join(root, 'bin', name), target);
}
if (kept.includes(path.join(dir, 'lampo'))) {
  console.error(`${path.join(dir, 'lampo')} is there already and isn’t Lampo’s, so it was left as it is: move or rename it, then run npm run link again.`);
  process.exitCode = 1;
} else console.log(`linked lampo → ${path.join(dir, 'lampo')}`);
if (kept.includes(path.join(dir, 'vr'))) console.log(`${path.join(dir, 'vr')} is another program’s: left as it is (type lampo).`);

const onPath = (process.env.PATH ?? '').split(path.delimiter).some((p) => p && path.resolve(p) === dir);
if (!onPath && !process.exitCode) {
  console.log(`${dir} is not on your PATH yet. Add this line to your shell's profile (~/.zshrc, ~/.bashrc), then open a new terminal:`);
  console.log('  export PATH="$HOME/.local/bin:$PATH"');
}
