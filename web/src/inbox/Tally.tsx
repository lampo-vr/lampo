// The inbox view's header: how much waits, in one quiet line, the keys and By video · By kind. Light: the library's header draws
// them in its first paint; the view itself (InboxView.tsx) is a chunk of its own.
import { t } from '../i18n/index.ts';
import { useMedia } from '../lib/media.ts';
import { Kbd, Segmented } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { useVisibleForYou } from './hidden.ts';
import { useInboxMode } from './mode.ts';
import { INBOX_WIDE, KEYS_HELP } from './nav.tsx';

/** How much waits, in one quiet line (each group's heading carries its own count): the library header's tally for this
 * view, loading or loaded. Stalled videos aren't in the bell's number, so they aren't in "waiting" either. */
export function InboxTally({ pending = false }: { pending?: boolean }) {
  const { data } = useVisibleForYou(!pending);
  if (!data)
    return (
      <div className="tally">
        <span>
          <SkLine w="6em" />
        </span>
      </div>
    );
  const { total, stalled } = data;
  return (
    <div className="tally" data-testid="inbox-tally">
      {total ? (
        <span>
          <b>{total}</b> {t('waiting')}
        </span>
      ) : (
        <span className="muted">{t('all caught up')}</span>
      )}
      {stalled > 0 && <span className="muted">{t('{n} stalled', { n: stalled })}</span>}
      {data.later.length > 0 && <span className="muted">{t('{n} later|{n} later', { n: data.later.length })}</span>}
    </div>
  );
}

/**
 * The keys' list, beside By video · By kind: where the list's controls are, only where the keys work — the list beside
 * the preview (INBOX_WIDE), a keyboard at hand, something in the list. The list (Rows.tsx) shows it.
 */
export function InboxKeys({ pending = false }: { pending?: boolean }) {
  const wide = useMedia(INBOX_WIDE);
  const touch = useMedia('(hover: none), (pointer: coarse)');
  const { data } = useVisibleForYou(!pending);
  if (!wide || touch || (data && !data.items.length)) return null;
  return (
    <button
      type="button"
      className="btn ghost inbox-keys"
      aria-keyshortcuts="?"
      onClick={() => window.dispatchEvent(new Event(KEYS_HELP))}
      data-testid="inbox-keys"
    >
      <Kbd>?</Kbd> {t('Keys')}
    </button>
  );
}

/** By video · By kind, across from the title. */
export function InboxModeSwitch() {
  const [mode, setMode] = useInboxMode();
  return (
    <Segmented
      label={t('Group the inbox')}
      className="inbox-mode"
      value={mode}
      onChange={(v) => v && setMode(v === 'kind' ? 'kind' : 'video')}
      options={[
        { value: 'video', label: t('By video') },
        { value: 'kind', label: t('By kind') },
      ]}
    />
  );
}
