// The review store on this machine: data/ read and written directly, exactly what `vr` has always done.

import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { setAgentStatus } from '../agentStatus.ts';
import { askView, type ItemSource, makeAsk } from '../askOptions.ts';
import { localOwner } from '../auth.ts';
import { loadConfig } from '../config.ts';
import { computeDiff } from '../diff.ts';
import { attachElements, pointersOf } from '../elementMaps.ts';
import { archivedNow, checkNotArchived, checkReviewOpen } from '../folderIds.ts';
import { moveVideo, normFolder, shownFolders } from '../folders.ts';
import { ingestPart } from '../parts.ts';
import { cacheDir, dataDir, projectDirOf, reviewDir, slugify } from '../paths.ts';
import * as playbooks from '../playbooks.ts';
import { attachPreview } from '../previews.ts';
import { restrictFormats } from '../probe.ts';
import { FRAME_CACHE_BYTES, pruneDir } from '../prune.ts';
import { draftPost, PostError, postsOf, shownPosts, viewOf } from '../publish/posts.ts';
import { cachedQa, runQa } from '../qa.ts';
import { frameInRange, normalizeRange } from '../range.ts';
import { attachRefFile, frameRef, linkRef, saveRefs } from '../refs.ts';
import { renderKey } from '../renderKey.ts';
import { listSessions } from '../sessions.ts';
import { dropShots, followShots, grabFrame, shotsOrLater } from '../shots.ts';
import { stageForReview } from '../stageContext.ts';
import { storage } from '../storage/index.ts';
import * as store from '../store.ts';
import { buildTaste, writeTaste } from '../taste.ts';
import { cachedTranscript, forgetTranscript, makeTranscript } from '../transcripts.ts';
import type { AskCreated, Comment, OptionGroup, ReviewEvent } from '../types.ts';
import type { Backend, PlaybookWhere } from './types.ts';

// A render that is still being written must settle before "the newest version" means anything.
async function syncWait(slug: string, maxMs = 15000) {
  const until = Date.now() + maxMs;
  for (;;) {
    const r = store.sync(slug);
    if (!r?.pending || Date.now() > until) return r;
    await sleep(750);
  }
}

async function bytes(review: Parameters<typeof store.ensureVersionFile>[0], v: number): Promise<string> {
  const file = await store.ensureVersionFile(review, v);
  if (!file) throw new Error(`the bytes of v${v} are gone`);
  return file;
}

/** Which playbook a question is about: a video's folder, a folder that exists, or the House. */
function scopeOf(where: PlaybookWhere): string {
  return where.video ? playbooks.scopeOfVideo(where.video) : playbooks.checkScope(where.folder, shownFolders().folders);
}

