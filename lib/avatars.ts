// Profile pictures: a person uploads a picture, it is checked like every file from outside (ffprobe with the incoming
// demuxers only, a still image, bounded size and dimensions), cut to its centre square and kept as a 256 px JPEG through
// the storage adapter (avatars/<user>-<hash>.jpg: data/avatars/ on this disk, or the bucket with Bunny/S3). The account
// records the file name; the old picture goes when a new one comes.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as auth from './auth.ts';
import { CACHE } from './paths.ts';
import { FFMPEG, probe, run } from './probe.ts';
import { moveFile, rootStorage } from './storage/index.ts';
import type { ProbeResult } from './types.ts';

export const AVATAR_LIMITS = {
  bytes: 8 * 1024 * 1024,
  maxSide: 8192,
  /** Side of the stored square. */
  size: 256,
} as const;

/** What a stored picture is called: the account id, a short hash of the picture. */
export const AVATAR_FILE = /^u_[a-f0-9]{12}-[a-f0-9]{8}\.jpg$/;
export const avatarKey = (file: string): string => `avatars/${file}`;
export const avatarUrl = (file: string): string => `/api/avatars/${file}`;

const STILLS = new Set(['png', 'mjpeg', 'webp', 'gif']);

async function checkPicture(file: string): Promise<ProbeResult> {
  const size = fs.statSync(file).size;
  if (!size) throw new Error('the picture is empty');
  if (size > AVATAR_LIMITS.bytes) throw new Error(`a profile picture may be at most ${AVATAR_LIMITS.bytes / 1024 / 1024} MB`);
  let meta: ProbeResult;
  try {
    meta = await probe(file, { incoming: true });
  } catch {
    throw new Error('not a picture this app can read (send PNG, JPEG, WebP or GIF)');
  }
  if (!STILLS.has(meta.codec) || meta.frames > 1) throw new Error('a profile picture is one still picture (PNG, JPEG, WebP or GIF)');
  if (!meta.width || !meta.height || meta.width > AVATAR_LIMITS.maxSide || meta.height > AVATAR_LIMITS.maxSide)
    throw new Error(`the picture must be between 1 and ${AVATAR_LIMITS.maxSide} px on each side`);
  return meta;
}

/** Stores `file` as the account's picture and returns the updated account. The caller's file stays where it is. */
export async function saveAvatar(userId: string, file: string): Promise<auth.User> {
  if (!auth.getUser(userId)) throw new Error('no such user');
  await checkPicture(file);
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'vr-avatar-'));
  try {
    const out = path.join(work, 'avatar.jpg');
    const s = AVATAR_LIMITS.size;
    await run(
      FFMPEG,
      [
        ...['-v', 'error', '-i', file, '-map', '0:v:0', '-frames:v', '1'],
        ...['-vf', `crop='min(iw,ih)':'min(iw,ih)',scale=${s}:${s}:flags=lanczos`, '-q:v', '3', '-y', out],
      ],
      { nice: 5, incoming: true, onDemand: true },
    );
    const hash = crypto.createHash('sha256').update(fs.readFileSync(out)).digest('hex').slice(0, 8);
    const name = `${userId}-${hash}.jpg`;
    await rootStorage().put(avatarKey(name), out, { keep: false, contentType: 'image/jpeg' });
    const { user, previous } = auth.setAvatar(userId, name);
    if (previous && previous !== name)
      await rootStorage()
        .remove(avatarKey(previous))
        .catch(() => {});
    return user;
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Profile pictures once lived in cache/avatars/ on this disk, which is disposable and left out of backups; they belong
 * in data/avatars/ (the storage key is unchanged, so Bunny and S3 are untouched). Moves what is still in the old place,
 * once; a picture already in the new place stays. Returns how many moved.
 */
export function migrateAvatars(): number {
  if (rootStorage().kind !== 'local') return 0;
  const old = path.join(CACHE, 'avatars');
  let names: string[];
  try {
    names = fs.readdirSync(old);
  } catch {
    return 0;
  }
  let moved = 0;
  for (const name of names.filter((n) => AVATAR_FILE.test(n))) {
    const to = rootStorage().localPath(avatarKey(name));
    if (fs.existsSync(to)) fs.rmSync(path.join(old, name), { force: true });
    else {
      moveFile(path.join(old, name), to);
      moved++;
    }
  }
  if (!fs.readdirSync(old).length) fs.rmSync(old, { recursive: true, force: true });
  return moved;
}

/** Takes the picture away (initials again). */
export async function removeAvatar(userId: string): Promise<auth.User> {
  const { user, previous } = auth.setAvatar(userId, null);
  if (previous)
    await rootStorage()
      .remove(avatarKey(previous))
      .catch(() => {});
  return user;
}

/** The pictures of the active accounts, by the name notes carry: for avatars next to notes and replies. */
export const people = (only: (u: auth.User) => boolean = () => true): { name: string; avatar: string | null }[] =>
  auth
    .listUsers()
    .filter((u) => !u.disabled && only(u))
    .map((u) => ({ name: u.name, avatar: u.avatar ? avatarUrl(u.avatar) : null }));
