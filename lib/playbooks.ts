// Playbooks: what the team knows before the first render, written down for people and agents (docs/playbooks.md).
// One House playbook for the whole studio, one per folder; a folder inherits every playbook above it and the deeper
// one wins. Each holds a brief, rules (markdown), references (pictures, links, moments of renders) and skills (the open
// Agent Skills format, SKILL.md, with small files that are stored and served but never run). Every change is a
// revision; renders record the revisions they were made with (Version.playbook, stamped in lib/store.ts). People on
// the team edit; agents propose, and a person accepts or rejects. Clients never see a playbook.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { isoLocal } from './paths.ts';
import { chainOf, HOUSE, listPlaybooks, playbookFile, playbookRoot, readPlaybook, stampFor } from './playbookFiles.ts';
import { changedSince, cleanText, PLAYBOOK_LIMITS, parseSkill, SKILL_FILE, type SkillText, scopeLabel, skillMarkdown, skillProblem } from './playbookText.ts';
import { frameRef, frameTarget, imageRef, linkRef } from './refs.ts';
import { storage } from './storage/index.ts';
import * as store from './store.ts';
import { recurringAsks } from './taste.ts';
import { compareTime, oneLine } from './time.ts';
import type {
  NoteRef,
  Playbook,
  PlaybookLayer,
  PlaybookProposal,
  PlaybookRevision,
  PlaybookScope,
  PlaybookSection,
  PlaybookSkill,
  PlaybookSkillSummary,
  PlaybookSummary,
  PlaybookText,
  PlaybookView,
  PlaybookWaiting,
  TasteSuggestion,
} from './types.ts';

export { chainOf, HOUSE, stampFor } from './playbookFiles.ts';
export { PLAYBOOK_LIMITS, parseSkill, scopeLabel, skillMarkdown } from './playbookText.ts';

/** A mistake the caller can fix (the routes answer 400/404/409 with its message). */
export class PlaybookError extends Error {
  status: number;
  details?: Record<string, unknown>;
  constructor(status: number, message: string, details?: Record<string, unknown>) {
    super(message);
    this.status = status;
    this.details = details;
  }
}
const bad = (message: string) => new PlaybookError(400, message);

// ---------------------------------------------------------------- scopes

const normScope = (scope: string | null | undefined): PlaybookScope =>
  String(scope || '')
    .split('/')
    .map((s) => s.trim().replace(/\s+/g, ' '))
    .filter(Boolean)
    .join('/');

/** A scope someone asks for: the House, or a folder that exists in the library. */
export function checkScope(scope: string | null | undefined, folders: string[]): PlaybookScope {
  const s = normScope(scope);
  if (s !== HOUSE && !folders.includes(s)) throw new PlaybookError(404, `there is no folder "${s}"`);
  return s;
}

/** A video's playbook scope: its folder (Unsorted videos have the House only). */
export function scopeOfVideo(slug: string): PlaybookScope {
  const r = store.loadReview(slug);
  if (!r) throw new PlaybookError(404, 'no such video');
  return normScope(r.folder);
}

// ---------------------------------------------------------------- reading and writing

const newId = (prefix: string) => `${prefix}_${crypto.randomBytes(6).toString('hex')}`;

function empty(scope: PlaybookScope): Playbook {
  return { id: newId('pb'), scope, rev: 0, updated: null, by: null, brief: '', rules: '', refs: [], skills: [], history: [], proposals: [] };
}

/** The playbook of a scope; an empty one when it has none yet (nothing is written until someone edits it). */
export const loadPlaybook = (scope: PlaybookScope): Playbook => readPlaybook(scope) || empty(scope);

/** Reads, changes and writes one playbook under the playbooks' lock; `fn`'s result is returned. */
function update<T>(scope: PlaybookScope, fn: (p: Playbook) => T): T {
  return store.withLock(playbookRoot(), () => {
    const p = loadPlaybook(scope);
    const out = fn(p);
    fs.mkdirSync(playbookRoot(), { recursive: true });
    store.writeAtomic(playbookFile(scope), `${JSON.stringify(p, null, 2)}\n`);
    return out;
  });
}

