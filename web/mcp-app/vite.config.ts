import { fileURLToPath } from 'node:url';
import { defineConfig, type Plugin } from 'vite';
import { licenseNotices } from '../../scripts/licenses.ts';

// The review card is served as one MCP resource (ui://video-review/review.html), and hosts render it in a sandboxed
// iframe without network access — so the build inlines its script and styles into a single HTML file.
// Build with `vite build web/mcp-app` (this directory is the root).
function inlineIntoHtml(): Plugin {
  return {
    name: 'inline-into-html',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const html = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
      if (html?.type !== 'asset') return;
      let source = String(html.source);
      for (const [name, file] of Object.entries(bundle)) {
        if (file.type === 'chunk' && file.isEntry) {
          source = source.replace(
            new RegExp(`<script[^>]*src="[^"]*${escapeRe(file.fileName)}"[^>]*></script>`),
            () => `<script type="module">${file.code}</script>`,
          );
          delete bundle[name];
        } else if (file.type === 'asset' && file.fileName.endsWith('.css')) {
          source = source.replace(new RegExp(`<link[^>]*href="[^"]*${escapeRe(file.fileName)}"[^>]*>`), () => `<style>${String(file.source)}</style>`);
          delete bundle[name];
        }
      }
      html.source = source;
    },
  };
}
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export default defineConfig({
  base: './',
  // The notices of what the card bundles travel inside it, as an HTML comment (after the inlining: one file).
  plugins: [inlineIntoHtml(), licenseNotices({ root: fileURLToPath(new URL('../..', import.meta.url)), html: true })],
  build: {
    outDir: '../dist-mcp',
    emptyOutDir: true,
    modulePreload: false,
    cssCodeSplit: false,
    assetsInlineLimit: 1_000_000,
    rollupOptions: { input: 'review.html', output: { inlineDynamicImports: true } },
  },
});
