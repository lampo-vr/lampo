// The markdown people write in a playbook, parsed into plain data (Markdown.tsx turns it into React elements, never
// HTML, so nothing written can run or restyle the page): headings, paragraphs, lists, quotes, code, bold, italics,
// inline code and http(s) links. Anything else stays as its text. Anyone who may write a playbook — or an agent's
// suggestion shown in one — writes this text, so parsing it must stay linear: no pattern that backtracks over the
// rest of a line for every character (a long run of "[" froze the tab for seconds), links are found by a scan.

export type Block =
  | { t: 'h'; level: 1 | 2 | 3; text: string }
  | { t: 'p'; text: string }
  | { t: 'ul' | 'ol'; items: string[] }
  | { t: 'quote'; text: string }
  | { t: 'code'; text: string }
  | { t: 'hr' };

export type Inline =
  | { t: 'text'; text: string }
  | { t: 'code'; text: string }
  | { t: 'strong' | 'em'; children: Inline[] }
  | { t: 'link'; href: string; label: string };

export function blocks(src: string): Block[] {
  const out: Block[] = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) {
      i++;
      continue;
    }
    if (/^```/.test(line)) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) code.push(lines[i++]);
      i++;
      out.push({ t: 'code', text: code.join('\n') });
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push({ t: 'h', level: Math.min(3, h[1].length) as 1 | 2 | 3, text: h[2] });
      i++;
      continue;
    }
    if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
      out.push({ t: 'hr' });
      i++;
      continue;
    }
    if (/^\s*>/.test(line)) {
      const q: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) q.push(lines[i++].replace(/^\s*>\s?/, ''));
      out.push({ t: 'quote', text: q.join(' ') });
      continue;
    }
    const bullet = /^\s*[-*+]\s+/;
    const number = /^\s*\d+[.)]\s+/;
    if (bullet.test(line) || number.test(line)) {
      const kind = bullet.test(line) ? 'ul' : 'ol';
      const re = kind === 'ul' ? bullet : number;
      const items: string[] = [];
      while (i < lines.length && lines[i].trim()) {
        if (re.test(lines[i])) items.push(lines[i].replace(re, ''));
        // a wrapped line continues the item before it
        else if (items.length) items[items.length - 1] += ` ${lines[i].trim()}`;
        else break;
        i++;
      }
      out.push({ t: kind, items });
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i])) para.push(lines[i++].trim());
    out.push({ t: 'p', text: para.join(' ') });
  }
  return out;
}

const SAFE_URL = /^https?:\/\//i;

/**
 * The next `ch` at or after `from`, remembered: scans only move forward, so every character is looked at a bounded
 * number of times however many "[" or "(" ask (a string with no "]" is searched once, not once per "[").
 */
function nextOf(text: string, ch: string) {
  let at = -2;
  return (from: number) => {
    if (at === -1 || (at >= from && at !== -2)) return at;
    at = text.indexOf(ch, from);
    return at;
  };
}

/** A link at `start` ("[label](url)", the label and url each non-empty, no space inside the url), or null. */
function linkAt(text: string, start: number, close: (i: number) => number, paren: (i: number) => number) {
  const c = close(start + 1);
  if (c <= start + 1 || text[c + 1] !== '(') return null;
  const p = paren(c + 2);
  if (p < 0) return null;
  const href = text.slice(c + 2, p).trim();
  if (!href || /\s/.test(href)) return null;
  return { whole: text.slice(start, p + 1), label: text.slice(start + 1, c), href };
}

/**
 * Bold, italics, code and links inside a line. Code, bold and italics only ever scan to their next closing mark;
 * links are a scan with remembered positions (`nextOf`), so the whole line is linear.
 */
export function inlineTokens(text: string): Inline[] {
  const out: Inline[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*\s][^*]*\*|_[^_\s][^_]*_)|(\[)|(https?:\/\/[^\s)<]+)/g;
  const close = nextOf(text, ']');
  const paren = nextOf(text, ')');
  let last = 0;
  const push = (t: Inline) => {
    const prev = out.at(-1);
    if (t.t === 'text' && prev?.t === 'text') prev.text += t.text;
    else out.push(t);
  };
  for (let m = re.exec(text); m; m = re.exec(text)) {
    const [, code, bold, em, bracket, bare] = m;
    let whole = m[0];
    let token: Inline;
    if (bracket) {
      const link = linkAt(text, m.index, close, paren);
      // a "[" that opens no link stays text: go on with the next character
      if (!link) continue;
      whole = link.whole;
      re.lastIndex = m.index + whole.length;
      token = SAFE_URL.test(link.href) ? { t: 'link', href: link.href, label: link.label } : { t: 'text', text: whole };
    } else if (code) token = { t: 'code', text: code.slice(1, -1) };
    else if (bold) token = { t: 'strong', children: inlineTokens(bold.slice(2, -2)) };
    else if (em) token = { t: 'em', children: inlineTokens(em.slice(1, -1)) };
    else token = { t: 'link', href: bare, label: bare };
    if (m.index > last) push({ t: 'text', text: text.slice(last, m.index) });
    push(token);
    last = m.index + whole.length;
  }
  if (last < text.length) push({ t: 'text', text: text.slice(last) });
  return out;
}
