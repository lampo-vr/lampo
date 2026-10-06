// Playbooks over HTTP (lib/playbooks.ts, docs/playbooks.md). Everyone on the team reads them; people with the
// `playbook` action edit and decide on suggestions; anyone who may comment (agents above all) suggests changes.
// Review links never reach these routes (the guard keeps guests on /api/g/…). A playbook names a folder by its path in
// the query or the body, never a path on a disk; files come inline (base64, small) and are served as downloads.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import express, { type Request, type Router } from 'express';
import { z } from 'zod';
import { shownFolders } from '../../lib/folders.ts';
import { byName, proposalContent, proposalEvidence, proposalReason } from '../../lib/inputs.ts';
import { can } from '../../lib/permissions.ts';
import * as playbooks from '../../lib/playbooks.ts';
import { PLAYBOOK_LIMITS, parseSkill } from '../../lib/playbookText.ts';
import { REF_FILE, REF_LIMITS } from '../../lib/refs.ts';
import { FOLDER_LIMITS } from '../../lib/store.ts';
import type { PlaybookScope } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { gate } from '../extension.ts';
import { body, fail, query, router, sendInternal } from '../http.ts';

const folder = z.string().max(FOLDER_LIMITS.length).optional();
const slug = z.string().max(600).optional();
const Where = z.object({ folder, video: slug }).strict();
const message = z.string().max(PLAYBOOK_LIMITS.message).optional();
const base_rev = z.number().int().min(0).optional();
const skillName = z.string().max(PLAYBOOK_LIMITS.skillName);

const Text = z
  .object({
    folder,
    section: z.enum(['brief', 'rules']),
    content: z.string().max(PLAYBOOK_LIMITS.text + 1000),
    message,
    base_rev,
  })
  .strict();
const Skill = z.union([
  z
    .object({
      folder,
      name: skillName,
      description: z.string().max(PLAYBOOK_LIMITS.skillDescription + 100),
      body: z.string().max(PLAYBOOK_LIMITS.skillBody + 1000),
      extra: z.string().max(4000).optional(),
      rename_from: skillName.optional(),
      message,
      base_rev,
    })
    .strict(),
  // A whole SKILL.md (an import, or what `vr playbook` sends).
  z.object({ folder, markdown: z.string().max(PLAYBOOK_LIMITS.skillBody + 6000), rename_from: skillName.optional(), message, base_rev }).strict(),
]);
const SkillQuery = z.object({ folder, video: slug, name: skillName }).strict();
const SkillFileQuery = z.object({ folder, skill: skillName, name: z.string().max(100) }).strict();
const SkillFile = z
  .object({
    folder,
    skill: skillName,
    name: z.string().max(100),
    data: z.string().max(Math.ceil(PLAYBOOK_LIMITS.fileBytes / 3) * 4 + 4),
  })
  .strict();
const caption = z.string().max(REF_LIMITS.caption).optional();
const Ref = z.union([
  z.object({ folder, kind: z.literal('link'), url: z.string().max(REF_LIMITS.url), caption }).strict(),
  z
    .object({
      folder,
      kind: z.literal('frame'),
      video: z.string().max(600),
      v: z.number().int().min(1).optional(),
      frame: z.number().int().min(0),
      to_frame: z.number().int().min(0).optional(),
      caption,
    })
    .strict(),
  z
    .object({
      folder,
      kind: z.literal('image'),
      caption,
      data: z.string().max(Math.ceil(REF_LIMITS.inlineBytes / 3) * 4 + 4),
    })
    .strict(),
]);
const RefQuery = z.object({ folder, id: z.string().regex(/^r_[a-f0-9]{10}$/) }).strict();
const RefFileQuery = z.object({ folder }).strict();
const Propose = z
  .object({
    folder,
    video: slug,
    section: z.union([z.enum(['brief', 'rules']), z.literal('skill')]),
    content: proposalContent,
    reason: proposalReason,
    evidence: proposalEvidence.optional(),
    by: byName.optional(),
  })
  .strict();
// base_rev: the playbook's revision the person deciding saw the diff against (lib/playbooks.ts acceptProposal)
const Accept = z.object({ message, base_rev }).strict();
const Reject = z.object({ reason: z.string().max(PLAYBOOK_LIMITS.reason).optional() }).strict();
const proposalId = z.string().regex(/^pp_[a-f0-9]{12}$/, 'expected a suggestion id like pp_1a2b3c4d5e6f');

