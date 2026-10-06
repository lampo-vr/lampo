// The player's sign-off, like a merge button: ONE button for the next step when that step is yours — approve, check
// the fixes, send to the client, mark final, carry an approval over, reopen — always the raised orange (the ✓ says
// "approve"), and "Decide ▾" when nothing is next. Everything else a role may do sits behind its chevron: requesting
// changes, approving anyway, deciding with a note, withdrawing, marking final, the history. Beside it the stage's
// glyph (the five steps in its tooltip); its words only when the button doesn't already say them.
import { useState } from 'react';
import type { FinalEntry, StageInfo } from '../../../lib/types.ts';
import { useCan } from '../api/auth.ts';
import type { ReviewResponse } from '../api/types.ts';
import { t } from '../i18n/index.ts';
import { pct } from '../lib/format.ts';
import { toast, toastError } from '../lib/toast.ts';
import { heldWords, youtubeHeld } from '../publish/held.ts';
import { postShort } from '../publish/words.ts';
import { AutoTextarea } from '../ui/controls.tsx';
import { STAGE_SHAPE } from '../ui/glyphs.ts';
import { I, type IconName } from '../ui/icons.tsx';
import { KeyGlyph, useChanged } from '../ui/KeyGlyph.tsx';
import { Menu, type MenuEntry, Modal, Tip } from '../ui/primitives.tsx';
import { ApprovalHistory } from './ApprovalHistory.tsx';
import { useStageActions } from './api.ts';
import { clientInvolved, StageStepper } from './StageStepper.tsx';
import { stageNote } from './StatusPill.tsx';
import { pillLabel } from './stageUi.ts';
import '../styles/status.css';
import { nextLabel, stageDetail } from './stageText.ts';

/** After the team's approval a review through a link is a choice, not a must: say what can come next. */
const nextLine = (info: StageInfo): string | null =>
  info.stage === 'team_approved'
    ? clientInvolved(info)
      ? t('Next: wait for their decision on the review link, or make it final')
      : t('Next: send it out for review with a review link, or make it final')
    : null;

interface StageControlProps {
  data: ReviewResponse;
  latestV: number;
  /** Opens the share dialog ("Share"). */
  onShare: () => void;
  /** Starts verify mode ("Check the fixes"). */
  onVerify?: () => void;
  /** Opens the publishing composer: after Final, publishing is the next step. */
  onPublish?: () => void;
  /** Phones: only the button, with a short word (the status is the line under the video's name: StageLine). */
  compact?: boolean;
}

/** Phones: where the video stands, as the line under its name — the bar has no room for the words beside the button,
 * and a glyph alone said nothing. */
export function StageLine({ info }: { info: StageInfo }) {
  const popped = useChanged(info.stage);
  return (
    <span className="p-stage" data-stage={info.stage} data-testid="stage-line">
      <KeyGlyph key={info.stage} shape={STAGE_SHAPE[info.stage]} pop={popped} />
      <span className="p-stage-label">{pillLabel(info)}</span>
      {info.published && <Published info={info} />}
    </span>
  );
}

/** A final version's posts beside where it stands: "· YouTube posted · Instagram failed". */
function Published({ info }: { info: StageInfo }) {
  const posts = info.published?.posts ?? [];
  if (!posts.length) return null;
  return (
    <span className="so-pub" data-testid="stage-published">
      {posts.map((p) => (
        <span key={p.id} className={`so-pub-one s-${p.state}`} data-platform={p.platform} data-state={p.state}>
          {' · '}
          {postShort(p.platform, p.state)}
        </span>
      ))}
    </span>
  );
}

interface Primary {
  kind: 'approve' | 'carry' | 'verify' | 'send' | 'finalize' | 'reopen' | 'publish';
  label: string;
  /** The word on a phone. */
  short: string;
  icon: IconName;
  onClick: () => void;
}

