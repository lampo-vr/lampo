// A store for Insights with a history, written before its server starts (startServer's `seed`): about two months of
// synthetic videos that went round the loop — versions, notes with topics, agents' fixes (some came back as still
// wrong), checks, approvals, review links — and what was watched. Two shapes:
//   solo  one person (the asker), four projects, four agents of different kinds (Claude Code, Codex, Cursor, an MCP
//         client that only asks). The last 30 days: ten approvals at 7.8 versions on average (5.1 in the 30 days
//         before), SFX notes behind the most rounds and no rule for them (a House rule says timing, which still comes
//         up), fixes that came back, four videos waiting now on you or an agent and one on a client whose review link
//         nobody opened. No client watched anything;
//   team  the same studio with a second person writing notes: 6.2 versions to approval (7.0 before), timing the top
//         topic even with its rule, two clients through review links deciding now (one watched a stretch again and
//         again, the other half of the video).
//
//   VR_DATA=… VR_CACHE=… VR_CONFIG=… VR_USER=Sam node test/e2e/lib/insightsStore.ts solo|team [--print]
//
// Never on a real store: it refuses a VR_DATA that has anything in it. Names, notes and footage are synthetic (lavfi).
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import type { AgentKind, Comment, Review, Severity, ShareWatch, TeamWatch } from '../../../lib/types.ts';

const shape = process.argv[2] === 'team' ? 'team' : 'solo';
const DATA = process.env.VR_DATA;
if (!DATA) throw new Error('insightsStore: VR_DATA must name the new store');
if (fs.existsSync(DATA) && fs.readdirSync(DATA).length) throw new Error(`insightsStore: ${DATA} is not empty`);
const ROOT = path.dirname(DATA);
const FFMPEG = process.env.VR_FFMPEG || 'ffmpeg';

const { slugify, isoLocal, reviewDir } = await import('../../../lib/paths.ts');
const store = await import('../../../lib/store.ts');
const { ensureLocalOwner } = await import('../../../lib/auth.ts');
const shares = await import('../../../lib/shares.ts');
const playbooks = await import('../../../lib/playbooks.ts');
const { encodeParts, PARTS } = await import('../../../lib/watch.ts');
const { timecode, frameToTime } = await import('../../../lib/time.ts');

const H = 3_600_000;
const D = 24;
const NOW = Date.now();
const at = (t: number) => isoLocal(new Date(t));
const owner = ensureLocalOwner(process.env.VR_USER || 'Sam');
const ME = owner.name;
const TEAM = shape === 'team';
const MATE = 'Robin';

// A tiny deterministic random, so every run builds the same store.
let seed = TEAM ? 11 : 7;
const rnd = () => {
  seed = (seed * 1103515245 + 12345) & 0x7fffffff;
  return seed / 0x7fffffff;
};
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)] as T;
/** One of `weights`' keys, each as likely as its weight. */
function weighted<K extends string>(weights: Record<K, number>): K {
  const all = Object.entries(weights) as [K, number][];
  let x = rnd() * all.reduce((s, [, w]) => s + w, 0);
  for (const [k, w] of all) {
    x -= w;
    if (x <= 0) return k;
  }
  return (all.at(-1) as [K, number])[0];
}

// ---------------------------------------------------------------- the studio

interface Agent {
  name: string;
  kind: AgentKind;
  /** How much likelier than usual its fixes come back as still wrong. */
  slip: number;
}
const CLAUDE: Agent = { name: 'launch-edit', kind: 'claude-code', slip: 0.8 };
const CODEX: Agent = { name: 'codex-cuts', kind: 'codex', slip: 1.6 };
const CURSOR: Agent = { name: 'grade-pass', kind: 'cursor', slip: 1 };
const MCP: Agent = { name: 'render-bot', kind: 'mcp', slip: 1 };

