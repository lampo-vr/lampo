// The library's one row of controls: search this view as you type, the Filter button (chips by stage, agent, project, …), the
// where-it-stands quick views with counts, the layout, and a Display panel for grouping, order and archived videos.
// ⌘K (the palette) searches everything, notes included. On a phone the row is the field and two square buttons, the
// quick views scroll under it, and the layout moves into Display (four icons don't fit beside a thumb-sized field).
import { type ReactNode, type RefObject, useState } from 'react';
import { LANES } from '../../../lib/stage.ts';
import { perLang, t } from '../i18n/index.ts';
import { useCarriedFocus, useScrollEdges } from '../lib/hooks.ts';
import { usePhone } from '../lib/media.ts';
import { laneLabel } from '../status/stageText.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { Switch } from '../ui/plain.tsx';
import { IconButton, Popover, Segmented, Tip } from '../ui/primitives.tsx';
import type { GroupBy, LaneFilter, Layout, SortBy } from './model.ts';

const LAYOUT_OPTIONS = perLang((): { value: Layout; label: string; icon: IconName; shortcut: string }[] => [
  { value: 'grid', label: t('Grid'), icon: 'grid', shortcut: '1' },
  { value: 'compact', label: t('Compact'), icon: 'compact', shortcut: '2' },
  { value: 'list', label: t('List'), icon: 'list', shortcut: '3' },
  { value: 'board', label: t('Board'), icon: 'board', shortcut: '4' },
]);

interface ToolbarProps {
  filterRef: RefObject<HTMLInputElement | null>;
  q: string;
  onQ: (q: string) => void;
  lane: LaneFilter;
  onLane: (l: LaneFilter) => void;
  /** null: the library is still loading (the chips show a placeholder for their numbers). */
  counts: Record<LaneFilter, number> | null;
  layout: Layout;
  onLayout: (l: Layout) => void;
  group: GroupBy;
  onGroup: (g: GroupBy) => void;
  sort: SortBy;
  onSort: (s: SortBy) => void;
  /** The Filter button (Filters.tsx), after the text filter. */
  filter?: ReactNode;
  archived: boolean;
  archivedCount: number;
  onArchived: (on: boolean) => void;
}

export function Toolbar(p: ToolbarProps) {
  const [display, setDisplay] = useState(false);
  const [lanesRef, lanesEdges] = useScrollEdges<HTMLDivElement>();
  const phone = usePhone();
  useCarriedFocus(p.filterRef, 'library-filter');
  return (
    <div className="lib-toolbar" role="toolbar" aria-label={t('Library view')}>
      <label className="lib-filter">
        <I name="search" size={15} />
        <input
          ref={p.filterRef}
          className="input"
          placeholder={t('Search this view')}
          aria-label={t('Search this view by name, project or agent')}
          value={p.q}
          onChange={(e) => p.onQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape' && p.q) {
              e.stopPropagation();
              p.onQ('');
            }
          }}
        />
        {p.q ? (
          <IconButton className="lib-filter-clear" label={t('Clear the filter')} shortcut="Esc" icon="x" size={13} onClick={() => p.onQ('')} />
        ) : (
          <kbd className="kbd">/</kbd>
        )}
      </label>
      {p.filter}
      <div className={`lib-lanes ${lanesEdges}`} ref={lanesRef}>
        <Segmented
          label={t('Where it stands')}
          className="chips"
          value={p.lane}
          onChange={(l) => p.onLane(l as LaneFilter)}
          options={[
            { value: 'all', label: t('All'), count: p.counts ? p.counts.all : null },
            ...LANES.map((l) => ({ value: l.id, label: laneLabel(l.id), count: p.counts ? p.counts[l.id] : null })),
          ]}
        />
      </div>
      <span className="grow" />
      {!phone && <Segmented label={t('Layout')} iconOnly value={p.layout} onChange={(l) => p.onLayout(l as Layout)} options={LAYOUT_OPTIONS()} />}
      <Popover
        open={display}
        onOpenChange={setDisplay}
        className="display-pop"
        trigger={
          <Tip content={t('Grouping, order and archived videos')}>
            <button type="button" className={`btn lib-display ${display ? 'on' : ''}`} aria-label={t('Display')}>
              <I name="display" size={14} /> <span className="lib-display-label">{t('Display')}</span>
            </button>
          </Tip>
        }
      >
        <div className="dp">
          {phone && (
            <div className="dp-row dp-layout">
              <Segmented
                label={t('Layout')}
                value={p.layout}
                onChange={(l) => p.onLayout(l as Layout)}
                options={LAYOUT_OPTIONS().map((o) => ({ value: o.value, label: o.label, icon: o.icon }))}
              />
            </div>
          )}
          {p.layout !== 'board' && (
            <div className="dp-row">
              <span>{t('Group by')}</span>
              <Segmented
                label={t('Group by')}
                value={p.group}
                onChange={(g) => p.onGroup(g as GroupBy)}
                options={[
                  { value: 'folder', label: t('Project') },
                  { value: 'stage', label: t('Stage') },
                  { value: 'none', label: t('None') },
                ]}
              />
            </div>
          )}
          <div className="dp-row">
            <span>{t('Order')}</span>
            <Segmented
              label={t('Order')}
              value={p.sort}
              onChange={(s) => p.onSort(s as SortBy)}
              options={[
                { value: 'recent', label: t('Recent') },
                { value: 'name', label: t('Name') },
                { value: 'stage', label: t('Stage') },
                { value: 'open', label: t('Open notes') },
              ]}
            />
          </div>
          {p.archivedCount > 0 && (
            <div className="dp-row">
              <label htmlFor="lib-archived">{t('Show archived ({archivedCount})', { archivedCount: p.archivedCount })}</label>
              <Switch id="lib-archived" checked={p.archived} onCheckedChange={p.onArchived} />
            </div>
          )}
        </div>
      </Popover>
    </div>
  );
}