/**
 * A playbook brought over from another store (`vr admin import`) with ids of this store (`withFreshIds`: its id names
 * where its files are; the caller stored them first), its history as it was. Refuses a scope that has a playbook here,
 * and an id one has: nothing written here is ever replaced.
 */
export function importPlaybook(p: Playbook): void {
  store.withLock(playbookRoot(), () => {
    if (readPlaybook(p.scope)) throw new PlaybookError(409, `there is a playbook for ${p.scope ? `"${p.scope}"` : 'the House'} already`);
    if (listPlaybooks().some((x) => x.id === p.id)) throw new PlaybookError(409, `there is a playbook with the id ${p.id} already`);
    fs.mkdirSync(playbookRoot(), { recursive: true });
    store.writeAtomic(playbookFile(p.scope), `${JSON.stringify(p, null, 2)}\n`);
  });
}

/**
 * A playbook from another store with ids of this one (`vr admin import`): its own id and its skills' ids name where
 * their files are kept, and proposals are found by id across playbooks, so a bundle's ids could name this store's and
 * write over their files (sweep 2 SW-2). `skills`: each skill's id in the bundle → its new one (revisions name a
 * proposal by its new id too).
 */
export function withFreshIds<P extends { id: string; skills: { id: string }[]; proposals: { id: string }[]; history: { proposal?: string | undefined }[] }>(
  p: P,
): { playbook: P; skills: Map<string, string> } {
  const out = structuredClone(p);
  out.id = newId('pb');
  const skills = new Map<string, string>();
  for (const s of out.skills) {
    const id = newId('sk');
    skills.set(s.id, id);
    s.id = id;
  }
  const proposals = new Map<string, string>();
  for (const x of out.proposals) {
    const id = newId('pp');
    proposals.set(x.id, id);
    x.id = id;
  }
  for (const h of out.history) if (h.proposal && proposals.has(h.proposal)) h.proposal = proposals.get(h.proposal);
  return { playbook: out, skills };
}

interface Change {
  section: PlaybookSection;
  before: string | null;
  after: string | null;
  by: string;
  message?: string;
  accepted_by?: string;
  proposal?: string;
}

function revise(p: Playbook, c: Change): PlaybookRevision {
  const rev: PlaybookRevision = {
    rev: p.rev + 1,
    at: isoLocal(),
    by: c.by,
    ...(c.accepted_by ? { accepted_by: c.accepted_by } : {}),
    ...(c.proposal ? { proposal: c.proposal } : {}),
    message: cleanText(c.message || '').slice(0, PLAYBOOK_LIMITS.message) || defaultMessage(c.section, c.before, c.after),
    section: c.section,
    before: c.before,
    after: c.after,
  };
  p.rev = rev.rev;
  p.updated = rev.at;
  p.by = c.accepted_by || c.by;
  p.history.push(rev);
  if (p.history.length > PLAYBOOK_LIMITS.history) p.history.splice(0, p.history.length - PLAYBOOK_LIMITS.history);
  return rev;
}

function defaultMessage(section: PlaybookSection, before: string | null, after: string | null): string {
  if (section.startsWith('skill:')) return `${before === null ? 'Added' : after === null ? 'Removed' : 'Changed'} the skill ${section.slice(6)}`;
  if (section === 'refs') return 'Changed the references';
  return `${before ? 'Changed' : 'Wrote'} the ${section}`;
}

/** Someone edited from an older revision: refused when the same section changed since (they'd overwrite it). */
function checkBase(p: Playbook, section: PlaybookSection, base: number | undefined): void {
  if (base === undefined || base >= p.rev) return;
  const since = p.history.filter((h) => h.rev > base && h.section === section);
  if (since.length) {
    const last = since.at(-1) as PlaybookRevision;
    throw new PlaybookError(409, `${last.accepted_by || last.by} changed this since you opened it`, { rev: p.rev });
  }
}

// ---------------------------------------------------------------- brief and rules

export function writeText(
  scope: PlaybookScope,
  section: PlaybookText,
  content: string,
  o: { by: string; message?: string; base_rev?: number },
): PlaybookRevision | null {
  const text = cleanText(content);
  if (text.length > PLAYBOOK_LIMITS.text) throw bad(`the ${section} may be at most ${PLAYBOOK_LIMITS.text} characters`);
  return update(scope, (p) => {
    checkBase(p, section, o.base_rev);
    const before = p[section];
    if (before === text) return null;
    p[section] = text;
    return revise(p, { section, before: before || null, after: text || null, by: o.by, message: o.message });
  });
}

