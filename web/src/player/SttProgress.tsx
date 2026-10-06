// While a voice note waits for the speech engine: the model downloading (first use, with how far it is) or loading.
import { useSttStatus } from '../api/queries.ts';
import { perLang, t } from '../i18n/index.ts';
import { Progress } from '../ui/controls.tsx';

const WORDS = perLang(
  (): Record<string, string> => ({
    starting: t('Starting speech-to-text…'),
    downloading: t('Downloading the speech model'),
    loading: t('Loading the speech model…'),
  }),
);

export function SttProgress({ active }: { active: boolean }) {
  const stt = useSttStatus(active);
  const words = WORDS();
  if (!active || !stt || !words[stt.state]) return null;
  const pct = stt.state === 'downloading' && stt.progress != null ? Math.round(stt.progress * 100) : null;
  return (
    <div className="stt-progress" data-testid="stt-progress">
      <span className="stt-progress-label">
        {words[stt.state]}
        {pct != null && <b> · {pct}%</b>}
      </span>
      <Progress value={pct} label={words[stt.state]} tone="claude" />
    </div>
  );
}