/** What the notes are about, now and in the 30 days before (the shares of the topics a note picks from). */
const TOPICS: Record<'now' | 'before', Record<string, number>> = TEAM
  ? {
      now: { timing: 30, 'text/typo': 17, sfx: 13, 'color/grade': 12, 'audio/music': 10, 'layout/overlap': 10, graphic: 8 },
      before: { timing: 26, 'color/grade': 22, 'text/typo': 16, sfx: 12, 'audio/music': 12, 'layout/overlap': 12 },
    }
  : {
      now: { sfx: 28, timing: 18, 'text/typo': 14, 'audio/music': 10, 'layout/overlap': 9, 'color/grade': 7, graphic: 4, cut: 3 },
      before: { timing: 30, 'color/grade': 20, 'text/typo': 16, sfx: 10, 'audio/music': 10, 'layout/overlap': 8, graphic: 6 },
    };
/** How often a fix on a topic comes back as still wrong (before the agent's own slip). */
const SLIPS: Record<string, number> = { sfx: 0.3, timing: 0.22, 'text/typo': 0.1, 'audio/music': 0.14, 'layout/overlap': 0.12, 'color/grade': 0.12 };
const WORDS: Record<string, string[]> = {
  sfx: [
    'The whoosh lands a frame after the cut',
    'Swoosh on the logo reveal is too loud',
    'Click sound missing on the button tap',
    'The riser should end on the drop, not before it',
    'Sound effect on the title card feels cheap',
    'Impact hit is late against the slam',
  ],
  timing: ['Hold the end card a beat longer', 'Cut to the pack shot on the beat', 'Tighten the pause before the line', 'The logo lands a frame early'],
  'text/typo': ['Kerning on the title is loose', 'Typo in the lower third', 'The price is missing its comma', 'Line break splits the product name'],
  'audio/music': ['The music swell comes in too soon', 'Voice is buried under the music', 'Music ends abruptly at the cut'],
  'layout/overlap': ['Lower third overlaps the safe area', 'Logo sits too close to the edge', 'Caption covers the face'],
  'color/grade': ['Lift the shadows in the second shot', 'Skin tones run warm in the close-up', 'Colour shifts between these two shots'],
  graphic: ['Logo animation feels stiff', 'The icon is the old version'],
  cut: ['The transition feels abrupt here'],
};
/** Notes nobody tagged, whose words suggest no topic either. */
const PLAIN = ['Not sure about this moment', 'Feels off here', 'Can we try another take of this'];
const QUESTIONS = ['Keep the old end card or the new one?', 'Should the logo animate in or cut in?', 'Is the slower cut what you meant?'];
const SEVERITY: Record<Severity, number> = { must: 40, should: 40, nice: 15, idea: 5 };

/** How a video's story ends. */
type End =
  | { kind: 'approved'; ago: number; final?: boolean; link?: { label: string; opened: boolean } }
  | { kind: 'check'; ago: number } // the newest version brought fixes nobody has checked yet
  | { kind: 'fixing'; ago: number } // notes on the newest version wait for the agent
  | { kind: 'look'; ago: number }; // a new version waits for a look

interface Spec {
  name: string;
  folder: string;
  /** The clip's look: a lavfi source; its size. */
  src: string;
  w?: number;
  h?: number;
  agent: Agent;
  /** Full versions it reaches. */
  versions: number;
  end: End;
  /** Questions the agent asked before its first version. */
  asks?: number;
}

const SOURCES = ['testsrc2', 'smptehdbars', 'mandelbrot', 'rgbtestsrc', 'testsrc', 'smptebars', 'cellauto', 'yuvtestsrc'];
const CLIP_SECS = 6;
const approved = (ago: number, more: Partial<Extract<End, { kind: 'approved' }>> = {}): End => ({ kind: 'approved', ago, ...more });

