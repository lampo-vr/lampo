// A group's heading in the grid: its name (a folder opens on click), how many videos, where they stand in one line,
// and a toggle to fold it away. A folder's heading also takes videos dropped on it.

import { t } from '../i18n/index.ts';
import { goView } from '../lib/nav.ts';
import { IconButton } from '../ui/primitives.tsx';
import { useDrop } from './drag.ts';
import { type Section, summaryLine } from './model.ts';

interface Props {
  section: Section;
  collapsed: boolean;
  onToggle: () => void;
  /** Absent: the heading takes no video (an archived project's). */
  onDropVideo?: (slug: string, folder: string) => void;
  /** The heading of the folder that is open (its own videos): no link to itself. */
  current?: boolean;
}

export function SectionHead({ section: s, collapsed, onToggle, onDropVideo, current }: Props) {
  const drop = useDrop((d) => d.video && s.folder && onDropVideo?.(d.video, s.folder));
  return (
    <div className={`shead ${drop.over ? 'drop' : ''}`} {...(s.folder && onDropVideo ? drop.props : {})}>
      <IconButton
        className="shead-toggle"
        label={collapsed ? t('Show {title}', { title: s.title }) : t('Hide {title}', { title: s.title })}
        icon="right"
        size={13}
        aria-expanded={!collapsed}
        onClick={onToggle}
      />
      {s.folder && !current ? (
        <button type="button" className="shead-title" onClick={() => s.folder && goView({ kind: 'folder', id: s.folder })}>
          {s.title}
        </button>
      ) : (
        <span className="shead-title">{s.title}</span>
      )}
      <span className="shead-count">{s.videos.length}</span>
      <span className="shead-sum ellipsis">{summaryLine(s.videos)}</span>
    </div>
  );
}
