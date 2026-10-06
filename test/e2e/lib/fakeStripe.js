// A stand-in for Stripe.js, served by test/e2e/billing.mjs in place of https://js.stripe.com/dahlia/stripe.js (the page
// asks for that address, so the app's Content-Security-Policy has to let js.stripe.com in for it to run at all). It
// does what the billing page's forms call: a Checkout Session in elements mode (address, tax ID and payment elements,
// the session's total, a promotion code, confirm) and the Payment Element on a setup or a payment. Each element is a
// frame from js.stripe.com, as Stripe's are, so the policy's frame-src is put to the test too. Confirming tells the
// stand-in billing module (test/e2e/lib/billingModule.ts, `/api/billing/fake/confirm`), the way Stripe's events would.
// `window.__fakeStripe.calls` records what the page asked; `window.__fakeStripe.decline = true` declines the next card;
// `__fakeStripe.address('DE' | 'AT' | 'US')` stands in for an address typed into the address element (the tax follows:
// 19 % in Germany, nothing elsewhere), `__fakeStripe.taxId('ATU12345678')` for a VAT ID typed into the tax ID element.
// Each frame is as tall as Stripe's own with our appearance, in the step's grid (measured on real Stripe.js: Slots.tsx).
(() => {
  const fake = { calls: [], decline: false, email: 'pia@e2e.test' };
  window.__fakeStripe = fake;
  const money = (minor, currency) => new Intl.NumberFormat('en-US', { style: 'currency', currency: currency.toUpperCase() }).format(minor / 100);

  function element(kind) {
    const on = {};
    let box = null;
    return {
      mount(el) {
        box = el;
        const f = document.createElement('iframe');
        f.src = `https://js.stripe.com/fake-frame.html#${kind}`;
        f.title = kind;
        const narrow = el.getBoundingClientRect().width < 450;
        const h = { address: 208.8, taxid: narrow ? 208.8 : 135.2, payment: narrow ? 184.88 : 170.03, intent: 184.88 }[kind] ?? 44;
        f.style.cssText = `display:block;width:100%;height:${h}px;border:0`;
        f.addEventListener('load', () => {
          for (const cb of on.ready ?? []) cb({});
        });
        el.append(f);
        el.dataset.mounted = kind;
      },
      destroy() {
        box?.replaceChildren();
      },
      on(event, cb) {
        on[event] ??= [];
        on[event].push(cb);
      },
    };
  }

  async function confirm(clientSecret, promo) {
    if (fake.decline) {
      fake.decline = false;
      return { error: { type: 'card_error', code: 'card_declined', decline_code: fake.declineCode ?? 'generic_decline', message: 'Your card was declined.' } };
    }
    const r = await fetch('/api/billing/fake/confirm', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientSecret, promo }),
    });
    if (!r.ok) return { error: { message: `The stand-in confirmation failed (${r.status}).` } };
    return r.json();
  }

  window.Stripe = (key, opts) => {
    fake.calls.push(['Stripe', key, opts?.locale ?? null]);
    for (const k of Object.keys(opts ?? {}))
      if (!['locale', 'betas', 'developerTools', 'apiVersion', 'stripeAccount'].includes(k)) throw new Error(`Invalid Stripe() parameter: ${k}`);
    fake.options = { ...fake.options, init: opts };
    return {
      initCheckoutElementsSdk(o) {
        // like the real Stripe.js (dahlia): options it doesn't take are an error, not ignored
        for (const k of Object.keys(o))
          if (!['clientSecret', 'elementsOptions', 'defaultValues'].includes(k))
            throw new Error(`Invalid initCheckout() parameter: options.${k} is not an accepted parameter.`);
        for (const k of Object.keys(o.elementsOptions ?? {}))
          if (!['appearance', 'fonts', 'loader', 'savedPaymentMethod'].includes(k))
            throw new Error(`Invalid initCheckout() parameter: options.elementsOptions.${k} is not an accepted parameter.`);
        const { clientSecret, elementsOptions } = o;
        fake.calls.push(['checkout', clientSecret]);
        fake.options = { ...fake.options, checkout: elementsOptions };
        const m = /^cs_fake_(\d+)_([a-z]+)(?:_f(\d+))?_\d+_secret_fake$/.exec(clientSecret);
        if (!m) throw new Error(`not a stand-in checkout: ${clientSecret}`);
        // due today (0 while a trial carries over) and the plan's full price (the first payment after the trial)
        const amount = Number(m[1]);
        const currency = m[2];
        const full = Number(m[3] ?? m[1]);
        let discount = 0;
        let country = null;
        let taxId = null;
        const listeners = [];
        const rate = () => (country === 'DE' ? 0.19 : 0);
        const off = (x) => (x ? Math.round(x * (1 - discount)) : 0);
        const line = (x) => ({ amount: money(x, currency), minorUnitsAmount: x });
        const session = () => {
          const net = off(amount);
          const tax = Math.round(net * rate());
          const nextTax = Math.round(off(full) * rate());
          const next = off(full) + nextTax;
          return {
            canConfirm: true,
            email: fake.email,
            tax: { status: country ? 'ready' : 'requires_billing_address' },
            taxAmounts: country
              ? [{ ...line(tax), displayName: country === 'US' ? 'Sales Tax' : 'VAT', percentage: country === 'DE' ? 19 : 0, inclusive: false }]
              : [],
            taxIdInfo: taxId ? { taxIdType: 'eu_vat', taxId } : null,
            total: {
              subtotal: line(amount),
              discount: line(amount - net),
              taxExclusive: line(tax),
              total: line(net + tax),
            },
            lineItems: [{ name: 'Lampo', total: line(amount) }],
            recurring: { dueNext: { subtotal: line(full), discount: line(full - off(full)), taxExclusive: line(nextTax), total: line(next) } },
            discountAmounts: discount ? [{ displayName: '10 % off', promotionCode: 'WELCOME' }] : [],
            billingAddress: country ? { name: 'Pia Brandt', address: { line1: 'Hafenstraße 1', postal_code: '20457', city: 'Hamburg', country } } : null,
          };
        };
        const changed = () => {
          const s = session();
          for (const cb of listeners) cb(s);
          return s;
        };
        fake.address = (c) => {
          country = c;
          changed();
        };
        fake.taxId = (v) => {
          taxId = v;
          changed();
        };
        return {
          createPaymentElement: (o) => {
            fake.options = { ...fake.options, payment: o };
            return element('payment');
          },
          createBillingAddressElement: (o) => {
            fake.options = { ...fake.options, address: o };
            return element('address');
          },
          createTaxIdElement: (o) => {
            fake.options = { ...fake.options, taxId: o };
            fake.calls.push(['createTaxIdElement']);
            return element('taxid');
          },
          on(event, cb) {
            if (event === 'change') listeners.push(cb);
          },
          changeAppearance(a) {
            fake.calls.push(['changeAppearance', a?.theme ?? null]);
          },
          async loadActions() {
            return {
              type: 'success',
              actions: {
                getSession: session,
                async applyPromotionCode(code) {
                  fake.calls.push(['promo', code]);
                  if (code !== 'WELCOME') return { type: 'error', error: { message: 'This code is invalid.' } };
                  discount = 0.1;
                  return { type: 'success', session: changed() };
                },
                async removePromotionCode() {
                  discount = 0;
                  return { type: 'success', session: changed() };
                },
                async updateTaxIdInfo(v) {
                  fake.calls.push(['updateTaxIdInfo', v]);
                  taxId = v?.taxId ?? null;
                  return { type: 'success', session: changed() };
                },
                async updateBusinessName(v) {
                  fake.calls.push(['updateBusinessName', v]);
                  return { type: 'success', session: changed() };
                },
                async confirm(o) {
                  fake.calls.push(['confirm', o?.redirect ?? null]);
                  const r = await confirm(clientSecret, discount ? 'WELCOME' : null);
                  return r.error ? { type: 'error', error: r.error } : { type: 'success', session: session() };
                },
              },
            };
          },
        };
      },
      elements({ clientSecret, ...o }) {
        fake.calls.push(['elements', clientSecret]);
        fake.options = { ...fake.options, elements: o };
        return {
          __secret: clientSecret,
          // a setup's or a payment's card: its terms are a line longer than a checkout's
          create: (kind, o) => {
            fake.options = { ...fake.options, intent: o };
            return element(kind === 'payment' ? 'intent' : kind);
          },
          submit: async () => ({}),
          update: (u) => fake.calls.push(['update', u?.appearance?.theme ?? null]),
        };
      },
      async confirmSetup({ elements, redirect }) {
        fake.calls.push(['confirmSetup', redirect]);
        const r = await confirm(elements.__secret, null);
        return r.error ? { error: r.error } : { setupIntent: { status: 'succeeded', payment_method: r.method } };
      },
      async confirmPayment({ elements, redirect }) {
        fake.calls.push(['confirmPayment', redirect]);
        const r = await confirm(elements.__secret, null);
        return r.error ? { error: r.error } : { paymentIntent: { status: 'succeeded', payment_method: r.method } };
      },
    };
  };
})();
