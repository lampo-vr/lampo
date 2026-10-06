// Stripe.js for the billing page's payment forms (billing/Pay.tsx): loaded from js.stripe.com — Stripe requires it to be
// loaded from there, never bundled or copied — only when a payment form opens on Settings → Billing, never before. The
// server allows that origin in the page's Content-Security-Policy only where a billing module takes payments
// (server/extension.ts contentSecurity). Card fields are Stripe's own frames: what is typed there goes to Stripe and
// never reaches this app. Only the few calls the forms make are typed here (no package for a script we don't bundle).
// Stripe.js sets Stripe's cookies and its address search asks Google: both wait for the person's say in the cookie
// settings (consent/consent.ts, its own chunk, loaded here when a form is about to open: A13 CLOUD-1).
import { currentLang, t } from '../i18n/index.ts';

/** The Stripe.js release that matches the server's API version (cloud module: stripe-node on 2026-08-26.dahlia). */
export const STRIPE_JS = 'https://js.stripe.com/dahlia/stripe.js';

export interface StripeError {
  type?: string;
  message?: string;
  /** Stripe's error code (`card_declined`, `expired_card`, `incorrect_cvc`, …) and a decline's own reason. */
  code?: string;
  decline_code?: string;
}

/**
 * What a payment that didn't go through says on the page: our sentence for Stripe's code, never Stripe's own text
 * (conversion SPEC §7c), and always that nothing was charged. Cards only here, so the way out is another card.
 */
export function declined(e: StripeError | undefined): string {
  const code = e?.decline_code ?? e?.code ?? '';
  if (/expired_card/.test(code)) return t('This card has expired. Nothing was charged. Try another card.');
  if (/(incorrect|invalid)_cvc/.test(code)) return t('The security code doesn’t match this card. Nothing was charged.');
  if (/(incorrect|invalid)_(number|expiry)/.test(code)) return t('The card number or expiry isn’t right. Nothing was charged.');
  if (/insufficient_funds|card_velocity_exceeded|withdrawal_count_limit_exceeded/.test(code))
    return t('The card can’t cover this payment right now. Nothing was charged. Try another card.');
  if (/authentication/.test(code)) return t('Your bank’s confirmation didn’t go through. Nothing was charged. Try again, or use another card.');
  if (/tax_id/.test(code)) return t('That VAT ID doesn’t fit the address’s country. Check it, or untick “I’m purchasing as a business”.');
  if (e?.type === 'card_error' || /declin|fraud/.test(code))
    return t('Your bank declined this card. Nothing was charged. Try another card, or ask the bank to allow the payment.');
  if (e?.type === 'validation_error') return t('Some details are missing or not right: check the fields above.');
  return t('The payment didn’t go through. Nothing was charged. Check the details and try again.');
}

export interface StripeElement {
  mount(el: HTMLElement): void;
  destroy(): void;
  on(event: 'ready' | 'change' | 'loaderror', cb: (e: { complete?: boolean; error?: StripeError }) => void): void;
}

/** An amount as Stripe.js formats it, and in minor units. */
export interface Amount {
  amount?: string;
  minorUnitsAmount?: number;
}

/** A Checkout Session's state as Stripe.js reports it (the fields the checkout shows). */
export interface CheckoutSession {
  canConfirm?: boolean;
  /** Where receipts and invoices go: the customer's address. */
  email?: string | null;
  total?: { total?: Amount; subtotal?: Amount; taxExclusive?: Amount; discount?: Amount };
  /** The tax lines once the billing address is known (`tax.status` says when it isn't yet). */
  taxAmounts?: { amount?: string; minorUnitsAmount?: number; displayName?: string; percentage?: number; inclusive?: boolean }[] | null;
  tax?: { status?: 'ready' | 'requires_billing_address' | 'requires_shipping_address' | string } | null;
  lineItems?: { name?: string; quantity?: number; unitAmount?: Amount; total?: Amount }[] | null;
  /** The next recurring payment: after a trial, the first one. */
  recurring?: { dueNext?: { total?: Amount; subtotal?: Amount; discount?: Amount; taxExclusive?: Amount } } | null;
  discountAmounts?: { displayName?: string; promotionCode?: string | null; amount?: string }[] | null;
  billingAddress?: {
    name?: string | null;
    address?: {
      line1?: string | null;
      line2?: string | null;
      city?: string | null;
      postal_code?: string | null;
      state?: string | null;
      country?: string | null;
    };
  } | null;
  taxIdInfo?: { taxIdType?: string; taxId?: string } | null;
}