/** Versions to approval in the last 30 days, and in the 30 before: solo 7.8 and 5.1, a team 6.2 and 7.0. */
const NOW_COUNTS = TEAM ? [9, 8, 7, 6, 6, 6, 5, 5, 5, 5] : [12, 10, 9, 8, 8, 7, 7, 6, 6, 5];
const BEFORE_COUNTS = TEAM ? [8, 8, 7, 7, 7, 7, 7, 6, 6, 7] : [7, 6, 6, 5, 5, 5, 5, 4, 4, 4];

const SPECS: Spec[] = [
  // approved in the last 30 days
  { name: 'brand-anthem.mp4', folder: 'Acme', src: 'testsrc2', agent: CLAUDE, versions: NOW_COUNTS[0] as number, end: approved(4 * D) },
  // with a team, a client decides on it now
  {
    name: 'promo-cut.mp4',
    folder: 'Acme',
    src: 'smptehdbars',
    agent: CLAUDE,
    versions: NOW_COUNTS[1] as number,
    end: approved(TEAM ? 30 : 6 * D, TEAM ? { link: { label: 'Client review', opened: true } } : {}),
  },
  { name: 'teaser-15s.mp4', folder: 'Acme/Social', src: 'mandelbrot', agent: CLAUDE, versions: NOW_COUNTS[2] as number, end: approved(9 * D, { final: true }) },
  { name: 'feature-tour.mp4', folder: 'Northwind', src: 'rgbtestsrc', agent: CODEX, versions: NOW_COUNTS[3] as number, end: approved(12 * D), asks: 2 },
  { name: 'social-9x16.mp4', folder: 'Northwind', src: 'testsrc', w: 180, h: 320, agent: CODEX, versions: NOW_COUNTS[4] as number, end: approved(14 * D) },
  { name: 'case-study.mp4', folder: 'Globex', src: 'smptebars', agent: CURSOR, versions: NOW_COUNTS[5] as number, end: approved(16 * D) },
  { name: 'event-recap.mp4', folder: 'Globex', src: 'cellauto', agent: CLAUDE, versions: NOW_COUNTS[6] as number, end: approved(19 * D) },
  { name: 'app-demo.mp4', folder: 'Initech', src: 'yuvtestsrc', agent: CODEX, versions: NOW_COUNTS[7] as number, end: approved(22 * D), asks: 3 },
  // approved two days ago and sent through a review link nobody has opened
  {
    name: 'spot-proof.mp4',
    folder: 'Acme',
    src: 'testsrc2',
    agent: CLAUDE,
    versions: NOW_COUNTS[8] as number,
    end: approved(2.2 * D, { link: { label: 'Final check', opened: false } }),
  },
  { name: 'ugc-edit.mp4', folder: 'Initech', src: 'mandelbrot', agent: CURSOR, versions: NOW_COUNTS[9] as number, end: approved(26 * D) },
  // approved in the 30 days before
  ...(
    [
      ['spring-launch.mp4', 'Acme', CLAUDE, 33],
      ['pack-shot.mp4', 'Acme', CLAUDE, 36],
      ['hero-loop.mp4', 'Northwind', CODEX, 38],
      ['interview-cut.mp4', 'Globex', CURSOR, 40],
      ['recruiting.mp4', 'Globex', CLAUDE, 43],
      ['menu-board.mp4', 'Initech', CODEX, 45],
      ['onboarding-tour.mp4', 'Initech', CLAUDE, 48],
      ['bumper.mp4', 'Acme', CLAUDE, 50],
      ['story-ad.mp4', 'Northwind', CODEX, 53],
      ['price-drop.mp4', 'Northwind', CURSOR, 56],
    ] as const
  ).map(([name, folder, agent, days], i) => ({
    name,
    folder,
    src: SOURCES[i % SOURCES.length] as string,
    agent,
    versions: BEFORE_COUNTS[i] as number,
    end: approved(days * D, i === 0 ? { final: true } : {}),
  })),
  // waiting now: fixes to check, an agent fixing, a version to look at
  { name: 'launch-film.mp4', folder: 'Acme', src: 'testsrc2', agent: CLAUDE, versions: 12, end: { kind: 'check', ago: 3 } },
  { name: 'product-loop.mp4', folder: 'Northwind', src: 'rgbtestsrc', agent: CODEX, versions: 5, end: { kind: 'fixing', ago: 20 }, asks: 3 },
  { name: 'explainer.mp4', folder: 'Globex', src: 'smptebars', agent: CURSOR, versions: 3, end: { kind: 'check', ago: 9 } },
  { name: 'logo-sting.mp4', folder: 'Initech', src: 'cellauto', agent: MCP, versions: 3, end: { kind: 'look', ago: 20 }, asks: 2 },
];

