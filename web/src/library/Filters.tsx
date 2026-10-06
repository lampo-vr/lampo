// Filter chips, built the way Linear builds them: a Filter button (F) opens a searchable list of what to filter by
// (stage, agent, project, review link, open musts, questions, updated); picking one shows its values with how many videos
// each leaves, several at once; the chosen ones become chips under the toolbar ("Stage is In progress ×") that open
// the same picker again when clicked. The rules themselves live in model.ts.
import { type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from 'react';
import type { Stage } from '../../../lib/types.ts';
import type { VideoSummary } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { stageLabel } from '../status/stageText.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { IconButton, Popover, Tip } from '../ui/primitives.tsx';
import { FILTER_FIELDS, type FilterField, type FilterRule, FLAG_FIELDS, fieldOptions, toggleRule } from './model.ts';

const FIELD: Record<FilterField, { label: () => string; icon: IconName }> = {
  stage: { label: () => t('Stage'), icon: 'board' },
  agent: { label: () => t('Agent'), icon: 'spark' },
  folder: { label: () => t('Project'), icon: 'folder' },
  client: { label: () => t('Review link'), icon: 'link' },
  musts: { label: () => t('Has open musts'), icon: 'flash' },
  questions: { label: () => t('Has questions'), icon: 'help' },
  updated: { label: () => t('Updated'), icon: 'clock' },
};

export function valueLabel(field: FilterField, value: string): string {
  switch (field) {
    case 'stage':
      return stageLabel(value as Stage);
    case 'agent':
      return value === '-' ? t('No agent') : value;
    case 'folder':
      return value === '-' ? t('No project') : value;
    case 'client':
      return (
        {
          none: t('Not shared'),
          shared: t('Shared, not opened'),
          opened: t('Opened'),
          changes: t('Changes requested'),
          approved: t('Approved'),
        }[value] ?? value
      );
    case 'updated':
      return { today: t('Today'), '7d': t('In the last 7 days'), '30d': t('In the last 30 days') }[value] ?? value;
    default:
      return value;
  }
}

export const fieldLabel = (field: FilterField) => FIELD[field].label();

/** "Stage is In progress", "Stage is any of 3", "Has open musts". */
export function chipLabel(r: FilterRule): string {
  if (FLAG_FIELDS.includes(r.field)) return fieldLabel(r.field);
  if (r.values.length === 1) return t('{field} is {value}', { field: fieldLabel(r.field), value: valueLabel(r.field, r.values[0] as string) });
  // two still read as words ("Project is Acme or Initech"); more become a count
  if (r.values.length === 2)
    return t('{field} is {a} or {b}', {
      field: fieldLabel(r.field),
      a: valueLabel(r.field, r.values[0] as string),
      b: valueLabel(r.field, r.values[1] as string),
    });
  return t('{field} is any of {n}', { field: fieldLabel(r.field), n: r.values.length });
}

// Arrow keys walk the options; Enter picks (the button does); typing filters.
function onListKeys(e: KeyboardEvent<HTMLElement>) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
  const root = e.currentTarget.closest('.fl-pick');
  if (!root) return;
  const items = [...root.querySelectorAll<HTMLElement>('[role=option]:not(:disabled)')];
  if (!items.length) return;
  e.preventDefault();
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'ArrowDown' ? (i < 0 ? 0 : Math.min(items.length - 1, i + 1)) : i <= 0 ? -1 : i - 1;
  if (next < 0) root.querySelector<HTMLInputElement>('input')?.focus();
  else items[next]?.focus();
}

interface PickerProps {
  videos: VideoSummary[];
  rules: FilterRule[];
  onRules: (r: FilterRule[]) => void;
  /** A field to open straight at (clicking a chip). */
  field: FilterField | null;
  onField: (f: FilterField | null) => void;
  onDone: () => void;
}