type Result = { type: 'success'; session?: CheckoutSession } | { type: 'error'; error: StripeError };

export interface CheckoutActions {
  getSession(): CheckoutSession;
  confirm(o: { redirect: 'if_required' }): Promise<Result>;
  applyPromotionCode(code: string): Promise<Result>;
  removePromotionCode(): Promise<Result>;
  /** Clears what the Tax ID Element collected (the business box unticked). */
  updateTaxIdInfo?(info: null): Promise<Result>;
  /** The business's name on the invoice (the page's own field where there is no Tax ID Element), or none. */
  updateBusinessName?(name: string | null): Promise<Result>;
}

export interface CheckoutSdk {
  createPaymentElement(o?: Record<string, unknown>): StripeElement;
  createBillingAddressElement(o?: Record<string, unknown>): StripeElement;
  /** In public preview at Stripe (the `custom_checkout_tax_id_1` beta, which stripeFor asks for): used when there. */
  createTaxIdElement?(o?: Record<string, unknown>): StripeElement;
  on(event: 'change', cb: (s: CheckoutSession) => void): void;
  /** A new look for every element of the checkout (a theme switch while the form is open). */
  changeAppearance?(appearance: Record<string, unknown>): void;
  loadActions(): Promise<{ type: 'success'; actions: CheckoutActions } | { type: 'error'; error: StripeError }>;
}

export interface StripeElements {
  create(type: 'payment', o?: Record<string, unknown>): StripeElement;
  update?(o: { appearance: Record<string, unknown> }): void;
  submit(): Promise<{ error?: StripeError }>;
}

export interface Stripe {
  initCheckoutElementsSdk?(o: { clientSecret: string; elementsOptions?: Record<string, unknown> }): CheckoutSdk;
  /** The same, by its older name. */
  initCheckout?(o: { clientSecret: string; elementsOptions?: Record<string, unknown> }): CheckoutSdk;
  elements(o: { clientSecret: string; appearance?: Record<string, unknown> }): StripeElements;
  confirmSetup(o: {
    elements: StripeElements;
    redirect: 'if_required';
    confirmParams: { return_url: string };
  }): Promise<{ error?: StripeError; setupIntent?: { status: string; payment_method?: string | { id: string } | null } }>;
  confirmPayment(o: {
    elements: StripeElements;
    redirect: 'if_required';
    confirmParams: { return_url: string };
  }): Promise<{ error?: StripeError; paymentIntent?: { status: string; payment_method?: string | { id: string } | null } }>;
}

type StripeFactory = (key: string, o?: { locale?: string; betas?: string[]; developerTools?: { assistant?: { enabled: boolean } } }) => Stripe;
declare global {
  interface Window {
    Stripe?: StripeFactory;
  }
}

let loading: Promise<StripeFactory> | null = null;
const instances = new Map<string, Stripe>();

/** The cookie settings, a chunk of their own: asked for only when a payment form is about to open. */
export const consent = () => import('../consent/consent.ts');

/**
 * What the payment form may load: Stripe.js (with its cookies) and its address search (Google's suggestions). The
 * person is asked once (the cookie settings' box) and the choice is kept; until they choose, this waits.
 */
export async function paymentsAllowed(): Promise<{ stripe: boolean; address: boolean }> {
  return (await consent()).paymentsChoice();
}

