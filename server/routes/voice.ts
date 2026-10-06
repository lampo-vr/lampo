// Voice note: raw audio body → m4a (kept) + transcript (lib/stt). The m4a waits in cache/voice until the comment is saved (see
// POST /api/review/:slug/comments); unsaved ones are cleaned up after a day.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { CACHE, cacheDir } from '../../lib/paths.ts';
import { probeFormat } from '../../lib/probe.ts';
import { transcribeFile } from '../../lib/stt/index.ts';
import { forSpeaker } from '../../lib/stt/policy.ts';
import type { VoiceResponse } from '../../lib/types.ts';
import { toM4a } from '../../lib/voice.ts';
import type { ServerContext } from '../context.ts';
import { fail, router } from '../http.ts';

const AUDIO_CONTAINERS = new Set(['matroska', 'webm', 'ogg', 'mov', 'mp4', 'wav']);

export function voiceRoutes(ctx: ServerContext): Router {
  const r = router();

  r.post('/api/voice', express.raw({ type: () => true, limit: '50mb' }), async (req, res) => {
    if (!Buffer.isBuffer(req.body) || !req.body.length) throw fail(400, 'no audio');
    const id = crypto.randomBytes(8).toString('hex');
    const dir = path.join(cacheDir(), 'voice');
    fs.mkdirSync(dir, { recursive: true });
    const raw = path.join(dir, `${id}.raw`);
    fs.writeFileSync(raw, req.body);
    try {
      // What browsers record (webm/opus, mp4/aac, ogg) or a wav; anything else never reaches ffmpeg's decoders.
      const format = await probeFormat(raw);
      if (!format.split(',').some((f) => AUDIO_CONTAINERS.has(f))) throw fail(400, 'not an audio recording');
      // Transcribe from the original recording (no AAC round trip) while the m4a for playback is written, listening
      // for the languages the speaker chose in Settings (Automatic: any; else the server's list).
      const stt = forSpeaker(ctx.cfg.stt, req.auth?.user?.prefs?.voice_languages);
      const [, transcript] = await Promise.all([toM4a(raw, path.join(dir, `${id}.m4a`)), transcribeFile(raw, stt)]);
      const out: VoiceResponse = { id, transcript, whisper: transcript !== null };
      res.json(out);
    } finally {
      fs.rmSync(raw, { force: true });
    }
  });

  return r;
}

// Voice notes that were recorded but never saved with a comment, in every workspace's cache (cache/voice and
// cache/w/<id>/voice).
export function cleanVoiceCache(maxAgeMs = 86400000): void {
  let others: string[] = [];
  try {
    others = fs.readdirSync(path.join(CACHE, 'w')).map((id) => path.join(CACHE, 'w', id, 'voice'));
  } catch {}
  for (const dir of [path.join(CACHE, 'voice'), ...others]) {
    try {
      for (const f of fs.readdirSync(dir)) if (Date.now() - fs.statSync(path.join(dir, f)).mtimeMs > maxAgeMs) fs.rmSync(path.join(dir, f), { force: true });
    } catch {}
  }
}
