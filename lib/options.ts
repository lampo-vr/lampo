// Options an agent offers before it spends a render: six narrator voices, three closing lines, the takes of a whoosh.
// The person auditions them in Lampo — every sound of a group at the same loudness, pictures side by side — picks one
// per group (or several) and writes what else matters; the answer goes back as an ordinary answer to the question,
// one line an agent parses: `PICKED voice=v3 music=m1 · note: "lampo.app on the end card"`.
// Browser-safe (no Node imports): the store and the routes check with these rules, the UI levels and shows with them.
import { cutChars } from './names.ts';
import { compareTime, instant, oneLine } from './time.ts';
import type { Comment, NoteRef, OptionAnswer, OptionGroup, OptionSeen, RefLoudness, Reply } from './types.ts';

export const OPTION_LIMITS = {
  /** Groups in one question. */
  groups: 8,
  /** A group's or an item's id. */
  id: 24,
  /** Items in a group: the keys 1–9 pick one. */
  items: 9,
  /** Items in one question, all groups together. */
  total: 48,
  /** Moments of renders (frame items) in one question: each is grabbed and stored, like a note's references (A12 OPT-1). */
  moments: 8,
  label: 80,
  /** The question itself, every way in (the API, MCP, `lampo ask`). */
  text: 5000,
  /** The question's own free-text prompt. */
  prompt: 200,
  /** What the person writes with their picks. */
  note: 2000,
  /** Answers one question keeps (picks given again are a new answer each): past it, ask a new one (A12 OPT-2). */
  answers: 50,
} as const;

/** An item's file that arrives once the question is no longer waiting (an upload URL used late): refused, 409. */
export const answeredAlready = (): Error => Object.assign(new Error('this question was answered or closed: it takes no more files'), { status: 409 });

/** A group's or an item's id: what the answer line names it by, so nothing in it can read as another field. */
export const OPTION_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,23}$/;

/** What an agent sends: ids, labels and how many may be picked (references come separately, lib/asks.ts). */
export interface OptionGroupInput {
  id: string;
  label?: string;
  pick?: 'one' | 'many';
  items: { id: string; label?: string }[];
}

// One line, no control characters, at most `max` characters.
const line = (s: unknown, max: number): string =>
  typeof s === 'string'
    ? cutChars(
        s
          .replace(/[\p{Cc}\u2028\u2029\u0085]/gu, ' ')
          .replace(/\s+/g, ' ')
          .trim(),
        max,
      ).trim()
    : '';

/**
 * Groups as kept: labels on one line (an id stands in for a missing one), ids checked and unique (groups in the
 * question, items in their group, ignoring case), every group with two items or more, within OPTION_LIMITS. Throws a
 * sentence for whoever asked: a question that arrives with half its options is worse than one refused.
 */
export function cleanOptions(input: readonly OptionGroupInput[]): OptionGroup[] {
  if (!Array.isArray(input) || !input.length) throw new Error('options need at least one group');
  if (input.length > OPTION_LIMITS.groups) throw new Error(`at most ${OPTION_LIMITS.groups} groups`);
  const groups = new Set<string>();
  let total = 0;
  return input.map((g) => {
    const id = String(g?.id ?? '');
    if (!OPTION_ID.test(id)) throw new Error(`group id "${line(id, 30)}": letters, digits, - and _ (at most 24)`);
    if (groups.has(id.toLowerCase())) throw new Error(`two groups are called "${id}"`);
    groups.add(id.toLowerCase());
    const items: OptionGroupInput['items'] = Array.isArray(g.items) ? g.items : [];
    if (items.length < 2) throw new Error(`group "${id}" needs two items or more to choose from`);
    if (items.length > OPTION_LIMITS.items) throw new Error(`group "${id}": at most ${OPTION_LIMITS.items} items (the keys 1–9 pick them)`);
    total += items.length;
    if (total > OPTION_LIMITS.total) throw new Error(`at most ${OPTION_LIMITS.total} items in one question`);
    const seen = new Set<string>();
    return {
      id,
      label: line(g.label, OPTION_LIMITS.label) || id,
      pick: g.pick === 'many' ? 'many' : 'one',
      items: items.map((it) => {
        const iid = String(it?.id ?? '');
        if (!OPTION_ID.test(iid)) throw new Error(`item id "${line(iid, 30)}" in "${id}": letters, digits, - and _ (at most 24)`);
        if (seen.has(iid.toLowerCase())) throw new Error(`two items in "${id}" are called "${iid}"`);
        seen.add(iid.toLowerCase());
        return { id: iid, label: line(it.label, OPTION_LIMITS.label) || iid };
      }),
    };
  });
}

