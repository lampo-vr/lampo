// Bunny Storage (Edge Storage HTTP API) with delivery through a pull zone.
//   PUT/GET/DELETE https://{region.}storage.bunnycdn.com/{zone}/{path}   header AccessKey: <storage zone password>
// Browsers get pull zone URLs signed with token authentication, so a leaked link stops working after a few hours.
// Range requests go straight to the CDN: frame-exact seeking needs nothing from the server.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import type { BunnyConfig } from '../paths.ts';
import { signBunnyUrl } from './bunnyToken.ts';
import { expect, readRange, request } from './http.ts';
import type { RemoteStore } from './index.ts';

const REGIONS: Record<string, string> = { '': '', de: '', uk: 'uk.', ny: 'ny.', la: 'la.', sg: 'sg.', se: 'se.', br: 'br.', jh: 'jh.', syd: 'syd.' };

const encodePath = (p: string) => p.split('/').map(encodeURIComponent).join('/');

async function sha256Hex(file: string): Promise<string> {
  const h = crypto.createHash('sha256');
  await pipeline(fs.createReadStream(file), h);
  return h.digest('hex').toUpperCase();
}

export function createBunnyStore(cfg: BunnyConfig | undefined): RemoteStore {
  if (!cfg?.zone || !cfg.access_key) throw new Error('storage "bunny" needs bunny.zone and bunny.access_key (VR_BUNNY_ZONE, VR_BUNNY_ACCESS_KEY)');
  const region = (cfg.region || '').toLowerCase();
  if (!(region in REGIONS) && !cfg.storage_url) throw new Error(`unknown bunny region "${cfg.region}" (${Object.keys(REGIONS).filter(Boolean).join(', ')})`);
  const base = (cfg.storage_url || `https://${REGIONS[region]}storage.bunnycdn.com`).replace(/\/+$/, '');
  const prefix = (cfg.prefix || '').replace(/^\/+|\/+$/g, '');
  const full = (key: string) => (prefix ? `${prefix}/${key}` : key);
  const objectUrl = (key: string) => `${base}/${encodeURIComponent(cfg.zone)}/${encodePath(full(key))}`;
  const headers = { AccessKey: cfg.access_key };
  const cdn = cfg.cdn_url ? cfg.cdn_url.replace(/\/+$/, '') : null;

  return {
    kind: 'bunny',
    async put(key, file, contentType = 'application/octet-stream') {
      const r = await request(objectUrl(key), { method: 'PUT', file, headers: { ...headers, 'Content-Type': contentType, Checksum: await sha256Hex(file) } });
      expect(r, [200, 201], `bunny upload ${key}`);
    },
    async get(key, file) {
      expect(await request(objectUrl(key), { method: 'GET', headers, saveTo: file }), [200], `bunny download ${key}`);
    },
    read: (key, start, end) => readRange(objectUrl(key), { ...headers, Range: `bytes=${start}-${end}` }, start, end - start + 1, `bunny read ${key}`),
    async check() {
      // Lists the zone's root (or prefix): proves the zone exists and the password is right, without writing.
      expect(await request(objectUrl('').replace(/\/*$/, '/'), { method: 'GET', headers }), [200, 404], 'bunny zone');
    },
    async remove(keyOrPrefix) {
      // A trailing slash deletes the directory and everything in it.
      expect(await request(objectUrl(keyOrPrefix), { method: 'DELETE', headers }), [200, 204, 404], `bunny delete ${keyOrPrefix}`);
    },
    url(key, expiresIn) {
      if (!cdn) return null;
      const url = `${cdn}/${encodePath(full(key))}`;
      return cfg.token_key ? signBunnyUrl(url, cfg.token_key, { expiresIn }) : url;
    },
    origins: () => (cdn ? [new URL(cdn).origin] : []),
  };
}
