// A stage in the UI's language. lib/stage.ts writes its `detail` and `next.label` in English for lampo, MCP and agents;
// the UI says the same things from the structured fields. Each German sentence is built next to the English one the
// server sent: when they don't describe the same thing (an agent's own status words, a case added later on the server),
// the server's English stands — the UI never states something the server didn't. Where the UI's words differ from the
// agents' (whoever reviews through a review link is never "the client" in the UI), it maps them in English too.
import type { ApprovalEntry, NextStep, ShareSignal, Stage, StageInfo } from '../../../lib/types.ts';
import { currentLang, english, fill, type Key, type Params, plural, t } from '../i18n/index.ts';
import { ago } from '../lib/format.ts';

export const stageLabel = (s: Stage): string =>
  ({
    to_review: t('To review'),
    changes: t('Changes requested'),
    in_progress: t('In progress'),
    check_fixes: t('Check fixes'),
    team_approved: t('Approved'),
    with_client: t('Out for review'),
    client_approved: t('Approved via link'),
    final: t('Final'),
  })[s];

export const laneLabel = (id: string): string =>
  ({ needs_you: t('To review'), fixing: t('Being fixed'), approved: t('Approved'), final: t('Final') })[id] ?? id;

/** The stepper's five steps: review → fixes → approved → shared (through a review link) → final. */
export const stepLabels = (): string[] => [t('Review'), t('Fixes'), t('Approved'), t('Shared'), t('Final')];

// Words in both languages at once: `en` is what lib/stage.ts writes (times left open), `here` what the UI shows;
// `mapped`: the UI says it in its own words, in English too.
interface Said {
  en: string;
  here: string;
  mapped?: boolean;
}
const ANY = '\u0000';
const lit = (s: string): Said => ({ en: s, here: s });
const cat = (...parts: Said[]): Said => ({
  en: parts.map((p) => p.en).join(''),
  here: parts.map((p) => p.here).join(''),
  mapped: parts.some((p) => p.mapped),
});
/**
 * `key` filled with `params`; `nested` are Said parts; `times` are ISO instants shown as "2 h ago" (any time matches);
 * `server`: what lib/stage.ts writes when the UI's words (the key) differ from it.
 */
function say(key: Key, params: Params = {}, nested: Record<string, Said> = {}, times: Record<string, string> = {}, server?: string): Said {
  const n = Number(params.n ?? 0);
  const en = fill(plural(server ?? english(key), n), {
    ...params,
    ...Object.fromEntries(Object.entries(nested).map(([k, v]) => [k, v.en])),
    ...Object.fromEntries(Object.keys(times).map((k) => [k, ANY])),
  });
  const here = t(key, {
    ...params,
    ...Object.fromEntries(Object.entries(nested).map(([k, v]) => [k, v.here])),
    ...Object.fromEntries(Object.entries(times).map(([k, v]) => [k, ago(v)])),
  });
  return { en, here, mapped: !!server || Object.values(nested).some((p) => p.mapped) };
}

const guest = (by: string) => by.replace(/^guest:/, '');

function openedBy(s: ShareSignal): Said {
  if (s.by) return s.last_opened ? say('opened by {name} {when}', { name: s.by }, {}, { when: s.last_opened }) : say('opened by {name}', { name: s.by });
  if (s.opens > 1)
    return s.last_opened ? say('opened {count}×, last {when}', { count: s.opens }, {}, { when: s.last_opened }) : say('opened {count}×', { count: s.opens });
  return s.last_opened ? say('opened {when}', {}, {}, { when: s.last_opened }) : say('opened');
}

function notOpened(s: ShareSignal | null | undefined, v: number): Said {
  if (!s) return say('shared · not opened yet');
  return s.seen_v !== null || s.opens
    ? say('shared via "{label}" · V{v} not seen yet', { label: s.label, v })
    : say('shared via "{label}" · not opened yet', { label: s.label });
}

// A verdict given through a review link: "(client: Mia)" for agents, "(Mia via review link)" here.
const who = (e: ApprovalEntry): Said => (e.party === 'client' ? say('{name} via review link', { name: guest(e.by) }, {}, {}, 'client: {name}') : say('team'));

function stillOpen(s: StageInfo): Said {
  return cat(
    s.open ? say(' · {n} note still open| · {n} notes still open', { n: s.open }) : lit(''),
    s.on_preview ? say(' · {n} fix checked on a preview, not rendered yet| · {n} fixes checked on a preview, not rendered yet', { n: s.on_preview }) : lit(''),
  );
}