// ---------------------------------------------------------------- skills

const summary = (s: PlaybookSkill): PlaybookSkillSummary => ({ name: s.name, description: s.description, files: s.files, updated: s.updated, by: s.by });
const skillText = (s: PlaybookSkill | undefined): string | null => (s ? skillMarkdown(s) : null);

export interface SkillInput extends SkillText {
  /** Renaming: the skill's name before (its files go with it). */
  rename_from?: string;
}

export function putSkill(scope: PlaybookScope, input: SkillInput, o: { by: string; message?: string; base_rev?: number }): PlaybookRevision | null {
  const s: SkillText = {
    name: input.name.trim(),
    description: cleanText(input.description).trim(),
    body: cleanText(input.body),
    ...(input.extra?.trim() ? { extra: cleanText(input.extra) } : {}),
  };
  const problem = skillProblem(s);
  if (problem) throw bad(problem);
  return update(scope, (p) => {
    const from = input.rename_from && input.rename_from !== s.name ? input.rename_from : s.name;
    checkBase(p, `skill:${from}`, o.base_rev);
    const old = p.skills.find((x) => x.name === from);
    if (input.rename_from && input.rename_from !== s.name) {
      if (!old) throw new PlaybookError(404, `there is no skill ${input.rename_from}`);
      if (p.skills.some((x) => x.name === s.name)) throw bad(`there is already a skill called ${s.name}`);
    }
    if (!old && p.skills.length >= PLAYBOOK_LIMITS.skills) throw bad(`a playbook holds at most ${PLAYBOOK_LIMITS.skills} skills`);
    const before = skillText(old);
    const next: PlaybookSkill = { id: old?.id || newId('sk'), ...s, files: old?.files || [], updated: isoLocal(), by: o.by };
    const after = skillMarkdown(next);
    if (before === after && old?.name === next.name) return null;
    p.skills = [...p.skills.filter((x) => x.name !== from), next].sort((a, b) => a.name.localeCompare(b.name));
    if (old && old.name !== next.name) {
      // A rename is two changes to the history: the old name gone, the new one there.
      revise(p, { section: `skill:${old.name}`, before, after: null, by: o.by, message: o.message || `Renamed the skill ${old.name} to ${next.name}` });
      return revise(p, { section: `skill:${next.name}`, before: null, after, by: o.by, message: o.message || `Renamed the skill ${old.name} to ${next.name}` });
    }
    return revise(p, { section: `skill:${next.name}`, before, after, by: o.by, message: o.message });
  });
}

export function deleteSkill(scope: PlaybookScope, name: string, o: { by: string; message?: string; base_rev?: number }): PlaybookRevision {
  const out = update(scope, (p) => {
    checkBase(p, `skill:${name}`, o.base_rev);
    const old = p.skills.find((x) => x.name === name);
    if (!old) throw new PlaybookError(404, `there is no skill ${name}`);
    p.skills = p.skills.filter((x) => x.name !== name);
    return { rev: revise(p, { section: `skill:${name}`, before: skillText(old), after: null, by: o.by, message: o.message }), key: skillDirKey(p, old) };
  });
  void storage()
    .remove(out.key)
    .catch(() => {});
  return out.rev;
}

/** Where a skill's files are stored: under its id, so renaming a skill moves nothing. */
const skillDirKey = (p: Pick<Playbook, 'id'>, s: Pick<PlaybookSkill, 'id'>): string => `playbooks/${p.id}/skills/${s.id}/`;
export const skillFileKey = (p: Pick<Playbook, 'id'>, s: Pick<PlaybookSkill, 'id'>, file: string): string => `${skillDirKey(p, s)}${file}`;

