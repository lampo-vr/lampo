// A new workspace (loaded when first asked for, auth/Workspaces.tsx): one name, and the app starts again inside it —
// empty, with the person as its owner. What it is for, in one sentence: its own videos, people and links. The field and
// the way in are the entrance's (ui/EntryForm.tsx): a press with no name says so instead of a grey button.
import { type FormEvent, useState } from 'react';
import { useCreateWorkspace } from '../api/workspaces.ts';
import { t } from '../i18n/index.ts';
import { EntryField, ErrorLine, GoButton, useMisses } from '../ui/EntryForm.tsx';
import { Modal } from '../ui/primitives.tsx';

export function NewWorkspaceDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateWorkspace();
  const [name, setName] = useState('');
  const tries = useMisses();
  const submit = async (e?: FormEvent) => {
    e?.preventDefault();
    if (create.isPending) return;
    if (!name.trim()) return tries.miss(t('Type a name first.'), 'workspace');
    tries.clear();
    try {
      await create.mutateAsync(name.trim());
    } catch (err) {
      tries.miss((err as Error).message, 'workspace');
    }
  };
  return (
    <Modal title={t('New workspace')} onClose={onClose} width={440}>
      <form className="ws-new inv-form" onSubmit={submit} noValidate>
        <p className="ws-new-lede">
          {t('A workspace has its own videos, people and review links. You’re its owner; nobody else sees it until you invite them.')}
        </p>
        <EntryField
          label={t('Name')}
          name="workspace"
          value={name}
          maxLength={80}
          autoFocus
          placeholder={t('Studio or brand name')}
          bad={!!tries.error}
          shake={tries.shakeOf('workspace')}
          onChange={(e) => {
            setName(e.target.value);
            tries.clear();
          }}
          data-testid="workspace-name"
        />
        <ErrorLine>{tries.error}</ErrorLine>
        <GoButton busy={create.isPending} disabled={create.isPending} data-testid="workspace-create">
          {t('Create workspace')}
        </GoButton>
      </form>
    </Modal>
  );
}
