// The answers an agent offers with its question (Comment.choices): one click sends one as the answer — the same answer
// as typing it, so the agent reads it like any other. Plain text on quiet buttons; the field under them stays for
// anything else.
import { t } from '../i18n/index.ts';

export function Choices({ choices, name, onPick, busy = false }: { choices: string[]; name: string; onPick: (answer: string) => void; busy?: boolean }) {
  return (
    <fieldset className="choices" aria-label={t('Answers {name} offers', { name })} data-testid="choices">
      {choices.map((c) => (
        <button key={c} type="button" className="btn sm choice" onClick={() => onPick(c)} disabled={busy}>
          {c}
        </button>
      ))}
    </fieldset>
  );
}
