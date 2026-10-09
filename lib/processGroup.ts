// Stopping what Lampo started (an agent run on the machine, `lampo render`'s tool): each runs as the leader of a process
// group of its own, and a stop is for the whole group. Every step goes to the group while it has a member, whatever
// its leader did: a leader that ends on the first signal leaves behind what it started (a shell's background job
// ignores SIGINT), and that is stopped too. A group's id is given to no other group while it has a member, and once it
// is seen empty it is never signalled again. Not on Windows (no process groups): callers signal the process there.

/** Whether process group `pgid` still has a member. */
export function groupAlive(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** Sends `sig` to the whole group: false once it has no member. */
function signalGroup(pgid: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(-pgid, sig);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export interface GroupStop {
  readonly pgid: number;
  /** Settles once the group has no member, or a grace after SIGKILL (a process stuck in the kernel). */
  done: Promise<void>;
  /** At most `graceMs` for each step still to come, and the process kept alive until it is done (the app is stopping). */
  hurry(graceMs: number): void;
  /** SIGKILL now (a second Ctrl-C). */
  kill(): void;
}

/**
 * Stops group `pgid`: `first` now (SIGINT: a tool ends its work cleanly), SIGTERM `graceMs` later, SIGKILL as long
 * after that — each only while the group has a member, never cut short because its leader has gone. `ref`: the ladder
 * keeps this process alive until it is done (a command that waits for it); unref'd, a server's own life carries it.
 */
export function stopGroup(pgid: number, { first = 'SIGINT', graceMs, ref = false }: { first?: NodeJS.Signals; graceMs: number; ref?: boolean }): GroupStop {
  const steps: NodeJS.Signals[] = first === 'SIGKILL' ? ['SIGKILL'] : [...new Set<NodeJS.Signals>([first, 'SIGTERM']), 'SIGKILL'];
  let next = 0;
  let grace = graceMs;
  let at = Date.now();
  let settled = false;
  let settle = () => {};
  const done = new Promise<void>((r) => {
    settle = r;
  });
  const finish = () => {
    if (settled) return;
    settled = true;
    clearInterval(tick);
    settle();
  };
  // the next signal, or the end once SIGKILL had its grace; a group found empty ends it
  const step = () => {
    if (settled) return;
    const sig = steps[next++];
    if (!sig || !signalGroup(pgid, sig)) return finish();
    at = Date.now();
  };
  const check = () => {
    if (settled) return;
    if (!groupAlive(pgid)) return finish();
    if (Date.now() - at >= grace) step();
  };
  const tick = setInterval(check, Math.max(10, Math.min(100, Math.floor(graceMs / 4))));
  if (!ref) tick.unref();
  step();
  return {
    pgid,
    done,
    hurry(g) {
      grace = Math.min(grace, g);
      tick.ref();
      check();
    },
    kill() {
      if (settled) return;
      next = steps.length - 1;
      step();
    },
  };
}

/**
 * The same, all at once and without waiting for the event loop (a process that is exiting): SIGTERM to every group,
 * up to `graceMs` for them to go, then SIGKILL to what is left.
 */
export function endGroupsNow(pgids: Iterable<number>, graceMs = 1000): void {
  let live = [...new Set(pgids)].filter((g) => signalGroup(g, 'SIGTERM'));
  const until = Date.now() + graceMs;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  while (live.length && Date.now() < until) {
    Atomics.wait(nap, 0, 0, 20);
    live = live.filter(groupAlive);
  }
  for (const g of live) signalGroup(g, 'SIGKILL');
}
