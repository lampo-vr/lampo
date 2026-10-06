// A hosted store for the operator's pages, written before its server starts (startServer's `seed`): a dozen workspaces
// in every state a plan can be in — a trial ending soon and tomorrow, Solo, Team and Business paid, Free, grace after a
// failed payment and after a trial, read-only, complimentary by hand, a trial run to a day by hand, one where nothing
// happened yet — with long names and long addresses where real ones get long, members, videos and storage of real size
// (review.json records only: no footage is needed to count them) and their last activity; ~30 accounts with roles in
// one or several, one disabled, one sign-up waiting for its link, one in no workspace; and the billing stand-in's
// state for each (test/e2e/lib/billingModule.ts reads FAKE_BILLING_FILE). Everything here is invented.
//
//   VR_MODE=server VR_DATA=… VR_CACHE=… VR_CONFIG=… FAKE_BILLING_FILE=… node test/e2e/lib/operatorStore.ts
//
// Never on a real store: it refuses a VR_DATA that has anything in it.
import fs from 'node:fs';
import path from 'node:path';

const DATA = process.env.VR_DATA;
const FAKE = process.env.FAKE_BILLING_FILE;
if (!DATA || !FAKE) throw new Error('operatorStore: VR_DATA and FAKE_BILLING_FILE must name the new store');
if (fs.existsSync(DATA) && fs.readdirSync(DATA).length) throw new Error(`operatorStore: ${DATA} is not empty`);

const auth = await import('../../../lib/auth.ts');
const ws = await import('../../../lib/workspaces.ts');
const { slugify, workspaceRoot } = await import('../../../lib/paths.ts');

export const PASSWORD = 'a long enough password';
const H = 3_600_000;
const D = 24 * H;
const NOW = Date.now();
const iso = (t: number) => new Date(t).toISOString();

// ---------------------------------------------------------------- people

const made = new Map<string, string>();
async function person(name: string, email: string, role: 'owner' | 'admin' | 'member' | 'reviewer' = 'member'): Promise<string> {
  const u = await auth.createUser({ email, name, password: PASSWORD, role });
  made.set(email, u.id);
  return u.id;
}
// workspace #1, the operator's own: Olivia owns it, Noor runs the server (LAMPO_OPERATOR), Max works there
const olivia = await person('Olivia Hart', 'olivia@lampo.test', 'owner');
const noor = await person('Noor Haddad', 'noor@lampo.test', 'admin');
await person('Max Field', 'max@lampo.test', 'member');
ws.migrateWorkspaces();
const W1 = 'w1';
ws.renameWorkspace(W1, 'Lampo');

interface Spec {
  name: string;
  owner: [string, string];
  /** Further people: [name, email, role]. An email already made joins with its account. */
  people: [string, string, 'admin' | 'member' | 'reviewer'][];
  videos: number;
  bytes: number;
  /** Days ago it was made, and hours ago anything last happened (null: nothing yet). */
  made: number;
  active: number | null;
  billing: Record<string, unknown>;
  override?: Record<string, unknown>;
  log?: Record<string, unknown>[];
}

