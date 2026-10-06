// What agents read, beside the playbook as it is written (web/src/playbook/agentText.ts): the pane shows the server's
// merged text with what is being typed put in place. Each case drafts on a real store, then saves the same text and
// holds the drafted text to what the server (lib/playbooks.ts agentMarkdown) hands agents after the save — so the
// preview can never say something an agent won't read. And whose each line is: this playbook's lit, inherited quieter.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { isolatedEnv } from '../lib/helpers.ts';

isolatedEnv();
const playbooks = await import('../../lib/playbooks.ts');
const { agentLines, ownOf, withDrafts } = await import('../../web/src/playbook/agentText.ts');
type Draft = import('../../web/src/playbook/agentText.ts').Draft;

const by = 'tester';
/** Drafts on the scope as it stands, then saves them one by one: the drafted text must be what the server says after. */
function same(scope: string, drafts: Draft[], what: string) {
  const p = playbooks.loadPlaybook(scope);
  const drafted = withDrafts(playbooks.agentMarkdown(scope), ownOf(p, drafts), drafts);
  for (const d of drafts) playbooks.writeText(scope, d.section, d.text, { by });
  assert.equal(drafted, playbooks.agentMarkdown(scope), what);
}

test('drafted text is what agents read once it is saved', () => {
  same('', [{ section: 'brief', text: 'We make **human** motion.\n\nCalm type.' }], 'nothing anywhere yet: the first brief');
  same('', [{ section: 'rules', text: '- Captions never over faces\n- -14 LUFS  ' }], 'a section the playbook doesn’t have yet, after the brief');
  same('', [{ section: 'brief', text: 'We make calm motion.' }], 'its own block changed, the revision moves on everywhere');
  same('Acme/Reels', [{ section: 'rules', text: '- 9:16 first' }], 'a folder writing its first rules above the House’s');
  same('Acme', [{ section: 'brief', text: 'Acme runs.' }], 'a layer between the House and the folder');
  same('Acme/Reels', [{ section: 'brief', text: 'Reels: short.' }], 'a brief first in its section, the deepest first');
  same('Acme/Reels', [{ section: 'rules', text: '- 9:16 first\n- Hook in 1 s' }], 'a block in the middle of its section replaced');
  same(
    'Acme/Reels',
    [
      { section: 'brief', text: 'Reels: shorter.' },
      { section: 'rules', text: '- 9:16 only' },
    ],
    'two drafts saved one after the other: two revisions',
  );
  same('Acme/Reels', [{ section: 'brief', text: '' }], 'a section emptied: its block goes, the layer stays for its rules');
  same('Acme/Reels', [{ section: 'rules', text: '   ' }], 'emptied of everything: it leaves the layers');
  same('Acme', [{ section: 'brief', text: '' }], 'the middle layer emptied: the House alone');
  same('', [{ section: 'rules', text: '' }], 'the House’s rules emptied');
  same('', [{ section: 'brief', text: '' }], 'nothing left anywhere: nothing applies');
});

test('a draft that has nothing to say changes nothing', () => {
  const md = playbooks.agentMarkdown('Globex');
  assert.equal(withDrafts(md, { scope: 'Globex', rev: 0, other: false }, []), md);
  assert.equal(withDrafts(md, { scope: 'Globex', rev: 0, other: false }, [{ section: 'brief', text: '  ' }]), md);
});

test('whose each line is: this playbook lit, what it inherits quieter, the unsaved lines marked', () => {
  playbooks.writeText('', 'rules', '- House rule', { by });
  playbooks.writeText('Acme', 'rules', '- Acme rule', { by });
  const saved = playbooks.agentMarkdown('Acme');
  const drafts: Draft[] = [{ section: 'rules', text: '- Acme rule\n- A new one' }];
  const md = withDrafts(saved, ownOf(playbooks.loadPlaybook('Acme'), drafts), drafts);
  const lines = agentLines(md, 'Acme', saved);
  const line = (text: string) => lines.find((l) => l.text === text);
  assert.deepEqual(line('# Playbook: Acme'), { text: '# Playbook: Acme', level: 1, own: false, inherited: false, draft: false });
  assert.equal(line('## Rules')?.level, 2);
  assert.ok(line('- Acme rule')?.own && !line('- Acme rule')?.draft, 'its own, saved');
  assert.ok(line('- A new one')?.own && line('- A new one')?.draft, 'its own, not saved yet');
  assert.ok(line('- House rule')?.inherited && !line('- House rule')?.own, 'from the House');
  playbooks.putSkill('', { name: 'naming', description: 'How we name renders', body: 'x' }, { by });
  const skill = agentLines(playbooks.agentMarkdown('Acme'), 'Acme').find((l) => l.text.startsWith('- **naming**'));
  assert.ok(skill?.inherited, 'a skill says where it comes from');
});