/** Adds (or replaces) a small file of a skill. `file` is a path on this machine the caller received the bytes in. */
export async function addSkillFile(scope: PlaybookScope, skill: string, name: string, file: string, by: string): Promise<PlaybookRevision> {
  if (!SKILL_FILE.test(name)) throw bad('a file name is letters, digits, dots, dashes and underscores (e.g. reels-export.aep, look.cube)');
  const size = fs.statSync(file).size;
  if (!size) throw bad('the file is empty');
  if (size > PLAYBOOK_LIMITS.fileBytes) throw bad(`a skill's file may be at most ${PLAYBOOK_LIMITS.fileBytes / 1024 / 1024} MB`);
  const p = loadPlaybook(scope);
  const s = p.skills.find((x) => x.name === skill);
  if (!s) throw new PlaybookError(404, `there is no skill ${skill}`);
  if (!s.files.some((f) => f.name === name) && s.files.length >= PLAYBOOK_LIMITS.filesPerSkill)
    throw bad(`a skill carries at most ${PLAYBOOK_LIMITS.filesPerSkill} files`);
  // Served as a download only (application/octet-stream): never shown or run in a browser, never run by Lampo.
  await storage().put(skillFileKey(p, s, name), file, { keep: true, contentType: 'application/octet-stream' });
  return update(scope, (q) => {
    const sk = q.skills.find((x) => x.name === skill);
    if (!sk) throw new PlaybookError(404, `there is no skill ${skill}`);
    const before = skillText(sk);
    const had = sk.files.some((f) => f.name === name);
    sk.files = [...sk.files.filter((f) => f.name !== name), { name, size, at: isoLocal(), by }].sort((a, b) => a.name.localeCompare(b.name));
    sk.updated = isoLocal();
    return revise(q, {
      section: `skill:${skill}`,
      before,
      after: skillText(sk),
      by,
      message: `${had ? 'Replaced' : 'Added'} ${name} (${Math.max(1, Math.round(size / 1024))} KB) in the skill ${skill}`,
    });
  });
}

export function removeSkillFile(scope: PlaybookScope, skill: string, name: string, by: string): PlaybookRevision {
  const out = update(scope, (p) => {
    const sk = p.skills.find((x) => x.name === skill);
    if (!sk) throw new PlaybookError(404, `there is no skill ${skill}`);
    if (!sk.files.some((f) => f.name === name)) throw new PlaybookError(404, 'no such file');
    const before = skillText(sk);
    sk.files = sk.files.filter((f) => f.name !== name);
    sk.updated = isoLocal();
    return {
      rev: revise(p, { section: `skill:${skill}`, before, after: skillText(sk), by, message: `Removed ${name} from the skill ${skill}` }),
      key: skillFileKey(p, sk, name),
    };
  });
  void storage()
    .remove(out.key)
    .catch(() => {});
  return out.rev;
}

/** A skill's file on this machine (a working copy with remote storage); null when it is gone. */
export async function skillFile(scope: PlaybookScope, skill: string, name: string): Promise<string | null> {
  const p = readPlaybook(scope);
  const s = p?.skills.find((x) => x.name === skill);
  if (!p || !s?.files.some((f) => f.name === name)) return null;
  return storage().ensureLocal(skillFileKey(p, s, name));
}

// ---------------------------------------------------------------- references

export const refFileKey = (p: Pick<Playbook, 'id'>, file: string): string => `playbooks/${p.id}/refs/${file}`;

const refLine = (r: NoteRef): string =>
  r.kind === 'link' ? `link ${r.url}` : r.kind === 'frame' ? `${r.name} v${r.v} ${r.timecode}` : `image ${r.file}${r.caption ? ` — ${r.caption}` : ''}`;
const refsText = (refs: NoteRef[]): string | null => (refs.length ? refs.map((r) => `- ${refLine(r)}${r.caption ? ` (${r.caption})` : ''}`).join('\n') : null);

export type PlaybookRefInput =
  | { kind: 'link'; url: string; caption?: string }
  | { kind: 'frame'; video: string; v?: number; frame: number; to_frame?: number; caption?: string }
  | { kind: 'image'; file: string; caption?: string };

