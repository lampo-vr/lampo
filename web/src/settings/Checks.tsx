// Auto-check: what it looks at in every new render, and the two things that change it (the text engine and the
// words it should accept). There is nothing to switch here: every check runs, findings are dismissed per render.
import { useInfo } from '../api/queries.ts';
import { perLang, t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { I, type IconName } from '../ui/icons.tsx';
import { Card, Code } from './parts.tsx';

const CHECKS = perLang((): { icon: IconName; title: string; what: string }[] => [
  { icon: 'typo', title: t('Text in the picture'), what: t('Reads burned-in text and checks its spelling, German and English.') },
  { icon: 'safeZone', title: t('Safe zones'), what: t('Text under Instagram’s buttons, caption or top bar.') },
  { icon: 'flash', title: t('Flash frames'), what: t('A single frame that doesn’t belong: a leftover from the edit.') },
  { icon: 'blackFrame', title: t('Black frames'), what: t('Black gaps between shots.') },
  { icon: 'freeze', title: t('Freezes'), what: t('The picture stands still where it should move.') },
  { icon: 'wave', title: t('Loudness and clipping'), what: t('Integrated loudness, true peak and clipped samples.') },
  { icon: 'mute', title: t('Silence'), what: t('Gaps in the sound.') },
]);

export function Checks() {
  const info = useInfo();
  const dictionary = info?.dataDir ? `${info.dataDir}/qa-dictionary.txt` : 'data/qa-dictionary.txt';
  return (
    <>
      <header className="set-head">
        <h1>{t('Auto-check')}</h1>
        <p>{t('Every new version is checked in the background before you watch it. What it finds shows in the player, marked on the timeline.')}</p>
      </header>
      <Card title={t('What it looks at')}>
        <div className="set-rows" data-testid="checks-list">
          {CHECKS().map((c) => (
            <div key={c.icon} className="set-row">
              <I name={c.icon} size={16} className="faint" />
              <div className="grow" style={{ minWidth: 0 }}>
                <b>{c.title}</b>
                <div className="set-sub">{c.what}</div>
              </div>
            </div>
          ))}
        </div>
      </Card>
      <Card title={t('Change it')}>
        <p className="set-hint">
          <T
            k={'Text recognition: <0>VR_OCR</0> is <1>auto</1> (macOS Vision on a Mac, tesseract elsewhere), <2>vision</2>, <3>tesseract</3> or <4>off</4>.'}
            tags={[(c) => <code>{c}</code>, (c) => <code>{c}</code>, (c) => <code>{c}</code>, (c) => <code>{c}</code>, (c) => <code>{c}</code>]}
          />
        </p>
        <Code label={t('Words it should accept (brand names), one per line')}>{dictionary}</Code>
      </Card>
    </>
  );
}
