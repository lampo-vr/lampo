// `npm run link`: puts `lampo` on this machine's PATH as ~/.local/bin/lampo, a link to this checkout's bin/lampo
// (bin/lampo finds a Node that runs it by itself), and `vr` beside it, its older name, for setups that still call it.
// A stock Mac has no ~/.local/bin, so it is made; when the shell doesn't look there, this says what to add. Plain
// JavaScript, like node-check.mjs: it runs on whatever Node npm found.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const dir = path.join(os.homedir(), '.local', 'bin');

fs.mkdirSync(dir, { recursive: true });
for (const name of ['lampo', 'vr']) {
  const target = path.join(dir, name);
  fs.rmSync(target, { force: true }); // like ln -sf: an older link (or file) of that name is replaced
  fs.symlinkSync(path.join(root, 'bin', name), target);
}
console.log(`linked lampo → ${path.join(dir, 'lampo')}`);

const onPath = (process.env.PATH ?? '').split(path.delimiter).some((p) => p && path.resolve(p) === dir);
if (!onPath) {
  console.log(`${dir} is not on your PATH yet. Add this line to your shell's profile (~/.zshrc, ~/.bashrc), then open a new terminal:`);
  console.log('  export PATH="$HOME/.local/bin:$PATH"');
}
