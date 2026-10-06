// A skill of a playbook, edited in one dialog: its name and when to use it (what an agent reads to decide), the
// instructions in markdown with a preview, the small files that come with it, and a SKILL.md to import or copy. An
// inherited skill opens read-only, with the way to the playbook it lives in.
import { useId, useRef, useState } from 'react';
import { PLAYBOOK_LIMITS, parseSkill, SKILL_NAME, skillMarkdown, skillProblem } from '../../../lib/playbookText.ts';
import type { PlaybookSkill, PlaybookSkillSummary } from '../../../lib/types.ts';
import { playbookHref, skillFileUrl, usePlaybookActions } from '../api/playbooks.ts';
import { t } from '../i18n/index.ts';
import { bytes } from '../lib/format.ts';
import { copyText, toast, toastError } from '../lib/toast.ts';
import { AutoTextarea } from '../ui/controls.tsx';
import { I } from '../ui/icons.tsx';
import { IconButton, Modal, Segmented, useConfirm } from '../ui/primitives.tsx';
import { Button } from '../ui/system.tsx';
import { Markdown } from './Markdown.tsx';

export interface SkillDialogProps {
  scope: string;
  /** The skill with its instructions (own); null: a new one. */
  skill: PlaybookSkill | null;
  /** Inherited from another playbook: shown, not edited here. */
  inherited?: (PlaybookSkillSummary & { from: string; body?: string }) | null;
  base_rev: number;
  canEdit: boolean;
  onClose: () => void;
}

