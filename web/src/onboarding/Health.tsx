// A self-hosted server's health check (the server setup's second step): what a team will need, checked on arrival one
// at a time as a calm list — the public address review links and emails point to, where renders are stored, how mail
// leaves (with a test mail on request), the speech engine getting ready. Each row says what it found and, when there
// is one, the fix. Nothing blocks Continue; "Check again" asks the server again (GET /api/server/health).
import { useQueryClient } from '@tanstack/react-query';
import { type CSSProperties, type ReactNode, useEffect, useRef, useState } from 'react';
import type { ServerHealth } from '../../../lib/types.ts';
import { useAuthStatus } from '../api/auth.ts';
import { useSttStatus } from '../api/queries.ts';
import { t } from '../i18n/index.ts';
import { T } from '../i18n/T.tsx';
import { toast, toastError } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { healthKey, mailTest, useServerHealth } from './data.ts';
import { Cmd, KG, OIcon, Spin } from './parts.tsx';
import { CHECKS, type CheckId, type CheckState, SceneHealth } from './pictures.tsx';
import type { StepProps } from './Setup.tsx';
import { Eyebrow, useHost } from './steps.tsx';

const NAMES = (): Record<CheckId, string> => ({ url: t('Public address'), storage: t('Storage'), mail: t('Email'), speech: t('Speech engine') });

const gb = (n: number | null) => (n == null ? null : n >= 1e12 ? `${(n / 1e12).toFixed(1)} TB` : `${Math.round(n / 1e9)} GB`);

/** What each check found, as the server answered it. */
function verdict(h: ServerHealth, id: CheckId): CheckState {
  if (id === 'url') return h.public_url.ok ? 'ok' : 'warn';
  if (id === 'storage') return h.storage.ok ? 'ok' : 'warn';
  if (id === 'mail') return h.mail.ok ? 'ok' : 'warn';
  return h.stt.ok ? 'ok' : h.stt.state === 'loading' || h.stt.state === 'downloading' ? 'run' : 'warn';
}

