// Settings → Billing's account, for owners and admins once the workspace has one: what a payment provider's own billing
// page used to show, here as one panel in three rows (a label column and its content). The payment method: the cards
// with their brand, which one renewals use, Make default and Remove (gone after the toast's time, Undo until then),
// and a new card added in place through the provider's payment form. The billing details: a summary, edited in the row
// as a form whose VAT ID is checked as it is typed and by the provider (VIES). The invoices: a table with the next one
// estimated on top, each with its status, its PDF, and an open one's Pay. The payment forms load only when one opens
// (billing/Pay.tsx).
import { type FormEvent, type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import type { BillingAccount, BillingAddress, BillingInfo, BillingInvoice, BillingMethod } from '../../../lib/types.ts';
import { useAddTaxId, useBillingAccount, useDefaultMethod, useNewMethod, useRemoveMethod, useRemoveTaxId, useSaveDetails } from '../billing/api.ts';
import { CardMark } from '../billing/parts.tsx';
import { dayOf, money } from '../billing/words.ts';
import { locale, t } from '../i18n/index.ts';
import { useLang } from '../i18n/T.tsx';
import { loader, useLoaded } from '../lib/lazy.ts';
import { type Deferred, errorMessage, later, toast, toastError } from '../lib/toast.ts';
import { EntryField } from '../ui/EntryForm.tsx';
import { Spinner } from '../ui/feedback.tsx';
import { I } from '../ui/icons.tsx';
import { KeyGlyph } from '../ui/KeyGlyph.tsx';
import { SkLine } from '../ui/Skeleton.tsx';
import { Select } from '../ui/select.tsx';
import { EmptyState } from '../ui/system.tsx';

/** The payment forms and Stripe.js: only when one opens. */
export const payForms = loader(() => import('../billing/Pay.tsx'));

const BRANDS: Record<string, string> = {
  visa: 'Visa',
  mastercard: 'Mastercard',
  amex: 'American Express',
  discover: 'Discover',
  diners: 'Diners Club',
  jcb: 'JCB',
  unionpay: 'UnionPay',
  cartes_bancaires: 'Cartes Bancaires',
};

/** "Visa •••• 4242", "SEPA Direct Debit •••• 3000", "PayPal · ada@studio.test". */
export function methodLabel(m: BillingMethod): string {
  const name =
    m.type === 'card'
      ? (BRANDS[m.brand ?? ''] ?? (m.brand ? m.brand[0].toUpperCase() + m.brand.slice(1) : t('Card')))
      : m.type === 'sepa_debit'
        ? 'SEPA Direct Debit'
        : m.type === 'paypal'
          ? 'PayPal'
          : m.type === 'link'
            ? 'Link'
            : m.type;
  // the dots and the digits stay together on one line
  if (m.last4) return `${name} ••••\u00a0${m.last4}`;
  return m.email ? `${name} · ${m.email}` : name;
}

/** Its expiry has passed: the provider says so, or its month is behind us. */
const expiredOf = (m: BillingMethod, now = new Date()) =>
  m.expired ?? (!!m.expMonth && !!m.expYear && (m.expYear < now.getFullYear() || (m.expYear === now.getFullYear() && m.expMonth < now.getMonth() + 1)));

/** ISO 3166-1 alpha-2: every country an invoice address may have. */
const COUNTRIES =
  'AD AE AF AG AI AL AM AO AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GT GU GW GY HK HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS XK YE YT ZA ZM ZW'.split(
    ' ',
  );
const EU = new Set('AT BE BG CY CZ DE DK EE ES FI FR GR HR HU IE IT LT LU LV MT NL PL PT RO SE SI SK'.split(' '));

/** The tax ID a billing address in that country can carry (the provider's type), or none we offer. */
export function taxIdTypeFor(country: string | undefined): string | null {
  if (!country) return null;
  if (EU.has(country)) return 'eu_vat';
  return ({ GB: 'gb_vat', CH: 'ch_vat', NO: 'no_vat', US: 'us_ein', CA: 'ca_bn', AU: 'au_abn' } as Record<string, string>)[country] ?? null;
}

const taxIdName = (type: string): string => (type === 'us_ein' ? 'EIN' : type === 'ca_bn' ? t('Business number') : type === 'au_abn' ? 'ABN' : t('VAT ID'));

/** What's wrong with an EU VAT ID as typed, before anyone asks VIES: its country's letters and its length. */
export function vatProblem(value: string, country: string): string | null {
  const v = value.replace(/\s+/g, '').toUpperCase();
  if (!v || !EU.has(country)) return null;
  // Greece's VAT IDs start with EL, every other country's with its own code
  const prefix = country === 'GR' ? 'EL' : country;
  if (country === 'DE' && !/^DE\d{9}$/.test(v)) return t('German VAT IDs are DE and 9 digits.');
  if (!v.startsWith(prefix) || !/^[A-Z]{2}[0-9A-Z+*]{8,12}$/.test(v))
    return t('An EU VAT ID starts with its country’s letters ({prefix}), then 8 to 12 digits or letters.', { prefix });
  return null;
}

/** The account's three rows: one panel under one title. */
export function BillingAccountPanel({ b, onPay }: { b: BillingInfo; onPay: () => void }) {
  const { data, error, isPending, refetch } = useBillingAccount(true);
  // the account read before a payment, a switch or a cancellation is stale once the plan says so: read it again
  const version = `${b.plan}|${b.state}|${b.subscribed}|${b.interval}|${b.endsAt ?? ''}|${b.seats ?? ''}`;
  const seen = useRef(version);
  useEffect(() => {
    if (seen.current === version) return;
    seen.current = version;
    refetch();
  }, [version, refetch]);
  const a = isPending ? null : (data ?? null);
  const email = a?.details.email;
  return (
    <section className="bill-acct" aria-label={t('Payment and invoices')}>
      <h2 className="section-title">{t('Payment and invoices')}</h2>
      <div className="panel bill-acct-panel">
        {error ? (
          <div className="bill-acct-row">
            <p className="bill-err" role="alert">
              {errorMessage(error)}
            </p>
          </div>
        ) : (
          <>
            <Row title={t('Payment method')} lede={t('Renewals are charged to the default card.')} testid="billing-methods">
              <Methods b={b} a={a} />
            </Row>
            <Row title={t('Billing details')} lede={t('On every invoice from now on.')} testid="billing-details">
              <Details a={a} reverse={!!b.reverseCharge} />
            </Row>
            <Row
              title={t('Invoices')}
              lede={email ? t('Each one is also emailed to {email}.', { email }) : t('Each one with its PDF, to download.')}
              testid="billing-invoices"
            >
              <Invoices b={b} a={a} onPay={onPay} />
            </Row>
          </>
        )}
      </div>
    </section>
  );
}

function Row({ title, lede, testid, children }: { title: string; lede: string; testid: string; children: ReactNode }) {
  return (
    <div className="bill-acct-row" data-testid={testid}>
      <div className="bill-acct-k">
        <h3>{title}</h3>
        <p>{lede}</p>
      </div>
      <div className="bill-acct-v">{children}</div>
    </div>
  );
}

function Methods({ b, a }: { b: BillingInfo; a: BillingAccount | null }) {
  const add = useNewMethod();
  const def = useDefaultMethod();
  const remove = useRemoveMethod();
  const [open, setOpen] = useState<string | null>(null);
  const [renewals, setRenewals] = useState(true);
  const [gone, setGone] = useState<string | null>(null);
  const held = useRef<Deferred | null>(null);
  const forms = useLoaded(payForms, !!open);
  useEffect(() => () => held.current?.flush(), []);
  const start = async () => {
    payForms.load().catch(() => {});
    try {
      setRenewals(true);
      setOpen((await add.mutateAsync()).clientSecret);
    } catch (e) {
      toastError(e);
    }
  };
  const makeDefault = async (m: BillingMethod) => {
    try {
      await def.mutateAsync(m.id);
      toast(t('Renewals are charged to {method} now.', { method: methodLabel(m) }), 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  // removed after the toast's time: until then the row says so and Undo puts it back
  const drop = (m: BillingMethod) => {
    held.current?.flush();
    held.current = later({
      message: t('{method} removed.', { method: methodLabel(m) }),
      apply: () => setGone(m.id),
      revert: () => setGone(null),
      commit: () => remove.mutateAsync(m.id),
    });
  };
  const undo = () => {
    held.current?.drop();
    held.current = null;
    setGone(null);
  };
  if (!a)
    return (
      <ul className="bill-pm-list" aria-busy="true">
        <li className="bill-pm">
          <span className="bill-mark bill-mark-any" />
          <span className="bill-pm-t">
            <SkLine w="9em" />
          </span>
        </li>
      </ul>
    );
  return (
    <>
      {a.methods.length ? (
        <ul className="bill-pm-list">
          {a.methods.map((m) =>
            gone === m.id ? (
              <li key={m.id} className="bill-pm gone" role="status">
                <span>{t('{method} removed.', { method: methodLabel(m) })}</span>
                <button type="button" className="btn ghost sm" onClick={undo} data-testid="billing-method-undo">
                  <I name="undo" size={13} /> {t('Undo')}
                </button>
              </li>
            ) : (
              <li key={m.id} className="bill-pm" data-testid="billing-method">
                <CardMark brand={m.type === 'card' ? m.brand : undefined} />
                <span className="bill-pm-t">
                  <b>{methodLabel(m)}</b>
                  {m.expMonth && m.expYear ? (
                    expiredOf(m) ? (
                      <small className="bad">{t('Expired {date}', { date: `${String(m.expMonth).padStart(2, '0')}/${m.expYear}` })}</small>
                    ) : (
                      <small>{t('Expires {date}', { date: `${String(m.expMonth).padStart(2, '0')}/${m.expYear}` })}</small>
                    )
                  ) : null}
                </span>
                <span className="bill-pm-r">
                  {m.default ? (
                    <span className="bill-tag">{t('Default')}</span>
                  ) : (
                    <>
                      <button
                        type="button"
                        className="btn ghost sm"
                        onClick={() => makeDefault(m)}
                        disabled={def.isPending}
                        data-testid="billing-method-default"
                      >
                        {t('Make default')}
                      </button>
                      <button type="button" className="btn ghost sm" onClick={() => drop(m)} data-testid="billing-method-remove">
                        {t('Remove')}
                      </button>
                    </>
                  )}
                </span>
              </li>
            ),
          )}
        </ul>
      ) : (
        <EmptyState size="sm" art="list" title={t('No card kept')}>
          {t('Add one so renewals go through on their own.')}
        </EmptyState>
      )}
      {open && b.payments ? (
        <div className="bill-add-card" data-testid="billing-add-card">
          {forms ? (
            <forms.IntentForm
              publishableKey={b.payments.key}
              clientSecret={open}
              kind="setup"
              title={t('Add a card')}
              action={t('Save card')}
              onDone={async (method) => {
                setOpen(null);
                if (method && (renewals || !a.methods.length)) await def.mutateAsync(method).catch(toastError);
                toast(renewals ? t('The card is saved. Renewals are charged to it.') : t('The card is saved.'), 'ok');
              }}
              onCancel={() => setOpen(null)}
            >
              {a.methods.length > 0 && (
                <label className="bill-chk">
                  <input type="checkbox" checked={renewals} onChange={(e) => setRenewals(e.target.checked)} data-testid="billing-method-renewals" />
                  <span>{t('Use it for renewals')}</span>
                </label>
              )}
            </forms.IntentForm>
          ) : (
            <div className="bill-pay-loading" role="status">
              <Spinner /> {t('Loading the payment form')}
            </div>
          )}
        </div>
      ) : (
        b.payments && (
          <button type="button" className="btn-link bill-add-lk" onClick={start} disabled={add.isPending} data-testid="billing-method-add">
            {add.isPending ? <Spinner /> : <I name="plus" size={14} />} {t('Add a card')}
          </button>
        )
      )}
    </>
  );
}

const blankAddress: BillingAddress = { line1: '', postalCode: '', city: '', country: '' };

interface Draft {
  name: string;
  email: string;
  address: BillingAddress;
  vat: string;
}

/** `reverse`: the provider offers reverse charge, so a VAT ID is checked (VIES) and counts for the tax; else it is printed. */
function Details({ a, reverse }: { a: BillingAccount | null; reverse: boolean }) {
  const lang = useLang();
  const save = useSaveDetails();
  const addTax = useAddTaxId();
  const removeTax = useRemoveTaxId();
  const [edit, setEdit] = useState<Draft | null>(null);
  const [vatTouched, setVatTouched] = useState(false);
  const [vatError, setVatError] = useState('');
  // biome-ignore lint/correctness/useExhaustiveDependencies: the names are in the page's language
  const countries = useMemo(() => {
    const names = new Intl.DisplayNames([locale()], { type: 'region' });
    return COUNTRIES.map((c) => ({ value: c, label: names.of(c) ?? c })).sort((x, y) => x.label.localeCompare(y.label, locale()));
  }, [lang]);
  const d = a?.details;
  const nameOf = (c: string) => countries.find((x) => x.value === c)?.label ?? c;
  const taxIdNow = (country: string) => d?.taxIds.find((x) => x.type === taxIdTypeFor(country)) ?? d?.taxIds[0];
  const open = () => {
    const address = { ...blankAddress, ...d?.address };
    setVatTouched(false);
    setVatError('');
    setEdit({ name: d?.name ?? '', email: d?.email ?? '', address, vat: taxIdNow(address.country)?.value ?? '' });
  };
  const set = (patch: Partial<BillingAddress>) => edit && setEdit({ ...edit, address: { ...edit.address, ...patch } });
  const taxType = edit ? taxIdTypeFor(edit.address.country) : null;
  const typed = edit && taxType === 'eu_vat' ? vatProblem(edit.vat, edit.address.country) : null;
  const shownVatError = vatError || (vatTouched && typed ? typed : '');
  const valid =
    !!edit && !!edit.name.trim() && !!edit.address.line1.trim() && !!edit.address.postalCode.trim() && !!edit.address.city.trim() && !!edit.address.country;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!edit) return;
    setVatTouched(true);
    if (typed) return;
    const ad = edit.address;
    try {
      await save.mutateAsync({
        name: edit.name.trim(),
        ...(edit.email.trim() ? { email: edit.email.trim() } : {}),
        address: {
          line1: ad.line1.trim(),
          ...(ad.line2?.trim() ? { line2: ad.line2.trim() } : {}),
          postalCode: ad.postalCode.trim(),
          city: ad.city.trim(),
          ...(ad.state?.trim() ? { state: ad.state.trim() } : {}),
          country: ad.country,
        },
      });
    } catch (err) {
      return toastError(err);
    }
    // the VAT ID: the provider keeps it apart from the address; a new one replaces the old
    const vat = edit.vat.replace(/\s+/g, '').toUpperCase();
    const old = taxIdNow(ad.country);
    if (taxType && vat !== (old?.value ?? '')) {
      try {
        if (old) await removeTax.mutateAsync(old.id);
        if (vat) await addTax.mutateAsync({ type: taxType, value: vat });
      } catch (err) {
        // said at the field, in the error colour, with the form still open
        return setVatError(errorMessage(err));
      }
    }
    setEdit(null);
    toast(t('Saved: the next invoices carry these details.'), 'ok');
  };
  if (!a)
    return (
      <div className="bill-det-view" aria-busy="true">
        <address>
          <SkLine w="12em" />
          <SkLine w="18em" />
        </address>
      </div>
    );
  if (edit)
    return (
      <form className="bill-det-form" onSubmit={submit} noValidate data-testid="billing-details-form">
        <div className="bill-det-grid">
          <div className="bill-span2">
            <EntryField
              label={t('Company or name')}
              value={edit.name}
              onChange={(e) => setEdit({ ...edit, name: e.target.value })}
              autoComplete="organization"
              maxLength={200}
              autoFocus
            />
          </div>
          <div className="bill-span2">
            <EntryField
              label={t('Invoices go to')}
              type="email"
              value={edit.email}
              onChange={(e) => setEdit({ ...edit, email: e.target.value })}
              autoComplete="email"
              maxLength={254}
            />
          </div>
          <div className="bill-span2">
            <EntryField
              label={t('Address')}
              value={edit.address.line1}
              onChange={(e) => set({ line1: e.target.value })}
              autoComplete="address-line1"
              maxLength={200}
            />
          </div>
          {edit.address.line2 !== undefined && edit.address.line2 !== '' && (
            <div className="bill-span2">
              <EntryField
                label={t('Address, second line')}
                value={edit.address.line2}
                onChange={(e) => set({ line2: e.target.value })}
                autoComplete="address-line2"
                maxLength={200}
              />
            </div>
          )}
          <EntryField
            label={t('Postal code')}
            value={edit.address.postalCode}
            onChange={(e) => set({ postalCode: e.target.value })}
            autoComplete="postal-code"
            maxLength={20}
          />
          <EntryField
            label={t('City')}
            value={edit.address.city}
            onChange={(e) => set({ city: e.target.value })}
            autoComplete="address-level2"
            maxLength={100}
          />
          <div className="entry-field bill-country">
            <span className="inv-label">{t('Country')}</span>
            <div className="inv-field">
              <Select value={edit.address.country} onChange={(v) => set({ country: v })} options={countries} label={t('Country')} />
            </div>
          </div>
          {['US', 'CA', 'AU'].includes(edit.address.country) && (
            <EntryField
              label={t('State or province')}
              value={edit.address.state ?? ''}
              onChange={(e) => set({ state: e.target.value })}
              autoComplete="address-level1"
              maxLength={100}
            />
          )}
          {taxType && (
            <EntryField
              label={taxIdName(taxType)}
              value={edit.vat}
              onChange={(e) => {
                setVatError('');
                setEdit({ ...edit, vat: e.target.value });
              }}
              onBlur={() => setVatTouched(true)}
              placeholder={taxType === 'eu_vat' ? `${edit.address.country === 'GR' ? 'EL' : edit.address.country || 'DE'}123456789` : ''}
              autoComplete="off"
              spellCheck={false}
              maxLength={40}
              bad={!!shownVatError}
              hint={
                shownVatError ? (
                  <span className="bill-err" role="alert" data-testid="billing-vat-error">
                    <I name="info" size={13} />
                    {shownVatError}
                  </span>
                ) : taxType === 'eu_vat' ? (
                  reverse ? (
                    t('Checked with the EU’s VIES; it goes on every invoice.')
                  ) : (
                    t('It goes on every invoice.')
                  )
                ) : undefined
              }
              data-testid="billing-vat-input"
            />
          )}
        </div>
        <div className="bill-form-acts">
          <button type="button" className="btn ghost lg" onClick={() => setEdit(null)}>
            {t('Cancel')}
          </button>
          <button type="submit" className="btn primary lg" disabled={!valid || save.isPending || addTax.isPending} data-testid="billing-details-save">
            {(save.isPending || addTax.isPending) && <Spinner />} {t('Save')}
          </button>
        </div>
      </form>
    );
  const ad = d?.address;
  return (
    <div className="bill-det-view">
      <address data-testid="billing-address">
        {d?.name && <b>{d.name}</b>}
        {ad ? (
          <span>{[ad.line1, ad.line2, `${ad.postalCode} ${ad.city}${ad.state ? `, ${ad.state}` : ''}`, nameOf(ad.country)].filter(Boolean).join(' · ')}</span>
        ) : (
          <span className="bill-muted">{t('No address yet: the first payment brings it, or add it now.')}</span>
        )}
      </address>
      <button type="button" className="btn sm bill-raised bill-det-edit" onClick={open} data-testid="billing-details-edit">
        {t('Edit')}
      </button>
      <dl className="bill-kv">
        <div>
          <dt>{t('Invoices go to')}</dt>
          <dd>{d?.email ?? <span className="bill-muted">{t('Not set')}</span>}</dd>
        </div>
        <div data-testid="billing-taxids">
          <dt>{t('VAT ID')}</dt>
          <dd>
            {d?.taxIds.length ? (
              d.taxIds.map((x) => (
                <span key={x.id} className="bill-taxid">
                  {x.value}
                  <TaxIdState v={x.verification} />
                </span>
              ))
            ) : (
              <span className="bill-muted">{t('None. Add one to have it on invoices.')}</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** What the provider's check with the tax authority (VIES) said about a VAT ID. */
function TaxIdState({ v }: { v?: BillingAccount['details']['taxIds'][number]['verification'] }) {
  if (!v) return null;
  if (v.status === 'verified')
    return (
      <span className="bill-vat ok" title={v.name}>
        <KeyGlyph shape="diamond" size={8} />
        {v.name ? t('checked: {name}', { name: v.name }) : t('checked')}
      </span>
    );
  if (v.status === 'unverified')
    return (
      <span className="bill-vat bad">
        <KeyGlyph shape="outline" size={8} />
        {t('VIES doesn’t know this number')}
      </span>
    );
  return (
    <span className="bill-vat">
      <KeyGlyph shape="ease" size={8} />
      {v.status === 'pending' ? t('being checked with VIES') : t('VIES couldn’t be asked yet')}
    </span>
  );
}

function Status({ s }: { s: BillingInvoice['status'] }) {
  if (s === 'paid')
    return (
      <span className="bill-tag ok">
        <KeyGlyph shape="diamond" size={8} />
        {t('Paid')}
      </span>
    );
  if (s === 'open')
    return (
      <span className="bill-tag bad">
        <KeyGlyph shape="outline" size={8} />
        {t('Open')}
      </span>
    );
  return <span className="bill-tag">{s === 'void' ? t('Void') : t('Uncollectible')}</span>;
}

function Invoices({ b, a, onPay }: { b: BillingInfo; a: BillingAccount | null; onPay: () => void }) {
  const head = (
    <div className="bill-inv-r bill-inv-h" aria-hidden="true">
      <span>{t('Date')}</span>
      <span>{t('Description')}</span>
      <span className="bill-inv-a">{t('Amount')}</span>
      <span>{t('Status')}</span>
      <span />
    </div>
  );
  if (!a)
    return (
      <div className="bill-inv" aria-busy="true">
        {head}
        <div className="bill-inv-r">
          <span className="bill-inv-d">
            <SkLine w="5em" />
          </span>
          <span className="bill-inv-x">
            <SkLine w="10em" />
          </span>
        </div>
      </div>
    );
  if (!a.invoices.length && !b.next)
    return (
      <EmptyState size="sm" art="list" title={t('No invoices yet')}>
        {t('Each payment’s invoice shows here, with its PDF.')}
      </EmptyState>
    );
  return (
    <div className="bill-inv">
      {head}
      {b.next && (
        <div className="bill-inv-r next" data-testid="billing-invoice-next">
          <span className="bill-inv-d">{dayOf(b.next.date, { short: true, year: true })}</span>
          <span className="bill-inv-x">
            <b>{t('Next invoice, estimated')}</b>
          </span>
          <span className="bill-inv-a">{money(b.next.amount, b.next.currency, { cents: true })}</span>
          <span className="bill-inv-s">
            <span className="bill-tag">{t('Upcoming')}</span>
          </span>
          <span className="bill-inv-p" />
        </div>
      )}
      {a.invoices.map((inv) => (
        <div key={inv.id} className="bill-inv-r" data-testid="billing-invoice">
          <span className="bill-inv-d">{dayOf(inv.date, { short: true, year: true })}</span>
          <span className="bill-inv-x">
            <b>{inv.description || inv.number || t('Invoice')}</b>
            {inv.description && inv.number && <small>{inv.number}</small>}
          </span>
          <span className="bill-inv-a">{money(inv.total, inv.currency, { cents: true })}</span>
          <span className="bill-inv-s">
            <Status s={inv.status} />
          </span>
          <span className="bill-inv-p">
            {inv.status === 'open' && b.payments ? (
              <button type="button" className="btn sm bill-raised" onClick={onPay} data-testid="billing-invoice-pay">
                {t('Pay')}
              </button>
            ) : inv.pdf ? (
              <a
                className="btn ghost sm icon-only"
                href={inv.pdf}
                target="_blank"
                rel="noopener noreferrer"
                download
                aria-label={t('Download {number} as PDF', { number: inv.number ?? t('the invoice') })}
                title={t('Download {number} as PDF', { number: inv.number ?? t('the invoice') })}
                data-testid="billing-invoice-pdf"
              >
                <I name="download" size={15} />
              </a>
            ) : null}
          </span>
        </div>
      ))}
    </div>
  );
}
