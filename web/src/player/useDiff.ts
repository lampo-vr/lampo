// What changed since the previous version (computed once per version pair on the server, in the background).
import { useMemo } from 'react';
import { useDiffQuery } from '../api/queries.ts';

export function useDiff(slug: string, v: number) {
  const { data } = useDiffQuery(slug, v);
  const diff = v > 1 && data && (data.ranges || data.retimes || data.incomparable) ? data : null;
  const changes = useMemo(() => [...(diff?.ranges || [])].sort((a, b) => a.in - b.in), [diff]);
  return { diff, pending: v > 1 && !!data?.pending, changes };
}
