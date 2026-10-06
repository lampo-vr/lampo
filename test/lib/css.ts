// A small reader for the app's stylesheets, enough for the design-system tests: rules with their selectors, the
// at-rules around them, and every declaration with its line. Not a full CSS parser (no need: the files are Biome
// formatted, and comments and strings are the only traps).
import fs from 'node:fs';
import path from 'node:path';

export const STYLES = path.join(import.meta.dirname, '../../web/src/styles');

export interface Decl {
  prop: string;
  value: string;
  line: number;
}
export interface Rule {
  file: string;
  line: number;
  selectors: string[];
  /** The at-rules this rule sits in, outermost first ("@media (max-width: 640px)"). */
  at: string[];
  decls: Decl[];
}

/** Comments out, strings kept, line breaks kept (so offsets still give the right line). */
function stripComments(src: string): string {
  let out = '';
  for (let i = 0; i < src.length; i++) {
    if (src[i] === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      const body = src.slice(i, end < 0 ? src.length : end + 2);
      out += body.replace(/[^\n]/g, ' ');
      i += body.length - 1;
    } else if (src[i] === '"' || src[i] === "'") {
      const q = src[i];
      let j = i + 1;
      while (j < src.length && src[j] !== q) j += src[j] === '\\' ? 2 : 1;
      out += src.slice(i, j + 1);
      i = j;
    } else out += src[i];
  }
  return out;
}

/** Splits on top-level commas (not inside parentheses: `:is(.a, .b)`). */
export function splitTop(s: string, sep = ','): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === sep && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

export function parseCss(file: string, src = fs.readFileSync(file, 'utf8')): Rule[] {
  const text = stripComments(src);
  const rules: Rule[] = [];
  const lineAt = (i: number) => text.slice(0, i).split('\n').length;
  // A stack of open blocks: an at-rule (its prelude) or a style rule (collecting declarations).
  const stack: ({ kind: 'at'; prelude: string } | { kind: 'rule'; rule: Rule })[] = [];
  let buf = '';
  let bufStart = 0;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '(') depth++;
    if (ch === ')') depth--;
    if (ch === '{' && depth === 0) {
      const prelude = buf.trim();
      const at = stack.filter((s) => s.kind === 'at').map((s) => (s as { prelude: string }).prelude);
      // keyframe steps (from, to, 50%) are not rules of the page
      if (prelude.startsWith('@') || at.some((a) => /^@(-webkit-)?keyframes/.test(a))) stack.push({ kind: 'at', prelude });
      else {
        const rule: Rule = { file, line: lineAt(bufStart + buf.indexOf(prelude)), selectors: splitTop(prelude.replace(/\s+/g, ' ')), at, decls: [] };
        rules.push(rule);
        stack.push({ kind: 'rule', rule });
      }
      buf = '';
      bufStart = i + 1;
    } else if (ch === '}' && depth === 0) {
      const top = stack.pop();
      if (top?.kind === 'rule' && buf.trim()) addDecls(top.rule, buf, bufStart);
      buf = '';
      bufStart = i + 1;
    } else if (ch === ';' && depth === 0 && stack.at(-1)?.kind === 'rule') {
      addDecls((stack.at(-1) as { rule: Rule }).rule, buf, bufStart);
      buf = '';
      bufStart = i + 1;
    } else if (ch === ';' && depth === 0) {
      buf = '';
      bufStart = i + 1;
    } else buf += ch;
  }
  function addDecls(rule: Rule, chunk: string, start: number) {
    const c = chunk.indexOf(':');
    if (c < 0) return;
    const prop = chunk.slice(0, c).trim();
    const value = chunk.slice(c + 1).trim();
    if (!prop) return;
    rule.decls.push({ prop, value, line: lineAt(start + chunk.search(/\S/)) });
  }
  return rules;
}

export const stylesheets = () =>
  fs
    .readdirSync(STYLES)
    .filter((f) => f.endsWith('.css'))
    .sort()
    .map((f) => path.join(STYLES, f));