/** Stripe.js, loaded once (a failed load is tried again next time). */
function script(): Promise<StripeFactory> {
  if (window.Stripe) return Promise.resolve(window.Stripe);
  if (!loading)
    loading = new Promise<StripeFactory>((resolve, reject) => {
      const s = document.createElement('script');
      s.src = STRIPE_JS;
      s.async = true;
      s.onload = () => (window.Stripe ? resolve(window.Stripe) : reject(new Error(t('The payment form could not load. Reload the page and try again.'))));
      s.onerror = () => {
        loading = null;
        s.remove();
        reject(new Error(t('The payment form could not load. Check the connection and try again.')));
      };
      document.head.append(s);
    });
  return loading;
}

/**
 * A Stripe instance for the publishable key, in the page's language — once the person allowed the payment form (the
 * callers ask paymentsAllowed first and say so when it isn't: nothing of Stripe loads before).
 */
export async function stripeFor(key: string): Promise<Stripe> {
  if (!(await paymentsAllowed()).stripe) throw new Error(t('The payment form isn’t allowed in the cookie settings.'));
  const id = `${key}:${currentLang()}`;
  const known = instances.get(id);
  if (known) return known;
  // no test-mode assistant floating over the page (Stripe takes this here, not in a checkout's elementsOptions); the
  // checkout's Tax ID Element (business name and VAT ID, in Stripe's public preview) needs its beta named here too
  const made = (await script())(key, { locale: currentLang(), betas: ['custom_checkout_tax_id_1'], developerTools: { assistant: { enabled: false } } });
  instances.set(id, made);
  return made;
}

/** The theme the page shows now: its choice, or the system's when it follows the system. */
const darkNow = (): boolean => {
  const t = document.documentElement.dataset.theme;
  return t === 'dark' || (t !== 'light' && matchMedia('(prefers-color-scheme: dark)').matches);
};

/**
 * The page's look as Stripe's appearance (conversion SPEC §5.1): one control scale with the app's entry fields — 40 px,
 * 13 px Instrument Sans, 12 px labels above; 44 px / 16 px on touch — in the theme's own tokens, read live, so a light
 * or dark switch is told again (onThemeChange). Focus and selection are ink, never the orange.
 */
export function appearance(): Record<string, unknown> {
  const css = getComputedStyle(document.documentElement);
  const dark = darkNow();
  const v = (name: string, dark: string, light: string) => css.getPropertyValue(name).trim() || (darkNow() ? dark : light);
  const T = {
    bg: v('--ink-0', '#070707', '#e9e5dc'),
    text: v('--fg', '#eeebe4', '#1c1b19'),
    text2: v('--fg-2', '#bebab2', '#3b3833'),
    muted: v('--muted', '#8c8982', '#69645b'),
    faint: v('--faint', '#5e5c58', '#868075'),
    line: v('--line-2', '#2c2c2e', '#d4cec2'),
    line3: v('--line-3', '#444446', '#b4ad9f'),
    must: v('--must', '#ff453a', '#b31434'),
    ok: v('--ok', '#3ddc97', '#157548'),
    // the app's focus ring and the field's sunk edge, as Stripe needs them: colours, not tokens
    ring: dark ? 'rgba(238,235,228,0.14)' : 'rgba(28,27,25,0.14)',
    mustRing: dark ? 'rgba(255,69,58,0.18)' : 'rgba(179,20,52,0.14)',
    sunk: dark ? 'rgba(0,0,0,0.18)' : 'rgba(58,46,28,0.06)',
  };
  const touch = matchMedia('(pointer: coarse)').matches;
  return {
    theme: 'flat',
    labels: 'above',
    variables: {
      fontFamily: '"Instrument Sans Variable", -apple-system, BlinkMacSystemFont, sans-serif',
      fontSizeBase: touch ? '16px' : '13px',
      fontSizeSm: '12px',
      fontSizeXs: '11px',
      fontWeightNormal: '400',
      fontWeightMedium: '500',
      fontWeightBold: '650',
      fontLineHeight: '1.3',
      spacingUnit: '4px',
      gridRowSpacing: '12px',
      gridColumnSpacing: '12px',
      borderRadius: '8px',
      colorPrimary: T.text,
      colorBackground: T.bg,
      colorText: T.text,
      colorTextSecondary: T.muted,
      colorTextPlaceholder: T.faint,
      colorIcon: T.muted,
      colorDanger: T.must,
      colorSuccess: T.ok,
      focusBoxShadow: `0 0 0 3px ${T.ring}`,
      focusOutline: 'none',
    },
    rules: {
      '.Label': { fontSize: '12px', fontWeight: '500', color: T.text2, lineHeight: '1.3', marginBottom: '6px' },
      '.Input': { padding: touch ? '13px 12px' : '11px 12px', lineHeight: '16px', border: `1px solid ${T.line}`, boxShadow: `inset 0 1px 2px ${T.sunk}` },
      '.Input:hover': { borderColor: T.line3 },
      '.Input:focus': { borderColor: T.text2, boxShadow: `0 0 0 3px ${T.ring}` },
      '.Input--invalid': { borderColor: T.must, boxShadow: `0 0 0 3px ${T.mustRing}`, color: T.text },
      '.Error': { fontSize: '12px', color: T.must, marginTop: '6px' },
      '.TermsText': { fontSize: '11px', lineHeight: '1.35', color: T.muted },
      '.CheckboxLabel': { fontSize: '13px', color: T.text2 },
      '.CheckboxInput': { borderColor: T.line3, backgroundColor: T.bg },
      '.CheckboxInput--checked': { backgroundColor: T.text, borderColor: T.text },
      '.Tab': { border: `1px solid ${T.line}`, boxShadow: 'none' },
      '.Tab--selected': { borderColor: T.text, boxShadow: `0 0 0 1px ${T.text}` },
    },
  };
}

