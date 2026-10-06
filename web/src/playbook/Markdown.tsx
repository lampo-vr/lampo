// Markdown as people write it in a playbook, shown as React elements (never as HTML, so nothing written can run or
// restyle the page). The parsing is plain data in markdown.ts (linear, unit-tested); this only draws it.
import type { ReactNode } from 'react';
import { blocks, type Inline, inlineTokens } from './markdown.ts';

/** Inline tokens as elements; `key` keeps React's keys unique across the line. */
function draw(tokens: Inline[], key: string): ReactNode[] {
  return tokens.map((tk, n) => {
    const k = `${key}.${n}`;
    switch (tk.t) {
      case 'text':
        return tk.text;
      case 'code':
        return <code key={k}>{tk.text}</code>;
      case 'strong':
        return <strong key={k}>{draw(tk.children, k)}</strong>;
      case 'em':
        return <em key={k}>{draw(tk.children, k)}</em>;
      default:
        return (
          <a key={k} href={tk.href} target="_blank" rel="noreferrer noopener">
            {tk.label}
          </a>
        );
    }
  });
}

const inline = (text: string, key: string) => draw(inlineTokens(text), key);

/** One line's bold, italics, code and links (a rule in the rules' list). */
export function InlineText({ text }: { text: string }) {
  return <>{inline(text, 'i')}</>;
}

/** A playbook's markdown, read-only. `className` goes on the wrapper (the page gives it its type and rhythm). */
export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  return (
    <div className={`md-text ${className}`}>
      {blocks(text).map((b, i) => {
        const k = String(i);
        switch (b.t) {
          case 'h':
            return b.level === 1 ? (
              <h3 key={k}>{inline(b.text, k)}</h3>
            ) : b.level === 2 ? (
              <h4 key={k}>{inline(b.text, k)}</h4>
            ) : (
              <h5 key={k}>{inline(b.text, k)}</h5>
            );
          case 'ul':
            return (
              <ul key={k}>
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: items are the text's lines, in order
                  <li key={j}>{inline(it, `${k}.${j}`)}</li>
                ))}
              </ul>
            );
          case 'ol':
            return (
              <ol key={k}>
                {b.items.map((it, j) => (
                  // biome-ignore lint/suspicious/noArrayIndexKey: items are the text's lines, in order
                  <li key={j}>{inline(it, `${k}.${j}`)}</li>
                ))}
              </ol>
            );
          case 'quote':
            return <blockquote key={k}>{inline(b.text, k)}</blockquote>;
          case 'code':
            return (
              <pre key={k}>
                <code>{b.text}</code>
              </pre>
            );
          case 'hr':
            return <hr key={k} />;
          default:
            return <p key={k}>{inline(b.text, k)}</p>;
        }
      })}
    </div>
  );
}
