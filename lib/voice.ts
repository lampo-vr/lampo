// Voice notes: the browser recording is kept as m4a next to the comment; its transcript comes from lib/stt.
import { FFMPEG, run } from './probe.ts';

/**
 * The recording as m4a. `maxSeconds`: what is written stops there, and so does ffmpeg's reading (a few MB of
 * low-bitrate audio can hold hours, each of them decoded and kept at 96 kbit/s otherwise).
 */
export async function toM4a(input: string, out: string, { maxSeconds }: { maxSeconds?: number } = {}): Promise<string> {
  const upTo = maxSeconds === undefined ? [] : ['-t', String(maxSeconds)];
  // The recording comes from someone's browser: read only as the containers recordings come in.
  await run(FFMPEG, ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', ...upTo, '-movflags', '+faststart', '-y', out], {
    incoming: true,
    onDemand: true,
  });
  return out;
}
