// Settings → Files: the House's files, the fonts, logos and music every project uses and inherits (a project's or a
// folder's own sit beside its videos). The same page as a folder's Files tab (files/FilesPage.tsx), loaded when opened.
import { Suspense } from 'react';
import { t } from '../i18n/index.ts';
import { loader, screen } from '../lib/lazy.ts';

const FilesPage = screen(loader(() => import('../files/FilesPage.tsx')));

export function HouseFiles() {
  return (
    <>
      <header className="set-head">
        <h1>{t('Files')}</h1>
        <p>{t('The House’s files: the fonts, logos and music every project uses. Every project and folder inherits them.')}</p>
      </header>
      <Suspense fallback={null}>
        <FilesPage area="" />
      </Suspense>
    </>
  );
}
