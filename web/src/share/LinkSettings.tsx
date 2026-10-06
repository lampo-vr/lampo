// A link's settings as one framed list, for a new link and for one being changed (ShareModal.tsx): a row per setting,
// its name on the left and its control on the right — a switch, the downloads menu, the expiry date's picker, the
// password's field. Every row keeps one height and nothing opens under a row, so nothing moves while settings change:
// the date's choices (1, 7, 30 days, any day) open over the page from its button, the password sits in its own row.
import { lazy, type RefObject, Suspense, useId, useState } from 'react';
import { t } from '../i18n/index.ts';
import { usePhone } from '../lib/media.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Switch } from '../ui/plain.tsx';
import { Menu, Modal, Popover } from '../ui/primitives.tsx';
import { IconButton } from '../ui/tip.tsx';
import { daysUntil, inDays, relDays, shortDay, ymd } from './dates.ts';
import { type Draft, passwordProblem } from './draft.ts';
import { generatePassword } from './password.ts';

const ExpiryCalendar = lazy(() => import('./ExpiryCalendar.tsx'));
const QUICK = [1, 7, 30];

const DOWNLOADS = () => [
  { value: 'off', label: t('Off') },
  { value: 'preview', label: t('Preview') },
  { value: 'original', label: t('Original') },
];

function Row({
  label,
  htmlFor,
  disabled,
  say,
  testId,
  children,
}: {
  label: string;
  htmlFor?: string;
  disabled?: boolean;
  /** What is wrong with the row's value, said on its own line's end (the password too short). */
  say?: string | null;
  testId?: string;
  children: React.ReactNode;
}) {
  const name = (
    <>
      {label}
      {say && (
        <span className="link-set-say" aria-live="polite">
          {say}
        </span>
      )}
    </>
  );
  return (
    <div className="link-set-row" data-disabled={disabled ? '' : undefined} data-testid={testId}>
      {htmlFor ? (
        <label className="link-set-label" htmlFor={htmlFor}>
          {name}
        </label>
      ) : (
        <span className="link-set-label">{name}</span>
      )}
      {children}
    </div>
  );
}

/** The expiry day as a button saying it; the choices open from it: 1, 7 or 30 days, or any day on the calendar. */
function ExpiryPicker({ value, onChange }: { value: string; onChange: (day: string) => void }) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const pick = (day: string) => {
    onChange(day);
    setOpen(false);
  };
  const choices = (
    <div className="link-date" data-testid="link-date-choices">
      <div className="link-date-quick">
        {QUICK.map((n) => {
          const day = ymd(inDays(n));
          return (
            <button key={n} type="button" className={`btn sm ${value === day ? 'on' : ''}`} aria-pressed={value === day} onClick={() => pick(day)}>
              {n === 1 ? t('1 day') : t('{n} days', { n })}
            </button>
          );
        })}
      </div>
      <Suspense
        fallback={
          <div className="expiry-loading">
            <Spinner />
          </div>
        }
      >
        <ExpiryCalendar value={value} onPick={pick} />
      </Suspense>
    </div>
  );
  const said = (
    <>
      {shortDay(value)} <span className="link-date-rel">· {relDays(daysUntil(value))}</span>
      <I name="down" size={12} />
    </>
  );
  if (phone)
    return (
      <>
        <button type="button" className="btn sm ghost link-date-btn" data-testid="link-date" onClick={() => setOpen(true)}>
          {said}
        </button>
        {open && (
          <Modal title={t('Expiry date')} onClose={() => setOpen(false)}>
            <div className="expiry-sheet">{choices}</div>
          </Modal>
        )}
      </>
    );
  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      // the focus goes to the chosen day (the calendar's arrow keys work at once), not the first quick choice; the quick
      // choices are a Shift+Tab away. Loading the calendar the first time, it takes the focus itself when it's there.
      onOpenAutoFocus={(e) => {
        e.preventDefault();
        const root = e.currentTarget as HTMLElement;
        requestAnimationFrame(() => root.querySelector<HTMLElement>('.rdp-selected button, .rdp-day button[tabindex="0"]')?.focus());
      }}
      className="expiry-pop"
      trigger={
        <button type="button" className="btn sm ghost link-date-btn" data-testid="link-date">
          {said}
        </button>
      }
    >
      {choices}
    </Popover>
  );
}

