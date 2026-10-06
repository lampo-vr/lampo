// Types for baseline.mjs, which a unit test checks (test/unit/e2e-baseline.test.ts).
export const BASELINE_DIR: string;
export const NEW_BASELINE_DIR: string;
export function onCI(env?: Record<string, string | undefined>): boolean;
export function baselinePlan(o: { exists: boolean; update?: boolean; ci?: boolean; missing?: string }): 'compare' | 'record' | 'missing' | 'skip';
export function baselineFiles(name: string, platform?: string): { baseline: string; fresh: string };
