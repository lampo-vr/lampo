// A person's own data as one zip (A13 PEOPLE-1: GDPR Art. 15 and 20): what the account is, where it works, how it gets
// in, and in each of its workspaces what it wrote and made — its notes and its replies (never anyone else's words: a
// reply on someone else's note carries only that note's id), its drafts, its unsent recordings with their audio, its
// verdicts, the review links it made, what it watched, and the metadata of what it uploaded (never the videos: they
// are the team's). JSON files with plain field names and a README that says what each is. The same for Settings →
// Profile → Export my data and `vr admin export-account`.
//
// Ownership goes by account id (author_id, by_id, added_by_id: lib/ownership.ts); only verdicts and versions, which
// record a name and no account, go by the account's name in that workspace (names are unique in a workspace).
import fs from 'node:fs';
import zlib from 'node:zlib';
import * as auth from './auth.ts';
import { avatarKey } from './avatars.ts';
import { listDrafts } from './drafts.ts';
import { listApps } from './oauth/store.ts';
import { slugify } from './paths.ts';
import { listSubs } from './push/index.ts';
import { audioFile, listRecordings, publicRecording } from './recordings.ts';
import { inWorkspace } from './scope.ts';
import { listShares } from './shares.ts';
import { rootStorage } from './storage/index.ts';
import { listReviews } from './store.ts';
import type { Comment, Review } from './types.ts';
import { readViews } from './views.ts';
import * as workspaces from './workspaces.ts';
import { planZip, type ZipPlan } from './zip.ts';

export interface ExportFile {
  name: string;
  data: Buffer;
}

const json = (name: string, value: unknown): ExportFile => ({ name, data: Buffer.from(`${JSON.stringify(value, null, 2)}\n`) });

/** A video as the export names it: its id, its name and its folder (never a path on the server). */
const videoOf = (r: Review) => ({ id: r.id ?? null, name: r.video.split('/').pop() ?? r.video, folder: r.folder });

/** A note's own fields, the drawing and files left out (they are the workspace's); its replies only when theirs. */
function noteOf(c: Comment, mine: (byId?: string) => boolean) {
  return {
    id: c.id,
    v: c.v,
    frame: c.frame,
    timecode: c.timecode,
    ...(c.range ? { range: c.range } : {}),
    text: c.text,
    tags: c.tags,
    severity: c.severity,
    kind: c.kind ?? 'feedback',
    status: c.status,
    created: c.created,
    ...(c.edited ? { edited: c.edited } : {}),
    replies: c.replies.filter((x) => mine(x.by_id)).map((x) => ({ text: x.text, at: x.at, ...(x.status ? { status: x.status } : {}) })),
  };
}

const README = `Your data from Lampo

profile.json         your account: name, address, when it was made, your settings
avatar.jpg           your profile picture (when you have one)
workspaces.json      the workspaces you work in and your role in each
access.json          your API tokens (names and dates, never the tokens), connected apps and devices
workspaces/<id>/
  notes.json         the notes you wrote, with your replies on them
  replies.json       your replies on other people's notes (with that note's id, never its words)
  drafts.json        notes you kept as drafts
  recordings.json    recordings you haven't sent yet (their audio in recordings/)
  verdicts.json      the versions you approved or asked changes for
  links.json         the review links you made (never their addresses)
  watching.json      which videos you watched, and how much
  uploads.json       what you uploaded: file names, sizes, dates (the videos themselves are the workspace's)

Notes and replies made before accounts were recorded with them, and anything other people wrote, are not in here.
`;

