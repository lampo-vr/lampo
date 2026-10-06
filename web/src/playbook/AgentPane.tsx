// What agents read, shown rather than described: the merged playbook exactly as get_playbook and `vr playbook` hand it
// out, beside the document on a wide screen (a dialog on a narrow one). This playbook's own lines are lit, what it
// inherits quieter; while a section is being written, the pane already shows the text with it (agentText.ts), the
// unsaved lines marked.
import { useId, useMemo } from 'react';
import type { PlaybookView } from '../../../lib/types.ts';
import { t } from '../i18n/index.ts';
import { copyText, toast } from '../lib/toast.ts';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { IconButton, Modal } from '../ui/primitives.tsx';
import { agentLines, type Draft, ownOf, withDrafts } from './agentText.ts';

/** The drafts that change something, in the order a person would save them. */
export const dirtyDrafts = (view: PlaybookView, drafts: Partial<Record<Draft['section'], string>>): Draft[] =>
  (['brief', 'rules'] as const).flatMap((section) => {
    const text = drafts[section];
    return text !== undefined && text !== view.playbook[section] ? [{ section, text }] : [];
  });

/** The text with whose each line is; drafts marked. */
export function AgentText({ view, drafts, boxed }: { view: PlaybookView; drafts: Draft[]; boxed?: boolean }) {
  const lines = useMemo(() => {
    const text = withDrafts(view.markdown, ownOf(view.playbook, drafts), drafts);
    return agentLines(text, view.scope, drafts.length ? view.markdown : undefined);
  }, [view, drafts]);
  return (
    <pre className={`pb-agent ${boxed ? 'boxed' : ''}`} data-testid="pb-agent-md">
      {lines.map((l, i) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: lines of one text, in order
          key={i}
          className={['pb-al', l.level ? `h${l.level}` : '', l.own ? 'own' : '', l.inherited ? 'inh' : '', l.draft ? 'draft' : ''].filter(Boolean).join(' ')}
        >
          {l.text}
          {'\n'}
        </span>
      ))}
    </pre>
  );
}

const copy = (text: string) => void copyText(text).then((ok) => toast(ok ? t('Copied') : t('Could not copy'), ok ? 'ok' : 'error'));

/** The pane beside the document. */
export function AgentPane({ view, drafts }: { view: PlaybookView; drafts: Draft[] }) {
  const id = useId();
  return (
    <section className="pb-pane-in" aria-labelledby={id} data-testid="pb-agent-pane">
      <header className="pb-pane-head">
        <h2 id={id} className="pb-pane-title">
          {t('What agents read')}
        </h2>
        <IconButton className="btn ghost sm icon-only" label={t('Copy')} icon="copy" size={14} onClick={() => copy(view.markdown)} />
        <p className="pb-pane-sub">
          {drafts.length ? (
            <span className="pb-pane-draft">
              <KeyGlyph shape="outline" size={10} />
              {t('With what you’re writing — once you save it')}
            </span>
          ) : (
            <span className="mono">get_playbook · vr playbook</span>
          )}
        </p>
      </header>
      <AgentText view={view} drafts={drafts} />
    </section>
  );
}

/** The same on a narrow screen: a dialog (a sheet on a phone). */
export function AgentDialog({ view, drafts, onClose }: { view: PlaybookView; drafts: Draft[]; onClose: () => void }) {
  return (
    <Modal
      title={t('What agents read')}
      onClose={onClose}
      width={760}
      foot={
        <>
          <span className="pb-agent-hint mono">get_playbook · vr playbook</span>
          <span className="grow" />
          <button type="button" className="btn ghost" onClick={() => copy(view.markdown)}>
            {t('Copy')}
          </button>
          <button type="button" className="btn primary" onClick={onClose}>
            {t('Done')}
          </button>
        </>
      }
    >
      <AgentText view={view} drafts={drafts} boxed />
    </Modal>
  );
}
