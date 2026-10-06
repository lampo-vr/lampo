// What is said in a render: its transcript (heard once per render's bytes, server/background.ts), as JSON for the
// player and agents, or as captions (SRT / WebVTT) to take into an editor.
import type { Request, Router } from 'express';
import { z } from 'zod';
import { shownTo } from '../../lib/publicError.ts';
import { toSrt, toVtt } from '../../lib/transcript.ts';
import type { Review, TranscriptAnswer } from '../../lib/types.ts';
import type { ServerContext } from '../context.ts';
import { getReview, getVersion } from '../helpers.ts';
import { audienceOf, fail, query, router, VersionQuery } from '../http.ts';

const LanguageQuery = z.object({ language: z.string().max(20).optional() });
/** A language someone picked for the render (ISO 639-1/-3); otherwise the engine detects it. */
const languageOf = (req: Request): string | undefined => {
  const l = (query(LanguageQuery, req).language ?? '').toLowerCase();
  if (!l || l === 'auto') return undefined;
  if (!/^[a-z]{2,3}$/.test(l)) throw fail(400, 'language: an ISO 639 code like "sv", or "auto"');
  return l;
};

export function transcriptRoutes(ctx: ServerContext): Router {
  const r = router();
  const { background } = ctx;

  // Why it failed, in words for whoever asks (the speech engine's own output names files on this server).
  const shown = (req: Request, a: TranscriptAnswer): TranscriptAnswer =>
    a.state === 'failed' && a.error ? { ...a, error: shownTo(audienceOf(req), a.error, 'the speech engine could not hear this version') } : a;
  const answer = (req: Request): { review: Review; answer: TranscriptAnswer } => {
    const review = getReview(req.params.slug as string);
    const ver = getVersion(review, query(VersionQuery, req).v);
    return { review, answer: shown(req, background.startTranscript(review, ver.v)) };
  };

  r.get('/api/review/:slug/transcript', (req, res) => {
    res.json(answer(req).answer);
  });

  // Captions: the transcript's lines as cues. 409 while it is still being heard (ask again when the event says so).
  for (const [ext, type, render] of [
    ['srt', 'application/x-subrip', toSrt],
    ['vtt', 'text/vtt', toVtt],
  ] as const) {
    r.get(`/api/review/:slug/transcript.${ext}`, (req, res) => {
      const { answer: a } = answer(req);
      if (a.state !== 'ready')
        throw fail(a.state === 'pending' ? 409 : 404, a.state === 'pending' ? 'the transcript is still being made' : a.error || 'no transcript');
      res.type(type).setHeader('Content-Disposition', `attachment; filename="transcript-v${a.v}.${ext}"`);
      res.send(render(a.transcript));
    });
  }

  // Hear it again (another model, a fixed engine, after a failure, or in a language picked because detection got it
  // wrong: ?language=sv): the kept transcript goes, a new run starts.
  r.post('/api/review/:slug/transcript/rerun', (req, res) => {
    const review = getReview(req.params.slug);
    const ver = getVersion(review, query(VersionQuery, req).v);
    res.json(shown(req, background.startTranscript(review, ver.v, languageOf(req), true)));
  });

  return r;
}
