// The agents installed on this machine, for the local setup's tiles (lib/agentsFound.ts): found by looking, never by
// running anything — an executable on PATH, Cursor's app — and the version only where a file says it: an npm
// package's package.json beside the CLI's real path, a native install's versioned file, Cursor's Info.plist.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { lookForAgents } from '../../lib/agentsFound.ts';
import { tmpdir } from '../lib/helpers.ts';

const exe = (file: string, body = '#!/bin/sh\necho "never run"; exit 1\n') => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body, { mode: 0o755 });
};

test('npm-installed CLIs on PATH: found, with the version their package says', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  const pkg = path.join(dir, 'lib/node_modules/@anthropic-ai/claude-code');
  exe(path.join(pkg, 'cli.js'));
  fs.writeFileSync(path.join(pkg, 'package.json'), JSON.stringify({ name: '@anthropic-ai/claude-code', version: '2.1.4' }));
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(bin, 'claude'));
  const codexPkg = path.join(dir, 'lib/node_modules/@openai/codex');
  exe(path.join(codexPkg, 'bin/codex.js'));
  fs.writeFileSync(path.join(codexPkg, 'package.json'), JSON.stringify({ name: '@openai/codex', version: '0.58.0' }));
  fs.symlinkSync(path.join(codexPkg, 'bin/codex.js'), path.join(bin, 'codex'));
  const r = lookForAgents({ pathVar: bin, claude: null, apps: path.join(dir, 'Applications') });
  assert.deepEqual(r.found, [
    { kind: 'claude-code', version: '2.1.4' },
    { kind: 'codex', version: '0.58.0' },
  ]);
});

test('a native install’s versioned file, Cursor’s app with its plist; a file that isn’t executable is nothing', () => {
  const dir = tmpdir();
  const bin = path.join(dir, 'bin');
  exe(path.join(dir, 'share/claude/versions/2.2.0'));
  fs.mkdirSync(bin, { recursive: true });
  fs.symlinkSync(path.join(dir, 'share/claude/versions/2.2.0'), path.join(bin, 'claude'));
  fs.writeFileSync(path.join(bin, 'codex'), 'not a program', { mode: 0o644 });
  const app = path.join(dir, 'Applications/Cursor.app/Contents');
  fs.mkdirSync(app, { recursive: true });
  fs.writeFileSync(
    path.join(app, 'Info.plist'),
    '<?xml version="1.0"?><plist><dict><key>CFBundleName</key><string>Cursor</string><key>CFBundleShortVersionString</key>\n<string>1.7.2</string></dict></plist>',
  );
  const r = lookForAgents({ pathVar: bin, claude: null, apps: path.join(dir, 'Applications') });
  assert.deepEqual(r.found, [
    { kind: 'claude-code', version: '2.2.0' },
    { kind: 'cursor', version: '1.7.2' },
  ]);
});

test('Claude Code where findClaude found it, a version nobody wrote down, nothing installed', () => {
  const dir = tmpdir();
  exe(path.join(dir, 'stand-in/claude'));
  assert.deepEqual(lookForAgents({ pathVar: '', claude: path.join(dir, 'stand-in/claude'), apps: dir }).found, [{ kind: 'claude-code', version: null }]);
  assert.deepEqual(lookForAgents({ pathVar: path.join(dir, 'empty'), claude: null, apps: path.join(dir, 'none') }).found, []);
});