export function Health({ frame, next }: StepProps) {
  const qc = useQueryClient();
  const host = useHost();
  const email = useAuthStatus().data?.user?.email ?? '';
  const { data: h, refetch, isFetching } = useServerHealth(true);
  // the checks show one at a time, calmly, however fast the server answered
  const [shown, setShown] = useState(0);
  const [round, setRound] = useState(0);
  const [mailOpen, setMailOpen] = useState(false);
  const [mailSent, setMailSent] = useState<string | null>(null);
  const [mailBusy, setMailBusy] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // "Show the fix" goes away as the fix opens: focus moves into the fix, not to the page
  const fixRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (mailOpen) fixRef.current?.focus({ preventScroll: true });
  }, [mailOpen]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a new answer (a new round) starts the reveal again
  useEffect(() => {
    if (!h || isFetching) return;
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (still) return setShown(CHECKS.length);
    setShown(0);
    let i = 0;
    const step = () => {
      i++;
      setShown(i);
      if (i < CHECKS.length) timer.current = setTimeout(step, 650);
    };
    timer.current = setTimeout(step, 450);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [h, isFetching, round]);
  // the speech engine getting ready: its progress from the server's speech status while it loads
  const sttLoading = !!h && verdict(h, 'speech') === 'run';
  const stt = useSttStatus(sttLoading);
  const sttPct = Math.round(((stt?.progress ?? h?.stt.progress ?? 0) as number) * 100);
  const sttReady = stt?.state === 'ready' || h?.stt.ok;
  useEffect(() => {
    if (sttLoading && sttReady) void refetch();
  }, [sttLoading, sttReady, refetch]);

  const stateOf = (id: CheckId, i: number): CheckState => {
    if (!h || isFetching) return i === 0 && isFetching ? 'run' : 'idle';
    if (i > shown) return 'idle';
    if (i === shown) return 'run';
    return verdict(h, id);
  };
  const states = Object.fromEntries(CHECKS.map((c, i) => [c.id, stateOf(c.id, i)])) as Record<CheckId, CheckState>;
  const done = CHECKS.every((c) => states[c.id] === 'ok' || states[c.id] === 'warn' || (c.id === 'speech' && states[c.id] === 'run' && shown >= CHECKS.length));
  const toFix = CHECKS.filter((c) => states[c.id] === 'warn').length;
  const again = () => {
    setMailOpen(false);
    setRound((n) => n + 1);
    void qc.invalidateQueries({ queryKey: healthKey });
  };
  const sendTest = async () => {
    setMailBusy(true);
    try {
      const r = await mailTest();
      setMailSent(r.to);
      toast(t('Test mail sent to {email}', { email: r.to }), 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setMailBusy(false);
    }
  };

  const found = (id: CheckId, s: CheckState): ReactNode => {
    if (!h) return ' ';
    if (s === 'run' && id !== 'speech') {
      return { url: t('Asking the address from outside…'), storage: t('Writing a test file…'), mail: t('Looking for a mail relay…'), speech: '' }[id];
    }
    if (s === 'idle') return ' ';
    switch (id) {
      case 'url':
        return h.public_url.ok ? (
          <T k="<0>{url}</0> · review links and emails point here." values={{ url: h.public_url.url ?? '' }} tags={[(c) => <code>{c}</code>]} />
        ) : h.public_url.url ? (
          <T k="<0>{url}</0> isn’t https: review links work, chat apps can’t connect." values={{ url: h.public_url.url }} tags={[(c) => <code>{c}</code>]} />
        ) : (
          <T k="No public address yet: set <0>LAMPO_PUBLIC_URL</0>, so links and emails point here." tags={[(c) => <code>{c}</code>]} />
        );
      case 'storage': {
        const free = gb(h.storage.free_bytes);
        const where = h.storage.where ?? '';
        if (!h.storage.writable) return t('Storage isn’t writable: uploads would fail. Check the folder’s or bucket’s rights.');
        // the folder only for the machine itself (the server says it to nobody else)
        if (h.storage.kind === 'local' && !where) return free ? t('Local disk · writable · {free} free.', { free }) : t('Local disk · writable.');
        if (h.storage.kind === 'local')
          return free ? (
            <T k="Local disk at <0>{where}</0> · writable · {free} free." values={{ where, free }} tags={[(c) => <code>{c}</code>]} />
          ) : (
            <T k="Local disk at <0>{where}</0> · writable." values={{ where }} tags={[(c) => <code>{c}</code>]} />
          );
        return (
          <T k="{kind} bucket <0>{where}</0> · writable." values={{ kind: h.storage.kind === 's3' ? 'S3' : 'Bunny', where }} tags={[(c) => <code>{c}</code>]} />
        );
      }
      case 'mail':
        return h.mail.ok ? (
          mailSent ? (
            <T
              k="Sends through <0>{relay}</0> · a test mail went to {email}."
              values={{ relay: h.mail.relay ?? '', email: mailSent }}
              tags={[(c) => <code>{c}</code>]}
            />
          ) : (
            <T k="Sends through <0>{relay}</0>." values={{ relay: h.mail.relay ?? '' }} tags={[(c) => <code>{c}</code>]} />
          )
        ) : (
          t('No mail relay yet. Invites and password resets become links you copy and send.')
        );
      case 'speech':
        if (s === 'run') return t('Getting {model} ready ({device})…', { model: h.stt.model ?? 'Parakeet', device: h.stt.device ?? 'CPU' });
        return h.stt.ok
          ? t('{model} on the {device} · voice notes and transcripts work.', { model: h.stt.model ?? '', device: h.stt.device ?? 'CPU' })
          : h.stt.state === 'off'
            ? t('Speech is off: voice notes keep their sound, without words.')
            : t('The speech engine didn’t start. Voice notes keep their sound; the server log says why.');
    }
  };

  // `held`: the row's final room, drawn unseen while its check still runs (the row keeps its height throughout)
  const fix = (id: CheckId, s: CheckState, held = false): ReactNode => {
    if (!h || s === 'idle' || s === 'run') return null;
    const room = held ? { 'aria-hidden': true, inert: true } : {};
    const hold = held ? ' ob-held' : '';
    if (id === 'mail' && s === 'ok')
      return (
        <div className={`ob-check-fix ob-check-fix-bare${hold}`} {...room}>
          <div className="ob-row">
            <button type="button" className="ob-btn ob-sm ob-raised" onClick={sendTest} disabled={mailBusy} data-testid={held ? undefined : 'ob-mail-test'}>
              {mailBusy ? <Spin /> : <OIcon name="mail" size={13} />}
              {mailSent ? t('Send another test mail') : t('Send a test mail to {email}', { email })}
            </button>
          </div>
        </div>
      );
    if (id === 'mail' && s === 'warn')
      return mailOpen && !held ? (
        <div className="ob-check-fix" data-testid="ob-mail-fix" ref={fixRef} tabIndex={-1}>
          <span className="ob-fine ob-fg2">
            <T k="Add a relay to <0>lampo.env</0> (or the compose file), then restart:" tags={[(c) => <code>{c}</code>]} />
          </span>
          <Cmd text={`LAMPO_SMTP_URL='smtp://user:password@smtp.example.com:587'\nLAMPO_MAIL_FROM='Lampo <lampo@${host}>'`} />
          <Cmd text="docker compose up -d" />
          <div className="ob-row">
            <button type="button" className="ob-btn ob-sm ob-raised" onClick={again} data-testid="ob-mail-recheck">
              <I name="refresh" size={13} />
              {t('I’ve set it, check again')}
            </button>
            <button type="button" className="ob-lk" onClick={() => setMailOpen(false)}>
              {t('Later')}
            </button>
          </div>
        </div>
      ) : (
        <div className={`ob-check-fix ob-check-fix-bare${hold}`} {...room}>
          <div className="ob-row">
            <button type="button" className="ob-btn ob-sm ob-raised" onClick={() => setMailOpen(true)} data-testid={held ? undefined : 'ob-mail-show-fix'}>
              {t('Show the fix')}
            </button>
          </div>
        </div>
      );
    return null;
  };

  return frame({
    pictureId: 'health',
    picture: <SceneHealth host={host} states={states} names={NAMES()} speechPct={sttPct} />,
    caption: t('What your team will need, checked.'),
    wide: true,
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="health" />
          <h1>{t('A quick check of your server')}</h1>
          <p className="ob-lede">{t('What your team will need. Fix anything now or later: Settings → About shows this server’s state.')}</p>
        </div>
        <ul className={`ob-checks ${h ? '' : 'ob-asking'}`} aria-live="polite" data-testid="ob-checks">
          {CHECKS.map((c) => {
            const s = states[c.id];
            // what the check will say once it has run (the last answer while it runs again): its room is kept from the
            // start, so the rows don't grow one by one as the answers land, nor fold up on "Check again"
            const end = h ? verdict(h, c.id) : null;
            const settled = !end || s === end;
            const status = (x: CheckState) =>
              x === 'ok' ? (
                <>
                  <KG tone="ok" pop />
                  {t('Ready')}
                </>
              ) : x === 'warn' ? (
                <>
                  <KG shape="half" tone="should" pop />
                  {t('To fix')}
                </>
              ) : x === 'run' ? (
                <>
                  <Spin />
                  {c.id === 'speech' && h && verdict(h, 'speech') === 'run' ? `${sttPct}%` : t('Checking')}
                </>
              ) : (
                <>
                  <KG shape="outline" />
                  {t('Waiting')}
                </>
              );
            return (
              <li key={c.id} className="ob-check" data-s={s} data-check={c.id}>
                <span className="ob-check-g">
                  <OIcon name={c.icon} size={15} />
                </span>
                <b>{NAMES()[c.id]}</b>
                {/* every label in one cell, the current one shown: the pill keeps the widest one's width */}
                <span className="ob-check-s">
                  <span className="ob-check-s-now">{status(s)}</span>
                  {(['ok', 'warn', 'run', 'idle'] as const)
                    .filter((x) => x !== s)
                    .map((x) => (
                      <span key={x} className="ob-held" aria-hidden="true">
                        {status(x)}
                      </span>
                    ))}
                </span>
                <span className="ob-check-r">
                  <span>{found(c.id, s)}</span>
                  {!settled && end && (
                    <span className="ob-held" aria-hidden="true">
                      {found(c.id, end)}
                    </span>
                  )}
                </span>
                {c.id === 'speech' && s === 'run' && h && verdict(h, 'speech') === 'run' && (
                  <span className="ob-check-bar">
                    <i style={{ '--p': `${sttPct}%` } as CSSProperties} />
                  </span>
                )}
                {settled ? fix(c.id, s) : end && fix(c.id, end, true)}
                {/* before the first answer: the mail row's button row, unseen (mail always has one: a test or the fix) */}
                {!h && c.id === 'mail' && (
                  <div className="ob-check-fix ob-check-fix-bare ob-held" aria-hidden="true">
                    <div className="ob-row">
                      <span className="ob-btn ob-sm">{t('Show the fix')}</span>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
        <div className="ob-su-acts ob-sticky">
          <div className="ob-row2">
            <span className="ob-sum" data-testid="ob-health-sum">
              {done ? (
                toFix ? (
                  <>
                    <KG shape="half" tone="should" />
                    {t('{n} to fix, whenever you like', { n: toFix })}
                  </>
                ) : (
                  <>
                    <KG tone="ok" />
                    {t('All set')}
                  </>
                )
              ) : (
                <>
                  <Spin />
                  {t('Checking…')}
                </>
              )}
            </span>
            <button type="button" className="ob-lk" onClick={again} data-testid="ob-health-rerun">
              <I name="refresh" size={13} />
              {t('Check again')}
            </button>
          </div>
          <button type="button" className={`ob-btn ob-lg ob-block ${done ? 'ob-go' : 'ob-raised'}`} onClick={next} data-testid="ob-next">
            {t('Continue')}
            <I name="right" size={15} className="ob-chev" />
          </button>
        </div>
      </>
    ),
  });
}
