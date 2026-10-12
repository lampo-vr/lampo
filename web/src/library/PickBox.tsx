import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';

/**
 * The box that ticks a video for the selection's bar (./select.ts), over the start of its picture: a row's thumbnail,
 * a card's poster. There under the pointer and on the keys' item, on every one while picking (library.css, cards.css).
 * The pointer's: the keys tick with X (Library.tsx), as in Files.
 */
export function PickBox({
  name,
  checked,
  onPick,
  className = 'lpick',
}: {
  name: string;
  checked: boolean;
  onPick: (shift: boolean) => void;
  className?: string;
}) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: a box drawn over the picture that takes a click, not a form field
    <button
      type="button"
      className={`vchip-pick ${className} ${checked ? 'on' : ''}`}
      role="checkbox"
      aria-checked={checked}
      aria-label={t('Select {name}', { name })}
      tabIndex={-1}
      data-testid="pick"
      onClick={(e) => {
        e.stopPropagation();
        onPick(e.shiftKey);
      }}
    >
      <I name="check" size={12} />
    </button>
  );
}