// ---------------------------------------------------------------- one video's history

let ids = 0;
const nextId = () => `c_${(++ids).toString(16).padStart(6, '0')}`;

interface History {
  registered: number[];
  comments: Comment[];
  approvals: NonNullable<Review['approvals']>;
  link: { label: string; at: number; opened: boolean } | null;
  final: Review['final'];
}

/** A video's history, step by step from its first version (at 0), then moved so it ends where its spec says. */
function history(spec: Spec, fps: number, frames: number): History {
  const period = spec.end.kind === 'approved' && spec.end.ago > 30 * D ? 'before' : 'now';
  let t = 0;
  let v = 1;
  const out: History = { registered: [0], comments: [], approvals: [], link: null, final: null };
  const reply = (c: Comment, by: string, text: string, status: Comment['status'], when: number) => {
    c.replies.push({ by, text, status, at: String(when) });
    c.status = status;
  };
  const note = (o: { text: string; tags: string[]; author: string; created: number; severity: Severity; question?: boolean }): Comment => {
    const frame = Math.floor(rnd() * (frames - 1));
    return {
      id: nextId(),
      v,
      frame,
      timecode: timecode(frame, fps),
      t: frameToTime(frame, fps),
      range: null,
      text: o.text,
      tags: o.tags,
      severity: o.severity,
      ...(o.question ? { kind: 'question' as const } : {}),
      drawing: [],
      shots: null,
      voice: null,
      status: 'open',
      author: o.author,
      created: String(o.created),
      replies: [],
    };
  };
  const agent = `agent:${spec.agent.name}`;
  const ask = (n: number) => {
    for (let i = 0; i < n; i++)
      out.comments.push(
        note({ text: QUESTIONS[i % QUESTIONS.length] as string, tags: [], author: agent, created: t + i * 60_000, severity: 'nice', question: true }),
      );
    t += (0.5 + rnd() * 2) * H;
    for (const c of out.comments) if (c.kind === 'question' && c.status === 'open') reply(c, ME, 'The new one, please', 'verified', t);
  };
  const write = () => {
    const n = rnd() < 0.35 ? 1 : rnd() < 0.7 ? 2 : 3;
    for (let i = 0; i < n; i++) {
      const plain = rnd() < 0.07;
      const tag = weighted(TOPICS[period]);
      out.comments.push(
        note({
          text: plain ? pick(PLAIN) : pick(WORDS[tag] as string[]),
          tags: plain ? [] : [tag],
          author: TEAM && rnd() < 0.4 ? MATE : ME,
          created: t + i * 60_000,
          severity: weighted(SEVERITY),
        }),
      );
    }
  };
  const fix = () => {
    for (const c of out.comments) if (c.status === 'open' && !c.kind) reply(c, agent, 'Changed it in the project', 'fixed', t);
    v++;
    out.registered.push(t);
  };
  const check = (last: boolean) => {
    for (const c of out.comments)
      if (c.status === 'fixed') {
        const p = (SLIPS[c.tags[0] ?? ''] ?? 0.08) * spec.agent.slip;
        if (!last && rnd() < p) reply(c, ME, pick(['Still not there', 'Closer, but still off', 'Still a beat late']), 'open', t);
        else reply(c, ME, 'Looks right', 'verified', t);
      }
  };
  if (spec.asks) ask(spec.asks);
  const rounds = spec.versions - 1;
  for (let k = 0; k < rounds; k++) {
    t += pick([0.5, 1, 1.5, 2, 3, 4, 6, 10, 14]) * H; // on you: watching it and writing the notes
    if (spec.agent === MCP) {
      // an MCP client that only asks: a new version on its own
      ask(1);
      v++;
      out.registered.push(t);
      continue;
    }
    write();
    t += (0.2 + rnd() * 2.3) * H; // on the agent: the fixes, with the next version
    fix();
    t += (0.3 + rnd() * 0.7) * H; // on you: checking the fixes
    const last = k === rounds - 1;
    if (last && spec.end.kind === 'check') break;
    check(last && spec.end.kind === 'approved');
  }
  if (spec.end.kind === 'fixing') {
    t += 2 * H;
    write();
  }
  if (spec.end.kind === 'approved') {
    t += (0.5 + rnd() * 3) * H;
    out.approvals.push({ party: 'team', status: 'approved', v, by: ME, at: String(t), note: null });
    if (spec.end.final) {
      t += 1 * H;
      out.final = { v, by: ME, at: String(t), note: null };
    }
    if (spec.end.link) {
      t += 1 * H;
      out.link = { label: spec.end.link.label, at: t, opened: spec.end.link.opened };
    }
  }
  // the whole story moved so its last step happened `ago` hours ago
  const shift = NOW - spec.end.ago * H - t;
  const iso = (x: string | number) => at(Number(x) + shift);
  for (const c of out.comments) {
    c.created = iso(c.created);
    for (const x of c.replies) x.at = iso(x.at);
  }
  for (const a of out.approvals) a.at = iso(a.at);
  if (out.final) out.final.at = iso(out.final.at);
  if (out.link) out.link.at += shift;
  out.registered = out.registered.map((x) => x + shift);
  return out;
}

