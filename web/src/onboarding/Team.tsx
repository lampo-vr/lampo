// The setup's team step: invites row after row — an address, a role, × — starting with two empty rows; a new row
// comes as the last one fills. Each row checks itself in place (a bad address, one already in the list, your own) once
// it was left or on Send; a pasted list becomes rows; Backspace in an empty row joins it to the one above; Enter goes to
// the next empty row, or sends. On Cloud the trial note says who pays (from the billing provider, when one runs); on a
// self-hosted server it says whether email works — without a relay each invite becomes a link to send yourself. The
// invites are the app's own (POST /api/admin/invites, emailed with `send`); the picture's paper planes fly on Send.
import { type ClipboardEvent, type KeyboardEvent, useLayoutEffect, useRef, useState } from 'react';
import type { SetupVariant } from '../../../lib/onboarding.ts';
import { defaultInviteRole } from '../../../lib/setupFlow.ts';
import type { InviteCreated, Persona, Role } from '../../../lib/types.ts';
import { pageLang, useAuthStatus } from '../api/auth.ts';
import { api } from '../api/client.ts';
import { useBilling, useInfo } from '../api/queries.ts';
import { perLang, t } from '../i18n/index.ts';
import { toast, toastError } from '../lib/toast.ts';
import { I } from '../ui/icons.tsx';
import { Cmd, initialsOf, isEmail, OAv, Said } from './parts.tsx';
import { SceneTeam } from './pictures.tsx';
import type { StepProps } from './Setup.tsx';
import { Eyebrow, useHost, useTrial } from './steps.tsx';

export interface InviteRow {
  email: string;
  role: Role;
  /** Left once with something in it: its sentence shows from then on. */
  touched: boolean;
}

const ROLES = perLang((): [Role, string][] => [
  ['member', t('Member')],
  ['reviewer', t('Reviewer')],
  ['admin', t('Admin')],
]);
const roleLabel = (r: Role) => (ROLES().find((x) => x[0] === r) ?? ROLES()[0])[1];

type RowState = { kind: 'empty' } | { kind: 'ok' } | { kind: 'bad'; msg: string };

function rowState(rows: InviteRow[], i: number, own: string): RowState {
  const e = rows[i].email.trim().toLowerCase();
  if (!e) return { kind: 'empty' };
  if (!isEmail(e)) return { kind: 'bad', msg: t('That doesn’t look like an email address.') };
  if (e === own.toLowerCase()) return { kind: 'bad', msg: t('That’s your own address: you’re in already.') };
  if (rows.slice(0, i).some((x) => x.email.trim().toLowerCase() === e)) return { kind: 'bad', msg: t('Already in the list.') };
  return { kind: 'ok' };
}

/** One empty row waits at the end: filling the last brings the next. */
const withRoom = (rows: InviteRow[], role: Role): InviteRow[] =>
  rows.length && rows[rows.length - 1].email.trim() ? [...rows, { email: '', role, touched: false }] : rows;

/** "After that, Team is €20 a member a month": the plan's price from the billing provider (none runs: no line). */
function usePriceLine(): string | null {
  const info = useInfo();
  const billing = useBilling(!!info?.billing).data;
  const offer = billing?.offers?.find((o) => o.plan === billing.plan) ?? billing?.offers?.find((o) => o.plan === 'team');
  if (!billing || !offer) return null;
  const cur = billing.currency ?? Object.keys(offer.prices)[0];
  const price = offer.prices[cur];
  if (!price) return null;
  const amount = new Intl.NumberFormat(pageLang() === 'de' ? 'de-DE' : 'en-GB', {
    style: 'currency',
    currency: cur.toUpperCase(),
    maximumFractionDigits: price.month % 100 ? 2 : 0,
  }).format(price.month / 100);
  return offer.perMember
    ? t('After that, {plan} is {price} a member a month; agents and review links are free.', { plan: offer.name, price: amount })
    : t('After that, {plan} is {price} a month; agents and review links are free.', { plan: offer.name, price: amount });
}