export async function addRef(scope: PlaybookScope, input: PlaybookRefInput, by: string): Promise<{ ref: NoteRef; rev: PlaybookRevision }> {
  const p = loadPlaybook(scope);
  if (p.refs.length >= PLAYBOOK_LIMITS.refs) throw bad(`a playbook holds at most ${PLAYBOOK_LIMITS.refs} references`);
  // A new playbook's id must be the one written, so its files land where it will look for them.
  if (!p.rev && !readPlaybook(scope)) update(scope, () => {});
  const stored = loadPlaybook(scope);
  const req = { by, caption: input.caption };
  let ref: NoteRef;
  try {
    if (input.kind === 'link') ref = linkRef(input.url, req);
    else if (input.kind === 'frame') {
      frameTarget(input);
      ref = await frameRef(input.video, input, req, (f) => refFileKey(stored, f));
    } else ref = await imageRef(input.file, (f) => refFileKey(stored, f), req);
  } catch (e) {
    throw e instanceof PlaybookError ? e : bad((e as Error).message);
  }
  const rev = update(scope, (q) => {
    const before = refsText(q.refs);
    q.refs.push(ref);
    return revise(q, { section: 'refs', before, after: refsText(q.refs), by, message: `Added a reference: ${refLine(ref)}` });
  });
  return { ref, rev };
}

export function removeRef(scope: PlaybookScope, id: string, by: string): PlaybookRevision {
  const out = update(scope, (p) => {
    const ref = p.refs.find((r) => r.id === id);
    if (!ref) throw new PlaybookError(404, 'no such reference');
    const before = refsText(p.refs);
    p.refs = p.refs.filter((r) => r.id !== id);
    return { rev: revise(p, { section: 'refs', before, after: refsText(p.refs), by, message: `Removed a reference: ${refLine(ref)}` }), ref, id: p.id };
  });
  for (const f of store.refFiles(out.ref))
    void storage()
      .remove(refFileKey({ id: out.id }, f))
      .catch(() => {});
  return out.rev;
}

/** A reference's file on this machine; null unless a reference of this playbook names it. */
export async function refFile(scope: PlaybookScope, file: string): Promise<string | null> {
  const p = readPlaybook(scope);
  if (!p?.refs.some((r) => store.refFiles(r).includes(file))) return null;
  return storage().ensureLocal(refFileKey(p, file));
}

// ---------------------------------------------------------------- proposals

export interface ProposalInput {
  section: PlaybookText | `skill:${string}`;
  content: string;
  reason: string;
  evidence?: string[];
  by: string;
}

/** An agent (or anyone who may comment) suggests a change; a person with the right to edit accepts or rejects it. */
export function propose(scope: PlaybookScope, input: ProposalInput): PlaybookProposal {
  const content = cleanText(input.content);
  const reason = cleanText(input.reason).trim();
  if (!reason) throw bad('say why: the reason is what the person deciding reads first');
  if (reason.length > PLAYBOOK_LIMITS.reason) throw bad(`a reason may be at most ${PLAYBOOK_LIMITS.reason} characters`);
  const evidence = [...new Set(input.evidence || [])];
  if (evidence.length > PLAYBOOK_LIMITS.evidence) throw bad(`at most ${PLAYBOOK_LIMITS.evidence} notes as evidence`);
  for (const id of evidence) if (!store.findComment(id)) throw bad(`there is no note ${id}`);
  let section = input.section;
  if (section === 'brief' || section === 'rules') {
    if (content.length > PLAYBOOK_LIMITS.text) throw bad(`the ${section} may be at most ${PLAYBOOK_LIMITS.text} characters`);
  } else if (section.startsWith('skill:')) {
    let s: SkillText;
    try {
      s = parseSkill(content);
    } catch (e) {
      throw bad((e as Error).message);
    }
    const problem = skillProblem(s);
    if (problem) throw bad(problem);
    // The skill's own name decides which skill it is.
    section = `skill:${s.name}`;
  } else throw bad('a proposal changes the brief, the rules or one skill');
  return update(scope, (p) => {
    const pending = p.proposals.filter((x) => x.status === 'pending');
    if (pending.length >= PLAYBOOK_LIMITS.pending) throw bad(`this playbook already has ${PLAYBOOK_LIMITS.pending} suggestions waiting; wait for a decision`);
    const current = section === 'brief' || section === 'rules' ? p[section] : skillText(p.skills.find((x) => `skill:${x.name}` === section)) || '';
    if (cleanText(current) === content) throw bad('that is what the playbook already says');
    const prop: PlaybookProposal = {
      id: newId('pp'),
      scope,
      at: isoLocal(),
      by: input.by,
      section,
      content,
      reason,
      evidence,
      base_rev: p.rev,
      status: 'pending',
    };
    p.proposals.push(prop);
    return prop;
  });
}

