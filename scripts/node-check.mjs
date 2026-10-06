// Runs before `npm start`, `npm test` and friends (the pre-scripts in package.json). With an older Node (an nvm
// default is often 20) they would die on the first `.ts` import with ERR_UNKNOWN_FILE_EXTENSION; this says what's
// wrong and where a capable Node is instead. Plain JavaScript on purpose: it must load on any Node.
import { canRunTypeScript, capableNode, tooOld } from '../bin/launch.js';

if (!canRunTypeScript()) {
  // npm names the script it's about to run ("prestart" → `npm start`).
  const script = (process.env.npm_lifecycle_event || 'prestart').replace(/^pre/, '');
  process.stderr.write(tooOld(capableNode(), script === 'test' || script === 'start' ? `npm ${script}` : `npm run ${script}`));
  process.exit(1);
}