const GB = 1e9;
const TB = 1e12;
const by = { account: noor, name: 'Noor Haddad', email: 'noor@lampo.test' };
const SPECS: Spec[] = [
  {
    name: 'Kestrel Motion',
    owner: ['Lee Quinn', 'lee@kestrel.test'],
    people: [
      ['Mia Stone', 'mia@kestrel.test', 'member'],
      ['Jonas Weber', 'jonas@kestrel.test', 'member'],
      ['Priya Raman', 'priya@kestrel.test', 'reviewer'],
    ],
    videos: 9,
    bytes: 128 * GB,
    made: 9,
    active: 2,
    billing: { plan: 'team', planName: 'Team', state: 'trial', trialEndsAt: iso(NOW + 5 * D) },
  },
  {
    name: 'Ferngrove Post-Production & Colour Collective — Berlin and Lisbon Offices',
    owner: ['Ana Beatriz Ribeiro-Vasconcelos', 'ana.beatriz.ribeiro-vasconcelos@ferngrove-colour-collective.test'],
    people: [
      ['Tomás Ferreira', 'tomas@ferngrove-colour-collective.test', 'admin'],
      ['Hanna Schulte-Bergmann', 'hanna.schulte-bergmann@ferngrove-colour-collective.test', 'member'],
      ['Dmitri Volkov', 'dmitri@ferngrove-colour-collective.test', 'member'],
      ['Inês Carvalho', 'ines@ferngrove-colour-collective.test', 'member'],
      ['Felix Krämer', 'felix@ferngrove-colour-collective.test', 'member'],
      ['Sofia Lindqvist', 'sofia@ferngrove-colour-collective.test', 'reviewer'],
      ['Mia Stone', 'mia@kestrel.test', 'reviewer'],
    ],
    videos: 87,
    bytes: 2.4 * TB,
    made: 64,
    active: 0.2,
    billing: { plan: 'team', planName: 'Team', state: 'paid', interval: 'year', limits: { members: 50, bytes: 8 * TB, activeVideos: null } },
  },
  {
    name: 'Atlas Reels',
    owner: ['Rafael Ortiz', 'rafael@atlasreels.test'],
    people: [],
    videos: 23,
    bytes: 212 * GB,
    made: 41,
    active: 26,
    billing: { plan: 'solo', planName: 'Solo', state: 'paid', interval: 'month' },
  },
  {
    name: 'Larkspur Studio',
    owner: ['Elif Demir', 'elif@larkspur.test'],
    people: [],
    videos: 2,
    bytes: 4.2 * GB,
    made: 30,
    active: 6 * 24,
    billing: { plan: 'free', planName: 'Free', state: 'free' },
  },
  {
    name: 'Tidewater Films',
    owner: ['Samuel Okafor', 'samuel@tidewater.test'],
    people: [
      ['Grace Liu', 'grace@tidewater.test', 'admin'],
      ['Ben Hollis', 'ben@tidewater.test', 'member'],
      ['Clara Novak', 'clara@tidewater.test', 'member'],
    ],
    videos: 31,
    bytes: 1.1 * TB,
    made: 120,
    active: 5,
    billing: { plan: 'team', planName: 'Team', state: 'grace', reason: 'payment', graceUntil: iso(NOW + 4 * D) },
  },
  {
    name: 'Pinecone Animation',
    owner: ['Yuki Tanaka', 'yuki@pinecone.test'],
    people: [
      ['Omar Haddou', 'omar@pinecone.test', 'member'],
      ['Lena Brandt', 'lena@pinecone.test', 'member'],
    ],
    videos: 7,
    bytes: 38 * GB,
    made: 52,
    active: 3 * 24,
    billing: { plan: 'free', planName: 'Free', state: 'read-only', reason: 'over-limit' },
  },
  {
    name: 'Harbor & Pine',
    owner: ['Chloé Martin', 'chloe@harborpine.test'],
    people: [['Arjun Mehta', 'arjun@harborpine.test', 'member']],
    videos: 4,
    bytes: 46 * GB,
    made: 13,
    active: 20,
    billing: { plan: 'team', planName: 'Team', state: 'trial', trialEndsAt: iso(NOW + 1 * D) },
  },
  {
    name: 'Mosaic Edit House',
    owner: ['Daniel Kim', 'daniel@mosaic-edit.test'],
    people: [
      ['Sara Nilsson', 'sara@mosaic-edit.test', 'admin'],
      ['Leo Brandt', 'leo@mosaic-edit.test', 'member'],
    ],
    videos: 15,
    bytes: 640 * GB,
    made: 75,
    active: 30,
    billing: { plan: 'free', planName: 'Free', state: 'free' },
    override: { kind: 'complimentary', plan: 'team', at: iso(NOW - 20 * D), by, reason: 'Launch partner: a year of Team, agreed by email' },
    log: [{ at: iso(NOW - 20 * D), by, change: { kind: 'complimentary', plan: 'team' }, reason: 'Launch partner: a year of Team, agreed by email' }],
  },
  {
    name: 'Quietfield',
    owner: ['Ivo Petrov', 'ivo@quietfield.test'],
    people: [],
    videos: 0,
    bytes: 0,
    made: 1,
    active: null,
    billing: { plan: 'free', planName: 'Free', state: 'free' },
  },
  {
    name: 'Brightwater Social Content Team',
    owner: ['Maya Goldberg', 'maya@brightwater-social.test'],
    people: [
      ['Ethan Brooks', 'ethan@brightwater-social.test', 'admin'],
      ['Zoe Adams', 'zoe@brightwater-social.test', 'member'],
      ['Lucas Moreau', 'lucas@brightwater-social.test', 'member'],
      ['Nina Petrova', 'nina@brightwater-social.test', 'member'],
      ['Kenji Sato', 'kenji@brightwater-social.test', 'reviewer'],
    ],
    videos: 64,
    bytes: 6.1 * TB,
    made: 210,
    active: 1,
    billing: { plan: 'business', planName: 'Business', state: 'paid', interval: 'year', limits: { members: null, bytes: 12 * TB, activeVideos: null } },
  },
  {
    name: 'Solstice Documentary Unit',
    owner: ['Hugo Lefèvre', 'hugo@solstice-docs.test'],
    people: [['Amara Osei', 'amara@solstice-docs.test', 'member']],
    videos: 11,
    bytes: 380 * GB,
    made: 19,
    active: 48,
    billing: { plan: 'team', planName: 'Team', state: 'free' },
    override: { kind: 'trial', until: iso(NOW + 20 * D), at: iso(NOW - 2 * D), by, reason: 'Festival season: two more weeks to decide' },
    log: [{ at: iso(NOW - 2 * D), by, change: { kind: 'trial', until: iso(NOW + 20 * D) }, reason: 'Festival season: two more weeks to decide' }],
  },
  {
    name: 'Ember Cut',
    owner: ['Fatima Zahra', 'fatima@embercut.test'],
    people: [['Noah Klein', 'noah@embercut.test', 'member']],
    videos: 5,
    bytes: 27 * GB,
    made: 23,
    active: 72,
    billing: { plan: 'free', planName: 'Free', state: 'grace', reason: 'trial-ended', graceUntil: iso(NOW + 3 * D) },
  },
];

