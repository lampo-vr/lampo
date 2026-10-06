// The light half of the Playbook view, in the library's own chunk: the words other screens borrow (the inbox names a
// suggestion), what a link asks the page for, and the page's loading layout. The page itself (PlaybookPage.tsx: the
// document, what agents read, the history) loads when a playbook is first opened; until then this shell stands in
// with the same boxes — the line of what it inherits, the document's four sections, the pane beside — so nothing moves.
import { t } from '../i18n/index.ts';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { SkeletonRegion, SkeletonText, SkLine } from '../ui/Skeleton.tsx';
import '../styles/playbook.css';

/** What a link opens the page on: the suggestions (the inbox's "Open the playbook") or the history. */
export type Focus = 'playbook' | 'suggestions' | 'history';

export const tabFromHash = (): Focus => {
  const m = /[?&]tab=([a-z]+)/.exec(location.hash);
  return m?.[1] === 'suggestions' || m?.[1] === 'history' ? m[1] : 'playbook';
};

/** The suggestion a link names (the inbox's "Open the playbook": `?tab=suggestions&id=pp_…`), or null. */
export const suggestionFromHash = (): string | null => /[?&]id=(pp_[a-f0-9]{12})\b/.exec(location.hash)?.[1] ?? null;

/** What a suggestion changes, in words: "the rules", "the skill export-reels". */
export function sectionWords(section: string): string {
  if (section === 'brief') return t('the brief');
  if (section === 'rules') return t('the rules');
  return t('the skill {name}', { name: section.replace(/^skill:/, '') });
}

/** The document's sections, in their order. */
export const sectionTitles = () => [t('Brief'), t('Rules'), t('Skills'), t('References')];

/** The whole page while its code or its data is on the way: the meta line, the document's sections, the pane. */
export function PlaybookPending({ scope }: { scope: string }) {
  return (
    <div className="pb" data-testid="playbook" data-scope={scope} aria-busy="true">
      <PlaybookSkeleton />
    </div>
  );
}

/** The page's own boxes with their words waiting: what the page renders until its playbook arrives. */
export function PlaybookSkeleton() {
  return (
    <SkeletonRegion label={t('Loading the playbook')} className="pb-wait">
      <div className="pb-meta">
        <span className="pb-lineage">
          <span className="pb-layer-chip">
            <KeyGlyph shape="outline" size={10} />
            <SkLine w="9em" />
          </span>
        </span>
        <span className="pb-meta-links">
          {/* there whatever the data says, on screens without the pane (CSS): the line keeps its two rows */}
          <span className="pb-meta-link narrow">
            <I name="eye" size={14} />
            {t('What agents read')}
          </span>
        </span>
      </div>
      <div className="pb-layout">
        <div className="panel panel-base pad-lg pb-sheet">
          {sectionTitles().map((title, i) => (
            <section key={title} className="pb-sec">
              <header className="pb-sec-head">
                <KeyGlyph shape="outline" size={12} className="pb-sec-key" />
                <h2 className="pb-sec-title">{title}</h2>
              </header>
              <div className="pb-sec-body">
                <SkeletonText lines={i < 2 ? 3 : 1} w={i < 2 ? '100%' : '60%'} />
              </div>
            </section>
          ))}
        </div>
        <aside className="pb-pane">
          <div className="pb-pane-in">
            <div className="pb-pane-head">
              <h2 className="pb-pane-title">{t('What agents read')}</h2>
              <p className="pb-pane-sub mono">get_playbook · vr playbook</p>
            </div>
            <div className="pb-agent">
              <SkeletonText lines={10} />
            </div>
          </div>
        </aside>
      </div>
    </SkeletonRegion>
  );
}
