// The rendering behind <T> (T.tsx), as plain TypeScript so the unit tests can run it: numbered tags wrap their text
// with `tags[i]`, `{name}` placeholders take `values` (text or elements).
import { createElement, Fragment, type ReactNode } from 'react';

export type Tags = ((content: ReactNode) => ReactNode)[];
const TOKEN = /<(\d+)>(.*?)<\/\1>|\{(\w+)\}/gs;

export function rich(text: string, values: Record<string, ReactNode>, tags: Tags): ReactNode[] {
  const out: ReactNode[] = [];
  let at = 0;
  for (const m of text.matchAll(TOKEN)) {
    const i = m.index ?? 0;
    if (i > at) out.push(text.slice(at, i));
    if (m[1] !== undefined) {
      const wrap = tags[Number(m[1])];
      const inner = rich(m[2] ?? '', values, tags);
      out.push(createElement(Fragment, { key: out.length }, wrap ? wrap(inner) : inner));
    } else {
      const name = m[3] as string;
      out.push(createElement(Fragment, { key: out.length }, name in values ? values[name] : m[0]));
    }
    at = i + m[0].length;
  }
  if (at < text.length) out.push(text.slice(at));
  return out;
}
