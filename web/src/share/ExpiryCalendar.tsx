// The month grid behind "Date…" in a link's expiry: react-day-picker for the keyboard and screen-reader behaviour,
// our tokens for the look (date-picker.css; the library's own stylesheet is not loaded). Loaded on first open.
import { DayPicker } from 'react-day-picker';
import '../styles/date-picker.css';
import { t } from '../i18n/index.ts';
import { dayOf, inDays, lang, weekStart, ymd } from './dates.ts';

export default function ExpiryCalendar({ value, onPick }: { value: string; onPick: (day: string) => void }) {
  const l = lang();
  const first = inDays(1);
  const selected = value ? dayOf(value) : undefined;
  return (
    <DayPicker
      mode="single"
      selected={selected}
      onSelect={(d) => d && onPick(ymd(d))}
      defaultMonth={selected && selected > first ? selected : first}
      startMonth={first}
      disabled={{ before: first }}
      weekStartsOn={weekStart()}
      showOutsideDays
      autoFocus
      lang={l}
      formatters={{
        formatCaption: (m) => m.toLocaleDateString(l, { month: 'long', year: 'numeric' }),
        formatWeekdayName: (d) => d.toLocaleDateString(l, { weekday: 'narrow' }),
      }}
      labels={{
        labelDayButton: (d, m) =>
          [
            d.toLocaleDateString(l, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }),
            m.today ? t('today') : '',
            m.selected ? t('selected') : '',
          ]
            .filter(Boolean)
            .join(', '),
        labelGrid: (d) => d.toLocaleDateString(l, { month: 'long', year: 'numeric' }),
        labelNext: () => t('Next month'),
        labelPrevious: () => t('Previous month'),
      }}
    />
  );
}