/**
 * The app's own Instrument Sans for Stripe's frames (they live on js.stripe.com and can't see our @font-face): the
 * family's faces as the page's stylesheets declare them — Vite names the files by their content, so they're read, not
 * guessed — at absolute URLs (the server lets other origins fetch .woff2). Empty where none are found: Stripe then
 * falls back to the system font.
 */
export function stripeFonts(): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  for (const sheet of Array.from(document.styleSheets)) {
    let rules: CSSRuleList;
    try {
      rules = sheet.cssRules;
    } catch {
      continue;
    }
    for (const rule of Array.from(rules)) {
      if (!(rule instanceof CSSFontFaceRule)) continue;
      const st = rule.style;
      const family = st.getPropertyValue('font-family').replace(/["']/g, '').trim();
      if (family !== 'Instrument Sans Variable') continue;
      if (st.getPropertyValue('font-style').trim() === 'italic') continue;
      const url = /url\(["']?([^"')]+\.woff2)["']?\)/.exec(st.getPropertyValue('src'))?.[1];
      if (!url) continue;
      out.push({
        family,
        src: `url(${new URL(url, sheet.href ?? location.href).href})`,
        weight: st.getPropertyValue('font-weight').trim() || '400 700',
        display: 'block',
        ...(st.getPropertyValue('unicode-range').trim() ? { unicodeRange: st.getPropertyValue('unicode-range').trim() } : {}),
      });
    }
  }
  return out;
}

/**
 * Calls `fn` whenever the page's theme changes (Light / Dark / System and the system's own switch): Stripe's look is
 * given once when its fields mount, so an open form is told again. Returns the unsubscribe.
 */
export function onThemeChange(fn: () => void): () => void {
  const watch = new MutationObserver(fn);
  watch.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  const media = matchMedia('(prefers-color-scheme: dark)');
  media.addEventListener('change', fn);
  return () => {
    watch.disconnect();
    media.removeEventListener('change', fn);
  };
}

/** What every Elements group starts with: our look and our type. */
export const elementsOptions = () => {
  const fonts = stripeFonts();
  return { appearance: appearance(), ...(fonts.length ? { fonts } : {}) };
};

/** Stripe's id of a payment method, as a confirmation returns it (an id or the object). */
export const methodId = (pm: string | { id: string } | null | undefined): string | null => (typeof pm === 'string' ? pm : (pm?.id ?? null));
