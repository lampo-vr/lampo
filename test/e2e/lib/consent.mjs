// The cookie settings' choice (web/src/consent/consent.ts, CookieConsent 3.1.0) as the library writes it, for suites
// that pay on a page and are not about the cookie settings themselves: set it before the page opens and the payment
// form loads at once, as it does for someone who chose before. `payments: false` is "Necessary only".

const DAY = 86_400_000;

/** The `cc_cookie` the library keeps for a choice (revision 1: consent.ts REVISION). */
export function consentCookie(base, { payments = true, address = true } = {}) {
  const now = new Date();
  const value = {
    categories: ['necessary', ...(payments ? ['payments'] : [])],
    revision: 1,
    data: null,
    consentTimestamp: now.toISOString(),
    consentId: `e2e-${now.getTime().toString(36)}`,
    services: { necessary: [], payments: payments ? ['stripe', ...(address ? ['address'] : [])] : [], analytics: [] },
    languageCode: 'en',
    lastConsentTimestamp: now.toISOString(),
    expirationTime: now.getTime() + 182 * DAY,
  };
  return { name: 'cc_cookie', value: encodeURIComponent(JSON.stringify(value)), url: base, sameSite: 'Lax' };
}
