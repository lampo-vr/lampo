// A stand-in billing provider for the browser suites (test/e2e/billing.mjs): what a private module behind
// server/extension.ts would be, loaded the same way (VR_CLOUD_MODULE), with nothing real behind it. Each workspace's
// state lives in a JSON file the suite writes (FAKE_BILLING_FILE: { workspaces: { [workspace]: Partial<BillingInfo> },
// accounts, sessions, calls }); a sign-up is placed through the app and gets a trial. Paying happens on the page:
// checkout, a new payment method and an open invoice each answer a client secret, and the stand-in Stripe.js the suite
// serves for js.stripe.com (test/e2e/lib/fakeStripe.js) "confirms" it through `/api/billing/fake/confirm`, the way
// Stripe's signed events would reach a real module. It asks for Stripe's CSP sources like the real one, so the suite's
// stand-in script only runs when the app's policy lets js.stripe.com in. Every write is written down (`calls`). The
// operator's pages (test/e2e/operator-admin.mjs) read each workspace's plan through its `operator` hook and set one by
// hand: the override and its log live in the same file (`overrides`, `oplog`), as the real module keeps them. A
// workspace's `reverseCharge: true` is the real module with the seller's VAT ID set; its `cancelWays` is what the cancel
// step's GET /api/billing/cancel answers (a consumer's yearly plan after its first year: one month's notice, a refund).
import fs from 'node:fs';

type Json = Record<string, unknown>;
interface Host {
  publicUrl: string;
  who(req: unknown): { workspace: string; role: string; via: string } | null;
  sameOrigin(req: unknown): boolean;
  usage(w: string): Promise<{ members: number; bytes: number; activeVideos: number; room?: { videos: number; bytes: number } }>;
  placeSignup(account: string, o?: { reset?: boolean }): Promise<{ workspace: string | null; own: boolean }>;
  funnel?(workspace: string, step: 'trial_end' | 'plan_paid', o?: { plan?: string; active?: boolean }): void;
}
interface Req {
  body?: Json;
}
interface Method {
  id: string;
  type: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  default: boolean;
}
interface Invoice {
  id: string;
  number: string;
  date: string;
  total: number;
  currency: string;
  status: 'paid' | 'open';
  pdf: string;
}
interface Account {
  details: { name: string | null; email: string | null; address: Json | null; taxIds: { id: string; type: string; value: string; verification?: Json }[] };
  methods: Method[];
  invoices: Invoice[];
}
interface Data {
  workspaces: Record<string, Json>;
  accounts: Record<string, Account>;
  sessions: Record<string, Json>;
  calls: Json[];
  seq: number;
  /** Plans the operator set by hand, and their log (oldest first). */
  overrides?: Record<string, Json & { kind: string; plan?: string; until?: string }>;
  oplog?: Record<string, Json[]>;
}
const PLAN_NAMES: Record<string, string> = { free: 'Free', solo: 'Solo', team: 'Team', business: 'Business' };

const DAY = 86_400_000;
const OFFERS = [
  {
    plan: 'solo',
    name: 'Solo',
    perMember: false,
    members: { min: 1, max: 1 },
    bytes: { base: 5e11, perMember: 0 },
    activeVideos: null,
    month: 1500,
    year: 14400,
  },
  {
    plan: 'team',
    name: 'Team',
    perMember: true,
    members: { min: 2, max: 50 },
    bytes: { base: 1e12, perMember: 5e11 },
    activeVideos: null,
    month: 2400,
    year: 24000,
  },
  {
    plan: 'business',
    name: 'Business',
    perMember: true,
    members: { min: 1, max: null },
    bytes: { base: 2e12, perMember: 1e12 },
    activeVideos: null,
    month: 4200,
    year: 42000,
  },
];
const LIMITS: Record<string, { members: number | null; bytes: number | null; activeVideos: number | null }> = {
  free: { members: 1, bytes: 1e10, activeVideos: 3 },
  solo: { members: 1, bytes: 5e11, activeVideos: null },
  team: { members: 50, bytes: 1e12, activeVideos: null },
  business: { members: null, bytes: 2e12, activeVideos: null },
};