// ---------------------------------------------------------------- versions on disk

/** One short clip per look; every version of every video is the same pictures with other bytes (a tag in its header). */
const clips = new Map<string, string>();
function clip(spec: Spec): string {
  const key = `${spec.src}-${spec.w ?? 320}x${spec.h ?? 180}`;
  const known = clips.get(key);
  if (known) return known;
  const file = path.join(ROOT, 'src', `${key}.mp4`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, [
    ...['-v', 'error', '-f', 'lavfi', '-i', `${spec.src}=size=${spec.w ?? 320}x${spec.h ?? 180}:rate=25`],
    ...['-f', 'lavfi', '-i', `sine=frequency=330:duration=${CLIP_SECS}`, '-t', String(CLIP_SECS)],
    ...['-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-g', '25', '-c:a', 'aac', '-shortest', '-y', file],
  ]);
  clips.set(key, file);
  return file;
}

function versionBytes(base: string, to: string, name: string, v: number): void {
  // the same pictures with other bytes: a few after the file's end, which players and ffmpeg pass over
  fs.copyFileSync(base, to);
  fs.appendFileSync(to, `\n${name} version ${String(v).padStart(3, '0')}\n`);
  // settled (the store takes younger files for renders still being written), never the mtime of the version before
  const t = new Date(NOW - (600 - v) * 1000);
  fs.utimesSync(to, t, t);
}

