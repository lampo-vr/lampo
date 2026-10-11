// Notifications on this device. Settings → Notifications manages them (PushSettings): turn them on (one tap — iOS
// insists on a tap), choose what's worth a ping, send a test, turn them off here; where the platform can't do it yet,
// say why and what to do instead (iOS: add the app to the Home Screen first). The inbox only asks (NotifyCard): a
// quiet, dismissible invitation while this device hasn't decided, or a word when they are blocked or need a step
// first — once they're on, the inbox says nothing about them.
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { type ReactNode, useRef, useState } from 'react';
import { DEFAULT_PREFS } from '../../../lib/pushPrefs.ts';
import type { PushPrefs, PushState } from '../../../lib/types.ts';
import { ApiError } from '../api/client.ts';
import { perLang, t } from '../i18n/index.ts';
import { errorMessage, toast, toastError } from '../lib/toast.ts';
import { disablePush, enablePush, pushState, pushSupport, setPrefs, testPush } from '../pwa/push.ts';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { Switch } from '../ui/plain.tsx';
import { IconButton } from '../ui/primitives.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import '../styles/foryou.css';

const LABELS = perLang((): [keyof PushPrefs, string, string][] => [
  ['questions', t('Questions from agents'), t('an agent needs a decision from you')],
  ['agents', t('Agents that stop or wait'), t('its work failed, or it waits for your OK')],
  ['quiet', t('Agents gone quiet'), t('no word from an agent at work for 30 min')],
  ['fixes', t('Fixes to check'), t('a new version with fixes, once per version')],
  ['clients', t('Review links'), t('notes and approvals that come through them')],
  ['answers', t('Replies'), t('an agent replied to your note')],
  ['versions', t('Every new version'), t('also versions without fixes')],
  ['posts', t('Posts'), t('a post of a final version went out, or failed')],
]);

type Why = 'ios-install' | 'insecure' | 'unsupported' | 'denied';
const WHY = perLang(
  (): Record<Why, { title: string; text: string }> => ({
    'ios-install': {
      title: t('Notifications need the app on your Home Screen'),
      text: t('On iPhone and iPad, tap Share, then “Add to Home Screen”, and open the app from there.'),
    },
    insecure: {
      title: t('Notifications need a secure connection'),
      text: t('Browsers only allow them over https (or on this computer itself). Open the app through the public tunnel or your server’s https address.'),
    },
    unsupported: { title: t('This browser can’t show notifications'), text: t('Use Safari on iOS 16.4 or later, or Chrome, Edge or Firefox.') },
    denied: { title: t('Notifications are blocked here'), text: t('Allow notifications for this site in the browser’s settings, then come back.') },
  }),
);

/** The query key of this device's notification state (kept across reloads with the screens' data: api/persist.ts). */
export const PUSH_KEY = ['push', 'device'] as const;

/** This device's notifications: what the platform allows, the subscription, and the actions on it. */
function usePushDevice() {
  const support = pushSupport();
  const qc = useQueryClient();
  // A query, so a reload shows the kept state at once (no box that grows when the browser has answered).
  const q = useQuery({ queryKey: PUSH_KEY, queryFn: pushState, enabled: support.ok });
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<PushState | null>, done?: string) => {
    setBusy(true);
    try {
      const s = await fn();
      if (s) qc.setQueryData(PUSH_KEY, s);
      if (done) toast(done, 'ok');
    } catch (e) {
      toastError(e);
    }
    setBusy(false);
  };
  // A switch turns at once and goes back if the server refuses: the card never goes grey while a choice is saved
  // (every switch and button used to be disabled for the request, a flash across the card on each change).
  const pref = async (k: keyof PushPrefs, on: boolean) => {
    const before = qc.getQueryData<PushState>(PUSH_KEY);
    if (before?.subscription)
      qc.setQueryData(PUSH_KEY, { ...before, subscription: { ...before.subscription, prefs: { ...before.subscription.prefs, [k]: on } } });
    try {
      qc.setQueryData(PUSH_KEY, await setPrefs({ [k]: on }));
    } catch (e) {
      if (before) qc.setQueryData(PUSH_KEY, before);
      toastError(e);
    }
  };
  return { support, state: q.data ?? null, busy, run, pref };
}

/** A computer's own settings for a browser's notifications, by platform: the step when a shown test isn't on screen. */
const systemHint = perLang(() => {
  const ua = navigator.userAgent;
  if (/Mac/.test(ua) && navigator.maxTouchPoints === 0)
    return t('This browser showed it. Nothing on screen? Allow your browser in the Mac’s System Settings → Notifications, and check that Focus is off.');
  if (/Windows/.test(ua))
    return t('This browser showed it. Nothing on screen? Allow your browser in Windows Settings → System → Notifications, and check Do not disturb.');
  return t('This device showed it. Nothing there? Allow notifications for this app in the device’s settings.');
});

