// Someone's words with the timecodes in them as links to their frame ("the name card at 0:28:20"): a click seeks
// whatever shows the video — the inbox's preview, the player; the link's address opens that frame in the full player
// (a new tab, a copied link). What is a timecode is lib/time.ts timecodesIn: the forms people and agents write, only
// frames the render has; the rest stays plain text (never HTML). Real links, not buttons: they wrap with the text.
import { useMemo } from 'react';
import { timecodesIn } from '../../../lib/time.ts';
import { t } from '../i18n/index.ts';

export function TimecodeText({
  text,
  fps,
  frames,
  href,
  onSeek,
}: {
  text: string;
  fps: number | undefined;
  frames?: number;
  /** The frame's address in the full player. */
  href: (frame: number) => string;
  onSeek: (frame: number) => void;
}) {
  const marks = useMemo(() => (fps ? timecodesIn(text, fps, frames) : []), [text, fps, frames]);
  if (!marks.length) return <>{text}</>;
  const parts: React.ReactNode[] = [];
  let at = 0;
  for (const m of marks) {
    if (m.start > at) parts.push(text.slice(at, m.start));
    parts.push(
      <a
        key={m.start}
        className="tc-link"
        href={href(m.frame)}
        aria-label={t('Go to {timecode}', { timecode: m.text })}
        data-frame={m.frame}
        onClick={(e) => {
          // a plain click seeks in place; with a modifier it is an ordinary link (a new tab)
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey || e.button !== 0) return;
          e.preventDefault();
          // the link's frame, not whatever the card or row around it does on a click
          e.stopPropagation();
          onSeek(m.frame);
        }}
      >
        {m.text}
      </a>,
    );
    at = m.end;
  }
  if (at < text.length) parts.push(text.slice(at));
  return <>{parts}</>;
}
