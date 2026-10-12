/**
 * React keys for a list shown newest first whose items carry no id of their own (an agent's steps: a time to the second
 * and words). Two items alike get `#2`, `#3`… counted from the oldest, so an item arriving on top leaves the keys below
 * it as they were. Never one key twice: React then loses track of one of the two rows, and the next render left its line
 * standing on top of the agent's rail for good (an agent read the notes twice within a second).
 */
export function newestFirstKeys<T>(items: readonly T[], base: (item: T) => string): string[] {
  const seen = new Map<string, number>();
  const keys = new Array<string>(items.length);
  for (let i = items.length - 1; i >= 0; i--) {
    const b = base(items[i]);
    const n = (seen.get(b) ?? 0) + 1;
    seen.set(b, n);
    keys[i] = n === 1 ? b : `${b}#${n}`;
  }
  return keys;
}
