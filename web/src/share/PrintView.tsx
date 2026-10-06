// #/print/<slug>: a light, paper-friendly sheet of all notes with their marked frames (Print / Save as PDF).
import { useEffect } from 'react';
import { noteKind } from '../../../lib/time.ts';
import { enc } from '../api/client.ts';
import { useReview } from '../api/queries.ts';
import type { Status } from '../api/types.ts';
import { locale, t } from '../i18n/index.ts';
import { severityLabel, tagLabel } from '../i18n/terms.ts';
import { fileName } from '../lib/format.ts';
import { crumbs } from '../lib/nav.ts';
import { I } from '../ui/icons.tsx';

/** A note's status in the printout. */
const statusLabel = (s: string): string => ({ open: t('Open'), fixed: t('Fixed'), verified: t('Checked'), wontfix: t('Won’t fix') })[s] ?? s;

// Questions and infos from agents carry a placeholder severity; print what the note is. `look` is the stored value (the
// class that colours it), `label` the word in the UI's language.
const look = (c: Parameters<typeof noteKind>[0] & { severity: string }) => {
  const kind = noteKind(c);
  return kind === 'feedback' ? c.severity : kind === 'agent' ? 'question' : kind;
};
const label = (value: string) => (value === 'question' ? t('Question') : value === 'info' ? t('Info') : severityLabel(value));

const ORDER: Record<Status, number> = { open: 0, fixed: 1, verified: 2, wontfix: 3 };

export default function PrintView({ slug }: { slug: string }) {
  const { data: d, error } = useReview(slug);
  useEffect(() => {
    document.body.classList.add('printing');
    return () => document.body.classList.remove('printing');
  }, []);
  if (!d) return <div className="stage-msg">{error ? error.message : t('client::Loading…')}</div>;
  const r = d.review;
  const latest = r.versions[r.versions.length - 1];
  const notes = [...r.comments].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.t - b.t);
  const n = d.summary.counts;
  return (
    <div className="sheet">
      <div className="sheet-actions">
        <button type="button" className="btn primary" onClick={() => window.print()}>
          <I name="copy" size={15} /> {t('client::Print / Save as PDF')}
        </button>
      </div>
      <header>
        <div className="sheet-eyebrow">{t('client::Review notes · {x}', { x: new Date().toLocaleDateString(locale()) })}</div>
        <h1>{fileName(r.video)}</h1>
        <div className="sheet-meta">
          {r.folder ? crumbs(r.folder) : r.project}{' '}
          {t('client::· V{v} · {width}×{height} · {fps} fps · {duration}s', {
            v: latest.v,
            width: r.width,
            height: r.height,
            fps: r.fps,
            duration: r.duration,
          })}
        </div>
        <div className="sheet-meta">
          {t("client::{open} open · {fixed} fixed · {verified} checked · {wontfix} won't fix", {
            open: n.open,
            fixed: n.fixed,
            verified: n.verified,
            wontfix: n.wontfix,
          })}
          {r.approval
            ? ` · ${r.approval.status === 'approved' ? t('client::APPROVED V{v} by {by}', { v: r.approval.v, by: r.approval.by }) : t('client::CHANGES REQUESTED V{v} by {by}', { v: r.approval.v, by: r.approval.by })}`
            : ''}
        </div>
      </header>
      {notes.map((c) => (
        <article key={c.id} className="sheet-note">
          {c.shots?.marked && <img src={`/data/${enc(slug)}/${c.shots.marked}`} alt="" />}
          <div>
            <div className="sheet-line">
              <b>{c.timecode}</b> {t('client::· frame {frame} · V{v} ·', { frame: c.frame, v: c.v })} <span className={`sev ${look(c)}`}>{label(look(c))}</span>{' '}
              · {statusLabel(c.status)}
              {c.tags?.length ? ` · ${c.tags.map(tagLabel).join(', ')}` : ''}
            </div>
            <p>{c.text || t('client::(marked frame)')}</p>
            {c.replies?.map((x) => (
              <div key={`${x.by}:${x.at}`} className="sheet-reply">
                {x.by}
                {x.status ? ` [${statusLabel(x.status)}${x.fixed_in_v ? ` V${x.fixed_in_v}` : ''}]` : ''}: {x.text || '—'}
              </div>
            ))}
            <div className="sheet-id">{c.id}</div>
          </div>
        </article>
      ))}
    </div>
  );
}