/** Writes inline base64 to a temporary file for `fn`; the copy goes either way. */
async function withInline<T>(data: string, limit: number, fn: (file: string) => Promise<T>): Promise<T> {
  const bytes = Buffer.from(data, 'base64');
  if (!bytes.length) throw fail(400, 'data is empty or not base64');
  if (bytes.length > limit) throw fail(413, `the file may be at most ${Math.floor(limit / 1024 / 1024)} MB`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-playbook-in-'));
  try {
    const file = path.join(dir, 'in');
    fs.writeFileSync(file, bytes);
    return await fn(file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** lib/playbooks' own errors carry their status; anything else from it is the caller's input too. */
function run<T>(fn: () => T): T {
  try {
    return fn();
  } catch (e) {
    if (e instanceof playbooks.PlaybookError) throw fail(e.status, e.message, e.details);
    throw e;
  }
}
async function runAsync<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof playbooks.PlaybookError) throw fail(e.status, e.message, e.details);
    throw e;
  }
}

/**
 * Editing a playbook and deciding on suggestions is for people, in the app. An API token (OAuth included) is how agents
 * and scripts reach a server, and a playbook's words become every agent's instructions: with a token, suggest instead.
 * On the machine itself (`local`, `lan`) a person and an agent can't be told apart; there the files are the agent's to
 * read anyway (docs/playbooks.md, "Trust").
 */
function person(req: Request): void {
  if (req.auth?.via === 'token')
    throw fail(403, 'playbooks are edited by people in the app; with an API token, suggest the change instead (POST /api/playbook/proposals)');
}

export function playbookRoutes(ctx: ServerContext): Router {
  const r = router();
  /** The playbook a request is about: a video's folder, a folder that exists, or the House (no folder). */
  const scopeOf = (w: { folder?: string; video?: string }): PlaybookScope =>
    run(() => (w.video ? playbooks.scopeOfVideo(w.video) : playbooks.checkScope(w.folder, shownFolders().folders)));
  const changed = (scope: PlaybookScope, inbox = false) => {
    ctx.broadcast('playbook', { scope });
    if (inbox) ctx.broadcast('for-you');
  };

  r.get('/api/playbooks', (_req, res) => {
    res.json({ playbooks: playbooks.summaries() });
  });

  r.get('/api/playbook', (req, res) => {
    const scope = scopeOf(query(Where, req));
    res.json(playbooks.playbookView(scope, { suggestions: can(req.auth?.role, 'playbook') }));
  });

  r.put('/api/playbook/text', express.json({ limit: '1mb' }), (req, res) => {
    person(req);
    const b = body(Text, req);
    const scope = scopeOf(b);
    const rev = run(() => playbooks.writeText(scope, b.section, b.content, { by: ctx.actor(req), message: b.message, base_rev: b.base_rev }));
    if (rev) changed(scope);
    res.json({ rev, playbook: playbooks.loadPlaybook(scope) });
  });

  r.get('/api/playbook/skill', (req, res) => {
    const q = query(SkillQuery, req);
    const skill = playbooks.skillFor(scopeOf(q), q.name);
    if (!skill) throw fail(404, `there is no skill ${q.name} here`);
    const { id: _id, ...rest } = skill;
    res.json({ ...rest, markdown: playbooks.skillMarkdown(skill) });
  });

  r.put('/api/playbook/skill', express.json({ limit: '1mb' }), (req, res) => {
    person(req);
    const b = body(Skill, req);
    const scope = scopeOf(b);
    const input = run(() => {
      if (!('markdown' in b)) return { name: b.name, description: b.description, body: b.body, extra: b.extra, rename_from: b.rename_from };
      try {
        return { ...parseSkill(b.markdown), rename_from: b.rename_from };
      } catch (e) {
        throw new playbooks.PlaybookError(400, (e as Error).message);
      }
    });
    const rev = run(() => playbooks.putSkill(scope, input, { by: ctx.actor(req), message: b.message, base_rev: b.base_rev }));
    if (rev) changed(scope);
    res.json({ rev, playbook: playbooks.loadPlaybook(scope) });
  });

  r.delete('/api/playbook/skill', (req, res) => {
    person(req);
    const q = query(SkillQuery, req);
    const scope = scopeOf(q);
    const rev = run(() => playbooks.deleteSkill(scope, q.name, { by: ctx.actor(req) }));
    changed(scope);
    res.json({ rev, playbook: playbooks.loadPlaybook(scope) });
  });

  r.post(
    '/api/playbook/skill/files',
    gate(() => ctx.extension, 'upload'),
    express.json({ limit: '4mb' }),
    async (req, res) => {
      person(req);
      const b = body(SkillFile, req);
      const scope = scopeOf(b);
      const rev = await withInline(b.data, PLAYBOOK_LIMITS.fileBytes, (file) =>
        runAsync(() => playbooks.addSkillFile(scope, b.skill, b.name, file, ctx.actor(req))),
      );
      changed(scope);
      res.json({ rev, playbook: playbooks.loadPlaybook(scope) });
    },
  );

  r.delete('/api/playbook/skill/files', (req, res) => {
    person(req);
    const q = query(SkillFileQuery, req);
    const scope = scopeOf(q);
    const rev = run(() => playbooks.removeSkillFile(scope, q.skill, q.name, ctx.actor(req)));
    changed(scope);
    res.json({ rev, playbook: playbooks.loadPlaybook(scope) });
  });

  // A download, never something a browser shows or runs: presets, LUTs and scripts are for the agent's own machine.
  r.get('/api/playbook/skill/files', async (req, res) => {
    const q = query(SkillFileQuery, req);
    const file = await playbooks.skillFile(scopeOf(q), q.skill, q.name);
    if (!file) throw fail(404, 'no such file');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${q.name}"`);
    res.setHeader('Cache-Control', 'private, no-cache');
    sendInternal(res, file);
  });

  r.post(
    '/api/playbook/refs',
    gate(() => ctx.extension, 'upload'),
    express.json({ limit: '12mb' }),
    async (req, res) => {
      person(req);
      const b = body(Ref, req);
      // `video` in a frame reference is the moment's video, not which playbook: that is the folder.
      const scope = scopeOf({ folder: b.folder });
      const by = ctx.actor(req);
      const out =
        b.kind === 'image'
          ? await withInline(b.data, REF_LIMITS.inlineBytes, (file) => runAsync(() => playbooks.addRef(scope, { kind: 'image', file, caption: b.caption }, by)))
          : await runAsync(() => playbooks.addRef(scope, b.kind === 'link' ? { kind: 'link', url: b.url, caption: b.caption } : b, by));
      changed(scope);
      res.json({ ref: out.ref, rev: out.rev, playbook: playbooks.loadPlaybook(scope) });
    },
  );

  r.delete('/api/playbook/refs', (req, res) => {
    person(req);
    const q = query(RefQuery, req);
    const scope = scopeOf(q);
    const rev = run(() => playbooks.removeRef(scope, q.id, ctx.actor(req)));
    changed(scope);
    res.json({ rev, playbook: playbooks.loadPlaybook(scope) });
  });

  // Pictures of a playbook's references (their images and stills): only files a reference of that playbook names.
  r.get('/api/playbook/refs/:file', async (req, res) => {
    const { file } = req.params;
    if (!REF_FILE.test(file) || file.endsWith('.mp4')) throw fail(404, 'not found');
    const local = await playbooks.refFile(scopeOf(query(RefFileQuery, req)), file);
    if (!local) throw fail(404, 'not found');
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    sendInternal(res, local);
  });

  // Suggestions: anyone who may comment. An agent labels itself (`by: "agent:…"`), people write as themselves.
  r.post('/api/playbook/proposals', express.json({ limit: '1mb' }), (req, res) => {
    const b = body(Propose, req);
    const scope = scopeOf(b);
    const proposal = run(() =>
      playbooks.propose(scope, {
        // a skill is named by its SKILL.md's frontmatter (lib/playbooks checks it)
        section: b.section === 'skill' ? `skill:${skillNameOf(b.content)}` : b.section,
        content: b.content,
        reason: b.reason,
        evidence: b.evidence,
        by: ctx.actor(req, b.by),
      }),
    );
    changed(scope, true);
    res.status(201).json(proposal);
  });

  r.get('/api/playbook/proposals/:id', (req, res) => {
    const id = parse(proposalId, req.params.id);
    const hit = playbooks.findProposal(id);
    if (!hit) throw fail(404, 'no such suggestion');
    res.json({ ...hit.proposal, current: playbooks.currentText(playbooks.loadPlaybook(hit.scope), hit.proposal.section) });
  });

  r.post('/api/playbook/proposals/:id/accept', express.json(), (req, res) => {
    person(req);
    const id = parse(proposalId, req.params.id);
    const b = body(Accept, req);
    const out = run(() => playbooks.acceptProposal(id, { by: ctx.actor(req), message: b.message, base_rev: b.base_rev }));
    changed(out.proposal.scope, true);
    res.json(out);
  });

  r.post('/api/playbook/proposals/:id/reject', express.json(), (req, res) => {
    person(req);
    const id = parse(proposalId, req.params.id);
    const b = body(Reject, req);
    const proposal = run(() => playbooks.rejectProposal(id, { by: ctx.actor(req), reason: b.reason }));
    changed(proposal.scope, true);
    res.json(proposal);
  });

  return r;
}

const parse = <T>(schema: z.ZodType<T>, v: unknown): T => {
  const out = schema.safeParse(v);
  if (!out.success) throw fail(400, out.error.issues[0]?.message || 'bad request');
  return out.data;
};

/** The skill a proposed SKILL.md is about (its frontmatter's name); lib/playbooks checks the rest. */
function skillNameOf(md: string): string {
  try {
    return parseSkill(md).name || 'unnamed';
  } catch {
    return 'unnamed';
  }
}