/** Where a proposal lives (ids are unique across playbooks). */
export function findProposal(id: string): { scope: PlaybookScope; proposal: PlaybookProposal } | null {
  for (const p of listPlaybooks()) {
    const x = p.proposals.find((q) => q.id === id);
    if (x) return { scope: p.scope, proposal: x };
  }
  return null;
}

function trimDecided(p: Playbook): void {
  const decided = p.proposals.filter((x) => x.status !== 'pending');
  if (decided.length <= PLAYBOOK_LIMITS.decided) return;
  const drop = new Set(decided.slice(0, decided.length - PLAYBOOK_LIMITS.decided).map((x) => x.id));
  p.proposals = p.proposals.filter((x) => !drop.has(x.id));
}

/**
 * A suggestion is a whole new text made against the revision it saw: accepting it after someone changed the same
 * section (a person's edit, or another suggestion accepted for it) would silently replace that change, so that is
 * refused — unless the person deciding says which revision they looked at the diff against (`seen`, the playbook's
 * revision on their screen) and nothing changed in that section since: then it replaces it on purpose.
 */
function checkProposalBase(p: Playbook, prop: PlaybookProposal, seen?: number): void {
  const last = changedSince(p, prop, seen);
  if (!last) return;
  const by = last.accepted_by || last.by;
  const what = prop.section.startsWith('skill:') ? `the skill ${prop.section.slice(6)}` : `the ${prop.section}`;
  const after =
    seen !== undefined && seen > prop.base_rev ? `r${Math.min(seen, p.rev)}, the revision you looked at` : `this suggestion was made on r${prop.base_rev}`;
  throw new PlaybookError(
    409,
    `${by} changed ${what} in r${last.rev}, after ${after}; accepting it would replace that change. Look at the diff again, then accept it with base_rev ${p.rev} to replace it on purpose, or reject it`,
    { by, changed_rev: last.rev, base_rev: prop.base_rev, rev: p.rev, ...(last.proposal ? { proposal: last.proposal } : {}) },
  );
}

/**
 * Accepts a suggestion: its text becomes the section's next revision. `base_rev`: the playbook's revision the person
 * deciding saw the diff against (the app sends it); without it, the suggestion's own.
 */
export function acceptProposal(id: string, o: { by: string; message?: string; base_rev?: number }): { proposal: PlaybookProposal; rev: PlaybookRevision } {
  const hit = findProposal(id);
  if (!hit) throw new PlaybookError(404, 'no such suggestion');
  return update(hit.scope, (p) => {
    const prop = p.proposals.find((x) => x.id === id);
    if (!prop) throw new PlaybookError(404, 'no such suggestion');
    if (prop.status !== 'pending') throw new PlaybookError(409, `this suggestion was ${prop.status} already`);
    checkProposalBase(p, prop, o.base_rev);
    let rev: PlaybookRevision;
    const change = { by: prop.by, accepted_by: o.by, proposal: prop.id, message: o.message || `${prop.reason.split('\n')[0].slice(0, 160)}` };
    if (prop.section === 'brief' || prop.section === 'rules') {
      const before = p[prop.section];
      p[prop.section] = prop.content;
      rev = revise(p, { ...change, section: prop.section, before: before || null, after: prop.content || null });
    } else {
      const s = parseSkill(prop.content);
      const old = p.skills.find((x) => x.name === s.name);
      if (!old && p.skills.length >= PLAYBOOK_LIMITS.skills) throw bad(`a playbook holds at most ${PLAYBOOK_LIMITS.skills} skills`);
      const next: PlaybookSkill = { id: old?.id || newId('sk'), ...s, files: old?.files || [], updated: isoLocal(), by: prop.by };
      p.skills = [...p.skills.filter((x) => x.name !== s.name), next].sort((a, b) => a.name.localeCompare(b.name));
      rev = revise(p, { ...change, section: `skill:${s.name}`, before: skillText(old), after: skillMarkdown(next) });
    }
    Object.assign(prop, { status: 'accepted', decided_by: o.by, decided_at: rev.at, rev: rev.rev });
    trimDecided(p);
    return { proposal: prop, rev };
  });
}

