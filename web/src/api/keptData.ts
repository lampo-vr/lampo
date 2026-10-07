// What of a screen's data this browser keeps (api/persistWrite.ts): pure, so a unit test reads it.
import type { QueryKey } from '@tanstack/react-query';

/**
 * What of an answer is kept: the plan as it is, but for the card a failed renewal tried (its label names the card), so
 * nothing of a card stays in this browser.
 */
export function keptData(key: QueryKey, data: unknown): unknown {
  if (key[0] !== 'billing' || !data || typeof data !== 'object') return data;
  const plan = data as { failure?: { method?: string } };
  if (!plan.failure?.method) return data;
  const { method: _method, ...failure } = plan.failure;
  return { ...plan, failure };
}