export function createLocalBackend(): Backend {
  // `vr` or the MCP server on a hosted instance's own store: the same demuxer limits as the server.
  restrictFormats(loadConfig().mode === 'server');
  return {
    kind: 'local',
    // Asked when said (a hosted server makes one backend at start, outside any workspace; each call runs in one).
    get where() {
      return `data: ${dataDir()}`;
    },

    listReviews: async () => store.listReviews(),
    stage: (review) => stageForReview(review),
    resolve: async (arg, opts) => store.resolveVideo(arg, opts),
    async review(slug, { wait = false } = {}) {
      const r = (wait ? await syncWait(slug) : store.sync(slug))?.review || store.loadReview(slug);
      if (!r) throw new Error(`no review for ${slug}`);
      return r;
    },
    findComment: async (id) => store.findComment(id),
    async ask(input) {
      // Files here are this machine's (the MCP fence sends only scratch copies of sent data from elsewhere).
      const sources: Record<string, ItemSource> = {};
      for (const g of input.groups)
        for (const it of g.items) {
          const key = `${g.id}/${it.id}`;
          if (it.path) sources[key] = { file: path.resolve(it.path) };
          else if (it.url) sources[key] = { url: it.url };
          else if (it.video !== undefined && it.frame !== undefined)
            sources[key] = { frame: { video: store.resolveVideo(it.video).slug, v: it.v, frame: it.frame, to_frame: it.to_frame } };
        }
      // A file to come later needs an upload URL: only a server hands those out (MCP over HTTP); here, name its path.
      const mint = input.mintUploads;
      if (!mint && input.groups.some((g) => g.items.some((it) => it.upload))) throw new Error('send each file by path or data here: no upload URLs');
      let uploads: AskCreated['uploads'] = {};
      const made = await makeAsk({
        slug: input.slug ?? null,
        folder: input.folder ?? null,
        makeFolder: !!input.makeFolder,
        text: input.text,
        groups: input.groups,
        sources,
        answer_prompt: input.answer_prompt,
        author: input.by,
        author_id: input.by_id,
        ...(mint
          ? {
              mint: (id: string, offered: OptionGroup[]) => {
                uploads = mint(id, offered);
              },
            }
          : {}),
      });
      return { id: made.id, slug: made.slug, folder: made.folder, uploads };
    },
    askView: async (id) => askView(id),

    async addNote(slug, n) {
      const review = store.loadReview(slug);
      if (!review) throw new Error(`no review for ${slug}`);
      // nothing new in an archived project: refused before a screenshot is made (the store asks again as it writes)
      checkReviewOpen(review);
      const ver = review.versions.find((x) => x.v === n.v);
      if (!ver) throw new Error(`no v${n.v}`);
      const id = store.reservedCommentId();
      // A range is whole frames inside the render (past the end is refused); the note's frame lies inside it.
      const range = n.scope === 'video' ? null : normalizeRange(n.range, ver.frames);
      const frame = frameInRange(n.frame, range);
      // A note about the whole video has no moment to screenshot. With the on-demand gate full, the note goes without its
      // screenshots and they follow from the job queue (A13 VERIFY-2): never refused for them.
      const shots =
        n.scope === 'video'
          ? undefined
          : await shotsOrLater({
              file: await bytes(review, ver.v),
              frame,
              meta: { ...(review.meta || {}), ...ver },
              drawing: n.drawing,
              dir: reviewDir(slug),
              id,
              range,
            });
      let comment: Comment;
      try {
        comment = store.addComment(slug, { id, ...n, frame, range, ...(n.scope === 'video' ? { frame: 0, drawing: [], range: null } : {}), shots });
      } catch (e) {
        // refused as it was written (its project archived meanwhile): its screenshots go with it
        if (shots) dropShots(reviewDir(slug), id);
        throw e;
      }
      if (!comment.shots && comment.scope !== 'video') followShots(slug, comment.id);
      return { comment, review: store.loadReview(slug) || review };
    },
    updateComment: async (id, p) => store.updateComment(id, { status: p.status, note: p.note, fixed_in_v: p.fixed_in_v, preview: p.preview, by: p.by }),
    async attachPreview(commentId, file, p) {
      const { preview, comment } = await attachPreview(commentId, file, p);
      return { preview, comment };
    },
    async attachRef(commentId, input) {
      const hit = store.findComment(commentId);
      if (!hit) throw new Error(`no note ${commentId}`);
      // nothing new in an archived project: refused before a file is stored or a frame grabbed
      checkReviewOpen(hit.review);
      const req = { caption: input.caption, note: input.note, by: input.by, by_id: input.by_id };
      if (input.kind === 'file') {
        const { ref, comment } = await attachRefFile(commentId, input.path, { ...req, kind: input.as });
        return { ref, comment };
      }
      const ref = input.kind === 'link' ? linkRef(input.url, req) : await frameRef(hit.slug, input, req);
      const comment = await saveRefs(commentId, hit.slug, [ref], req);
      return { ref, comment };
    },
    refFile: (review, file) => store.ensureRefFile(slugify(review.video), file),
    refLocation: (review, file) => storage().localPath(store.refKey(slugify(review.video), file)),
    setSource: async (slug, v, source, by) => store.setVersionSource(slug, v, source, by),

    async track(videoPath, { by, byId, session, folder }) {
      // A folder that can't be made, or one in an archived project, is refused before the video is tracked, not after.
      if (folder) checkNotArchived(normFolder(folder));
      // a video in an archived project takes nothing new: a re-render waits on disk until the project is restored
      checkReviewOpen(store.loadReview(slugify(path.resolve(videoPath))));
      let { review, created } = store.createOrGetReview(videoPath, { by, byId, session });
      if (folder !== undefined) review = moveVideo(slugify(review.video), folder, by);
      return { review, created };
    },
    async push(file, { by, folder, name, to, part }) {
      const o = { name: name || path.basename(file), folder, slug: to, by, keep: true };
      const r = part ? await ingestPart(file, { ...o, ...part }) : await store.ingestUpload(file, o);
      return { review: r.review, created: r.created, duplicate: r.duplicate, v: r.version.v, ...(r.version.part ? { part: r.version.part } : {}) };
    },
    async putElements(slug, v, map) {
      const review = store.loadReview(slug);
      if (!review) throw new Error(`no review for ${slug}`);
      return attachElements(review, v, map);
    },
    pointers: async (review, comments) => pointersOf(review, comments),
    move: async (slug, folder, by, o) => moveVideo(slug, folder, by, { out: !!o?.out }),
    archivedProjects: async () => archivedNow(),
    folders: async (reviews) => shownFolders(reviews).folders,
    async assign(slug, session, by) {
      store.assignSession(slug, session, by);
    },
    sync: (slug) => syncWait(slug),
    sessions: () => listSessions(),

    async qa(review, ver, { rerun = false, progress } = {}) {
      const hit = rerun ? null : cachedQa(ver);
      if (hit) return hit;
      progress?.(`pre-reviewing v${ver.v} (OCR, safe zones, cuts, audio)…`);
      if (rerun) fs.rmSync(path.join(cacheDir(), 'qa', `${renderKey(ver)}.json`), { force: true });
      const projectDir = store.isUpload(review) ? undefined : projectDirOf(review.video);
      // the render's own language, then the machine owner's, then the server's (lib/text/language.ts)
      const languages = [cachedTranscript(ver)?.language, ...(localOwner()?.prefs?.voice_languages ?? []), ...loadConfig().stt.languages];
      return runQa(await bytes(review, ver.v), ver, review.meta || {}, { projectDir, languages });
    },
    async diff(review, ov, nv) {
      return computeDiff(await bytes(review, ov.v), ov, await bytes(review, nv.v), nv);
    },
    async transcript(review, ver, { rerun = false, progress } = {}) {
      if (rerun) forgetTranscript(ver);
      const hit = cachedTranscript(ver);
      if (hit) return hit;
      progress?.(`listening to v${ver.v} (speech to text, once per render)…`);
      return makeTranscript(await bytes(review, ver.v), ver, loadConfig().stt);
    },
    async taste(scope) {
      return { taste: buildTaste(store.listReviews(), scope), file: writeTaste(scope) };
    },
    playbook: async (where) => playbooks.playbookView(scopeOf(where)),
    async skill(where, name) {
      const s = playbooks.skillFor(scopeOf(where), name);
      if (!s) throw new Error(`there is no skill ${name} here`);
      const { id: _id, ...rest } = s;
      return { ...rest, markdown: playbooks.skillMarkdown(s) };
    },
    skillFile: (scope, skill, name) => playbooks.skillFile(scope, skill, name),
    playbookStamp: async (folder) => playbooks.stampFor(folder),
    async proposePlaybook(where, input) {
      const section = input.section === 'skill' ? (`skill:${playbooks.parseSkill(input.content).name}` as const) : input.section;
      return playbooks.propose(scopeOf(where), { ...input, section });
    },
    async proposal(id) {
      const hit = playbooks.findProposal(id);
      if (!hit) throw new Error(`there is no suggestion ${id}`);
      return { ...hit.proposal, current: playbooks.currentText(playbooks.loadPlaybook(hit.scope), hit.proposal.section) };
    },
    setStatus: async (slug, status, by) => setAgentStatus(slug, status, by),
    async draftPost(input) {
      try {
        const { post, created } = draftPost(input);
        return { post: viewOf(post), created };
      } catch (e) {
        // the stage's next step rides along, as the server sends it
        if (e instanceof PostError && e.next) throw new Error(`${e.message} (next: ${e.next})`);
        throw e;
      }
    },
    posts: async (slug) => (slug ? postsOf(slug) : shownPosts()).map((p) => viewOf(p)),
    // Footage search (lib/footage/), loaded only when used: the index is read here, the query embedded by the model's
    // own process. Shots carry the render's path on this machine; callers that aren't the machine get it removed
    // (mcp/access.ts backendFor, server/routes/footage.ts).
    async findFootage(req) {
      const f = await import('../footage/service.ts');
      return f.find(req, { local: true });
    },
    async footageSheet(ids, out) {
      const f = await import('../footage/service.ts');
      return { file: (await f.sheet(ids, out)).file };
    },
    async footageStatus() {
      return (await import('../footage/service.ts')).status();
    },
    async setFootage(on, by) {
      return (await import('../footage/service.ts')).setOn(on, by);
    },
    events: async (limit) => store.readEvents({ limit }),

    watch(onEvent, { signal } = {}) {
      if (signal?.aborted) return Promise.resolve();
      // The log of the workspace this process works in (VR_WORKSPACE, lib/scope.ts), never workspace #1's by default.
      const file = store.eventsFile();
      let pos = 0;
      try {
        pos = fs.statSync(file).size;
      } catch {}
      let partial = '';
      const tick = () => {
        let size = 0;
        try {
          size = fs.statSync(file).size;
        } catch {
          return;
        }
        if (size < pos) pos = 0;
        if (size === pos) return;
        const fd = fs.openSync(file, 'r');
        const buf = Buffer.alloc(size - pos);
        fs.readSync(fd, buf, 0, buf.length, pos);
        fs.closeSync(fd);
        pos = size;
        const lines = (partial + buf.toString('utf8')).split('\n');
        partial = lines.pop() || '';
        for (const l of lines) {
          let e: ReviewEvent;
          try {
            e = store.shownEvent(JSON.parse(l));
          } catch {
            continue;
          }
          // another store's history, which an earlier version's import appended here (store.appendHistory): never news
          if (e.imported) continue;
          onEvent(e);
        }
      };
      const timer = setInterval(tick, 700);
      let watcher: fs.FSWatcher | null = null;
      try {
        watcher = fs.watch(path.dirname(file), (_ev, name) => name?.toString() === path.basename(file) && tick());
        watcher.on('error', () => {});
      } catch {}
      return new Promise<void>((resolve) =>
        signal?.addEventListener(
          'abort',
          () => {
            clearInterval(timer);
            watcher?.close();
            resolve();
          },
          { once: true },
        ),
      );
    },

    shotFile: (review, file) => (file ? path.join(reviewDir(slugify(review.video)), file) : null),
    async fetchShots() {},
    async frame(review, ver, frame, o) {
      const png = path.join(cacheDir(), 'mcp', 'frames', `${renderKey(ver).slice(0, 16)}_${frame}.png`);
      if (!fs.existsSync(png)) {
        o?.count?.check();
        fs.mkdirSync(path.dirname(png), { recursive: true });
        await grabFrame(await bytes(review, ver.v), frame, { ...(review.meta || {}), ...ver }, png);
        o?.count?.landed();
        pruneDir(path.dirname(png), FRAME_CACHE_BYTES, (f) => f.endsWith('.png') && f !== path.basename(png));
      }
      return png;
    },
    reviewData: (review) => path.join(reviewDir(slugify(review.video)), 'review.json'),
    // Rendered from the events, like the file (which a hosted server doesn't keep writing).
    inboxMarkdown: async () => store.renderInbox(store.inboxEvents()),
    async reviewMarkdown(slug, o) {
      const r = store.loadReview(slug);
      if (!r) throw new Error(`no review ${slug}`);
      return store.renderReviewMd(o?.agentDetails === false && r.session ? { ...r, session: { ...r.session, cwd: null } } : r, {
        files: o?.files === false ? 'urls' : 'paths',
      });
    },
  };
}