export function Team({ frame, next, s, set, variant, personas }: StepProps & { variant: SetupVariant; personas: Persona[] }) {
  const status = useAuthStatus().data;
  const info = useInfo();
  const user = status?.user;
  const ws = status?.workspace;
  const host = useHost();
  const trial = useTrial();
  const price = usePriceLine();
  // the trial's note comes with the billing answer: its room is kept until then (Send doesn't jump down after paint)
  const billingQuery = useBilling(variant === 'cloud' && !!info?.billing);
  const trialPending = variant === 'cloud' && (!info || (!!info.billing && billingQuery.isPending));
  const own = user?.email ?? '';
  const role0: Role = variant === 'cloud' ? defaultInviteRole(personas) : 'member';
  const rows = s.rows ?? [
    { email: '', role: role0, touched: false },
    { email: '', role: role0, touched: false },
  ];
  const setRows = (r: InviteRow[]) => set({ rows: withRoom(r, role0) });
  const [tried, setTried] = useState(false);
  const [err, setErr] = useState('');
  const [shakeRow, setShakeRow] = useState<{ i: number; n: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [links, setLinks] = useState<{ email: string; role: Role; url: string }[] | null>(null);
  const focusTo = useRef<{ i: number; end?: boolean } | null>(null);
  const box = useRef<HTMLFieldSetElement>(null);
  // a mail relay sends the invites; without one (the outbox only) each one becomes a link to send yourself
  const mailless = variant !== 'cloud' && (!info?.mail || info.mail_transport === 'log');

  useLayoutEffect(() => {
    const f = focusTo.current;
    if (!f) return;
    focusTo.current = null;
    const el = box.current?.querySelector<HTMLInputElement>(`#ob-ir-${f.i}`);
    if (!el) return;
    el.focus();
    if (f.end) el.setSelectionRange(el.value.length, el.value.length);
  });

  const states = rows.map((_, i) => rowState(rows, i, own));
  const valid = rows.filter((_, i) => states[i].kind === 'ok');
  const n = valid.length;
  const verb = mailless ? 'create' : 'send';
  const label =
    verb === 'create'
      ? n
        ? t('Create {n} invite|Create {n} invites', { n })
        : t('Create invites')
      : n
        ? t('Send {n} invite|Send {n} invites', { n })
        : t('Send invites');

  const send = async () => {
    setTried(true);
    const bad = states.findIndex((x) => x.kind === 'bad');
    const badN = states.filter((x) => x.kind === 'bad').length;
    const msg = bad >= 0 ? (badN > 1 ? t('Some addresses need a look.') : t('One address needs a look.')) : n ? '' : t('Add an email first, or skip for now.');
    setErr(msg);
    if (msg) {
      const i = bad >= 0 ? bad : 0;
      setShakeRow((x) => ({ i, n: (x?.n ?? 0) + 1 }));
      focusTo.current = { i };
      return;
    }
    setSending(true);
    try {
      const made: { email: string; role: Role; url: string }[] = [];
      for (const r of valid) {
        const res = await api<InviteCreated>('/api/admin/invites', {
          method: 'POST',
          body: { role: r.role, email: r.email.trim(), ...(mailless ? {} : { send: true, lang: pageLang() }) },
        });
        made.push({ email: r.email.trim(), role: r.role, url: res.url });
      }
      if (mailless) {
        setLinks(made);
        return;
      }
      // the planes fly, then on
      const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
      setTimeout(
        () => {
          toast(made.length > 1 ? t('{n} invites sent', { n: made.length }) : t('Invite sent to {email}', { email: made[0].email }), 'ok');
          next();
        },
        still ? 0 : 750,
      );
    } catch (e) {
      setSending(false);
      toastError(e);
    }
  };

  const onInput = (i: number, value: string) => {
    const r = rows.map((x, j) => (j === i ? { ...x, email: value } : x));
    if (err) setErr('');
    setRows(r);
  };
  const onPaste = (i: number, e: ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text');
    const parts = text
      .split(/[\s,;<>]+/)
      .map((x) => x.trim())
      .filter((x) => x.includes('@'));
    if (parts.length < 2) return;
    e.preventDefault();
    const role = rows[i].role;
    const fresh = parts.map((email) => ({ email, role, touched: true }));
    const merged = [...rows.slice(0, i), ...fresh, ...rows.slice(i + 1)].filter((r, j, all) => r.email.trim() || j === all.length - 1);
    const out = withRoom(merged, role0);
    set({ rows: out });
    focusTo.current = { i: out.length - 1 };
    toast(t('{n} addresses, one row each', { n: parts.length }));
  };
  const onKey = (i: number, e: KeyboardEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    if (e.key === 'Enter') {
      e.preventDefault();
      const r = rows.map((x, j) => (j === i ? { ...x, touched: true } : x));
      set({ rows: r });
      const nextEmpty = r.findIndex((x, j) => j > i && !x.email.trim());
      if (!input.value.trim() || nextEmpty < 0) void send();
      else focusTo.current = { i: nextEmpty };
    } else if (e.key === 'Backspace' && !input.value && i > 0) {
      e.preventDefault();
      const r = rows.filter((_, j) => j !== i);
      setRows(r.length ? r : [{ email: '', role: role0, touched: false }]);
      focusTo.current = { i: i - 1, end: true };
    }
  };
  const remove = (i: number) => {
    const r = rows.length > 1 ? rows.filter((_, j) => j !== i) : [{ ...rows[0], email: '' }];
    setRows(r.length < 2 ? [...r, { email: '', role: role0, touched: false }] : r);
    focusTo.current = { i: Math.min(i, r.length - 1) };
  };
  const addRow = () => {
    const empty = rows.findIndex((r) => !r.email.trim());
    if (empty >= 0 && empty !== rows.length - 1) focusTo.current = { i: empty };
    else {
      const r = rows[rows.length - 1].email.trim() ? [...rows, { email: '', role: role0, touched: false }] : rows;
      set({ rows: r });
      focusTo.current = { i: r.length - 1 };
    }
  };

  const me = { name: user?.name ?? '', email: own };
  const sub = variant === 'server' ? host : trial ? t('{plan} trial · {n} day left|{plan} trial · {n} days left', { plan: trial.plan, n: trial.days }) : host;
  const picture = (
    <SceneTeam name={ws?.name ?? ''} sub={sub} me={me} invitees={valid.map((r) => ({ email: r.email.trim(), role: roleLabel(r.role) }))} mailless={mailless} />
  );
  const lede =
    variant === 'server'
      ? t('Everyone who makes the videos or signs them off. They get an account of their own.')
      : personas.includes('inhouse') && !personas.includes('agency')
        ? t('Everyone who makes the videos or signs them off. The trial covers all of them for 14 days.')
        : t('Your editors, producers and whoever approves. People you share with don’t need an account: they review through a link.');

  if (links)
    return frame({
      pictureId: 'team',
      picture,
      caption: t('Your team in this workspace.'),
      wide: true,
      body: (
        <>
          <div className="ob-su-head">
            <Eyebrow id="team" />
            <h1>{t('Send these yourself')}</h1>
            <p className="ob-lede">{t('There’s no mail relay yet, so each invite is a link. Each works once, for a week.')}</p>
          </div>
          {links.map((l) => (
            <div key={l.email} className="ob-block" data-testid="ob-invite-link">
              <div className="ob-block-h">
                <span className="ob-inline">
                  <OAv text={initialsOf(l.email)} size={22} />
                  {l.email}
                </span>
                <span className="ob-fine">{t('{role} · 7 days', { role: roleLabel(l.role) })}</span>
              </div>
              <Cmd text={l.url} />
            </div>
          ))}
          <p className="ob-fine">{t('Once email works, Settings → Users can send them again.')}</p>
          <div className="ob-su-acts ob-sticky">
            <button type="button" className="ob-btn ob-go ob-lg ob-block" onClick={next} data-testid="ob-next">
              {t('Continue')}
              <I name="right" size={15} className="ob-chev" />
            </button>
          </div>
        </>
      ),
    });

  return frame({
    pictureId: 'team',
    picture,
    caption: t('Your team in this workspace.'),
    wide: true,
    sending,
    body: (
      <>
        <div className="ob-su-head">
          <Eyebrow id="team" />
          <h1>{t('Invite your team')}</h1>
          <p className="ob-lede">{lede}</p>
        </div>
        <fieldset className="ob-irs" aria-label={t('Invites')} ref={box} data-testid="ob-invites">
          <div className="ob-irs-h" aria-hidden="true">
            <span />
            <span>{t('Email')}</span>
            <span>{t('Role')}</span>
            <span />
          </div>
          {rows.map((r, i) => {
            const st = states[i];
            const showErr = st.kind === 'bad' && (r.touched || tried);
            const last = i === rows.length - 1;
            return (
              <div
                // biome-ignore lint/suspicious/noArrayIndexKey: rows are places in a list the person edits
                key={i}
                className={`ob-ir ob-${st.kind} ${showErr ? 'ob-err-on' : ''} ${shakeRow?.i === i ? 'ob-shake' : ''}`}
                data-row={i}
                data-testid="ob-invite-row"
                {...(shakeRow?.i === i ? { 'data-shake': shakeRow.n } : {})}
                onAnimationEnd={() => setShakeRow(null)}
              >
                <span className="ob-ir-av" aria-hidden="true">
                  {st.kind === 'ok' ? <OAv text={initialsOf(r.email)} /> : <span className="ob-av ob-ghost" />}
                </span>
                <input
                  className="ob-inp ob-ir-email"
                  id={`ob-ir-${i}`}
                  type="email"
                  value={r.email}
                  placeholder={i === 0 ? t('jonas@northwind.studio') : t('name@company.com')}
                  autoComplete="off"
                  spellCheck={false}
                  aria-label={t('Email {n}', { n: i + 1 })}
                  aria-describedby={`ob-ir-err-${i}`}
                  aria-invalid={showErr || undefined}
                  onChange={(e) => onInput(i, e.target.value)}
                  onPaste={(e) => onPaste(i, e)}
                  onKeyDown={(e) => onKey(i, e)}
                  onBlur={() => r.email.trim() && !r.touched && set({ rows: rows.map((x, j) => (j === i ? { ...x, touched: true } : x)) })}
                />
                <select
                  className="ob-sel ob-ir-role"
                  value={r.role}
                  aria-label={t('Role for invite {n}', { n: i + 1 })}
                  onChange={(e) => set({ rows: rows.map((x, j) => (j === i ? { ...x, role: e.target.value as Role } : x)) })}
                >
                  {ROLES().map(([k, l]) => (
                    <option key={k} value={k}>
                      {l}
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="ob-ir-x"
                  aria-label={t('Remove this invite')}
                  onClick={() => remove(i)}
                  hidden={!r.email && (last || rows.length <= 2)}
                >
                  <I name="x" size={14} />
                </button>
                <p className="ob-ir-err" id={`ob-ir-err-${i}`} role="alert">
                  {showErr && st.kind === 'bad' ? st.msg : ''}
                </p>
              </div>
            );
          })}
          <button type="button" className="ob-ir-add" onClick={addRow}>
            <I name="plus" size={14} />
            {t('Add another')}
          </button>
        </fieldset>
        {variant === 'server' ? (
          mailless ? (
            <Said shape="half" tone="should" first={<b>{t('No mail relay yet.')}</b>} second={t('You’ll get a link per person to send yourself.')} />
          ) : (
            <Said tone="ok" first={<b>{t('Email works.')}</b>} second={t('Invites are sent by email from {host}.', { host })} />
          )
        ) : trial ? (
          <Said
            shape="hold"
            first={
              <>
                <b>{t('The trial covers everyone')}</b> {t('for {n} day.|for {n} days.', { n: trial.days })}
              </>
            }
            second={price ?? undefined}
          />
        ) : trialPending ? (
          <Said
            shape="hold"
            className="ob-room"
            first={
              <>
                <b>{t('The trial covers everyone')}</b> {t('for {n} day.|for {n} days.', { n: 14 })}
              </>
            }
            second={t('After that, {plan} is {price} a member a month; agents and review links are free.', { plan: 'Team', price: '€20' })}
          />
        ) : null}
        <div className="ob-su-acts ob-sticky">
          <p className="ob-err" id="ob-err-team" role="alert">
            {err || ' '}
          </p>
          <button
            type="button"
            className="ob-btn ob-go ob-lg ob-block"
            onClick={send}
            // the row being typed in keeps the focus: leaving it would show its sentence and move this button away
            // between the press and the release, and the press would miss
            onMouseDown={(e) => e.preventDefault()}
            disabled={sending}
            aria-busy={sending || undefined}
            data-testid="ob-send-invites"
          >
            <span>{label}</span>
            <I name="right" size={15} className="ob-chev" />
          </button>
          <div className="ob-row2">
            <span />
            <button type="button" className="ob-lk" onClick={next} data-testid="ob-skip-team">
              {t('Skip for now')}
            </button>
          </div>
        </div>
      </>
    ),
  });
}
