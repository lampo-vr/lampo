// covers: **
// The audit ledger (AUDITS.md) stays usable. Every tracked file belongs to an area, so new code lands somewhere an
// audit will read it. Every path still covers a file, so a rename doesn't drop code out of the ledger. Every area
// names the audit and commit it was last read at, and the queue is in the shape scripts/audits.ts reads.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { covers, parseLedger, stale, trackedFiles, unmapped } from '../../scripts/audits.ts';
import { ROOT } from '../lib/helpers.ts';

const ledger = parseLedger(fs.readFileSync(path.join(ROOT, 'AUDITS.md'), 'utf8'));
const files = fs.existsSync(path.join(ROOT, '.git')) ? trackedFiles() : null;

test('paths: a file, a folder, a name with *', () => {
  assert.ok(covers('lib/auth.ts', 'lib/auth.ts'));
  assert.ok(!covers('lib/auth.ts', 'lib/auth.tsx'));
  assert.ok(covers('lib/oauth/', 'lib/oauth/store.ts'));
  assert.ok(!covers('lib/oauth/', 'lib/oauth.ts'));
  assert.ok(covers('lib/insights*.ts', 'lib/insightsFlow.ts'));
  assert.ok(!covers('lib/insights*.ts', 'lib/insights/flow.ts'), '* stays inside one folder');
  assert.ok(!covers('lib/playbook*.ts', 'lib/playbookXts'), 'the dot is a dot');
});

test('every area names its paths and the audit and commit it was last read at', () => {
  assert.ok(ledger.areas.length >= 10);
  assert.equal(new Set(ledger.areas.map((a) => a.id)).size, ledger.areas.length, 'area ids are unique');
  for (const a of ledger.areas) {
    assert.ok(a.paths.length, `${a.id} has paths`);
    assert.match(a.audit, /^A\d+$/, `${a.id} names an audit`);
    assert.match(a.commit, /^[0-9a-f]{7,40}$/, `${a.id} names a commit`);
    assert.match(a.date, /^\d{4}-\d{2}-\d{2}$/, `${a.id} has a date`);
  }
});

test('every queue line is read, whether it names a commit or the branch it came from', () => {
  const sample = parseLedger(
    ['## Needs audit', '', '- 2026-10-05 · `5d080dce` · links · a commit', '- 2026-10-06 · (operator-admin) · routing, auth · a branch', '', '## Log'].join(
      '\n',
    ),
  );
  assert.deepEqual(
    sample.queue.map((q) => [q.commit, q.areas]),
    [
      ['5d080dce', ['links']],
      ['(operator-admin)', ['routing', 'auth']],
    ],
  );
  const text = fs.readFileSync(path.join(ROOT, 'AUDITS.md'), 'utf8');
  const listed = text
    .slice(text.indexOf('## Needs audit'), text.indexOf('## Log'))
    .split('\n')
    .filter((l) => l.startsWith('- '));
  assert.equal(ledger.queue.length, listed.length, 'no queue line is skipped unread');
});

test('queued changes name known areas', () => {
  const ids = new Set(ledger.areas.map((a) => a.id));
  for (const q of ledger.queue) for (const a of q.areas) assert.ok(ids.has(a), `queue line "${q.what}" names an area that exists, not "${a}"`);
});

test('every tracked file has an area; every path covers a file', { skip: !files && 'not a git checkout' }, () => {
  assert.deepEqual(unmapped(files ?? [], ledger.areas), [], 'give these files an area in AUDITS.md');
  assert.deepEqual(stale(files ?? [], ledger.areas), [], 'these paths in AUDITS.md cover nothing any more');
});