export function StageControl({ data, latestV, onShare, onVerify, onPublish, compact = false }: StageControlProps) {
  const info: StageInfo = data.summary.stage;
  const allowed = useCan();
  const act = useStageActions(data.slug);
  const [noteFor, setNoteFor] = useState(false);
  const [note, setNote] = useState('');
  const [history, setHistory] = useState(false);
  const [confirmFinal, setConfirmFinal] = useState(false);
  // a YouTube schedule outlives a reopen (publish/held.ts): asked first, only then
  const [confirmReopen, setConfirmReopen] = useState(false);
  const busy = act.verdict.isPending || act.final.isPending || act.reopen.isPending || act.carry.isPending;
  const final = info.stage === 'final';
  // The stage glyph pops when the stage changes while the player is open, like a keyframe being set.
  const popped = useChanged(info.stage);

  const run = async (fn: () => Promise<unknown>, done: string) => {
    try {
      await fn();
      toast(done, 'ok');
      setNote('');
      setNoteFor(false);
    } catch (e) {
      toastError(e);
    }
  };
  const verdict = (status: 'approved' | 'changes' | null) =>
    run(
      () => act.verdict.mutateAsync({ status, v: latestV, note: note.trim() || undefined }),
      status === 'approved' ? t('Approved V{v}', { v: latestV }) : status ? t('Changes requested') : t('Your decision is withdrawn'),
    );
  const markFinal = (confirm = false) => {
    if (info.open && !confirm) return setConfirmFinal(true);
    setConfirmFinal(false);
    return run(() => act.final.mutateAsync({ v: latestV, note: note.trim() || undefined, confirm }), t('V{v} is final', { v: latestV }));
  };
  const reopen = (confirm = false) => {
    if (youtubeHeld(info) && !confirm) return setConfirmReopen(true);
    setConfirmReopen(false);
    return run(() => act.reopen.mutateAsync(note.trim() || undefined), t('Reopened'));
  };
  const carry = () => run(() => act.carry.mutateAsync(), t('Approval carried over to V{v}', { v: latestV }));

  const next = info.next;
  const teamVerdict = info.team;
  const canVerdict = allowed('approve') && !final;
  const decided = (status: 'approved' | 'changes') => teamVerdict?.status === status;

  // The one next step, when it is this person's to take.
  const primary: Primary | null =
    next.kind === 'review' && canVerdict && !decided('approved')
      ? { kind: 'approve', label: t('Approve V{latestV}', { latestV }), short: t('Approve'), icon: 'check', onClick: () => verdict('approved') }
      : next.kind === 'carry' && allowed('approve')
        ? { kind: 'carry', label: nextLabel(next), short: t('Carry over'), icon: 'check', onClick: carry }
        : next.kind === 'verify' && onVerify
          ? { kind: 'verify', label: nextLabel(next), short: t('Check'), icon: 'eye', onClick: onVerify }
          : next.kind === 'send' && allowed('share')
            ? { kind: 'send', label: t('Share V{latestV}', { latestV }), short: t('Share'), icon: 'link', onClick: onShare }
            : next.kind === 'finalize' && allowed('finalize')
              ? { kind: 'finalize', label: t('Mark V{latestV} final', { latestV }), short: t('Final'), icon: 'lock', onClick: () => markFinal() }
              : next.kind === 'reopen' && allowed('finalize')
                ? { kind: 'reopen', label: nextLabel(next), short: t('Reopen'), icon: 'refresh', onClick: () => reopen() }
                : // after Final the next step is publishing it (the UI's; agents read the stage as lib/stage.ts says it)
                  final && next.kind === 'none' && onPublish
                  ? { kind: 'publish', label: t('Publish…'), short: t('Publish'), icon: 'upload', onClick: onPublish }
                  : null;
  // Where the video stands. With a next step the button says it ("Check 2 fixes", "Approve V1"): then the words are
  // for screen readers only, and the glyph (its tooltip holds the steps) stays.
  const status = primary?.kind === 'verify' ? t('{n} fix waiting|{n} fixes waiting', { n: info.to_verify }) : pillLabel(info);

  // What we wait for, when nothing is this person's to do.
  const waiting = !primary
    ? final && next.kind === 'none'
      ? t('Nothing left: V{latestV} is the version that ships', { latestV })
      : next.kind === 'review'
        ? null
        : nextLabel(next)
    : null;

  const items: MenuEntry[] = [
    canVerdict &&
      primary?.kind !== 'approve' &&
      !decided('approved') && {
        label: info.open ? t('Approve V{latestV} anyway', { latestV }) : t('Approve V{latestV}', { latestV }),
        icon: 'check',
        onClick: () => verdict('approved'),
      },
    canVerdict && !decided('changes') && { label: t('Request changes'), icon: 'undo', onClick: () => verdict('changes') },
    canVerdict && { label: t('Decide with a note…'), icon: 'edit', onClick: () => setNoteFor(true) },
    canVerdict && teamVerdict && { label: t('Withdraw your decision'), icon: 'x', onClick: () => verdict(null) },
    'sep',
    allowed('finalize') &&
      !final &&
      primary?.kind !== 'finalize' &&
      (info.stage === 'team_approved' || info.stage === 'with_client' || info.stage === 'client_approved') &&
      // a partial render is a quick check: what ships is rendered in full (the server refuses it too)
      (info.part
        ? { label: t('Final needs a full version: V{latestV} is a part', { latestV }), icon: 'lock', disabled: true, onClick: () => {} }
        : { label: t('Mark V{latestV} final', { latestV }), icon: 'lock', onClick: () => markFinal() }),
    final &&
      next.kind === 'none' &&
      allowed('finalize') && { label: t('Reopen, if something must change after all'), icon: 'refresh', onClick: () => reopen() },
    final && onPublish && primary?.kind !== 'publish' && { label: t('Publish…'), icon: 'upload', onClick: onPublish },
    'sep',
    { label: t('History…'), icon: 'clock', onClick: () => setHistory(true) },
  ];
  const finals: FinalEntry[] = data.review.finals || [];
  const tone = primary ? 'primary' : '';
  // How far the client got through this version, through the review link (the furthest visitor; web/src/guest/watch.ts).
  const share = info.share;
  const watched = share?.watched ?? null;
  const watchedLine =
    share && watched !== null
      ? share.watched_by
        ? t('{name} watched {pct} of V{v} through “{label}”', { name: share.watched_by, pct: pct(watched), v: info.v, label: share.label })
        : t('A visitor watched {pct} of V{v} through “{label}”', { pct: pct(watched), v: info.v, label: share.label })
      : null;

  return (
    <div className={compact ? 'signoff compact' : 'signoff'} data-stage={info.stage}>
      {!compact && (
        <Tip
          side="bottom"
          content={
            <div className="so-tip">
              <StageStepper info={info} />
              <span>{stageDetail(info)}</span>
              {watchedLine && <span>{watchedLine}</span>}
              {nextLine(info) && <span className="so-next">{nextLine(info)}</span>}
            </div>
          }
        >
          {/* biome-ignore lint/a11y/noNoninteractiveTabindex: focusable so keyboard users get the steps in its tooltip */}
          <span className="so-status" tabIndex={0} data-stage={info.stage} data-testid="stage-control">
            <KeyGlyph key={info.stage} shape={STAGE_SHAPE[info.stage]} pop={popped} />
            <span className={primary && primary.kind !== 'publish' ? 'so-label sr-only' : 'so-label'}>{status}</span>
            {info.published && <Published info={info} />}
            {watched !== null && (
              <span className="so-watch" data-testid="stage-watched">
                <I name="eye" size={12} /> {pct(watched)}
              </span>
            )}
            {stageNote(info) && <span className="so-note">{stageNote(info)}</span>}
            {waiting && <span className="so-wait">· {waiting}</span>}
          </span>
        </Tip>
      )}
      <fieldset className="so-split" aria-label={t('Decision')}>
        {primary && (
          <button
            type="button"
            className={`btn sm ${tone} so-main`}
            onClick={primary.onClick}
            disabled={busy}
            data-testid="stage-next"
            data-kind={primary.kind}
            aria-label={compact ? primary.label : undefined}
          >
            <I name={primary.icon} size={14} /> {compact ? primary.short : primary.label}
          </button>
        )}
        <Menu
          sideOffset={6}
          items={items}
          trigger={
            <button
              type="button"
              className={`btn sm ${tone} so-more`}
              aria-label={primary ? t('More decisions') : t('Decide')}
              data-testid="stage-more"
              disabled={busy}
            >
              {!primary && canVerdict && <span>{t('Decide')}</span>}
              <I name="down" size={13} />
            </button>
          }
        />
      </fieldset>

      {noteFor && (
        <Modal
          title={t('Decide on V{latestV}', { latestV })}
          onClose={() => setNoteFor(false)}
          width={460}
          foot={
            <>
              <button type="button" className="btn ghost" onClick={() => setNoteFor(false)}>
                {t('Cancel')}
              </button>
              <button type="button" className="btn" onClick={() => verdict('changes')} disabled={busy || decided('changes')}>
                <I name="undo" size={14} /> {t('Request changes')}
              </button>
              <button
                type="button"
                className="btn primary"
                onClick={() => verdict('approved')}
                disabled={busy || decided('approved')}
                data-testid="verdict-approve"
              >
                <I name="check" size={14} /> {t('Approve V{latestV}', { latestV })}
              </button>
            </>
          }
        >
          <AutoTextarea
            className="so-note-field"
            value={note}
            onChange={(e) => setNote(e.target.value)}
            aria-label={t('Note with your decision')}
            placeholder={t('Why? It is kept in the history with your decision.')}
            rows={3}
            autoFocus
          />
        </Modal>
      )}
      {history && (
        <Modal title={t('History')} onClose={() => setHistory(false)} width={520}>
          <div className="so-history" data-testid="stage-history">
            <StageStepper info={info} />
            <p className="so-now">
              <b>{pillLabel(info)}</b> · {stageDetail(info)}
            </p>
            <ApprovalHistory approvals={data.approvals} finals={finals} />
          </div>
        </Modal>
      )}
      {confirmReopen && (
        <Modal
          title={t('Reopen V{v}?', { v: data.review.final?.v ?? latestV })}
          onClose={() => setConfirmReopen(false)}
          width={440}
          foot={
            <>
              <button type="button" className="btn ghost" onClick={() => setConfirmReopen(false)}>
                {t('Not yet')}
              </button>
              <button type="button" className="btn primary" onClick={() => reopen(true)} disabled={busy} data-testid="reopen-anyway">
                <I name="refresh" size={14} /> {t('Reopen')}
              </button>
            </>
          }
        >
          <p data-testid="reopen-held">{heldWords()}</p>
        </Modal>
      )}
      {confirmFinal && (
        <Modal
          title={t('Mark V{latestV} final?', { latestV })}
          onClose={() => setConfirmFinal(false)}
          width={440}
          foot={
            <>
              <button type="button" className="btn ghost" onClick={() => setConfirmFinal(false)}>
                {t('Not yet')}
              </button>
              <button type="button" className="btn primary" onClick={() => markFinal(true)} disabled={busy} data-testid="final-anyway">
                <I name="lock" size={14} /> {t('Mark final anyway')}
              </button>
            </>
          }
        >
          <p>
            {t(
              '{n} required note is still open on this video. Final means this version ships: agents fix nothing more until someone reopens it.|{n} required notes are still open on this video. Final means this version ships: agents fix nothing more until someone reopens it.',
              { n: info.open },
            )}
          </p>
        </Modal>
      )}
    </div>
  );
}
