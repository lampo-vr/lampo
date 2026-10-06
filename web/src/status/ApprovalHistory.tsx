// Who approved which version, the team or someone through a review link, when, and what they said; plus marking final
// and reopening.
import { compareTime } from '../../../lib/time.ts';
import type { ApprovalEntry, FinalEntry } from '../../../lib/types.ts';
import '../styles/status.css';
import { locale, perLang, t } from '../i18n/index.ts';

const WORD = perLang((): Record<ApprovalEntry['status'], string> => ({ approved: t('Approved'), changes: t('Changes requested'), withdrawn: t('Withdrawn') }));
const name = (by: string) => by.replace(/^guest:/, '').replace(/^agent:/, '');
const when = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleString(locale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

type Row = { at: string; key: string; party: 'team' | 'client' | 'final'; status: string; what: string; v: number; by: string; note: string | null };

export function ApprovalHistory({ approvals, finals = [] }: { approvals: ApprovalEntry[]; finals?: FinalEntry[] }) {
  const word = WORD();
  const rows: Row[] = [
    ...approvals.map((e, i) => ({
      at: e.at,
      key: `a${i}`,
      party: e.party,
      status: e.status,
      what: e.carried_from ? t('{what} V{v} (carried over from V{from})', { what: word[e.status], v: e.v, from: e.carried_from }) : `${word[e.status]} V${e.v}`,
      v: e.v,
      by: e.by,
      note: e.note,
    })),
    ...finals.map((f, i) => ({
      at: f.at,
      key: `f${i}`,
      party: 'final' as const,
      status: f.action,
      what: f.action === 'final' ? t('Final V{v}', { v: f.v }) : t('Reopened V{v}', { v: f.v }),
      v: f.v,
      by: f.by,
      note: f.note,
    })),
  ].sort((a, b) => compareTime(b.at, a.at));
  if (!rows.length) return <p className="st-empty">{t('Nobody has decided yet.')}</p>;
  return (
    <ol className="st-history">
      {rows.map((r) => (
        <li key={r.key} data-status={r.status}>
          <span className={`st-party ${r.party}`}>{r.party === 'final' ? t('Final') : r.party === 'client' ? t('Link') : t('Team')}</span>
          <div className="st-h-main">
            <b>{r.what}</b>
            <span className="muted">
              {name(r.by)} · {when(r.at)}
            </span>
            {r.note && <span className="st-h-note">“{r.note}”</span>}
          </div>
        </li>
      ))}
    </ol>
  );
}