export default async function fakeBilling(host: Host, env: Record<string, string | undefined>) {
  const file = env.FAKE_BILLING_FILE as string;
  const read = (): Data => {
    try {
      return { workspaces: {}, accounts: {}, sessions: {}, calls: [], seq: 0, ...JSON.parse(fs.readFileSync(file, 'utf8')) };
    } catch {
      return { workspaces: {}, accounts: {}, sessions: {}, calls: [], seq: 0 };
    }
  };
  const write = (d: Data) => fs.writeFileSync(file, JSON.stringify(d, null, 2));
  const stateOf = (w: string): Json => read().workspaces[w] ?? { plan: 'free', planName: 'Free', state: 'free' };
  const update = <T>(fn: (d: Data) => T): T => {
    const d = read();
    const out = fn(d);
    write(d);
    return out;
  };
  const change = (w: string, patch: Json, call?: Json) =>
    update((d) => {
      d.workspaces[w] = { ...(d.workspaces[w] ?? {}), ...patch };
      if (call) d.calls.push(call);
    });
  const readOnly = (w: string) => stateOf(w).state === 'read-only';
  const refuse = {
    ok: false as const,
    reason: 'read-only' as const,
    message: 'This workspace is over its plan, so it is read-only for now. Nothing is deleted.',
    messages: { de: 'Dieser Workspace ist über seinem Plan und deshalb vorerst nur lesbar. Nichts wird gelöscht.' },
    upgrade: 'team',
  };
  const decide = async (w: string) => (readOnly(w) ? refuse : { ok: true as const });
  /** What the workspace's plan holds: its own limits when the suite set them, the plan's, and extra terabytes on top. */
  const limitsOf = (w: string) => {
    // w1 is the operator's own, complimentary: no limits (as GET /api/billing says)
    if (w === 'w1') return { members: null, bytes: null, activeVideos: null };
    const s = stateOf(w);
    const l = { ...((s.limits as typeof LIMITS.free | undefined) ?? LIMITS[String(s.plan ?? 'free')] ?? LIMITS.free) };
    const extra = Number((s.addons as { storageTB?: number } | undefined)?.storageTB ?? 0);
    if (l.bytes !== null && extra) l.bytes += extra * 1e12;
    return l;
  };
  /** The smallest step that fits, as the real module says it: Free → Solo for room, Team for people; Team → one more terabyte. */
  const fitsFor = (w: string, reason: 'storage' | 'members' | 'videos') => {
    const plan = String(stateOf(w).plan ?? 'free');
    if (reason === 'members') return plan === 'business' ? undefined : plan === 'team' ? 'business' : 'team';
    if (reason === 'storage' && (plan === 'team' || plan === 'business') && stateOf(w).state === 'paid') return 'addon:storage_tb';
    return plan === 'free' ? 'solo' : plan === 'solo' ? 'team' : 'business';
  };
  // the plan's limits, said like the real module: the reason, what was asked for, the room the app counts, what fits
  const canUpload = async (w: string, bytes: number) => {
    if (readOnly(w)) return refuse;
    const room = limitsOf(w).bytes;
    const counted = await host.usage(w);
    const used = Number((stateOf(w).usage as Json | undefined)?.bytes ?? counted.bytes);
    if (room === null || used + bytes <= room) return { ok: true as const };
    return {
      ok: false as const,
      reason: 'storage' as const,
      message: 'This workspace’s plan has no room for this file.',
      messages: { de: 'Der Plan dieses Workspace hat keinen Platz für diese Datei.' },
      needed: bytes,
      ...(counted.room ? { room: counted.room } : {}),
      fits: fitsFor(w, 'storage'),
    };
  };
  const canAddMember = async (w: string) => {
    if (readOnly(w)) return refuse;
    const room = limitsOf(w).members;
    if (room === null || (await host.usage(w)).members < room) return { ok: true as const };
    return {
      ok: false as const,
      reason: 'members' as const,
      message: 'This workspace’s plan has no room for another member.',
      messages: { de: 'Der Plan dieses Workspace hat keinen Platz für ein weiteres Mitglied.' },
      fits: fitsFor(w, 'members'),
    };
  };
  const canAddVideo = async (w: string) => {
    if (readOnly(w)) return refuse;
    const room = limitsOf(w).activeVideos;
    if (room === null || (await host.usage(w)).activeVideos < room) return { ok: true as const };
    return {
      ok: false as const,
      reason: 'videos' as const,
      message: 'This workspace’s plan has no room for another video under review.',
      messages: { de: 'Der Plan dieses Workspace hat keinen Platz für ein weiteres Video im Review.' },
      fits: fitsFor(w, 'videos'),
    };
  };
  const json = (status: number, body: unknown) => ({ status, json: body });
  // owners and admins, in person, from this app: what the real module asks of every billing write
  const manager = (req: unknown, write = true) => {
    const who = host.who(req);
    if (!who) return { error: json(401, { error: 'Sign in first.' }) };
    if ((who.role !== 'owner' && who.role !== 'admin') || who.via === 'token') return { error: json(403, { error: 'Only owners and admins manage billing.' }) };
    if (write && !host.sameOrigin(req)) return { error: json(403, { error: 'Refused: not from this app.' }) };
    return { who };
  };
  // every write and the account: an owner's or admin's, a person's alone (the app holds callers to this, BILL-10)
  const route = (method: 'GET' | 'POST', path: string, fn: (who: { workspace: string }, req: Req) => Promise<{ status: number; json: unknown }>) => ({
    method,
    path,
    role: 'admin' as const,
    person: true,
    async handle(req: Req) {
      const m = manager(req, method === 'POST');
      return m.error ?? fn(m.who as { workspace: string }, req);
    },
  });
  const units = async (w: string, offer: (typeof OFFERS)[number]) => (offer.perMember ? Math.max(offer.members.min, (await host.usage(w)).members) : 1);
  const accountOf = (d: Data, w: string): Account => {
    d.accounts[w] ??= { details: { name: null, email: null, address: null, taxIds: [] }, methods: [], invoices: [] };
    return d.accounts[w];
  };
  const secret = (d: Data, kind: string, w: string, extra: Json, label: string) => {
    const s = `${label}_${++d.seq}_secret_fake`;
    d.sessions[s] = { kind, workspace: w, ...extra };
    return s;
  };
  const card = (d: Data, brand: string, last4: string): Method => ({
    id: `pm_fake${++d.seq}`,
    type: 'card',
    brand,
    last4,
    expMonth: 12,
    expYear: 2031,
    default: false,
  });
  const setDefault = (a: Account, id: string) => {
    for (const m of a.methods) m.default = m.id === id;
  };
  return {
    name: 'fake-billing',
    billing: true,
    // what the real module asks for while paying works: Stripe.js, its frames, its API
    contentSecurity: {
      script: ['https://js.stripe.com', 'https://*.js.stripe.com'],
      frame: ['https://js.stripe.com', 'https://*.js.stripe.com', 'https://hooks.stripe.com'],
      connect: ['https://api.stripe.com'],
      img: ['https://*.stripe.com'],
    },
    entitlements: {
      get: async (w: string) => stateOf(w),
      canUpload,
      canAddMember,
      canAddVideo,
      canShare: decide,
      // a paid plan (in grace too) may hide "Powered by Lampo" on its review links, as Lampo Cloud says (A13 CLOUD-7)
      canHideBadge: async (w: string) => stateOf(w).state === 'paid' || (stateOf(w).state === 'grace' && stateOf(w).reason === 'payment'),
    },
    workspaces: {},
    // the operator's pages: each workspace's plan as the suite wrote it, an override set by hand on top
    operator: {
      async plans(list: { workspace: string; usage: { bytes: number } }[]) {
        const d = read();
        const out: Record<string, Json> = {};
        for (const { workspace: w } of list) {
          const o = d.overrides?.[w];
          const s = stateOf(w);
          if (w === 'w1') out[w] = { plan: 'business', name: 'Business', state: 'complimentary', storage: null, fixed: 'own' };
          else if (o?.kind === 'complimentary') out[w] = { plan: o.plan, name: PLAN_NAMES[String(o.plan)], state: 'complimentary', storage: null, override: o };
          else if (o?.kind === 'trial') out[w] = { plan: 'team', name: 'Team', state: 'trial', trialEndsAt: o.until, storage: LIMITS.team.bytes, override: o };
          else
            out[w] = {
              plan: String(s.plan ?? 'free'),
              name: PLAN_NAMES[String(s.plan ?? 'free')] ?? String(s.planName),
              state: s.state === 'trial' || s.state === 'grace' || s.state === 'read-only' ? s.state : 'active',
              ...(s.reason ? { reason: s.reason } : {}),
              ...(s.trialEndsAt ? { trialEndsAt: s.trialEndsAt } : {}),
              ...(s.graceUntil ? { graceUntil: s.graceUntil } : {}),
              storage: limitsOf(w).bytes,
              ...(s.state === 'paid' ? { paying: true } : {}),
            };
        }
        return out;
      },
      async log(w: string) {
        return [...(read().oplog?.[w] ?? [])].reverse();
      },
      async set(w: string, change: { kind: string; plan?: string; until?: string }, by: Json, reason: string) {
        if (w === 'w1') return { ok: false, reason: 'fixed', message: 'This is the server’s own workspace: it is always complimentary.' };
        if (stateOf(w).state === 'paid' && change.kind !== 'normal') return { ok: false, reason: 'paying', message: 'This workspace pays for a plan.' };
        if (change.kind === 'trial' && !(Date.parse(String(change.until)) > Date.now())) return { ok: false, reason: 'date', message: 'A day after today.' };
        if (change.kind === 'normal' && !read().overrides?.[w]) return { ok: false, reason: 'none', message: 'Nothing was set by hand here.' };
        const at = new Date().toISOString();
        update((d) => {
          d.overrides ??= {};
          d.oplog ??= {};
          if (change.kind === 'normal') delete d.overrides[w];
          else d.overrides[w] = { ...change, kind: change.kind, at, by, reason };
          d.oplog[w] = [...(d.oplog[w] ?? []), { at, by, change, reason }];
          d.calls.push({ operator: change.kind, workspace: w });
        });
        return { ok: true };
      },
    },
    async onSignup(e: { account: string; reset: boolean }) {
      const placed = await host.placeSignup(e.account, { reset: e.reset });
      if (placed.workspace && placed.own)
        change(placed.workspace, {
          plan: 'team',
          planName: 'Team',
          state: 'trial',
          trialStartsAt: new Date().toISOString(),
          trialEndsAt: new Date(Date.now() + Number(env.FAKE_TRIAL_DAYS ?? 14) * DAY).toISOString(),
        });
    },
    routes: [
      {
        method: 'GET',
        path: '/api/billing',
        // the plan is everyone's to read in the workspace; offers and the account are for owners and admins
        role: 'reviewer' as const,
        async handle(req: Req) {
          const who = host.who(req);
          if (!who) return json(401, { error: 'Sign in first.' });
          const s = stateOf(who.workspace);
          // a suite may say what the workspace uses (four members, a terabyte) without making them
          const usage = (s.usage as { members: number; bytes: number; activeVideos: number } | undefined) ?? (await host.usage(who.workspace));
          // w1 is the operator's own, as with the real module: complimentary, nothing for anyone to choose
          if (who.workspace === 'w1')
            return json(200, {
              plan: 'business',
              planName: 'Complimentary',
              state: 'paid',
              complimentary: true,
              manage: false,
              usage,
              limits: { members: null, bytes: null, activeVideos: null },
            });
          const manage = (who.role === 'owner' || who.role === 'admin') && who.via !== 'token';
          const plan = String(s.plan ?? 'free');
          // Insights, roles and webhooks come with Team and Business (and the trial, which is Team's)
          const team = plan === 'team' || plan === 'business';
          const info: Json = {
            features: { insights: team, roles: team, webhooks: team },
            ...s,
            limits: limitsOf(who.workspace),
            usage,
            manage,
            // one more terabyte, sold on a running Team or Business plan: the terabytes bought and one terabyte's price for
            // the subscription's interval (BillingInfo.addons, present with none bought too, for the limit sheet's +1 TB)
            ...(team && s.state === 'paid'
              ? { addons: { storageTB: Number((s.addons as Json | undefined)?.storageTB ?? 0), price: s.interval === 'month' ? 1000 : 10000 } }
              : {}),
          };
          delete info.customer;
          // the cancel step's other ways are their own answer (GET /api/billing/cancel), never the plan's
          delete info.cancelWays;
          delete info.keptRenewsAt;
          // what only owners and admins read: the provider's next invoice and the failed renewal's details
          if (!manage) {
            delete info.next;
            delete info.failure;
            delete info.refund;
          }
          if (manage)
            Object.assign(info, {
              available: true,
              subscribed: s.state === 'paid' || (s.state === 'grace' && !!s.customer),
              account: !!s.customer,
              payments: { provider: 'stripe', key: 'pk_test_fake' },
              // a subscription fixes its currency, as Stripe does
              currency: String(s.currency ?? 'eur'),
              currencies: s.customer && s.currency ? [s.currency] : ['eur', 'usd'],
              tax: 'excluded',
              // what a consumer pays on top, as Lampo Cloud says it: the page shows consumers gross prices (A13 CLOUD-2)
              vat: { rate: 19 },
              offers: OFFERS.map(({ month, year, ...o }) => ({
                ...o,
                prices: { eur: { month, year }, usd: { month, year } },
                fits: o.members.max === null || usage.members <= o.members.max,
                highlights: { en: [`${o.name}: the words a provider adds`], de: [`${o.name}: die Worte eines Anbieters`] },
              })),
            });
          return json(200, info);
        },
      },
      // what the buyer agreed to, right before the order (A13 CLOUD-2): a consumer's express start, or a business — with
      // its VAT ID for the invoice where there is no reverse charge (the real module prints it on the invoices)
      route('POST', '/api/billing/checkout/consent', async (who, req) => {
        const b = req.body ?? {};
        if ((b.buyer !== 'consumer' && b.buyer !== 'business') || typeof b.start !== 'boolean') return json(400, { error: 'buyer and start' });
        if (b.buyer === 'consumer' && !b.start) return json(400, { error: 'a consumer asks for the plan to start at once' });
        if (b.vatId !== undefined && (b.buyer !== 'business' || typeof b.vatId !== 'string' || !/^[A-Z0-9][A-Z0-9.\-/+*]{3,29}$/.test(b.vatId)))
          return json(400, { error: 'That VAT ID doesn’t look right. Check it, or leave it out.', code: 'tax-id-invalid' });
        update((d) => {
          d.calls.push({ kind: 'consent', workspace: who.workspace, buyer: b.buyer, start: b.start, ...(b.vatId ? { vatId: b.vatId } : {}) });
        });
        return json(200, { ok: true });
      }),
      // the cancel step's ways beyond the two every plan has: one month's notice where the suite gave the workspace one
      // (`cancelWays`, as the real module answers for a consumer's yearly plan after its first year)
      route('GET', '/api/billing/cancel', async (who) => json(200, (stateOf(who.workspace).cancelWays as Json | undefined) ?? {})),
      route('POST', '/api/billing/checkout', async (who, req) => {
        const b = req.body ?? {};
        const offer = OFFERS.find((o) => o.plan === b.plan);
        if (!offer) return json(400, { error: 'no such plan' });
        const n = await units(who.workspace, offer);
        const unit = b.interval === 'year' ? offer.year : offer.month;
        // a trial with days to spare carries over into Solo and Team (not Business, as the real module): nothing is due today
        const s = stateOf(who.workspace);
        const trial = s.state === 'trial' && Date.parse(String(s.trialEndsAt)) - Date.now() > 2 * DAY && offer.plan !== 'business';
        const clientSecret = update((d) => {
          d.calls.push({ kind: 'checkout', workspace: who.workspace, ...b });
          // like the real module: the workspace's Stripe customer is made when a checkout starts, so the account
          // (empty until paid) shows from then on
          d.workspaces[who.workspace] = { ...d.workspaces[who.workspace], customer: true };
          // the secret carries what is due today and the plan's full price (`_f…`: the first payment after a trial)
          return secret(
            d,
            'checkout',
            who.workspace,
            { ...b, amount: trial ? 0 : n * unit, units: n },
            `cs_fake_${trial ? 0 : n * unit}_${b.currency}_f${n * unit}`,
          );
        });
        return json(200, { clientSecret });
      }),
      {
        // what the stand-in Stripe.js sends when the page confirms: Stripe's events, in short
        method: 'POST',
        path: '/api/billing/fake/confirm',
        role: 'admin' as const,
        person: true,
        async handle(req: Req) {
          const who = host.who(req);
          if (!who) return json(401, { error: 'Sign in first.' });
          return update((d) => {
            const s = d.sessions[String(req.body?.clientSecret)];
            if (!s || s.workspace !== who.workspace) return json(404, { error: 'no such session' });
            const a = accountOf(d, who.workspace);
            d.calls.push({ kind: `confirm-${s.kind}`, workspace: who.workspace, promo: req.body?.promo ?? null });
            if (s.kind === 'checkout') {
              const offer = OFFERS.find((o) => o.plan === s.plan) as (typeof OFFERS)[number];
              const m = card(d, 'visa', '4242');
              a.methods.push(m);
              setDefault(a, m.id);
              a.invoices.unshift({
                id: `in_fake${++d.seq}`,
                number: `LAMPO-000${d.seq}`,
                date: new Date().toISOString(),
                total: Number(s.amount),
                currency: String(s.currency),
                status: 'paid',
                pdf: `${host.publicUrl}/fake-invoice-${d.seq}.pdf`,
              });
              a.details = {
                ...a.details,
                name: 'Pia Brandt',
                email: 'pia@e2e.test',
                address: { line1: 'Hafenstraße 1', postalCode: '20457', city: 'Hamburg', country: 'DE' },
              };
              d.workspaces[who.workspace] = {
                ...d.workspaces[who.workspace],
                plan: offer.plan,
                planName: offer.name,
                state: 'paid',
                customer: true,
                interval: s.interval,
                currency: s.currency,
                renewsAt: new Date(Date.now() + (s.interval === 'year' ? 365 : 30) * DAY).toISOString(),
                limits: LIMITS[offer.plan],
                seats: offer.perMember ? s.units : undefined,
                trialEndsAt: undefined,
              };
              host.funnel?.(who.workspace, 'plan_paid', { plan: offer.plan });
              return json(200, { method: m.id });
            }
            if (s.kind === 'setup') {
              const m = card(d, 'mastercard', '4444');
              a.methods.push(m);
              return json(200, { method: m.id });
            }
            const open = a.invoices.find((i) => i.status === 'open');
            if (open) open.status = 'paid';
            const m = card(d, 'amex', '0005');
            a.methods.push(m);
            d.workspaces[who.workspace] = { ...d.workspaces[who.workspace], state: 'paid', reason: undefined, graceUntil: undefined, failure: undefined };
            return json(200, { method: m.id });
          });
        },
      },
      route('GET', '/api/billing/account', async (who) => {
        if (!stateOf(who.workspace).customer) return json(409, { error: 'This workspace has no billing account yet: choose a plan first.' });
        return json(200, accountOf(read(), who.workspace));
      }),
      route('POST', '/api/billing/payment-method', async (who) =>
        json(200, { clientSecret: update((d) => secret(d, 'setup', who.workspace, {}, 'seti_fake')) }),
      ),
      route('POST', '/api/billing/payment-method/default', async (who, req) =>
        update((d) => {
          const a = accountOf(d, who.workspace);
          if (!a.methods.some((m) => m.id === req.body?.id)) return json(404, { error: 'No such payment method.' });
          setDefault(a, String(req.body?.id));
          d.calls.push({ kind: 'default', workspace: who.workspace, id: req.body?.id });
          return json(200, { ok: true });
        }),
      ),
      route('POST', '/api/billing/payment-method/remove', async (who, req) =>
        update((d) => {
          const a = accountOf(d, who.workspace);
          const m = a.methods.find((x) => x.id === req.body?.id);
          if (!m) return json(404, { error: 'No such payment method.' });
          if (m.default) return json(409, { error: 'Renewals are charged to this one. Make another payment method the default first.' });
          a.methods = a.methods.filter((x) => x !== m);
          d.calls.push({ kind: 'remove', workspace: who.workspace, id: m.id });
          return json(200, { ok: true });
        }),
      ),
      route('POST', '/api/billing/details', async (who, req) =>
        update((d) => {
          const a = accountOf(d, who.workspace);
          const b = req.body ?? {};
          a.details = { ...a.details, name: String(b.name), email: (b.email as string) ?? a.details.email, address: b.address as Json };
          d.calls.push({ kind: 'details', workspace: who.workspace, ...b });
          return json(200, { ok: true });
        }),
      ),
      route('POST', '/api/billing/tax-id', async (who, req) => {
        const b = req.body ?? {};
        if (!/^[A-Z]{2}\d{9}$/.test(String(b.value))) return json(400, { error: 'That tax ID doesn’t look right for its country. Check it and try again.' });
        return update((d) => {
          const a = accountOf(d, who.workspace);
          // VIES, in short: a known number answers with the name it is registered to
          const verification = { status: 'verified', name: [a.details.name, (a.details.address as { city?: string } | null)?.city].filter(Boolean).join(', ') };
          const x = { id: `txi_fake${++d.seq}`, type: String(b.type), value: String(b.value), verification };
          a.details.taxIds.push(x);
          d.calls.push({ kind: 'tax-id', workspace: who.workspace, ...b });
          return json(200, x);
        });
      }),
      route('POST', '/api/billing/tax-id/remove', async (who, req) =>
        update((d) => {
          const a = accountOf(d, who.workspace);
          a.details.taxIds = a.details.taxIds.filter((x) => x.id !== req.body?.id);
          return json(200, { ok: true });
        }),
      ),
      route('POST', '/api/billing/invoice/pay', async (who) =>
        update((d) => {
          const open = accountOf(d, who.workspace).invoices.find((i) => i.status === 'open');
          if (!open) return json(409, { error: 'There is no open invoice to pay.' });
          return json(200, { clientSecret: secret(d, 'payment', who.workspace, { invoice: open.id }, 'pi_fake'), amount: open.total, currency: open.currency });
        }),
      ),
      {
        // a member who can't pay tells the owners and admins: once per failed renewal
        method: 'POST',
        path: '/api/billing/nudge',
        role: 'reviewer' as const,
        person: true,
        async handle(req: Req) {
          const who = host.who(req);
          if (!who) return json(401, { error: 'Sign in first.' });
          if (!host.sameOrigin(req)) return json(403, { error: 'Refused: not from this app.' });
          const s = stateOf(who.workspace);
          if (s.reason !== 'payment') return json(409, { error: 'Nothing to tell: the payments are fine.' });
          return update((d) => {
            const told = d.calls.some((c) => c.kind === 'nudge' && c.workspace === who.workspace && c.invoice === (s.failure as Json | undefined)?.invoice);
            if (!told) d.calls.push({ kind: 'nudge', workspace: who.workspace, invoice: (s.failure as Json | undefined)?.invoice ?? null });
            return json(200, told ? { already: true } : { notified: true });
          });
        },
      },
      route('POST', '/api/billing/plan/preview', async (who, req) => {
        const offer = OFFERS.find((o) => o.plan === req.body?.plan);
        if (!offer) return json(400, { error: 'no such plan' });
        const n = await units(who.workspace, offer);
        const next = n * (req.body?.interval === 'year' ? offer.year : offer.month);
        const cur = OFFERS.find((o) => o.plan === stateOf(who.workspace).plan);
        const now = cur ? (await units(who.workspace, cur)) * (stateOf(who.workspace).interval === 'year' ? cur.year : cur.month) : 0;
        return json(200, {
          amount: next,
          currency: String(stateOf(who.workspace).currency ?? 'usd'),
          date: new Date(Date.now() + 16 * DAY).toISOString(),
          // the difference for the rest of the period, on that invoice (the real module: Stripe's proration lines)
          prorated: Math.max(0, Math.round(((next - now) * 16) / 30)),
        });
      }),
      route('POST', '/api/billing/plan', async (who, req) => {
        const offer = OFFERS.find((o) => o.plan === req.body?.plan);
        if (!offer) return json(400, { error: 'no such plan' });
        change(
          who.workspace,
          { plan: offer.plan, planName: offer.name, interval: req.body?.interval, limits: LIMITS[offer.plan] },
          { kind: 'plan', workspace: who.workspace, ...req.body },
        );
        return json(202, { ok: true });
      }),
      // extra storage on a running plan, on the card on file (the real module: a subscription item, prorated): `tb` is
      // the terabytes in all, as the real route takes it (0 removes them); fewer is refused while the workspace holds more
      route('POST', '/api/billing/storage', async (who, req) => {
        const tb = Number(req.body?.tb);
        const s = stateOf(who.workspace);
        if (!Number.isInteger(tb) || tb < 0 || tb > 20) return json(400, { error: 'tb is a whole number of terabytes' });
        if (s.state !== 'paid') return json(409, { error: 'Extra storage comes with a running plan.' });
        const have = Number((s.addons as Json | undefined)?.storageTB ?? 0);
        if (tb < have) {
          const room = limitsOf(who.workspace).bytes;
          const used = Number((s.usage as Json | undefined)?.bytes ?? (await host.usage(who.workspace)).bytes);
          if (room !== null && used > room - (have - tb) * 1e12) return json(409, { error: 'The workspace holds more than that would leave room for.' });
        }
        change(who.workspace, { addons: { storageTB: tb } }, { kind: 'storage', workspace: who.workspace, tb });
        return json(202, { ok: true });
      }),
      // "Cancel contracts here" (§ 312k BGB): ordinary, or for an important reason; when it was received, when it ends
      route('POST', '/api/billing/cancel', async (who, req) => {
        const b = req.body ?? {};
        const kind = b.kind === 'extraordinary' ? 'extraordinary' : b.kind === 'notice' ? 'notice' : 'ordinary';
        if (kind === 'extraordinary' && String(b.reason ?? '').trim().length < 3) return json(400, { error: 'an extraordinary cancellation says its reason' });
        const s = stateOf(who.workspace);
        const receivedAt = new Date().toISOString();
        if (kind === 'notice') {
          const notice = (s.cancelWays as { notice?: { endsAt: string; refund: { amount: number; currency: string; days: number; of: number } } } | undefined)
            ?.notice;
          if (!notice) return json(409, { error: 'This plan is cancelled at the end of its period.' });
          change(
            who.workspace,
            {
              endsAt: notice.endsAt,
              renewsAt: undefined,
              refund: { amount: notice.refund.amount, currency: notice.refund.currency },
              keptRenewsAt: s.renewsAt,
            },
            { kind: 'cancel', workspace: who.workspace, how: 'notice' },
          );
          return json(202, { ok: true, kind, receivedAt, endsAt: notice.endsAt, refund: notice.refund });
        }
        change(
          who.workspace,
          { endsAt: s.renewsAt, renewsAt: undefined },
          { kind: 'cancel', workspace: who.workspace, how: kind, ...(kind === 'extraordinary' ? { reason: String(b.reason).trim() } : {}) },
        );
        return json(202, { ok: true, kind, receivedAt, endsAt: s.renewsAt ?? null });
      }),
      route('POST', '/api/billing/resume', async (who) => {
        const s = stateOf(who.workspace);
        // kept after a notice: the renewal it had, and no refund owed
        change(
          who.workspace,
          { renewsAt: s.keptRenewsAt ?? s.endsAt, endsAt: undefined, refund: undefined, keptRenewsAt: undefined },
          { kind: 'resume', workspace: who.workspace },
        );
        return json(202, { ok: true });
      }),
    ],
  };
}
