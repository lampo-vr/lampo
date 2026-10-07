// The process that owns a detached render (`vr render --detach`): started by lib/render/detach.ts in a session of its
// own with the render's folder in the cache, it runs the job there and keeps its state beside it.
import { supervise } from './detach.ts';

const dir = process.argv[2];
if (!dir) {
  process.stderr.write('usage: supervisor.ts <render folder>\n');
  process.exitCode = 2;
} else await supervise(dir);
