// A stand-in speech-to-text server for the pictures: OpenAI's /v1/audio/transcriptions shape, answering with made-up
// words and timings — never real speech, never a real engine. Lampo sends 16 kHz mono WAV (lib/stt/http.ts), so the
// length of the audio says what it is: the launch film (16 s, 17 s for V3) gets its voice-over, other renders say
// nothing, and anything else is a recording, which gets what the reviewer "said" while recording.
import http from 'node:http';
import { freePort } from '../demo/server.ts';

type Word = { word: string; start: number; end: number };
const words = (list: [string, number, number][]): Word[] => list.map(([word, start, end]) => ({ word, start, end }));

/** The launch film's voice-over, on its captions ("The long way home", "Every mile, on the record.", the end card). */
export const FILM_SAID = words([
  ['Some', 1.3, 1.55],
  ['roads', 1.55, 1.95],
  ['take', 1.95, 2.2],
  ['longer.', 2.2, 2.8],
  ['This', 3.1, 3.3],
  ['is', 3.3, 3.42],
  ['the', 3.42, 3.55],
  ['long', 3.55, 3.85],
  ['way', 3.85, 4.1],
  ['home.', 4.1, 4.6],
  ['Every', 5.9, 6.2],
  ['mile,', 6.2, 6.7],
  ['on', 6.9, 7.05],
  ['the', 7.05, 7.18],
  ['record.', 7.18, 7.9],
  ['Northwind.', 11.5, 12.2],
  ['Available', 12.6, 13.1],
  ['this', 13.1, 13.3],
  ['spring.', 13.3, 13.9],
]);

/** What the reviewer says while recording feedback, on the recording's clock (scripts/shots/local.ts acts in between). */
export const RECORDING_SAID = words([
  ['Let', 0.6, 0.75],
  ['the', 0.75, 0.85],
  ['title', 0.85, 1.1],
  ['breathe', 1.1, 1.4],
  ['a', 1.4, 1.5],
  ['beat', 1.5, 1.7],
  ['longer.', 1.7, 2.1],
  ['This', 3.4, 3.6],
  ['line', 3.6, 3.9],
  ['could', 3.9, 4.1],
  ['sit', 4.1, 4.3],
  ['a', 4.3, 4.4],
  ['little', 4.4, 4.7],
  ['higher.', 4.7, 5.1],
  ['The', 6.4, 6.6],
  ['end', 6.6, 6.8],
  ['card', 6.8, 7.1],
  ['comes', 7.1, 7.4],
  ['in', 7.4, 7.5],
  ['too', 7.5, 7.7],
  ['fast.', 7.7, 8.1],
]);

/** Seconds of 16 kHz mono 16-bit audio in a multipart body (its WAV's data chunk), or null. */
function seconds(body: Buffer): number | null {
  const riff = body.indexOf('RIFF');
  if (riff < 0) return null;
  const data = body.indexOf('data', riff + 12);
  if (data < 0) return null;
  const rate = body.readUInt32LE(riff + 24);
  const bytesPerSecond = body.readUInt32LE(riff + 28) || rate * 2;
  return body.readUInt32LE(data + 4) / bytesPerSecond;
}

function said(body: Buffer): Word[] {
  const s = seconds(body);
  if (s === null) return [];
  if (Math.abs(s - 16) < 0.2 || Math.abs(s - 17) < 0.2) return FILM_SAID;
  // the other renders of the demo (6, 7, 8 and 12 s): music only
  if ([6, 7, 8, 12].some((d) => Math.abs(s - d) < 0.2)) return [];
  return RECORDING_SAID;
}

export interface SpeechStandIn {
  url: string;
  close: () => void;
}

export async function startSpeech(): Promise<SpeechStandIn> {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (d: Buffer) => chunks.push(d));
    req.on('end', () => {
      if (req.method !== 'POST') return void res.writeHead(404).end();
      const list = said(Buffer.concat(chunks));
      res.setHeader('content-type', 'application/json');
      // a moment, like a real engine: the drafts' "hearing" state shows meanwhile
      setTimeout(() => res.end(JSON.stringify({ text: list.map((w) => w.word).join(' '), language: 'english', words: list, segments: [] })), 400);
    });
  });
  const port = await freePort();
  await new Promise<void>((r) => server.listen(port, '127.0.0.1', () => r()));
  return { url: `http://127.0.0.1:${port}/v1`, close: () => server.close() };
}