export function rejectProposal(id: string, o: { by: string; reason?: string }): PlaybookProposal {
  const hit = findProposal(id);
  if (!hit) throw new PlaybookError(404, 'no such suggestion');
  return update(hit.scope, (p) => {
    const prop = p.proposals.find((x) => x.id === id);
    if (!prop) throw new PlaybookError(404, 'no such suggestion');
    if (prop.status !== 'pending') throw new PlaybookError(409, `this suggestion was ${prop.status} already`);
    const why = cleanText(o.reason || '')
      .trim()
      .slice(0, PLAYBOOK_LIMITS.reason);
    Object.assign(prop, { status: 'rejected', decided_by: o.by, decided_at: isoLocal(), ...(why ? { reject_reason: why } : {}) });
    trimDecided(p);
    return prop;
  });
}

/** Every suggestion waiting for a decision, newest first (the inbox). */
export function pendingProposals(): PlaybookProposal[] {
  return listPlaybooks()
    .flatMap((p) => p.proposals.filter((x) => x.status === 'pending'))
    .sort((a, b) => compareTime(b.at, a.at));
}

/** A section's current text in a playbook (a skill: its SKILL.md; '' when there is none yet), for diffs. */
export function currentText(p: Playbook, section: PlaybookSection): string {
  if (section === 'brief' || section === 'rules') return p[section];
  if (section.startsWith('skill:')) return skillText(p.skills.find((x) => `skill:${x.name}` === section)) || '';
  return refsText(p.refs) || '';
}

// ---------------------------------------------------------------- what people and agents read

const layerOf = (p: Playbook): PlaybookLayer => ({ scope: p.scope, rev: p.rev, brief: p.brief, rules: p.rules, refs: p.refs, skills: p.skills.map(summary) });
const hasContent = (p: Playbook): boolean => !!p.brief || !!p.rules || !!p.refs.length || !!p.skills.length;

/** The playbooks of a chain that have content, House first. */
export function layersFor(scope: PlaybookScope): Playbook[] {
  return chainOf(scope)
    .map((s) => readPlaybook(s))
    .filter((p): p is Playbook => !!p && hasContent(p));
}