interface Built {
  spec: Spec;
  review: Review;
  slug: string;
  link: History['link'];
}
const built: Built[] = [];
for (const spec of SPECS) {
  const base = clip(spec);
  const file = path.join(ROOT, 'Studio', spec.folder, 'export', spec.name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  versionBytes(base, file, spec.name, 1);
  const { review } = store.createOrGetReview(file, { by: ME, byId: owner.id });
  const slug = slugify(file);
  for (let k = 2; k <= spec.versions; k++) {
    versionBytes(base, file, spec.name, k);
    store.mutate(slug, () => {});
  }
  const h = history(spec, review.fps, review.frames);
  const done = store.mutate(slug, (r) => {
    if (r.versions.length !== h.registered.length)
      throw new Error(`${spec.name}: ${r.versions.length} versions on disk, ${h.registered.length} in its history`);
    r.folder = spec.folder;
    r.added = at(h.registered[0] as number);
    r.versions.forEach((x, i) => {
      x.registered = at(h.registered[i] as number);
    });
    r.comments = h.comments;
    r.approvals = h.approvals;
    const last = h.approvals.at(-1);
    r.approval = last ? { status: 'approved', v: last.v, by: ME, at: last.at, note: null } : null;
    r.final = h.final;
    r.session = { name: spec.agent.name, id: null, cwd: null, assigned: r.added, by: ME, agent: spec.agent.kind };
  });
  built.push({ spec, review: done, slug, link: h.link });
}

// The House playbook says timing already (it still comes up): "rule exists — still n rounds".
playbooks.writeText('', 'rules', '- Timing: hold the end card at least 2 s, and land every change on the beat', { by: ME, message: 'Timing' });

// ---------------------------------------------------------------- review links and what clients watched

const seenOf = (share: number) => encodeParts(Array.from({ length: Math.round(share * PARTS) }, (_, i) => i));
const playsOf = (share: number, again?: [number, number, number]) =>
  Array.from({ length: PARTS }, (_, i) => (i < Math.round(share * PARTS) ? 1 : 0) + (again && i >= again[0] && i <= again[1] ? again[2] - 1 : 0));

/** Moves a link and what happened through it to when it happened (the share functions stamp the moment they run). */
function backdate(id: string, created: number, opened: number): void {
  shares.flushShareStats(); // what visitors did waits in memory: on disk before it is moved back in time
  const file = path.join(DATA as string, 'shares.json');
  const all = JSON.parse(fs.readFileSync(file, 'utf8')) as { shares: Record<string, Record<string, unknown>> };
  for (const s of Object.values(all.shares)) {
    if (s.id !== id) continue;
    s.created = at(created);
    type Stats = {
      last_opened?: string | null;
      visitors?: Record<string, { first: string; last: string }>;
      videos?: Record<string, { last_viewed: string; watch?: Record<string, ShareWatch> }>;
      activity?: { at: string }[];
    };
    const stats = s.stats as Stats;
    if (stats.last_opened) stats.last_opened = at(opened);
    for (const x of Object.values(stats.visitors || {})) Object.assign(x, { first: at(opened), last: at(opened + 0.2 * H) });
    for (const x of Object.values(stats.videos || {})) {
      x.last_viewed = at(opened);
      for (const w of Object.values(x.watch || {})) Object.assign(w, { first: at(opened), last: at(opened + 0.2 * H) });
    }
    for (const x of stats.activity || []) x.at = at(opened);
  }
  fs.writeFileSync(file, JSON.stringify(all, null, 2));
}

function clientWatch(
  s: ReturnType<typeof shares.createShare>,
  b: Built,
  who: { name: string; browser: string; share: number; again?: [number, number, number] },
) {
  const v = b.review.versions.at(-1)?.v ?? 1;
  const visitor = shares.visitorKey(s, who.browser);
  shares.recordVisit(s.token, { open: true, name: who.name, visitor });
  shares.recordView(s.token, b.slug, v, who.name);
  shares.recordWatch(s.token, b.slug, visitor, {
    v,
    seen: seenOf(who.share),
    secs: Math.round(CLIP_SECS * who.share * (who.again ? 1.6 : 1)),
    name: who.name,
    plays: playsOf(who.share, who.again),
  });
}

for (const b of built)
  if (b.link) {
    const s = shares.createShare(b.slug, { label: b.link.label, by: ME });
    if (b.link.opened) clientWatch(s, b, { name: 'Mia', browser: 'browser-client-0001', share: 1, again: [30, 45, 3] });
    backdate(s.id as string, b.link.at, b.link.at + 3 * H);
  }
if (TEAM) {
  // a link to the feature tour: Jon watched half of it and hasn't decided yet
  const b = built.find((x) => x.spec.name === 'feature-tour.mp4') as Built;
  const s = shares.createShare(b.slug, { label: 'Northwind review', by: ME });
  clientWatch(s, b, { name: 'Jon', browser: 'browser-client-0002', share: 0.5 });
  backdate(s.id as string, NOW - 30 * H, NOW - 6 * H);
}

// ---------------------------------------------------------------- what the team watched (the API keeps it; the page doesn't show it)

for (const b of built) {
  const newest = b.review.versions.at(-1);
  if (!newest || Date.parse(newest.registered) < NOW - 30 * D * H) continue;
  const t = Math.min(NOW - 0.5 * H, Date.parse(newest.registered) + 2 * H);
  const rec = (name: string, k: number): TeamWatch => ({
    v: newest.v,
    seen: seenOf(k),
    secs: Math.round(CLIP_SECS * k),
    last: at(t),
    name,
    plays: playsOf(k),
    sessions: 1,
    first: at(t - 0.2 * H),
    total_secs: Math.round(CLIP_SECS * k * 2),
    total_sessions: 2,
  });
  const viewers: Record<string, TeamWatch> = { [owner.id]: rec(ME, 1) };
  if (TEAM) viewers.u_teammate0001 = rec(MATE, 0.6);
  fs.writeFileSync(path.join(reviewDir(b.slug), 'views.json'), `${JSON.stringify({ viewers })}\n`);
}

console.log(`insightsStore: ${shape}, ${built.length} videos, ${built.reduce((n, b) => n + b.review.versions.length, 0)} versions, ${ids} notes and questions`);

if (process.argv.includes('--print')) {
  // what Insights will say about it: for tuning the shape
  const { insights } = await import('../../../lib/insights.ts');
  const { watchingOf } = await import('../../../lib/insightsWatch.ts');
  const links = shares.linksWithStats();
  const reviews = store.listReviews();
  const rulesFor = (scope: string) => [...playbooks.layersFor(scope).map((x) => x.rules), playbooks.loadPlaybook(scope).rules].join('\n');
  const { stageForReview } = await import('../../../lib/stageContext.ts');
  const b = insights(reviews, {
    period: '30d',
    links,
    stageFor: (r) => stageForReview(r, { sessionActive: false }),
    rulesFor,
    watching: (from, to) => watchingOf(reviews, from, to, links, Date.now(), owner.id),
  }).board;
  console.log(
    JSON.stringify(
      {
        toApproval: b?.toApproval,
        causes: { ...b?.causes, topics: b?.causes?.topics.map((t) => [t.tag, t.rounds, t.share, t.notes, t.must, t.back, t.scope, t.covered]) },
        stillWrong: {
          ...b?.stillWrong,
          topics: b?.stillWrong?.topics.map((t) => [t.tag, t.n, t.agents.map((a) => `${a.name}×${a.n}`).join(' ')]),
          agents: b?.stillWrong?.agents.map((a) => [a.name, a.n]),
        },
        turnaround: b?.turnaround,
        firstTime: b?.firstTime,
        agents: b?.agents?.map((a) => [a.name, a.kind, a.fixes, a.checked, a.right, a.rate, a.fixHours, a.questions, a.wrongTopics.map((x) => x.tag).join()]),
        stuck: b?.flow?.stuck.map((s) => [s.video, s.waitingOn, s.hours, s.label, s.agent]),
        clients: b?.watching?.videos.flatMap((v) =>
          v.viewers.filter((x) => x.kind === 'client').map((x) => [x.name, v.video, x.v, x.vWatched, x.link, x.again]),
        ),
        unopened: b?.watching?.unopened,
      },
      null,
      1,
    ),
  );
}
