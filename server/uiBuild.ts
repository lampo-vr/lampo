// The first start of a fresh checkout (`npm start` without `npm run build`): what the app serves is built then, the UI
// and the MCP review card alike (package.json's build makes both). Without the card, an MCP client that shows it got
// "not built yet" for good (mcp/app.ts reads web/dist-mcp/review.html on every ask, so one built now is served at once).
import fs from 'node:fs';
import path from 'node:path';

type Build = (o: { root: string; logLevel: 'warn' }) => Promise<unknown>;

/** Builds what is missing under `webRoot` (web/): the UI (dist/index.html), then the card (dist-mcp/review.html).
 * Returns what it built, by name. `build`: vite's (tests pass a stand-in). */
export async function buildMissing(webRoot: string, build?: Build): Promise<string[]> {
  const missing = [
    { name: 'UI', root: webRoot, built: path.join(webRoot, 'dist', 'index.html') },
    { name: 'review card', root: path.join(webRoot, 'mcp-app'), built: path.join(webRoot, 'dist-mcp', 'review.html') },
  ].filter((x) => !fs.existsSync(x.built));
  if (!missing.length) return [];
  const run: Build = build ?? (await import('vite')).build;
  console.log(`building ${missing.map((x) => x.name).join(' and the ')} (first start)…`);
  for (const x of missing) await run({ root: x.root, logLevel: 'warn' });
  return missing.map((x) => x.name);
}
