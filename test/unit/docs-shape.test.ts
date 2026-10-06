// Code blocks are read as they are, without wrapping: a file tree, a diagram or a column of aligned comments keeps its
// columns, and a page of docs holds about 96 monospace characters across. A longer line in a fenced block of the
// README or docs/*.md makes the reader scroll sideways, so none is longer: wrap it, shorten its comment, or put the
// comment on its own line above the command.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { ROOT } from '../lib/helpers.ts';

const WIDTH = 96;

const pages = fs.readdirSync(path.join(ROOT, 'docs')).sort();
// the documents that are read as pages: the README, the docs and the governance files
const DOCS = ['README.md', 'CONTRIBUTING.md', 'SECURITY.md', 'CODE_OF_CONDUCT.md', ...pages.filter((f) => f.endsWith('.md')).map((f) => `docs/${f}`)].filter(
  (f) => fs.existsSync(path.join(ROOT, f)),
);

/** The lines inside fenced code blocks, numbered from 1. A fence is three or more backticks or tildes, indented or not
 * (a block in a list item is indented); it closes at a bare fence of the same character at least as long, or at the
 * end of the file. A run of backticks with more backticks after it is inline code, not a fence. */
function codeLines(markdown: string): { line: number; text: string }[] {
  const out: { line: number; text: string }[] = [];
  let open: string | null = null;
  markdown.split(/\r?\n/).forEach((text, i) => {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(text);
    if (open === null) {
      if (fence && !(fence[1][0] === '`' && fence[2].includes('`'))) open = fence[1];
    } else if (fence && fence[1][0] === open[0] && fence[1].length >= open.length && !fence[2].trim()) open = null;
    else out.push({ line: i + 1, text });
  });
  return out;
}

test('the scan reads fenced blocks the way Markdown does', () => {
  const md = [
    'A paragraph can be as long as it likes: prose wraps on the page, so nobody scrolls sideways to read this line.',
    '```sh',
    'npm start',
    '```',
    '1. A step:',
    '',
    '   ```json',
    '   {"a": 1}',
    '   ```',
    '````md',
    '```',
    '~~~',
    '````',
    '```inline``` code at the start of a paragraph',
    '~~~',
    'a block nobody closed runs to the end',
  ].join('\n');
  assert.deepEqual(
    codeLines(md).map((l) => l.line),
    [3, 8, 11, 12, 16],
  );
});

test(`every line in a code block of the docs fits its column (${WIDTH} characters)`, () => {
  const long: string[] = [];
  let seen = 0;
  for (const file of DOCS) {
    for (const { line, text } of codeLines(fs.readFileSync(path.join(ROOT, file), 'utf8'))) {
      seen++;
      // code points, as the page shows them: an ellipsis or an arrow takes one column
      const length = [...text].length;
      if (length > WIDTH) long.push(`${file}:${line} is ${length} characters`);
    }
  }
  assert.ok(seen > 0, 'the scan found the code blocks');
  assert.deepEqual(long, [], `longer than ${WIDTH} characters (wrap it, shorten its comment or move the comment above):\n${long.join('\n')}`);
});

// A blank left for later ("[… — set before publishing]") would ship to every reader: the contacts, the licence, a
// name. Every public page is read, the governance files included.
test('no public page keeps a placeholder for later', () => {
  const pagesRead = [...DOCS, 'TRADEMARKS.md', 'CLA.md', 'NOTICE.md'].filter((f) => fs.existsSync(path.join(ROOT, f)));
  const blanks = pagesRead.flatMap((f) =>
    fs
      .readFileSync(path.join(ROOT, f), 'utf8')
      .split('\n')
      .flatMap((text, i) => (/set before publishing|\[[A-Z][A-Z -]*ADDRESS[^\]]*\]/.test(text) ? [`${f}:${i + 1}`] : [])),
  );
  assert.deepEqual(blanks, [], `placeholders left:\n${blanks.join('\n')}`);
});
