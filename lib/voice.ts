// Voice notes: the browser recording is kept as m4a next to the comment; its transcript comes from lib/stt.
import { FFMPEG, run } from './probe.ts';

export async function toM4a(input: string, out: string): Promise<string> {
  // The recording comes from someone's browser: read only as the containers recordings come in.
  await run(FFMPEG, ['-v', 'error', '-i', input, '-vn', '-ac', '1', '-c:a', 'aac', '-b:a', '96k', '-movflags', '+faststart', '-y', out], {
    incoming: true,
    onDemand: true,
  });
  return out;
}
