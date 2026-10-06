// "Bring your own speech-to-text": any server speaking OpenAI's /v1/audio/transcriptions (whisper.cpp's server,
// vLLM, speaches, CrispASR, hosted APIs). The note goes out as 16 kHz mono WAV, which every one of them accepts.
import type { SttHttpConfig } from '../paths.ts';
import type { Attempt, SttResult } from './policy.ts';

export function wav16(pcm: Float32Array, rate = 16000): Buffer {
  const data = Buffer.alloc(pcm.length * 2);
  for (let i = 0; i < pcm.length; i++) data.writeInt16LE(Math.round(Math.max(-1, Math.min(1, pcm[i])) * 32767), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

// verbose_json answers with language names ("german"); the policy works with ISO codes.
const NAMES: Record<string, string> = {
  german: 'de',
  english: 'en',
  french: 'fr',
  spanish: 'es',
  italian: 'it',
  dutch: 'nl',
  portuguese: 'pt',
  polish: 'pl',
  swedish: 'sv',
  danish: 'da',
  norwegian: 'no',
  finnish: 'fi',
  czech: 'cs',
  turkish: 'tr',
  russian: 'ru',
  ukrainian: 'uk',
  chinese: 'zh',
  japanese: 'ja',
  korean: 'ko',
};
const isoLanguage = (l: unknown): string => {
  const s = String(l || '').toLowerCase();
  return NAMES[s] || (/^[a-z]{2,3}$/.test(s) ? s : '');
};

export function endpoint(url: string): string {
  const base = url.replace(/\/+$/, '');
  return base.endsWith('/audio/transcriptions') ? base : `${base}${base.endsWith('/v1') ? '' : '/v1'}/audio/transcriptions`;
}

export async function httpTranscribe(pcm: Float32Array, attempt: Attempt, http: SttHttpConfig, fetchImpl: typeof fetch = fetch): Promise<SttResult> {
  const form = new FormData();
  form.append('file', new Blob([new Uint8Array(wav16(pcm))], { type: 'audio/wav' }), 'note.wav');
  form.append('model', http.model || 'whisper-1');
  // A timed run needs the timings: verbose_json with words (servers that don't time words still send segments).
  form.append('response_format', attempt.timed ? 'verbose_json' : http.response_format || 'json');
  if (attempt.timed) {
    form.append('timestamp_granularities[]', 'word');
    form.append('timestamp_granularities[]', 'segment');
  }
  if (attempt.language) form.append('language', attempt.language);
  if (attempt.prompt) form.append('prompt', attempt.prompt);
  const res = await fetchImpl(endpoint(http.url), {
    method: 'POST',
    body: form,
    headers: http.api_key ? { authorization: `Bearer ${http.api_key}` } : {},
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`speech server answered ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const body = (await res.json()) as { text?: unknown; language?: unknown; words?: unknown; segments?: unknown };
  const out: SttResult = { text: String(body.text ?? '').trim(), language: isoLanguage(body.language) };
  if (attempt.timed) {
    out.words = timedList(body.words, 'word');
    out.segments = timedList(body.segments, 'text');
  }
  return out;
}

/** OpenAI's verbose_json timings ({word|text, start, end} in seconds), whatever else a server puts beside them. */
function timedList(list: unknown, key: 'word' | 'text'): { text: string; t0: number; t1: number }[] {
  if (!Array.isArray(list)) return [];
  const out: { text: string; t0: number; t1: number }[] = [];
  for (const x of list as Record<string, unknown>[]) {
    const text = String(x?.[key] ?? x?.text ?? '').trim();
    const t0 = Number(x?.start);
    const t1 = Number(x?.end);
    if (text && Number.isFinite(t0) && Number.isFinite(t1) && t1 >= t0) out.push({ text, t0, t1 });
  }
  return out;
}