const billing: {
  workspaces: Record<string, unknown>;
  overrides: Record<string, unknown>;
  oplog: Record<string, unknown[]>;
  accounts: object;
  sessions: object;
  calls: unknown[];
  seq: number;
} = { workspaces: {}, overrides: {}, oplog: {}, accounts: {}, sessions: {}, calls: [], seq: 0 };
const createdAt: Record<string, string> = {};
const activeAt: Record<string, number | null> = {};

for (const spec of SPECS) {
  const ownerId = made.get(spec.owner[1]) ?? (await person(spec.owner[0], spec.owner[1]));
  const w = ws.createWorkspace({ name: spec.name, ownerId }).id;
  if (ws.roleIn(W1, ownerId)) ws.removeMember(W1, ownerId);
  for (const [name, email, role] of spec.people) {
    const id = made.get(email) ?? (await person(name, email));
    if (ws.roleIn(W1, id) && id !== olivia && id !== noor) ws.removeMember(W1, id);
    ws.addMember(w, id, role);
  }
  billing.workspaces[w] = spec.billing;
  if (spec.override) billing.overrides[w] = spec.override;
  if (spec.log) billing.oplog[w] = spec.log;
  createdAt[w] = iso(NOW - spec.made * D);
  activeAt[w] = spec.active;
  // its videos: review.json records of the right size (nothing to play: the operator's pages only count them)
  const root = workspaceRoot(w).data;
  for (let i = 0; i < spec.videos; i++) {
    const video = `/@uploads/Spots/spot-${String(i + 1).padStart(3, '0')}.mp4`;
    const slug = slugify(video);
    const size = Math.round(spec.bytes / spec.videos);
    const at = iso(NOW - (spec.made - (i * spec.made) / Math.max(1, spec.videos)) * D);
    const review = {
      id: `vid_${w.slice(2, 8)}${String(i).padStart(4, '0')}`,
      video,
      project: 'Spots',
      fps: 25,
      width: 1920,
      height: 1080,
      duration: 30,
      frames: 750,
      versions: [{ v: 1, hash: `h${w}${i}`, mtime: at, size, frames: 750, fps: 25, width: 1920, height: 1080, duration: 30, registered: at }],
      comments: [],
      session: null,
      folder: 'Spots',
      added: at,
      added_by: spec.owner[0],
      ...(i % 3 === 2 ? { final: { v: 1, by: spec.owner[0], at, note: null } } : {}),
    };
    fs.mkdirSync(path.join(root, slug), { recursive: true });
    fs.writeFileSync(path.join(root, slug, 'review.json'), `${JSON.stringify(review, null, 2)}\n`);
  }
  if (spec.active !== null) {
    fs.mkdirSync(root, { recursive: true });
    const line = {
      at: iso(NOW - spec.active * H),
      type: 'comment',
      by: spec.owner[0],
      video: 'spot-001.mp4',
      slug: slugify('/@uploads/Spots/spot-001.mp4'),
      session: null,
    };
    fs.appendFileSync(path.join(root, 'events.jsonl'), `${JSON.stringify(line)}\n`);
  }
}