function Picker({ videos, rules, onRules, field, onField, onDone }: PickerProps) {
  const [q, setQ] = useState('');
  const input = useRef<HTMLInputElement>(null);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new step starts with an empty search, focused
  useEffect(() => {
    setQ('');
    input.current?.focus();
  }, [field]);
  const words = q.trim().toLowerCase();
  const hit = (label: string) => !words || label.toLowerCase().includes(words);

  if (!field) {
    const fields = FILTER_FIELDS.filter((f) => hit(fieldLabel(f)));
    return (
      <div className="fl-pick">
        <input
          ref={input}
          className="input fl-search"
          placeholder={t('Filter by…')}
          aria-label={t('Filter by')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onListKeys}
        />
        <div role="listbox" aria-label={t('Filter by')} className="fl-list" onKeyDown={onListKeys}>
          {fields.map((f) => (
            <button
              type="button"
              role="option"
              aria-selected={rules.some((r) => r.field === f)}
              key={f}
              className="fl-opt"
              onClick={() => {
                if (FLAG_FIELDS.includes(f)) {
                  onRules(toggleRule(rules, f));
                  onDone();
                } else onField(f);
              }}
            >
              <I name={FIELD[f].icon} size={15} />
              <span className="grow">{fieldLabel(f)}</span>
              {FLAG_FIELDS.includes(f) ? rules.some((r) => r.field === f) && <I name="check" size={14} /> : <I name="right" size={13} className="faint" />}
            </button>
          ))}
          {!fields.length && <p className="fl-none">{t('No filter by that name')}</p>}
        </div>
      </div>
    );
  }

  const chosen = rules.find((r) => r.field === field)?.values ?? [];
  const options = fieldOptions(videos, field, rules).filter((o) => hit(valueLabel(field, o.value)));
  return (
    <div className="fl-pick">
      <div className="fl-head">
        <IconButton className="btn sm ghost icon-only" label={t('Back to the filters')} icon="back" size={14} onClick={() => onField(null)} />
        <b>{fieldLabel(field)}</b>
      </div>
      <input
        ref={input}
        className="input fl-search"
        placeholder={t('Search {field}…', { field: fieldLabel(field).toLowerCase() })}
        aria-label={t('Search {field}…', { field: fieldLabel(field).toLowerCase() })}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={onListKeys}
      />
      <div role="listbox" aria-multiselectable="true" aria-label={fieldLabel(field)} className="fl-list" onKeyDown={onListKeys}>
        {options.map((o) => {
          const on = chosen.includes(o.value);
          return (
            <button
              type="button"
              role="option"
              aria-selected={on}
              key={o.value}
              className={`fl-opt ${on ? 'on' : ''}`}
              disabled={!on && o.count === 0}
              onClick={() => onRules(toggleRule(rules, field, o.value))}
            >
              <span className={`fl-check ${on ? 'on' : ''}`} aria-hidden="true">
                {on && <I name="check" size={12} />}
              </span>
              <span className="grow">{valueLabel(field, o.value)}</span>
              <span className="fl-count">{o.count}</span>
            </button>
          );
        })}
        {!options.length && <p className="fl-none">{t('Nothing by that name')}</p>}
      </div>
    </div>
  );
}

interface FilterButtonProps {
  videos: VideoSummary[];
  rules: FilterRule[];
  onRules: (r: FilterRule[]) => void;
  open: boolean;
  onOpen: (open: boolean) => void;
  field: FilterField | null;
  onField: (f: FilterField | null) => void;
}

export function FilterButton({ videos, rules, onRules, open, onOpen, field, onField }: FilterButtonProps) {
  return (
    <Popover
      open={open}
      onOpenChange={(o) => {
        onOpen(o);
        if (!o) onField(null);
      }}
      className="fl-pop"
      align="start"
      // Escape goes back a step (values → the list of filters) and closes only from the list
      onEscapeKeyDown={(e) => {
        if (!field) return;
        e.preventDefault();
        onField(null);
      }}
      trigger={
        <Tip content={t('Filter')} shortcut="F">
          {/* the icon until a filter applies; then the word and how many (the search field beside it is the other way to narrow) */}
          <button
            type="button"
            className={`btn lib-filter-btn ${open || rules.length ? 'on' : ''} ${rules.length ? '' : 'icon-only'}`}
            data-testid="filter-button"
            aria-label={t('Filter')}
            data-tip=""
          >
            <I name="filter" size={14} />
            {rules.length > 0 && (
              <>
                <span className="lib-display-label">{t('Filter')}</span>
                <span className="fl-badge">{rules.length}</span>
              </>
            )}
          </button>
        </Tip>
      }
    >
      {/* a new step is a new picker: its search starts empty in its first frame, not one frame later */}
      <Picker key={field ?? ''} videos={videos} rules={rules} onRules={onRules} field={field} onField={onField} onDone={() => onOpen(false)} />
    </Popover>
  );
}

/** The applied filters, one chip each: click to change, × to remove. */
export function FilterChips({
  rules,
  onRules,
  onEdit,
  extra,
}: {
  rules: FilterRule[];
  onRules: (r: FilterRule[]) => void;
  onEdit: (f: FilterField) => void;
  extra?: ReactNode;
}) {
  if (!rules.length) return null;
  return (
    <fieldset className="lib-filters" aria-label={t('Active filters')} data-testid="filter-chips">
      {rules.map((r) => (
        <span className="fl-chip" key={r.field}>
          <Tip content={r.values.length > 1 ? r.values.map((v) => valueLabel(r.field, v)).join(' · ') : t('Change this filter')}>
            <button type="button" className="fl-chip-main" onClick={() => onEdit(r.field)} disabled={FLAG_FIELDS.includes(r.field)}>
              <I name={FIELD[r.field].icon} size={13} /> <span className="fl-chip-text">{chipLabel(r)}</span>
            </button>
          </Tip>
          <button
            type="button"
            className="fl-chip-x"
            aria-label={t('Remove the filter {x}', { x: chipLabel(r) })}
            onClick={() => onRules(rules.filter((x) => x !== r))}
          >
            <I name="x" size={12} />
          </button>
        </span>
      ))}
      <button type="button" className="fl-clear" onClick={() => onRules([])}>
        {t('Clear filters')}
      </button>
      {extra}
    </fieldset>
  );
}
