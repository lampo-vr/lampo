// Third-party licence notices that travel with the build. MIT, ISC, BSD and the OFL ask for their notice to go with
// every copy, and a bundler strips the comments that carried it — so the web build writes third-party-licenses.txt
// next to the app: the packages bundled into it (from the module graph) and the server's runtime dependencies (the
// production part of package-lock.json, which is what the Docker image keeps). The texts come from each package's
// own LICENSE file in node_modules; nothing is fetched.
import fs from 'node:fs';
import path from 'node:path';
import type { Plugin } from 'vite';

export interface PackageNotice {
  name: string;
  version: string;
  license: string;
  homepage: string | null;
  /** The package's licence file, or null when it ships none (the SPDX id above is then all there is). */
  text: string | null;
}

/** Packages that declare no licence in package.json, with what their own documentation says. */
const DECLARED_ELSEWHERE: Record<string, string> = {
  // tus-js-client → combine-errors: "MIT" in its README, no "license" field.
  'combine-errors': 'MIT (stated in its README; the package declares no license field)',
};

const LICENSE_FILE = /^(licen[cs]e|copying|notice)(\.(md|txt|markdown))?$/i;

/** The package directory a module id belongs to ("…/node_modules/@scope/name/dist/x.js" → "…/node_modules/@scope/name"). */
export function packageRoot(id: string): string | null {
  const file = id.replace(/^\0/, '').replace(/[?#].*$/, '');
  const at = file.lastIndexOf('/node_modules/');
  if (at < 0) return null;
  const rest = file.slice(at + '/node_modules/'.length).split('/');
  const depth = rest[0]?.startsWith('@') ? 2 : 1;
  if (rest.length < depth || !rest[depth - 1]) return null;
  return file.slice(0, at + '/node_modules/'.length) + rest.slice(0, depth).join('/');
}

function homepageOf(pkg: { homepage?: string; repository?: string | { url?: string } }): string | null {
  const repo = typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url;
  const url =
    pkg.homepage ||
    repo
      ?.replace(/^git\+/, '')
      .replace(/^git:\/\//, 'https://')
      .replace(/^git@([^:]+):/, 'https://$1/')
      .replace(/\.git$/, '') ||
    null;
  return url && /^https?:\/\//.test(url) ? url : null;
}

/** What one installed package says about its licence. */
export function describePackage(dir: string): PackageNotice {
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')) as {
    name: string;
    version: string;
    license?: string | { type?: string };
    homepage?: string;
    repository?: string | { url?: string };
  };
  const declared = typeof pkg.license === 'string' ? pkg.license : pkg.license?.type;
  const file = fs.readdirSync(dir).find((f) => LICENSE_FILE.test(f));
  return {
    name: pkg.name,
    version: pkg.version,
    license: declared || DECLARED_ELSEWHERE[pkg.name] || 'UNKNOWN',
    homepage: homepageOf(pkg),
    text: file ? fs.readFileSync(path.join(dir, file), 'utf8').trim() : null,
  };
}

interface LockEntry {
  version?: string;
  license?: string;
  dev?: boolean;
  devOptional?: boolean;
}

/** The production dependency tree from package-lock.json: installed packages, and platform packages that aren't. */
export function productionPackages(root: string): { installed: string[]; elsewhere: { name: string; version: string; license: string }[] } {
  const lock = JSON.parse(fs.readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as { packages: Record<string, LockEntry> };
  const installed: string[] = [];
  const elsewhere: { name: string; version: string; license: string }[] = [];
  for (const [key, entry] of Object.entries(lock.packages)) {
    if (!key.startsWith('node_modules/') || entry.dev || entry.devOptional) continue;
    const dir = path.join(root, key);
    const name = key.slice(key.lastIndexOf('node_modules/') + 'node_modules/'.length);
    if (fs.existsSync(path.join(dir, 'package.json'))) installed.push(dir);
    else elsewhere.push({ name, version: entry.version || '', license: entry.license || DECLARED_ELSEWHERE[name] || 'UNKNOWN' });
  }
  return { installed, elsewhere };
}

const RULE = '='.repeat(100);

function section(title: string, notices: PackageNotice[]): string {
  const unique = [...new Map(notices.map((n) => [`${n.name}@${n.version}`, n])).values()].sort((a, b) => a.name.localeCompare(b.name));
  const blocks = unique.map((n) =>
    [RULE, `${n.name} ${n.version} — ${n.license}`, n.homepage, '', n.text ?? `(no licence file in the package; it declares ${n.license})`]
      .filter((l) => l !== null)
      .join('\n'),
  );
  return [`## ${title} (${unique.length})`, '', ...blocks].join('\n');
}

const MIT_GITHUB = `MIT License

Copyright (c) GitHub Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit
persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.`;

/** Code copied into the app rather than installed (web/src/vendor/): CookieConsent, the cookie settings. */
export function vendoredNotices(root: string): PackageNotice[] {
  return [
    {
      name: 'CookieConsent (web/src/vendor/cookieconsent/, the cookie settings)',
      version: '3.1.0',
      license: 'MIT',
      homepage: 'https://github.com/orestbida/cookieconsent',
      text: fs.readFileSync(path.join(root, 'web/src/vendor/cookieconsent/LICENSE'), 'utf8').trim(),
    },
  ];
}

/**
 * Artwork drawn into the app that isn't a package: the logo's lettering (Norican outlines, docs/brand/) and the agent
 * marks (web/src/ui/agentLogos.ts, path data copied from Simple Icons).
 */
export function artworkNotices(root: string): PackageNotice[] {
  return [
    {
      name: 'Norican (the Lampo logo’s lettering, as outlines)',
      version: '2011',
      license: 'OFL-1.1',
      homepage: 'https://github.com/googlefonts/NoricanFont',
      text: fs.readFileSync(path.join(root, 'docs/brand/OFL-Norican.txt'), 'utf8').trim(),
    },
    {
      name: 'Simple Icons (agent marks: Claude, Cursor, Google Gemini, Windsurf, Zed Industries)',
      version: '16.33.0',
      license: 'CC0-1.0',
      homepage: 'https://simpleicons.org',
      text: 'The path data is dedicated to the public domain (CC0 1.0). The marks are trademarks of their owners, shown only to name the integration an agent uses; no endorsement is implied.',
    },
    {
      name: 'GitHub Copilot mark (Primer Octicons, via Simple Icons)',
      version: '16.33.0',
      license: 'MIT',
      homepage: 'https://primer.style/foundations/icons/copilot-24',
      text: `${MIT_GITHUB}\n\nGitHub Copilot is a trademark of GitHub, Inc., shown only to name the integration.`,
    },
  ];
}

/** The whole file: a header, then one section per group of packages. */
export function renderNotices(o: {
  version: string;
  bundled: PackageNotice[];
  vendored?: PackageNotice[];
  artwork?: PackageNotice[];
  server?: PackageNotice[];
  elsewhere?: { name: string; version: string; license: string }[];
}): string {
  const parts = [
    `Third-party software in Lampo ${o.version}`,
    '',
    'Lampo is licensed under the GNU Affero General Public License v3.0 only (see LICENSE). It includes and',
    'depends on the software below, each under its own licence. This file is generated at build time by',
    'scripts/licenses.ts. Speech models and system packages (ffmpeg, Tesseract, Hunspell) are listed in NOTICE.md.',
    '',
    section('Bundled into this web app', o.bundled),
  ];
  if (o.vendored?.length) parts.push('', section('Copied into this web app', o.vendored));
  if (o.artwork?.length) parts.push('', section('Artwork drawn into this web app', o.artwork));
  if (o.server) parts.push('', section("The server's runtime dependencies", o.server));
  if (o.elsewhere?.length)
    parts.push(
      '',
      `## Platform packages for other systems (${o.elsewhere.length})`,
      '',
      'Optional builds for other operating systems and CPUs; npm installs the one that fits. Same licence texts as above.',
      '',
      ...o.elsewhere.sort((a, b) => a.name.localeCompare(b.name)).map((p) => `${p.name} ${p.version} — ${p.license}`),
    );
  return `${parts.join('\n')}\n`;
}

/** The notices for every package a bundle's module graph touched (the project's own files are skipped). */
export function bundledNotices(moduleIds: Iterable<string>): PackageNotice[] {
  const dirs = new Set<string>();
  for (const id of moduleIds) {
    const dir = packageRoot(id);
    if (dir && fs.existsSync(path.join(dir, 'package.json'))) dirs.add(dir);
  }
  return [...dirs].map(describePackage);
}

/**
 * Vite plugin: writes third-party-licenses.txt into the build. `server: true` adds the server's runtime dependencies
 * (the main app, which the Docker image serves); `html: true` appends the notices to the page as a comment instead
 * (the MCP App, which ships as one self-contained HTML file).
 */
export function licenseNotices({ root, server = false, html = false }: { root: string; server?: boolean; html?: boolean }): Plugin {
  return {
    name: 'vr-license-notices',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const version = (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')) as { version: string }).version;
      const bundled = bundledNotices(this.getModuleIds());
      if (html) {
        const page = Object.values(bundle).find((f) => f.type === 'asset' && f.fileName.endsWith('.html'));
        if (page?.type === 'asset') page.source = `${String(page.source)}\n<!--\n${renderNotices({ version, bundled }).replaceAll('--', '- -')}-->\n`;
        return;
      }
      const prod = server ? productionPackages(root) : null;
      const source = renderNotices({
        version,
        bundled,
        vendored: vendoredNotices(root),
        artwork: artworkNotices(root),
        server: prod?.installed.map(describePackage),
        elsewhere: prod?.elsewhere,
      });
      this.emitFile({ type: 'asset', fileName: 'third-party-licenses.txt', source });
    },
  };
}
