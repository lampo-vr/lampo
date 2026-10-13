// Loaded first into a server a test starts (`node --import …/withParent.ts?parent=<pid>`, WITH_PARENT in ./tmp.ts):
// the server stops once the test process that started it is gone. A test process stopped with SIGKILL runs no hook
// that could stop it, and such servers went on for days with init or launchd as their parent. The test's pid comes in
// the URL, not from process.ppid: a test SIGKILLed while its server was still starting is gone before this runs.
import { isMainThread } from 'node:worker_threads';

const parent = Number(new URL(import.meta.url).searchParams.get('parent')) || process.ppid;
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
};

if (isMainThread) {
  // started by the test itself: its leaving shows as a new parent, whatever process gets its pid later (Node reads
  // the parent's pid anew each time); started through something else, the test's pid is all there is to go by
  const direct = process.ppid === parent;
  const watch = setInterval(() => {
    if (direct ? process.ppid === parent : alive(parent)) return;
    clearInterval(watch);
    // the server's own Ctrl-C: it stops at once, and so do the agents it started
    process.kill(process.pid, 'SIGINT');
    // a server that doesn't stop on it still ends
    setTimeout(() => process.exit(1), 10_000).unref();
  }, 1000);
  watch.unref();
}