/** Everything of account `userId`, as files (see the top). */
export async function accountExport(userId: string): Promise<ExportFile[]> {
  const u = auth.getUser(userId);
  if (!u) throw new workspaces.WorkspaceError('no such account', 404);
  const files: ExportFile[] = [{ name: 'README.txt', data: Buffer.from(README) }];
  files.push(
    json('profile.json', {
      id: u.id,
      name: u.name,
      email: u.email,
      ...(u.pending_email ? { pending_email: u.pending_email } : {}),
      created: u.created,
      ...(u.signed_in ? { last_sign_in: u.signed_in } : {}),
      ...(u.unverified ? { unverified_since: u.unverified } : {}),
      ...(u.signup ? { signed_up: u.signup } : {}),
      ...(u.disabled ? { disabled: u.disabled } : {}),
      has_password: !!u.password,
      settings: u.prefs ?? {},
    }),
  );
  if (u.avatar)
    try {
      const file = await rootStorage().ensureLocal(avatarKey(u.avatar));
      if (file) files.push({ name: 'avatar.jpg', data: fs.readFileSync(file) });
    } catch (e) {
      console.error(`export: ${u.id}: picture: ${(e as Error).message}`);
    }
  const mine = workspaces.workspacesOf(userId, { suspended: true });
  files.push(
    json(
      'workspaces.json',
      mine.map(({ workspace, role }) => {
        const m = workspace.members.find((x) => x.user === userId);
        return { id: workspace.id, name: workspace.name, role, since: m?.since ?? null, ...(m?.suspended ? { suspended: m.suspended } : {}) };
      }),
    ),
  );
  files.push(
    json('access.json', {
      tokens: auth.listTokens(userId).map((t) => ({
        name: t.name,
        created: t.created,
        last_used: t.last_used ?? null,
        expires: t.expires ?? null,
        workspace: auth.tokenWorkspace(t),
      })),
      apps: listApps(userId).map((a) => ({
        name: a.client_name,
        host: a.client_host,
        scopes: a.scopes,
        created: a.created,
        last_used: a.last_used,
        workspace: a.workspace ?? 'w1',
      })),
      devices: listSubs()
        .filter(([, s]) => s.user === userId)
        .map(([, s]) => ({ name: s.name, created: s.created, last_ok: s.last_ok })),
    }),
  );
  for (const { workspace } of mine) {
    const dir = `workspaces/${workspace.id}`;
    const name = u.name;
    // by id where one was recorded; a name alone (older records) is never taken for theirs here
    const byMe = (byId?: string) => !!byId && byId === userId;
    const parts = inWorkspace(workspace.id, () => {
      const notes: unknown[] = [];
      const replies: unknown[] = [];
      const drafts: unknown[] = [];
      const recordings: unknown[] = [];
      const audio: ExportFile[] = [];
      const verdicts: unknown[] = [];
      const watching: unknown[] = [];
      const uploads: unknown[] = [];
      for (const r of listReviews()) {
        if (r.onboarding_sample) continue;
        const slug = slugify(r.video);
        const video = videoOf(r);
        for (const c of r.comments) {
          if (byMe(c.author_id)) notes.push({ video, ...noteOf(c, byMe) });
          else
            for (const x of c.replies)
              if (byMe(x.by_id)) replies.push({ video, note: c.id, text: x.text, at: x.at, ...(x.status ? { status: x.status } : {}) });
        }
        for (const d of listDrafts(slug, userId)) drafts.push({ video, ...noteOf(d, byMe) });
        for (const rec of listRecordings(slug)) {
          if (rec.by_id !== userId) continue;
          const { by: _by, by_id: _id, ...shown } = publicRecording(rec);
          recordings.push({ video, ...shown });
          const file = audioFile(slug, rec.id);
          if (fs.existsSync(file)) audio.push({ name: `${dir}/recordings/${rec.id}.m4a`, data: fs.readFileSync(file) });
        }
        for (const a of r.approvals ?? []) if (a.party === 'team' && a.by === name) verdicts.push({ video, v: a.v, status: a.status, at: a.at, note: a.note });
        const w = readViews(slug).viewers[userId];
        if (w) watching.push({ video, v: w.v, seconds: w.secs, plays: w.plays ?? null, last: w.last });
        const added = r.added_by_id === userId;
        const versions = r.versions.filter((v) => v.by === name || (added && v.v === 1 && !v.by));
        if (added || versions.length)
          uploads.push({
            video,
            ...(added ? { added: r.added } : {}),
            versions: versions.map((v) => ({
              v: v.v,
              size: v.size,
              duration: v.duration,
              width: v.width,
              height: v.height,
              fps: v.fps,
              registered: v.registered,
            })),
          });
      }
      const links = listShares()
        .filter((s) => s.by_id === userId)
        .map((s) => ({
          label: s.label,
          created: s.created,
          ...(s.expires ? { expires: s.expires } : {}),
          ...(s.revoked ? { revoked: s.revoked } : {}),
          kind: s.folder ? 'folder' : 'video',
          ...(s.folder ? { folder: s.folder } : {}),
        }));
      return { notes, replies, drafts, recordings, audio, verdicts, watching, uploads, links };
    });
    files.push(
      json(`${dir}/notes.json`, parts.notes),
      json(`${dir}/replies.json`, parts.replies),
      json(`${dir}/drafts.json`, parts.drafts),
      json(`${dir}/recordings.json`, parts.recordings),
      ...parts.audio,
      json(`${dir}/verdicts.json`, parts.verdicts),
      json(`${dir}/links.json`, parts.links),
      json(`${dir}/watching.json`, parts.watching),
      json(`${dir}/uploads.json`, parts.uploads),
    );
  }
  return files;
}

/** The files as one store-only zip, every byte known up front. */
export function exportZip(files: ExportFile[], at = new Date()): ZipPlan {
  return planZip(
    files.map((f) => ({
      name: f.name,
      size: f.data.length,
      crc: zlib.crc32(f.data),
      mtime: at,
      async *read(start: number, end: number) {
        yield f.data.subarray(start, end + 1);
      },
    })),
  );
}