function compose(s: StageInfo): Said | null {
  const v = s.v;
  // the newest version as lib/stage.ts names it: "V8 (part)" for a partial render
  const vv: Said = s.part ? { en: `${v} (part)`, here: t('{v} (part)', { v }) } : lit(String(v));
  switch (s.stage) {
    case 'final':
      if (!s.final) return null;
      return s.final_superseded
        ? say('Final V{v} · V{w} arrived since', { v: s.final.v, w: s.final_superseded })
        : say('Final V{v} · marked by {name}', { v: s.final.v, name: s.final.by });
    case 'client_approved':
      return s.client
        ? cat(say('{name} approved V{v} via review link', { name: guest(s.client.by) }, { v: vv }, {}, 'Client approved V{v} ({name})'), stillOpen(s))
        : null;
    case 'with_client':
      return s.share ? cat(say('Approved V{v} · {state}', {}, { v: vv, state: openedBy(s.share) }), stillOpen(s)) : null;
    case 'team_approved':
      return s.linked
        ? cat(say('Approved V{v} · {state}', {}, { v: vv, state: notOpened(s.share, v) }), stillOpen(s))
        : cat(say('Approved V{v} by the team', {}, { v: vv }), stillOpen(s));
    case 'changes':
    case 'in_progress': {
      const verdict = s.client ?? s.team;
      if (verdict?.status === 'changes')
        return cat(say('Changes requested on V{v} ({who})', {}, { v: vv, who: who(verdict) }), lit(verdict.note ? `: ${verdict.note}` : ''));
      if (s.open) return say('{n} note open on V{v}|{n} notes open on V{v}', { n: s.open }, { v: vv });
      if (s.on_preview)
        return say('{n} fix checked on a preview · V{w} to render|{n} fixes checked on a preview · V{w} to render', { n: s.on_preview, w: v + 1 });
      return null;
    }
    case 'check_fixes':
      return say('{n} fix to check in V{v}|{n} fixes to check in V{v}', { n: s.to_verify }, { v: vv });
    case 'to_review':
      if (s.identical_to_approved && s.approval_stale) return say('V{v} is identical to approved V{w}', { w: s.approval_stale.v }, { v: vv });
      if (s.approval_stale) return say('V{w} approved · V{v} new', { w: s.approval_stale.v }, { v: vv });
      return say('V{v} to review', {}, { v: vv });
  }
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const same = (en: string, server: string) => new RegExp(`^${escapeRe(en).replaceAll(ANY, '.*?')}$`, 's').test(server);

/** One line for people: "Approved V6 by the team" — in the UI's language when it is sure to say the same. */
export function stageDetail(s: StageInfo): string {
  const english = currentLang() === 'en';
  // only a verdict given through a review link reads differently in English
  if (english && !s.client) return s.detail;
  const said = compose(s);
  if (!said || !same(said.en, s.detail)) return s.detail;
  // in English the server's words stand, unless the UI words it its own way
  return english && !said.mapped ? s.detail : said.here;
}

// The next step's English words (lib/stage.ts, what agents read) and how the UI says them — in English too, where the
// UI's words differ from the agents' ("Assign an agent", no "verdict").
const NEXT: [RegExp, (m: RegExpMatchArray) => string][] = [
  [/^Review V(\d+)$/, (m) => t('Review V{v}', { v: m[1] as string })],
  [/^Carry the approval over to V(\d+)$/, (m) => t('Carry the approval over to V{v}', { v: m[1] as string })],
  [/^Waiting for fixes from (.+)$/, (m) => t('Waiting for fixes from {name}', { name: m[1] as string })],
  [/^Check (\d+) fix(?:es)?$/, (m) => t('Check {n} fix|Check {n} fixes', { n: Number(m[1]) })],
  [/^Reopen to review V(\d+)$/, (m) => t('Reopen to review V{v}', { v: m[1] as string })],
  [/^Render the fixes checked on previews$/, () => t('Render the fixes checked on previews')],
  [/^Hand it to an agent$/, () => t('Assign an agent')],
  [/^An agent is on it$/, () => t('An agent is on it')],
  [/^Send to the client$/, () => t('Send out for review')],
  [/^Waiting for the client's verdict$/, () => t('Waiting for their decision')],
  [/^Waiting for the client to open the link$/, () => t('Waiting for the link to be opened')],
  [/^Mark final$/, () => t('Mark final')],
  [/^Render it in full for final$/, () => t('Render it in full for final')],
  [/^Done$/, () => t('Done')],
];

/** The next step's words ("Review V7", "Send out for review"). */
export function nextLabel(n: NextStep): string {
  for (const [re, say] of NEXT) {
    const m = n.label.match(re);
    if (m) return say(m);
  }
  return n.label;
}

// "4 final · 1 out for review · 1 in progress": the settled end first, the work last. It counts videos.
const ORDER: Stage[] = ['final', 'client_approved', 'with_client', 'team_approved', 'check_fixes', 'to_review', 'in_progress', 'changes'];
const countOf = (s: Stage, n: number): string =>
  ({
    final: t('{n} final|{n} final', { n }),
    client_approved: t('{n} approved via link|{n} approved via link', { n }),
    with_client: t('{n} out for review|{n} out for review', { n }),
    team_approved: t('{n} approved|{n} approved', { n }),
    check_fixes: t('{n} to check|{n} to check', { n }),
    to_review: t('{n} to review|{n} to review', { n }),
    in_progress: t('{n} in progress|{n} in progress', { n }),
    changes: t('{n} needs changes|{n} need changes', { n }),
  })[s];

/** Where a group of videos stands, in one line. */
export function summaryLine(stages: Stage[]): string {
  const n = new Map<Stage, number>();
  for (const s of stages) n.set(s, (n.get(s) ?? 0) + 1);
  return ORDER.filter((s) => n.get(s))
    .map((s) => countOf(s, n.get(s) as number))
    .join(' · ');
}
