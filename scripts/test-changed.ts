// The unit tests this branch's changes can affect, and only those: `npm run test:changed [base]`. A test file is
// chosen when it imports a changed module, directly or through local imports, names it as a path, or changed itself
// (test/lib/affected.ts says how); package*.json chooses them all. The base is main (else origin/main) unless named;
// what isn't committed yet counts too.
//   node scripts/test-changed.ts [base] [--list] [--test-… options for node --test]
import { spawnSync } from 'node:child_process';
import { baseRef, changedFiles, ROOT, unitTestsFor } from '../test/lib/affected.ts';

const args = process.argv.slice(2);
const base = baseRef(args.find((a) => !a.startsWith('--')));
const files = changedFiles(base);
const picked = unitTestsFor(files);
const say = (line: string) => console.error(line);

say(
  `test:changed: ${files.length} file${files.length === 1 ? '' : 's'} since ${base} → ${picked.files.length} unit test file${picked.files.length === 1 ? '' : 's'}`,
);
if (picked.everything) say(`  all of them: ${picked.everything}`);
if (args.includes('--list')) {
  for (const f of picked.files) console.log(f);
  process.exit(0);
}
if (!picked.files.length) process.exit(0);
// VR_TEST_JOBS: test files at a time, as for `npm test` (node --test's own default is one fewer than the CPUs)
const jobs = process.env.VR_TEST_JOBS ? [`--test-concurrency=${process.env.VR_TEST_JOBS}`] : [];
const r = spawnSync(process.execPath, ['--test', ...jobs, ...args.filter((a) => a.startsWith('--test')), ...picked.files], { cwd: ROOT, stdio: 'inherit' });
process.exit(r.status ?? 1);
