// A question an agent asked on a project or folder before its first version (lib/asks.ts) leads the page: the agent waits
// on exactly this decision, so it stands above the videos (or the empty project) — who asks, the question in its own
// words, what there is to compare, and the one thing to do, Compare and pick. The questions come with the inbox's list
// (the bell asks for it on every page and this browser keeps it), so the block is there with the library, not after it;
// the audition's code arrives when the button is pointed at or pressed (options/code.ts).
import { useMemo, useState } from 'react';
import { compareTime } from '../../../lib/time.ts';
import type { ForYouItem, OptionSeen } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { useVisibleForYou } from '../inbox/hidden.ts';
import { crumbs, within } from '../lib/folders.ts';
import { ago } from '../lib/format.ts';
import { useLoaded } from '../lib/lazy.ts';
import { auditionCode } from '../options/code.ts';
import type { IconName } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { Button, Chip, Panel } from '../ui/system.tsx';

const who = (by: string | null | undefined) => (by ? by.replace(/^agent:/, '') : '');
const prefetch = () => void auditionCode.load().catch(() => {});

export interface FolderAsk {
  /** The newest question waiting here (or in a folder inside). */
  lead: ForYouItem | null;
  /** How many more wait. */
  more: number;
  /** The list has answered (or failed): until then the page can't say whether a question leads it. */
  known: boolean;
}

/** The questions waiting on this project or folder, the newest first — also those put aside for later in the inbox: this
 * is the page they are about. */
export function useFolderAsk(folder: string | null, enabled: boolean): FolderAsk {
  const { data, error } = useVisibleForYou(enabled);
  return useMemo(() => {
    if (!folder) return { lead: null, more: 0, known: true };
    const waiting = (data ? [...data.items, ...data.later] : [])
      .filter((i) => i.kind === 'question' && !i.slug && !!i.id && within(i.folder, folder))
      .sort((a, b) => compareTime(b.at, a.at));
    return { lead: waiting[0] ?? null, more: Math.max(0, waiting.length - 1), known: !!data || !!error };
  }, [folder, data, error]);
}

const KIND_ICON: Record<OptionSeen['kind'], IconName> = {
  audio: 'volume',
  image: 'image',
  clip: 'film',
  frame: 'film',
  link: 'link',
  text: 'notes',
  mixed: 'layers',
};

/** "3 clips", "3 sounds": what a group offers, counted in its kind's word. */
function offered(g: OptionSeen): string {
  switch (g.kind) {
    case 'clip':
      return t('{n} clip|{n} clips', { n: g.n });
    case 'audio':
      return t('{n} sound|{n} sounds', { n: g.n });
    case 'image':
      return t('{n} picture|{n} pictures', { n: g.n });
    case 'frame':
      return t('{n} frame|{n} frames', { n: g.n });
    case 'link':
      return t('{n} link|{n} links', { n: g.n });
    default:
      return t('{n} option|{n} options', { n: g.n });
  }
}

export function AskLead({ ask, folder }: { ask: FolderAsk; folder: string }) {
  const [open, setOpen] = useState(false);
  const code = useLoaded(auditionCode, open);
  const item = ask.lead;
  if (!item) return null;
  const groups = item.options ?? [];
  // one group says what it offers; several name themselves too ("Narrator: 3 sounds")
  const chips = groups.map((g) => ({ icon: KIND_ICON[g.kind], text: groups.length > 1 ? `${g.label}: ${offered(g)}` : offered(g) }));
  const inside = item.folder && item.folder !== folder ? crumbs(item.folder.slice(folder.length + 1)) : null;
  return (
    <Panel as="section" className="ask-lead" aria-label={t('{name} asks', { name: who(item.by) })} data-testid="ask-lead">
      <div className="ask-lead-text">
        <p className="ask-lead-who">
          <KeyGlyph shape="outline" />
          <span className="ellipsis">
            <T k="{name} asks" values={{ name: <b>{who(item.by)}</b> }} />
            {inside && <span className="ask-lead-in"> · {t('in {folder}', { folder: inside })}</span>}
          </span>
          <span className="ask-lead-ago">{ago(item.at)}</span>
        </p>
        <p className="ask-lead-q" title={item.text} data-testid="ask-lead-question">
          {item.text}
        </p>
        <div className="ask-lead-offer">
          {chips.map((c, i) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: the groups in the question's order
            <Chip key={i} icon={c.icon}>
              <span className="ellipsis">{c.text}</span>
            </Chip>
          ))}
          {ask.more > 0 && (
            <a className="btn-link ask-lead-more" href="#/inbox" data-testid="ask-lead-more">
              {t('{n} more question in the inbox|{n} more questions in the inbox', { n: ask.more })}
            </a>
          )}
        </div>
      </div>
      <Button
        variant="primary"
        icon="play"
        className="ask-lead-go"
        onClick={() => setOpen(true)}
        onPointerEnter={prefetch}
        onFocus={prefetch}
        data-testid="ask-lead-open"
      >
        {t('Compare and pick')}
      </Button>
      {open && code && <code.AuditionDialog id={item.id as string} text={item.text ?? ''} by={item.by ?? ''} groups={groups} onClose={() => setOpen(false)} />}
    </Panel>
  );
}