export function LinkSettings({
  d,
  set,
  editing,
  hasPassword,
  checked = false,
  passwordRef,
}: {
  d: Draft;
  set: (p: Partial<Draft>) => void;
  /** An existing link: its password, if it has one, can't be shown again (the server keeps it scrambled). */
  editing: boolean;
  hasPassword: boolean;
  /** A create or save was tried: a password that can't go with the link says why on its row. */
  checked?: boolean;
  passwordRef?: RefObject<HTMLInputElement | null>;
}) {
  const id = useId();
  // left once with something typed: a short password says so then, not with every key
  const [left, setLeft] = useState(false);
  const watch = d.access === 'watch';
  const kept = editing && hasPassword && d.passwordAction === 'keep';
  const passwordOn = d.passwordAction === 'set' || kept;
  const problem = passwordProblem(d);
  const bad = !!problem && (checked || (left && !!d.password));
  const download = DOWNLOADS().find((o) => o.value === d.download)?.label ?? '';
  return (
    <div className="link-set" data-testid="link-details">
      <Row label={t('Leave notes')} htmlFor={`${id}n`}>
        <Switch id={`${id}n`} label={t('Leave notes')} checked={!watch} onCheckedChange={(on) => set({ access: on ? 'review' : 'watch' })} />
      </Row>
      <Row label={t('Approve or request changes')} htmlFor={`${id}a`} disabled={watch}>
        <Switch
          id={`${id}a`}
          label={t('Approve or request changes')}
          checked={d.access === 'review'}
          disabled={watch}
          onCheckedChange={(on) => set({ access: on ? 'review' : 'comment' })}
        />
      </Row>
      <Row label={t('See notes from other links')} htmlFor={`${id}o`} disabled={watch}>
        <Switch
          id={`${id}o`}
          label={t('See notes from other links')}
          checked={!watch && d.notes === 'all'}
          disabled={watch}
          onCheckedChange={(on) => set({ notes: on ? 'all' : 'own' })}
        />
      </Row>
      <Row label={t('All versions, to switch and compare')} htmlFor={`${id}v`}>
        <Switch
          id={`${id}v`}
          label={t('All versions, to switch and compare')}
          checked={d.versions === 'all'}
          onCheckedChange={(on) => set({ versions: on ? 'all' : 'latest' })}
        />
      </Row>
      <Row label={t('Downloads')}>
        <Menu
          align="end"
          trigger={
            <button type="button" className="btn sm ghost link-set-menu" aria-label={`${t('Downloads')}: ${download}`}>
              {download}
              <I name="down" size={12} />
            </button>
          }
          items={[
            { heading: t('Downloads') },
            ...DOWNLOADS().map((o) => ({
              label: o.label,
              icon: o.value === d.download ? ('check' as const) : undefined,
              onClick: () => set({ download: o.value as Draft['download'] }),
            })),
          ]}
        />
      </Row>
      <Row label={t('Expiry date')} htmlFor={`${id}e`} testId="link-expiry">
        {d.expires && <ExpiryPicker value={d.expires} onChange={(expires) => set({ expires })} />}
        {/* on: a week to start with; its button says the day and changes it */}
        <Switch id={`${id}e`} label={t('Expiry date')} checked={!!d.expires} onCheckedChange={(on) => set({ expires: on ? ymd(inDays(7)) : '' })} />
      </Row>
      <Row label={t('Password')} htmlFor={`${id}p`} say={bad ? problem : null} testId="link-password">
        {kept ? (
          <>
            <span className="link-set-value">{t('Set')}</span>
            <button type="button" className="btn sm ghost" onClick={() => set({ passwordAction: 'set', password: generatePassword() })}>
              {t('Change')}
            </button>
          </>
        ) : (
          passwordOn && (
            <span className={`link-pass ${bad ? 'bad' : ''}`}>
              <input
                ref={passwordRef}
                className="input link-pass-in"
                aria-label={t('Password')}
                aria-invalid={bad || undefined}
                autoComplete="off"
                autoCapitalize="none"
                spellCheck={false}
                // a password for visitors, not this person's own: password managers stay out of it
                data-1p-ignore=""
                data-lpignore="true"
                value={d.password}
                onChange={(e) => set({ password: e.target.value, passwordAction: 'set' })}
                onBlur={() => setLeft(true)}
              />
              <IconButton
                className="btn sm ghost icon-only"
                label={t('Generate a password')}
                icon="refresh"
                size={14}
                onClick={() => set({ password: generatePassword(), passwordAction: 'set' })}
              />
            </span>
          )
        )}
        {/* on: a password made up at once (readable, in the clear: it is sent to people); off: none, or removed on save */}
        <Switch
          id={`${id}p`}
          label={t('Password')}
          checked={passwordOn}
          onCheckedChange={(on) => {
            setLeft(false);
            set(on ? { passwordAction: 'set', password: generatePassword() } : { passwordAction: editing && hasPassword ? 'remove' : 'keep', password: '' });
          }}
        />
      </Row>
    </div>
  );
}
