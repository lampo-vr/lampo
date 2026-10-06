// The entry of an Embed link's player (web/embed.html, served at /e/<token>): an entry of its own, so the page another
// site frames loads none of the app (no sign-in, no library, no service worker, no data kept in the browser) and the
// app's first paint none of it. Its words in English, or German when the code asks for it (?lang=de).
import '@fontsource-variable/instrument-sans/standard.css';
import '@fontsource-variable/martian-mono/standard.css';
import '../styles/base.css';
import '../styles/controls.css';
import '../styles/dock.css';
import '../styles/layout.css';
import '../styles/embed.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { loadClientLang } from '../i18n/index.ts';
import { Embed } from './Embed.tsx';
import { embedOptions, tokenFromPath } from './options.ts';

const options = embedOptions(location.search);
void loadClientLang(options.lang)
  .catch(() => loadClientLang('en'))
  .then(() => {
    const root = document.getElementById('root');
    if (!root) throw new Error('#root missing');
    createRoot(root).render(
      <StrictMode>
        <Embed token={tokenFromPath(location.pathname)} options={options} />
      </StrictMode>,
    );
  });