/** The free-text prompt as kept: one line, bounded; undefined when there is none. */
export const cleanPrompt = (s: unknown): string | undefined => line(s, OPTION_LIMITS.prompt) || undefined;

/**
 * Picks as kept: only groups and items the question offers (unknown ones refused, so a typo never reads as a choice),
 * one item at most in a `one` group, each item once, in the question's order; groups without a pick are left out.
 */
export function checkPicks(groups: readonly OptionGroup[], picks: Record<string, readonly string[]>): Record<string, string[]> {
  if (!picks || typeof picks !== 'object') throw new Error('picks must name items per group');
  for (const [gid, ids] of Object.entries(picks)) {
    const g = groups.find((x) => x.id === gid);
    if (!g) throw new Error(`there is no group "${line(gid, 30)}"`);
    if (!Array.isArray(ids)) throw new Error(`picks for "${gid}" must be a list of item ids`);
    for (const id of ids) if (!g.items.some((it) => it.id === id)) throw new Error(`"${gid}" has no item "${line(String(id), 30)}"`);
    if (g.pick === 'one' && new Set(ids).size > 1) throw new Error(`"${g.label}" takes one pick`);
  }
  const out: Record<string, string[]> = {};
  for (const g of groups) {
    const ids = picks[g.id];
    if (!ids?.length) continue;
    out[g.id] = g.items.filter((it) => ids.includes(it.id)).map((it) => it.id);
  }
  return out;
}

/**
 * The answer as agents read it, on one line: `PICKED voice=v3 sfx=t1+t3 music=- · note: "…"` — every group in the
 * question's order (`-` = left open), several picks joined by `+`, the person's words last and quoted (on their
 * line, whatever they typed). Ids can't hold spaces, `=`, `+` or quotes, so the line splits cleanly.
 */
export function picksLine(groups: readonly OptionGroup[] | null, answer: OptionAnswer): string {
  const ids = groups ? groups.map((g) => g.id) : Object.keys(answer.picks);
  const parts = ids.map((id) => `${id}=${answer.picks[id]?.length ? answer.picks[id].join('+') : '-'}`);
  const note = answer.note?.trim();
  return oneLine(`PICKED ${parts.join(' ')}${note ? ` · note: "${note}"` : ''}`);
}

/** The groups in a few words, for lines that only name them: `voice (one of 6), sfx (any of 3)`. */
export const optionsSummary = (groups: readonly { id: string; pick?: 'one' | 'many'; items: readonly unknown[] }[]): string =>
  groups.map((g) => `${g.id} (${g.pick === 'many' ? 'any' : 'one'} of ${g.items.length})`).join(', ');

/** One line per group, for agents (get_note, lampo show): `options voice "Voice" (pick one): v1 Calm · v2 Warm (audio 3.1 s)`. */
export function optionLines(groups: readonly OptionGroup[]): string[] {
  return groups.map((g) => {
    const items = g.items.map((it) => {
      const r = it.ref;
      const what = !r
        ? ''
        : r.kind === 'audio' || r.kind === 'clip'
          ? ` (${r.kind} ${r.duration?.toFixed(1) ?? '?'} s)`
          : r.kind === 'link'
            ? ` (${r.url})`
            : r.kind === 'frame'
              ? ` (${r.name} v${r.v} ${r.timecode})`
              : ' (image)';
      return `${it.id} ${it.label}${what}`;
    });
    return oneLine(`options ${g.id} "${g.label}" (pick ${g.pick === 'many' ? 'any' : 'one'}): ${items.join(' · ')}`);
  });
}