/** "Send a test", saying what happened on the button itself, with the next step beside it: sending, sent (the push
 * service took it) and then what this browser made of it — shown, not shown, or no word yet — or why it couldn't go. */
type Tested =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'sent' | 'shown' | 'late' | 'blocked'; fresh: boolean }
  | { state: 'failed'; why: string; next: string; fresh: boolean };

function useTestPush() {
  const qc = useQueryClient();
  const [tested, setTested] = useState<Tested>({ state: 'idle' });
  const said = useRef(0);
  const settle = (next: Tested) => {
    const n = ++said.current;
    setTested(next);
    // the button says it for a while, then offers the test again; the line beside it stays until the next test
    setTimeout(() => n === said.current && setTested((s) => ('fresh' in s ? { ...s, fresh: false } : s)), 8000);
    return n;
  };
  const send = async () => {
    if (tested.state === 'sending') return;
    said.current++;
    setTested({ state: 'sending' });
    try {
      const { shown } = await testPush();
      const n = settle({ state: 'sent', fresh: true });
      const was = await shown;
      // what this browser made of it, said beside the button (a newer test has its own say)
      if (n === said.current) setTested((s) => ({ state: was ? 'shown' : was === false ? 'blocked' : 'late', fresh: 'fresh' in s && s.fresh }));
    } catch (e) {
      const status = e instanceof ApiError ? e.status : 0;
      if (status === 404 || status === 410) {
        // the server no longer has this device: the card turns to "Off on this device", and says why
        await qc.invalidateQueries({ queryKey: PUSH_KEY });
        setTested({ state: 'idle' });
        toast(t('This device’s notifications had ended. Turn them on again to get them here.'), 'error');
        return;
      }
      settle(
        status === 502
          ? {
              state: 'failed',
              why: t('the push service refused it'),
              next: t('Try again in a moment. If it keeps failing, turn notifications off and on here.'),
              fresh: true,
            }
          : status
            ? { state: 'failed', why: t('the server refused it'), next: errorMessage(e), fresh: true }
            : { state: 'failed', why: t('no connection'), next: t('Check the connection, then try again.'), fresh: true },
      );
    }
  };
  return { tested, send };
}

function TestFoot({ disabled, children }: { disabled: boolean; children: ReactNode }) {
  const { tested, send } = useTestPush();
  const s = tested.state;
  const fresh = 'fresh' in tested && tested.fresh;
  const label =
    s === 'sending'
      ? t('Sending…')
      : fresh && (s === 'sent' || s === 'shown' || s === 'late')
        ? t('Sent: check your notifications')
        : fresh && s === 'blocked'
          ? t('Sent, but not shown here')
          : fresh && tested.state === 'failed'
            ? t('Couldn’t send: {why}', { why: tested.why })
            : t('Send a test');
  const line =
    s === 'shown'
      ? systemHint()
      : s === 'late'
        ? t('The push service took it, but this browser hasn’t shown it yet. If it never comes, turn notifications off and on here.')
        : s === 'blocked'
          ? t('This browser didn’t show it: allow notifications for this site in its settings.')
          : tested.state === 'failed'
            ? tested.next
            : '';
  return (
    <div className="fy-prefs-foot" data-tested={s}>
      <button
        // one node all along: what it says changes after the press, and the keyboard's focus stays on it
        type="button"
        className={`btn sm fy-test ${fresh ? s : ''}`}
        disabled={disabled}
        aria-busy={s === 'sending' || undefined}
        onClick={send}
        data-testid="push-test"
      >
        {s === 'sending' ? (
          <Spinner />
        ) : fresh && (s === 'failed' || s === 'blocked') ? (
          <I name="x" size={13} />
        ) : fresh ? (
          <I name="check" size={13} />
        ) : (
          <I name="bell" size={13} />
        )}
        {label}
      </button>
      {children}
      <p className="fy-test-said" role="status" data-testid="push-test-said">
        {line}
      </p>
    </div>
  );
}

/** The device's state in one row: a glyph, what it is, a line on it, and the action when there is one. */
function DeviceHead({ title, text, on, children }: { title: ReactNode; text: ReactNode; on?: boolean; children?: ReactNode }) {
  return (
    <div className="fy-device-head">
      <span className={`fy-device-glyph${on ? ' on' : ''}`}>
        <I name="bell" size={16} />
      </span>
      <div className="grow">
        <b>{title}</b>
        <p>{text}</p>
      </div>
      {children}
    </div>
  );
}