export function SkillDialog({ scope, skill, inherited, base_rev, canEdit, onClose }: SkillDialogProps) {
  const act = usePlaybookActions(scope);
  const [name, setName] = useState(skill?.name || '');
  const [description, setDescription] = useState(skill?.description || '');
  const [body, setBody] = useState(skill?.body || '');
  const [extra, setExtra] = useState(skill?.extra);
  const [tab, setTab] = useState<'write' | 'preview'>(skill?.body ? 'preview' : 'write');
  const [busy, setBusy] = useState(false);
  const [ask, confirmation] = useConfirm();
  const importer = useRef<HTMLInputElement>(null);
  const adder = useRef<HTMLInputElement>(null);
  const ids = { name: useId(), desc: useId() };
  const readOnly = !canEdit || !!inherited;
  const problem = name || description ? skillProblem({ name, description, body }) : null;

  const save = async () => {
    const p = skillProblem({ name, description, body });
    if (p) return toast(p, 'error');
    setBusy(true);
    try {
      await act.putSkill({ name, description, body, extra, rename_from: skill && skill.name !== name ? skill.name : undefined, base_rev });
      toast(skill ? t('Saved — agents read the new version') : t('Added — agents see it from now on'), 'ok');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!skill) return;
    const yes = await ask({
      title: t('Delete the skill “{name}”?', { name: skill.name }),
      body: t('Agents stop seeing it, and its files go with it. The history keeps what it said.'),
      action: t('Delete skill'),
      danger: true,
    });
    if (!yes) return;
    try {
      await act.deleteSkill(skill.name);
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  const importFile = async (f: File) => {
    try {
      const s = parseSkill(await f.text());
      setName(s.name);
      setDescription(s.description);
      setBody(s.body);
      setExtra(s.extra);
      setTab('preview');
    } catch (e) {
      toastError(e);
    }
  };
  const addFile = async (f: File) => {
    if (!skill) return;
    if (f.size > PLAYBOOK_LIMITS.fileBytes) return toast(t('A skill’s file may be at most {mb} MB', { mb: PLAYBOOK_LIMITS.fileBytes / 1024 / 1024 }), 'error');
    try {
      await act.addFile(skill.name, f);
      toast(t('{file} added', { file: f.name }), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const files = inherited?.files || skill?.files || [];
  const shownName = inherited?.name || name;

  return (
    <Modal
      title={inherited ? inherited.name : skill ? t('Skill') : t('New skill')}
      onClose={onClose}
      width={720}
      head={
        !readOnly && (
          <Button variant="ghost" size="sm" icon="upload" onClick={() => importer.current?.click()}>
            {t('Import SKILL.md')}
          </Button>
        )
      }
      foot={
        readOnly ? (
          <>
            {inherited && (
              <a className="btn" href={playbookHref(inherited.from)} onClick={onClose}>
                {t('Open the playbook it comes from')}
              </a>
            )}
            <button type="button" className="btn primary" onClick={onClose}>
              {t('Done')}
            </button>
          </>
        ) : (
          <>
            {skill && (
              <Button variant="ghost" icon="trash" className="pb-skill-delete" onClick={() => void remove()}>
                {t('Delete')}
              </Button>
            )}
            <span className="grow" />
            <Button
              variant="ghost"
              icon="copy"
              onClick={() =>
                void copyText(skillMarkdown({ name, description, body, extra })).then((ok) =>
                  toast(ok ? t('SKILL.md copied') : t('Could not copy'), ok ? 'ok' : 'error'),
                )
              }
            >
              {t('Copy SKILL.md')}
            </Button>
            <button type="button" className="btn" onClick={onClose}>
              {t('Cancel')}
            </button>
            <button
              type="button"
              className="btn primary"
              onClick={() => void save()}
              disabled={busy || !!skillProblem({ name, description, body })}
              data-testid="pb-skill-save"
            >
              {skill ? t('Save') : t('Add skill')}
            </button>
          </>
        )
      }
    >
      <input
        ref={importer}
        type="file"
        accept=".md,text/markdown,text/plain"
        hidden
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void importFile(f);
        }}
      />
      <div className="pb-skill" data-testid="pb-skill-dialog">
        {inherited ? (
          <p className="pb-skill-from">
            <I name="playbook" size={14} /> {t('From the {name} playbook — change it there.', { name: inherited.from || t('House') })}
          </p>
        ) : null}
        <div className="pb-skill-fields">
          <label htmlFor={ids.name}>{t('Name')}</label>
          <input
            id={ids.name}
            className="input mono"
            value={shownName}
            readOnly={readOnly}
            onChange={(e) => setName(e.target.value.toLowerCase().replace(/[\s_]+/g, '-'))}
            placeholder="export-reels"
            maxLength={PLAYBOOK_LIMITS.skillName}
            spellCheck={false}
            data-testid="pb-skill-name"
          />
          <label htmlFor={ids.desc}>{t('When to use it')}</label>
          <input
            id={ids.desc}
            className="input"
            value={inherited?.description ?? description}
            readOnly={readOnly}
            onChange={(e) => setDescription(e.target.value)}
            placeholder={t('What it does and when an agent should use it')}
            maxLength={PLAYBOOK_LIMITS.skillDescription}
            data-testid="pb-skill-desc"
          />
        </div>
        {name && !SKILL_NAME.test(name) && !readOnly && <p className="pb-skill-problem">{t('Lowercase letters, digits and hyphens, like export-reels')}</p>}
        {problem && SKILL_NAME.test(name) && description && !readOnly && <p className="pb-skill-problem">{problem}</p>}
        <div className="pb-skill-body">
          {!readOnly && (
            <Segmented
              label={t('Instructions')}
              value={tab}
              onChange={(v) => setTab(v as 'write' | 'preview')}
              options={[
                { value: 'write', label: t('Write') },
                { value: 'preview', label: t('Preview') },
              ]}
            />
          )}
          {readOnly || tab === 'preview' ? (
            <div className="pb-skill-preview">
              {(inherited?.body ?? body).trim() ? <Markdown text={inherited?.body ?? body} /> : <p className="muted">{t('No instructions yet.')}</p>}
            </div>
          ) : (
            <AutoTextarea
              className="textarea pb-textarea"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onSubmit={() => void save()}
              placeholder={t('Step by step, the way you’d explain it to a new editor: settings, order, what to check before rendering.')}
              aria-label={t('Instructions')}
              rows={10}
              data-testid="pb-skill-body"
            />
          )}
        </div>
        <div className="pb-skill-files">
          <div className="pb-skill-files-h">
            <b>{t('Files')}</b>
            <span className="muted">{t('Presets, LUTs, scripts — agents download them; nothing runs here.')}</span>
            {!readOnly && skill && (
              <Button variant="ghost" size="sm" icon="attach" onClick={() => adder.current?.click()} data-testid="pb-skill-add-file">
                {t('Add file')}
              </Button>
            )}
          </div>
          <input
            ref={adder}
            type="file"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void addFile(f);
            }}
            data-testid="pb-skill-file-input"
          />
          {files.length ? (
            <ul>
              {files.map((f) => (
                <li key={f.name}>
                  <I name="attach" size={14} />
                  <a href={skillFileUrl(inherited?.from ?? scope, shownName, f.name)} download={f.name} className="mono">
                    {f.name}
                  </a>
                  <span className="muted">{bytes(f.size)}</span>
                  {!readOnly && skill && (
                    <IconButton
                      className="btn ghost sm icon-only"
                      label={t('Remove {file}', { file: f.name })}
                      icon="x"
                      size={14}
                      onClick={() => void act.removeFile(skill.name, f.name).catch(toastError)}
                    />
                  )}
                </li>
              ))}
            </ul>
          ) : (
            <p className="muted pb-skill-nofiles">{skill || readOnly ? t('No files.') : t('Add the skill first, then its files.')}</p>
          )}
        </div>
      </div>
      {confirmation}
    </Modal>
  );
}