/** The newest answer to a question's options (a reply that carries one), or null. */
export const lastAnswer = (c: Pick<Comment, 'replies'>): Reply | null => [...(c.replies || [])].reverse().find((r) => r.answer) ?? null;

/**
 * A question whose options were answered after the newest render arrived: the picks are what the agent renders next,
 * so `lampo open` keeps it listed until a render comes after them.
 */
export function picksToRender(c: Pick<Comment, 'options' | 'replies'>, newestRender: string | undefined): boolean {
  if (!c.options?.length) return false;
  const a = lastAnswer(c);
  return !!a && (!newestRender || compareTime(a.at, newestRender) > 0);
}

// ---------------------------------------------------------------- levelling

/** No sound is raised past this true peak (dBTP): levelling never clips. */
export const PEAK_CEILING = -1;
/** Below this a measurement is silence (ebur128's gate): nothing to level. */
const SILENT = -69;

const usable = (l: RefLoudness | null | undefined): l is RefLoudness => !!l && Number.isFinite(l.i) && l.i > SILENT;

/**
 * The gain in dB that makes every sound of a group play at the same loudness, applied when it plays (the files stay as
 * sent). Each is brought to the loudest level all of them can reach: a sound may be raised only while its true peak
 * stays under PEAK_CEILING, so loud takes are turned down, quiet ones up, and nothing clips. null for a sound that
 * wasn't measured (or is silent): it plays as it is.
 */
export function levelGains(loud: readonly (RefLoudness | null | undefined)[]): (number | null)[] {
  // A peak not known (no `tp`) leaves no room: such a sound is never raised.
  const peak = (l: RefLoudness) => (typeof l.tp === 'number' && Number.isFinite(l.tp) ? l.tp : PEAK_CEILING);
  const reach = loud.map((l) => (usable(l) ? l.i + Math.max(0, PEAK_CEILING - peak(l)) : null));
  const known = reach.filter((r): r is number => r !== null);
  if (!known.length) return loud.map(() => null);
  const target = Math.min(...known);
  return loud.map((l) => (usable(l) ? Math.round((target - l.i) * 10) / 10 : null));
}

/** A group as lists name it before it is opened (the inbox, the folder's pill): its label, size and kind of items. */
export function optionsSeen(groups: readonly OptionGroup[]): OptionSeen[] {
  return groups.map((g) => {
    const kinds = new Set(g.items.map((it) => it.ref?.kind ?? 'text'));
    const kind = kinds.size === 1 ? ([...kinds][0] as OptionSeen['kind']) : 'mixed';
    return { label: g.label, n: g.items.length, kind };
  });
}

/** Every reference an option carries (to store, serve or remove its files). */
export const optionRefs = (groups: readonly OptionGroup[] | undefined): NoteRef[] =>
  (groups || []).flatMap((g) => g.items.map((it) => it.ref).filter((r): r is NoteRef => !!r));

/** A gain in dB as the factor a Web Audio GainNode takes. */
export const dbToGain = (db: number): number => 10 ** (db / 20);

/**
 * The same balance where sound can only be turned down (a media element's `volume`, when the files come from a bucket
 * that Web Audio may not read): every gain shifted so the largest is 0 dB. A sound that wasn't measured plays at 1.
 */
export function volumesOf(gains: readonly (number | null)[]): number[] {
  const known = gains.filter((g): g is number => g !== null);
  const top = known.length ? Math.max(...known) : 0;
  return gains.map((g) => (g === null ? 1 : dbToGain(g - top)));
}

/** Newest first by when it was asked (questions asked on folders, the library's strip). */
export const byNewest = <T extends { created: string }>(a: T, b: T): number => instant(b.created) - instant(a.created);