/**
 * Settings → Notifications, "This device": everything about this device's notifications, flat in its card. Before
 * this device's state is known (a first visit — after that the kept state shows at once) it takes the layout it will
 * most likely have: on, with the usual choices, where the browser already allows notifications here.
 */
export function PushSettings() {
  const { support, state, busy, run, pref } = usePushDevice();
  if (!support.ok) {
    const why = WHY()[support.reason];
    return (
      <div className="fy-device" data-testid="push-settings" data-state="unsupported">
        <DeviceHead title={why.title} text={why.text} />
      </div>
    );
  }
  const pending = !state;
  const sub = state ? state.subscription : Notification.permission === 'granted' ? { name: '', prefs: DEFAULT_PREFS } : null;
  if (!sub)
    return (
      <div className="fy-device" data-testid="push-settings" data-state="off" aria-busy={pending || undefined}>
        <DeviceHead
          title={t('Off on this device')}
          text={t('Agents’ questions, fixes to check and feedback from review links — on this device, even with the app closed.')}
        >
          <button type="button" className="btn primary" disabled={busy || pending} onClick={() => run(() => enablePush(), t('Notifications are on'))}>
            {busy ? <Spinner /> : <I name="bell" size={15} />} {t('Turn on')}
          </button>
        </DeviceHead>
      </div>
    );
  return (
    <div className="fy-device" data-testid="push-settings" data-state="on" aria-busy={pending || undefined}>
      <DeviceHead
        on
        title={t('Notifications are on')}
        text={
          !state ? (
            <SkLine w="9em" />
          ) : state.devices > 1 ? (
            t('On {name} and {n} more device.|On {name} and {n} more devices.', { name: sub.name, n: state.devices - 1 })
          ) : (
            t('On {name}.', { name: sub.name })
          )
        }
      />
      <div className="fy-prefs">
        {LABELS().map(([k, label, hint]) => (
          <div key={k} className="fy-pref">
            <label htmlFor={`fy-pref-${k}`}>
              <b>{label}</b>
              <span className="muted">{hint}</span>
            </label>
            <Switch
              id={`fy-pref-${k}`}
              checked={sub.prefs[k] ?? DEFAULT_PREFS[k] ?? false}
              disabled={busy || pending}
              onCheckedChange={(on) => void pref(k, on)}
            />
          </div>
        ))}
      </div>
      <TestFoot disabled={busy || pending}>
        <button
          type="button"
          className="btn sm ghost fy-off"
          disabled={busy || pending}
          onClick={() => run(() => disablePush(), t('Notifications are off on this device'))}
        >
          {t('Turn off here')}
        </button>
      </TestFoot>
    </div>
  );
}

// "Not now" on this device, per kind of card: an invitation put away stays away; a new reason (blocked since) asks again.
const LATER = 'vr.notify.later';
const laterKind = () => {
  try {
    return localStorage.getItem(LATER);
  } catch {
    return null;
  }
};

/** In the inbox: only while there is something to decide or to fix; nothing once notifications are on. */
export function NotifyCard() {
  const { support, state, busy, run } = usePushDevice();
  const [later, setLater] = useState(laterKind);
  // a browser that can't do it at all has nothing to act on here (Settings says so)
  const kind: Why | 'invite' | null = !support.ok ? (support.reason === 'unsupported' ? null : support.reason) : state && !state.subscription ? 'invite' : null;
  if (!kind || kind === later) return null;
  const notNow = () => {
    try {
      localStorage.setItem(LATER, kind);
    } catch {}
    setLater(kind);
  };
  const dismiss = <IconButton className="btn ghost sm icon-only" label={t('Not now')} icon="x" size={15} onClick={notNow} data-testid="notify-later" />;
  if (kind !== 'invite') {
    const why = WHY()[kind];
    return (
      <div className="fy-notify" data-testid="notify-card" data-kind={kind}>
        <I name="bell" size={18} />
        <div className="grow">
          <b>{why.title}</b>
          <p>{why.text}</p>
        </div>
        {dismiss}
      </div>
    );
  }
  return (
    <div className="fy-notify" data-testid="notify-card">
      <I name="bell" size={18} />
      <div className="grow">
        <b>{t('Get a ping when something needs you')}</b>
        <p>{t('Agents’ questions, fixes to check and feedback from review links — on this device, even with the app closed.')}</p>
        <button
          type="button"
          className="btn sm"
          disabled={busy}
          onClick={() => run(() => enablePush(), t('Notifications are on — choose what pings you in Settings → Notifications'))}
        >
          {busy ? <Spinner /> : <I name="bell" size={15} />} {t('Turn on')}
        </button>
      </div>
      {dismiss}
    </div>
  );
}
