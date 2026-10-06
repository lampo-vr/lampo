// Theme and language, in one place (the account menu keeps a quick theme row). Chosen here, they apply to this browser
// at once and are kept on the account, so the person's other devices follow (AuthGate adopts them there).
import { t } from '../i18n/index.ts';
import { LangSwitch } from '../ui/LangSwitch.tsx';
import { ThemeSwitch } from '../ui/ThemeSwitch.tsx';
import { Card } from './parts.tsx';

export function Appearance() {
  return (
    <>
      <header className="set-head">
        <h1>{t('Appearance')}</h1>
        <p>{t('How the app looks and which language it speaks. Saved on your account, so your other devices follow.')}</p>
      </header>
      <Card title={t('Theme')} lede={t('Light, dark, or whatever this device is set to.')}>
        <div className="set-theme">
          <ThemeSwitch labels />
        </div>
      </Card>
      <Card title={t('Language')} lede={t('English, or German if you prefer. Notes stay in the language they were written in.')}>
        <div className="set-lang">
          <LangSwitch labels />
        </div>
      </Card>
    </>
  );
}