// one account disabled, one sign-up still waiting for its link, one that left every workspace
await auth.updateUser(made.get('clara@tidewater.test') as string, { disabled: true }, { memberships: true });
await auth.signUp({ email: 'wren@pending-signup.test', name: 'Wren Calloway', password: PASSWORD, mode: 'open', anyName: true });
const left = await person('Orla Byrne', 'orla@formerly.test');
if (ws.roleIn(W1, left)) ws.removeMember(W1, left);

// when things were made and last signed in to, spread over the weeks (the registry and the accounts file as written)
const wsFile = path.join(DATA, 'workspaces.json');
const reg = JSON.parse(fs.readFileSync(wsFile, 'utf8'));
for (const w of reg.workspaces) {
  if (createdAt[w.id]) w.created = createdAt[w.id];
  if (w.id === W1) w.created = iso(NOW - 400 * D);
}
fs.writeFileSync(wsFile, `${JSON.stringify(reg, null, 2)}\n`);
const usersFile = auth.USERS_FILE;
const users = JSON.parse(fs.readFileSync(usersFile, 'utf8'));
users.users.forEach((u: { email: string; created: string; signed_in?: string }, i: number) => {
  u.created = iso(NOW - Math.max(4, 300 - i * 7) * D);
  if (u.email === 'wren@pending-signup.test') {
    u.created = iso(NOW - 2 * H);
    return;
  }
  if (u.email === 'olivia@lampo.test' || u.email === 'noor@lampo.test' || i % 5 !== 4) u.signed_in = iso(NOW - ((i * 7) % 90) * H - 600_000);
});
fs.writeFileSync(usersFile, `${JSON.stringify(users, null, 2)}\n`);
fs.chmodSync(usersFile, 0o600);

fs.writeFileSync(FAKE, JSON.stringify(billing, null, 2));
if (process.argv.includes('--print'))
  console.log(JSON.stringify({ workspaces: reg.workspaces.map((w: { id: string; name: string }) => [w.id, w.name]) }, null, 2));
