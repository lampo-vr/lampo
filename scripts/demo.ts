// `npm run demo`: synthetic renders with a realistic review history on a throwaway store, so you can click through
// everything (notes, verify mode, diffs, pre-review, client links) without adding your own videos. Ctrl+C removes it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDemoMedia } from './demo/media.ts';
import { startServer } from './demo/server.ts';
import { populate } from './demo/store.ts';

const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'vr-demo-'));
console.log('rendering demo footage with ffmpeg (about 20 s)…');
const media = renderDemoMedia(path.join(dir, 'media'));
const server = await startServer(path.join(dir, 'store'), { mediaRoot: media.root, port: Number(process.env.VR_PORT) || undefined });
console.log('adding notes, a re-render and a client link…');
const demo = await populate(server.url, media);

console.log(`
demo running at ${server.url}
  client link (no account):  ${server.url}/g/${demo.shareToken}
  the CLI on this store:     VR_DATA=${path.join(dir, 'store/data')} vr ls
Ctrl+C stops the server and deletes ${dir}`);

const stop = async () => {
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  process.exit(0);
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
