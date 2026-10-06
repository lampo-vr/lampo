// The app's cookie settings (A13 CLOUD-1), as on the website: CookieConsent 3.1.0 (MIT, web/src/vendor/cookieconsent/),
// the same build, the same cookie (`cc_cookie`, 182 days), the same words and buttons of equal weight, in the app's own
// look (styles/consent.css). The app itself keeps only what it needs to do what it's asked (the session, this device, a
// review link unlocked, this choice). The one third party is the billing page's payment form: Stripe.js, which sets
// Stripe's cookies against fraud (__stripe_mid, __stripe_sid), and the address search inside it, whose suggestions come
// from Google. They are a category of their own, "payments" (services `stripe` and `address`), off until allowed: the
// payment form waits for it (billing/stripe.ts). Analytics is there and off, with nothing connected to it.
// Loaded only when a payment form is about to open or someone asks for the settings: nothing of it is in the first paint.
import type { InfoResponse } from '../../../lib/types.ts';
import { api } from '../api/client.ts';
import { currentLang, t } from '../i18n/index.ts';
import * as CookieConsent from '../vendor/cookieconsent/cookieconsent.esm.js';
import '../vendor/cookieconsent/cookieconsent.css';
import '../styles/consent.css';

/** What the payment form may load: Stripe.js (and its cookies), and its address search (Google's suggestions). */
export interface PaymentsChoice {
  stripe: boolean;
  address: boolean;
}

/** Raised with the categories or the services: whoever asked is asked again when the settings change. */
export const REVISION = 1;

const waiting = new Set<() => void>();
const changes = new Set<() => void>();
const told = () => {
  for (const fn of [...waiting]) fn();
  waiting.clear();
  for (const fn of changes) fn();
};

/** A link to the operator's privacy policy, where the server names one (VR_PRIVACY_URL). */
const link = (url: string | null | undefined, words: string) => (url ? ` <a href="${encodeURI(url)}" target="_blank" rel="noreferrer">${words}</a>` : '');

/** The box's and the settings' words in the page's language (the library asks again after a switch: setLanguage). */
function words(privacy: string | null | undefined) {
  return {
    consentModal: {
      title: t('Cookies on this site'),
      description:
        t(
          'Lampo keeps only what it needs: your sign-in and this choice. The payment form is Stripe’s: it sets Stripe’s cookies against fraud, and its address search sends what you type to Google — only once you allow it. Analytics stays off; nothing is connected to it.',
        ) + link(privacy, t('Privacy')),
      acceptAllBtn: t('Allow all'),
      acceptNecessaryBtn: t('Necessary only'),
      showPreferencesBtn: t('Settings'),
    },
    preferencesModal: {
      title: t('Cookie settings'),
      acceptAllBtn: t('Allow all'),
      acceptNecessaryBtn: t('Necessary only'),
      savePreferencesBtn: t('Save my choice'),
      closeIconLabel: t('Close'),
      // the library's own plural form ("one|more")
      serviceCounterLabel: `${t('Service')}|${t('Services')}`,
      sections: [
        {
          title: t('Necessary'),
          description: t('What Lampo needs to do what you ask of it. Always on.'),
          linkedCategory: 'necessary',
          cookieTable: {
            caption: t('What it keeps'),
            headers: { name: t('Name'), purpose: t('Purpose'), duration: t('Duration') },
            body: [
              { name: '__Host-vr_session', purpose: t('Keeps you signed in'), duration: t('30 days') },
              { name: 'vr_device', purpose: t('Knows this device, for sign-in alerts'), duration: t('365 days') },
              { name: 'vr_g_…', purpose: t('A review link you unlocked with its password'), duration: t('30 days') },
              { name: 'cc_cookie', purpose: t('Your choice in these settings'), duration: t('182 days') },
            ],
          },
        },
        {
          title: t('The payment form'),
          description: t(
            'Settings → Billing’s payment form is Stripe’s. Stripe.js sets Stripe’s cookies against fraud; the address search sends what you type to Google for its suggestions. Off until you allow it: without it, nobody pays on the page.',
          ),
          linkedCategory: 'payments',
          cookieTable: {
            caption: t('What it keeps'),
            headers: { name: t('Name'), purpose: t('Purpose'), duration: t('Duration') },
            body: [
              { name: '__stripe_mid', purpose: t('Stripe: recognises the browser, against fraud'), duration: t('1 year') },
              { name: '__stripe_sid', purpose: t('Stripe: the same, for this visit'), duration: t('30 minutes') },
            ],
          },
        },
        {
          title: t('Analytics'),
          description: t('Off unless you switch it on. No analytics service is connected to it, so switching it on sets nothing more.'),
          linkedCategory: 'analytics',
        },
        ...(privacy ? [{ title: t('More'), description: t('How your data is handled:') + link(privacy, t('the privacy policy')) }] : []),
      ],
    },
  };
}

let started: Promise<void> | null = null;

/** The library, set up once per page: its box shows at once when nothing was chosen yet (or the settings changed). */
function start(): Promise<void> {
  started ??= (async () => {
    const info = await api<InfoResponse>('/api/info').catch(() => null);
    const lang = currentLang();
    await CookieConsent.run({
      revision: REVISION,
      cookie: { name: 'cc_cookie', expiresAfterDays: 182, sameSite: 'Lax' },
      // a person in a headless browser is a person: the e2e suites (and anyone automating the app) see the box too
      hideFromBots: false,
      guiOptions: {
        consentModal: { layout: 'box', position: 'bottom right', equalWeightButtons: true, flipButtons: false },
        preferencesModal: { layout: 'box', equalWeightButtons: true, flipButtons: false },
      },
      categories: {
        necessary: { enabled: true, readOnly: true },
        payments: {
          enabled: false,
          readOnly: false,
          services: {
            stripe: { label: t('Stripe: the payment form and its check against fraud') },
            address: { label: t('Google: suggestions in the address search') },
          },
          // refused later: what Stripe left in this browser goes too
          autoClear: { cookies: [{ name: /^__stripe_/ }] },
        },
        analytics: { enabled: false, readOnly: false },
      },
      language: { default: lang, translations: { en: () => words(info?.privacy_url), de: () => words(info?.privacy_url) } },
      onFirstConsent: told,
      onChange: told,
    });
  })();
  return started;
}

/** What the payment form may load now: the person's choice, asked for (the box) when there is none yet. */
export async function paymentsChoice(): Promise<PaymentsChoice> {
  await start();
  if (!CookieConsent.validConsent()) await new Promise<void>((resolve) => waiting.add(resolve));
  return { stripe: CookieConsent.acceptedService('stripe', 'payments'), address: CookieConsent.acceptedService('address', 'payments') };
}

/** "Allow the payment form": the payments category with its services, the rest as chosen. */
export async function allowPayments(): Promise<void> {
  await start();
  const kept = CookieConsent.getUserPreferences().acceptedCategories.filter((c) => c !== 'payments');
  CookieConsent.acceptCategory([...kept, 'payments']);
}

/** The settings, from a button that asks for them (in the page's language). */
export async function showSettings(): Promise<void> {
  await start();
  await CookieConsent.setLanguage(currentLang());
  CookieConsent.showPreferences();
}

/** Called whenever the choice changes (the payment form asks again); returns the unsubscribe. */
export function onConsentChange(fn: () => void): () => void {
  changes.add(fn);
  return () => changes.delete(fn);
}
