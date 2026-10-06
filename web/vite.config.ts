import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';
import { THEME_BOOT } from '../lib/themeBoot.ts';
import { licenseNotices } from '../scripts/licenses.ts';

// The service worker (web/sw/sw.js) is written next to the build with a version made from the build's file names —
// they carry content hashes, so any change to the app is a new worker and the app offers to reload — and the files a
// start needs (entry script and styles, the offline page), which it keeps for an instant start.
function serviceWorker(): Plugin {
  return {
    name: 'vr-service-worker',
    apply: 'build',
    generateBundle(_options, bundle) {
      const files = ['/offline.html', '/offline.js', '/manifest.webmanifest', '/icons/icon-192.png', '/icons/favicon-32.png'];
      for (const f of Object.values(bundle))
        if (f.type === 'chunk' && f.isEntry) {
          files.push(`/${f.fileName}`);
          for (const css of f.viteMetadata?.importedCss ?? []) files.push(`/${css}`);
        }
      const version = createHash('sha256').update(Object.keys(bundle).sort().join('\n')).digest('hex').slice(0, 12);
      const source = fs
        .readFileSync(new URL('./sw/sw.js', import.meta.url), 'utf8')
        .replace("'__VERSION__'", JSON.stringify(version))
        .replace('__PRECACHE__', JSON.stringify(files));
      this.emitFile({ type: 'asset', fileName: 'sw.js', source });
    },
  };
}

// Every text file of the build also as .br (brotli 11) and .gz (gzip 9): the server sends those as they are
// (server/respond.ts), so the best compression costs nothing per request. Small files aren't worth it.
function precompress(): Plugin {
  const TEXT = /\.(?:js|mjs|css|html|svg|json|webmanifest|txt)$/;
  let outDir = '';
  return {
    name: 'vr-precompress',
    apply: 'build',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    closeBundle() {
      const walk = (dir: string): string[] =>
        fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
      for (const file of walk(outDir)) {
        if (!TEXT.test(file)) continue;
        const buf = fs.readFileSync(file);
        if (buf.length < 1024) continue;
        fs.writeFileSync(`${file}.br`, zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } }));
        fs.writeFileSync(`${file}.gz`, zlib.gzipSync(buf, { level: 9 }));
      }
    },
  };
}

// The theme is set before the first paint by a classic inline script (lib/themeBoot.ts, allowed by hash in the
// server's CSP), in place of the marker in index.html.
function themeBoot(): Plugin {
  return {
    name: 'vr-theme-boot',
    transformIndexHtml: (html) => html.replace('<!-- vr:theme-boot -->', `<script>${THEME_BOOT}</script>`),
  };
}

// The UI imports lib/time.js and lib/drawing.js from the project root, so the same code
// computes timecodes and renders drawings on screen and in the _marked.png files.
export default defineConfig({
  // third-party-licenses.txt: the bundled packages' notices plus the server's runtime dependencies (the image ships both).
  plugins: [react(), themeBoot(), serviceWorker(), licenseNotices({ root: fileURLToPath(new URL('..', import.meta.url)), server: true }), precompress()],
  server: { fs: { allow: ['..'] } },
  // #/styleguide is in dev and test builds; VR_STYLEGUIDE=0 (the Dockerfile) leaves it out of a release.
  define: { __STYLEGUIDE__: JSON.stringify(process.env.VR_STYLEGUIDE !== '0') },
  build: { outDir: 'dist', emptyOutDir: true, chunkSizeWarningLimit: 1000 },
});