/** Every skill of a chain, the deepest of a name winning. */
export function skillsFor(scope: PlaybookScope): (PlaybookSkill & { from: PlaybookScope })[] {
  const byName = new Map<string, PlaybookSkill & { from: PlaybookScope }>();
  for (const p of layersFor(scope)) for (const s of p.skills) byName.set(s.name, { ...s, from: p.scope });
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** One skill as it applies to a scope (its own or inherited). */
export function skillFor(scope: PlaybookScope, name: string): (PlaybookSkill & { from: PlaybookScope }) | null {
  return skillsFor(scope).find((s) => s.name === name) || null;
}

const heading = (p: Playbook) => oneLine(`From ${scopeLabel(p.scope)} (revision ${p.rev})`);

/**
 * The merged playbook as agents read it: most specific first, each part saying where it comes from, so an agent sees
 * both what applies and which layer to cite. Skills are listed; their instructions come with get_skill.
 */
export function agentMarkdown(scope: PlaybookScope): string {
  const layers = layersFor(scope);
  const deep = [...layers].reverse();
  const L: string[] = [];
  // A scope is a folder's name (a person's, or an agent's: organize): never a line of its own (A12 VC-6).
  L.push(oneLine(`# Playbook: ${scopeLabel(scope)}`));
  L.push('');
  if (!layers.length) {
    L.push(oneLine(`No playbook applies to ${scope ? `"${scope}"` : 'the House'} yet. Follow the notes and the taste file.`));
    L.push('');
    L.push('Know a rule the team keeps asking for? Suggest it with propose_playbook_change (MCP) or `vr playbook propose`; a person decides.');
    return `${L.join('\n')}\n`;
  }
  // one line per paragraph: the app shows this text as it is, and a hard wrap wraps again, raggedly, when narrower
  L.push('What the team decided before anyone watched your render. Read it before you render, follow it, and cite it when a note seems to contradict it.');
  L.push(
    oneLine(
      `Layers, deepest first: ${deep.map((p) => `${scopeLabel(p.scope)} r${p.rev}`).join(' · ')}. Where two layers disagree, the deeper one (listed first) wins.`,
    ),
  );
  L.push('');
  const section = (title: string, get: (p: Playbook) => string) => {
    const withText = deep.filter((p) => get(p).trim());
    if (!withText.length) return;
    L.push(`## ${title}`);
    L.push('');
    for (const p of withText) {
      L.push(`### ${heading(p)}`);
      L.push('');
      L.push(get(p).trim());
      L.push('');
    }
  };
  section('Brief', (p) => p.brief);
  section('Rules', (p) => p.rules);
  const skills = skillsFor(scope);
  if (skills.length) {
    L.push('## Skills');
    L.push('');
    L.push('Instructions for recurring work (the Agent Skills format). Load one with get_skill or `vr playbook skill <name>`.');
    L.push('');
    for (const s of skills)
      L.push(
        oneLine(`- **${s.name}** (from ${scopeLabel(s.from)}): ${s.description}${s.files.length ? ` — files: ${s.files.map((f) => f.name).join(', ')}` : ''}`),
      );
    L.push('');
  }
  const refs = deep.flatMap((p) => p.refs.map((r) => ({ r, p })));
  if (refs.length) {
    L.push('## References');
    L.push('');
    for (const { r, p } of refs) L.push(oneLine(`- ${refLine(r)}${r.caption && r.kind !== 'image' ? ` — ${r.caption}` : ''} (from ${scopeLabel(p.scope)})`));
    L.push('');
  }
  L.push('## Changing it');
  L.push('');
  L.push(
    'You can suggest a change (propose_playbook_change / `vr playbook propose`) with the reason and the notes behind it; a person accepts or rejects it. Never edit around a rule silently.',
  );
  return `${L.join('\n')}\n`;
}

/** A playbook with what it inherits and what an agent reads (GET /api/playbook). */
export function playbookView(scope: PlaybookScope, o: { suggestions?: boolean } = {}): PlaybookView {
  const playbook = loadPlaybook(scope);
  const layers = layersFor(scope).filter((p) => p.scope !== scope);
  const skills = skillsFor(scope).map(({ body: _body, extra: _extra, id: _id, ...s }) => s);
  const view: PlaybookView = {
    scope,
    label: scopeLabel(scope),
    playbook,
    layers: layers.map(layerOf),
    skills,
    stamp: stampFor(scope),
    markdown: agentMarkdown(scope),
  };
  if (o.suggestions) {
    view.suggestions = suggestionsFor(scope, playbook);
    view.below = waitingBelow(scope);
  }
  return view;
}

/** The playbooks of folders inside a scope (any depth; the House: every folder's) with suggestions waiting. */
export function waitingBelow(scope: PlaybookScope): PlaybookWaiting[] {
  return listPlaybooks()
    .filter((p) => p.scope !== scope && (scope === HOUSE || p.scope.startsWith(`${scope}/`)))
    .map((p) => ({ scope: p.scope, pending: p.proposals.filter((x) => x.status === 'pending').length }))
    .filter((x) => x.pending > 0)
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

/** Recurring asks from the notes that the playbook's rules don't mention yet (by their tag). */
export function suggestionsFor(scope: PlaybookScope, p: Playbook = loadPlaybook(scope)): TasteSuggestion[] {
  const rules = layersFor(scope)
    .map((x) => x.rules)
    .concat(p.rules)
    .join('\n')
    .toLowerCase();
  return recurringAsks(store.listReviews(), scope ? { folder: scope } : {})
    .filter((s) => !rules.includes(s.tag.toLowerCase()))
    .slice(0, 6);
}

/** Every playbook with content or suggestions waiting (the folder list's badges). */
export function summaries(): PlaybookSummary[] {
  return listPlaybooks()
    .filter((p) => hasContent(p) || p.proposals.some((x) => x.status === 'pending'))
    .map((p) => ({
      scope: p.scope,
      rev: p.rev,
      updated: p.updated,
      skills: p.skills.length,
      pending: p.proposals.filter((x) => x.status === 'pending').length,
    }))
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

export const playbookDir = (): string => playbookRoot();
export const archiveDir = (): string => path.join(playbookRoot(), 'archive');
