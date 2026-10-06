// Every registered route, asked the way an attacker would: upper case, a trailing slash, doubled or dot segments, an
// encoded prefix — anonymously, as a reviewer (API token and browser session) and as the owner. Only the canonical
// path may reach a handler; everything else is refused or not found, and the app shell is the most a variant may get.
// (A route matched case-insensitively once skipped sign-in and the role table: /API/status served every video.)
// An extension module's routes are walked too (a stand-in like Lampo Cloud's: a signed-in read, a signed-in write and a
// public webhook): signed out only its public one answers, no spelling of any of them reaches its handler, and the role
// table holds each to the role it declares (BILL-10: a module that forgets its own check is still covered).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { before, test } from 'node:test';
import { startApp } from '../lib/app.ts';
import { isolatedEnv, makeVideo, tmpdir } from '../lib/helpers.ts';
import { client, tusUpload } from '../lib/http.ts';
import { registeredRoutes, routeMatcher } from '../lib/routes.ts';

const PUBLIC = 'http://review.test';
const { dir } = isolatedEnv({ vars: { VR_MODE: 'server', VR_PUBLIC_URL: PUBLIC, VR_STT: 'off' } });
const { staticUi } = await import('../../server/app.ts');
const { loadConfig } = await import('../../lib/config.ts');
const { createContext } = await import('../../server/context.ts');
const ext = await import('../../server/extension.ts');
const { ruleFor } = await import('../../server/permissions.ts');
const { can } = await import('../../lib/permissions.ts');
const auth = await import('../../lib/auth.ts');

const SHELL = '<!doctype html><title>shell</title><p>app shell</p>';
const dist = tmpdir('vr-dist-');
fs.writeFileSync(path.join(dist, 'index.html'), SHELL);

// The stand-in module: it only asks who the caller is (host.who), never their role, as if a module forgot its own check;
// what it declares (`role`, `person`) is what the app holds its callers to.
const host = ext.hostContext({ publicUrl: PUBLIC, who: ext.callerOf, sameOrigin: ext.sameOriginOf(PUBLIC) });
const allow = async () => ({ ok: true as const });
const ctx = createContext({ cfg: loadConfig(), token: 'unused' });
ctx.extension = ext.createExtension(
  {
    name: 'stand-in',
    entitlements: { get: async () => null, canUpload: allow, canAddMember: allow, canAddVideo: allow, canShare: allow },
    routes: [
      {
        method: 'GET',
        path: '/api/billing',
        role: 'reviewer',
        handle: async (req) => (host.who(req) ? { status: 200, json: { plan: 'team' } } : { status: 401, json: {} }),
      },
      {
        method: 'POST',
        path: '/api/billing/plan',
        role: 'admin',
        person: true,
        handle: async (req) => (host.who(req) ? { status: 200, json: { ok: true } } : { status: 401, json: {} }),
      },
      {
        method: 'POST',
        path: '/api/billing/webhook',
        public: true,
        raw: true,
        handle: async (req) => ({ status: 200, json: { bytes: req.rawBody?.length ?? 0 } }),
      },
    ],
    workspaces: {},
  },
  host,
);
const moduleRoute = (method: string, pattern: string) => ctx.extension.routes.find((r) => r.method === method && r.path === pattern);

const { app, port } = await startApp({ ctx, ui: staticUi(dist) });

interface Answer {
  status: number;
  text: string;
}
/** One request; streams (SSE) are cut after a moment, their status is what counts. */
function ask(method: string, url: string, headers: Record<string, string> = {}, body?: string): Promise<Answer> {
  return new Promise((resolve) => {
    const h: Record<string, string> = { Host: 'review.test', ...headers };
    if (body !== undefined) {
      h['content-type'] = 'application/json';
      h['content-length'] = String(Buffer.byteLength(body));
    }
    // A fresh connection each time: a kept-alive socket the server just closed would read as a dropped answer.
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: h, agent: false }, (res) => {
      let text = '';
      const done = () => resolve({ status: res.statusCode || 0, text });
      const timer = setTimeout(() => {
        req.destroy();
        done();
      }, 400);
      res.setEncoding('utf8');
      res.on('data', (d) => {
        if (text.length < 4000) text += d;
      });
      res.on('end', () => {
        clearTimeout(timer);
        done();
      });
      res.on('error', () => {
        clearTimeout(timer);
        done();
      });
    });
    // A connection the server drops without answering counts as an answer too (status 0), so the walk goes on.
    req.on('error', (e) => resolve({ status: 0, text: String(e) }));
    req.end(body);
  });
}

// A real video, a real review link and a real note, so parameters point at things that exist.
let slug = '';
let shareToken = '';
let commentId = '';
let ownerToken = '';
const callers: Record<string, Record<string, string>> = {};
let reviewerRole: 'reviewer' = 'reviewer';

before(async () => {
  const owner = await auth.createUser({ email: 'owner@example.com', name: 'Olivia', password: 'a long password', role: 'owner' });
  const rita = await auth.createUser({ email: 'rita@example.com', name: 'Rita', password: 'a long password', role: 'reviewer' });
  reviewerRole = rita.role as 'reviewer';
  ownerToken = auth.createToken(owner.id, 'test').token;
  const bearer = { Authorization: `Bearer ${ownerToken}` };
  const request = client(port, { Host: 'review.test' });
  const up = await tusUpload(request, makeVideo(path.join(dir, 'in/spot.mp4'), { w: 160, h: 90, dur: 1 }), { filename: 'spot.mp4', folder: 'ClientA' }, bearer);
  slug = up.json().slug;
  assert.ok(slug, up.text);
  // a review link is a person's to make (PERSON_ONLY): signed in in the app
  const asOlivia = { Cookie: `vr_session=${auth.signSession(owner)}`, Origin: PUBLIC };
  const share = await request('POST', `/api/review/${encodeURIComponent(slug)}/shares`, { body: {}, headers: asOlivia });
  assert.equal(share.status, 200, share.text);
  shareToken = share.json().token;
  const note = await request('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { body: { frame: 3, text: 'Logo später' }, headers: bearer });
  assert.equal(note.status, 200, note.text);
  commentId = note.json().id;
  callers.anonymous = {};
  callers['reviewer (token)'] = { Authorization: `Bearer ${auth.createToken(rita.id, 'test').token}` };
  callers['reviewer (session)'] = { Cookie: `vr_session=${auth.signSession(rita)}`, Origin: PUBLIC };
  callers.owner = bearer;
});

/** A route pattern with its parameters filled in with things that exist. */
function fill(pattern: string): string {
  return pattern
    .replace(/\{\*[a-z]+\}/gi, 'x/y')
    .replace(/:slug/g, encodeURIComponent(slug))
    .replace(/:token/g, shareToken)
    .replace(/:id/g, commentId)
    .replace(/:file/g, 'x.png')
    .replace(/:v/g, '1')
    .replace(/:[a-z]+/gi, 'x');
}

/** The ways one path can be spelled so that a lenient router still matches it. */
function variants(pattern: string): string[] {
  const canonical = fill(pattern);
  const segs = pattern.split('/');
  const literal = (s: string) => s !== '' && !/[:{]/.test(s);
  const upper = (pick: (i: number) => boolean) => fill(segs.map((s, i) => (literal(s) && pick(i) ? s.toUpperCase() : s)).join('/'));
  const firstLit = segs.findIndex(literal);
  const lastLit = segs.length - 1 - [...segs].reverse().findIndex(literal);
  const out = new Set<string>([
    upper((i) => i === firstLit),
    upper((i) => i === lastLit),
    upper(() => true),
    `${canonical}/`,
    canonical.replace(/^\/([^/]+)\//, '/$1//'),
    canonical.replace(/^\/([^/]+)\//, '/$1/./'),
    canonical.replace(/^\/a/, '/%61'),
  ]);
  out.delete(canonical);
  return [...out];
}

const isPublic = (p: string) =>
  ctx.extension.routes.some((r) => r.public && r.path === p) ||
  /^\/(api\/g|media\/g|data\/g|e|oauth|\.well-known)(\/|$)/.test(p) ||
  /^\/(healthz|readyz|robots\.txt|mcp|oembed)$/.test(p) ||
  /^\/api\/(auth\/(status|setup|login|token|logout|invite\/peek|invite\/accept|signup|verify|verify\/resend|forgot|reset|reset\/peek)|info|uploads\/direct\/:ticket)$/.test(
    p,
  );

const methodsOf = (m: string) => (m === '*' ? ['GET', 'POST'] : m === 'HEAD' ? ['HEAD'] : [m]);
const WRITES = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

test('only canonical paths reach a handler: case, slashes and dot segments are never a way around sign-in or roles', async () => {
  const routes = registeredRoutes(app);
  assert.ok(routes.length > 100, `found ${routes.length} routes`);
  for (const r of ctx.extension.routes)
    assert.ok(
      routes.some(([m, p]) => m === r.method && p === r.path),
      `the module's ${r.method} ${r.path} is walked`,
    );
  // A spelling that is itself the canonical path of a route (/api/uploads/TICKETS is an upload id for the tus route)
  // is that route's business, checked by the canonical test below.
  // exact, case-sensitive matchers for the registered patterns, like the routers use them
  const matchers = routes.map(([, p]) => routeMatcher(p));
  const canonicalSomewhere = (url: string) => matchers.some((re) => re.test(url));
  const problems: string[] = [];
  for (const [who, headers] of Object.entries(callers)) {
    for (const [m, pattern] of routes) {
      for (const method of methodsOf(m)) {
        const body = WRITES.has(method) ? '{}' : undefined;
        for (const url of variants(pattern).filter((u) => !canonicalSomewhere(u))) {
          const r = await ask(method, url, headers, body);
          const shell = r.status === 200 && r.text === SHELL;
          if (!shell && ![401, 403, 404, 405].includes(r.status)) problems.push(`${who} ${method} ${url} → ${r.status} ${r.text.slice(0, 80)}`);
        }
      }
    }
  }
  assert.deepEqual(problems, [], `non-canonical paths answered:\n${problems.join('\n')}`);
});

test('the canonical path: signed out, only the public routes answer; reviewers get exactly what the role table allows', async () => {
  const problems: string[] = [];
  for (const [m, pattern] of registeredRoutes(app)) {
    for (const method of methodsOf(m)) {
      const url = fill(pattern);
      const body = WRITES.has(method) ? '{}' : undefined;
      if (!isPublic(pattern)) {
        const anon = await ask(method, url, {}, body);
        if (anon.status !== 401) problems.push(`anonymous ${method} ${url} → ${anon.status}`);
      }
      const { rule } = ruleFor(method, url);
      // a module's route is held to the role it declares: a reviewer's token reaches its handler only when the route
      // takes reviewers and isn't a person's alone
      const declared = moduleRoute(method, pattern);
      if (declared) {
        if (declared.public) continue;
        const r = await ask(method, url, callers['reviewer (token)'], body);
        const allowed = declared.role === 'reviewer' && !declared.person;
        if (allowed ? r.status === 403 : r.status !== 403)
          problems.push(`reviewer token ${method} ${url} (module: ${declared.role}${declared.person ? ', a person' : ''}) → ${r.status}`);
        continue;
      }
      if (isPublic(pattern) || rule === 'self' || rule === 'public' || (rule !== 'none' && can(reviewerRole, rule))) continue;
      // Writes need the site's own origin for a session; the token caller is the cleaner probe of the table.
      const r = await ask(method, url, callers['reviewer (token)'], body);
      if (r.status !== 403) problems.push(`reviewer ${method} ${url} (needs ${rule}) → ${r.status}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('what only a person does: every PERSON_ONLY route is a registered one, and an owner’s API token is refused on each', async () => {
  const { PERSON_ONLY, PERSON_ONLY_ERROR } = await import('../../server/permissions.ts');
  const routes = registeredRoutes(app);
  const problems: string[] = [];
  for (const [method, pattern] of PERSON_ONLY) {
    if (!routes.some(([m, p]) => p === pattern && (m === method || m === '*'))) problems.push(`${method} ${pattern} is no registered route`);
    const r = await ask(method, fill(pattern), callers.owner as Record<string, string>, WRITES.has(method) ? '{}' : undefined);
    if (r.status !== 403 || !r.text.includes(PERSON_ONLY_ERROR)) problems.push(`owner token ${method} ${pattern} → ${r.status} ${r.text.slice(0, 80)}`);
  }
  // a module's routes that are a person's alone: the owner's own token is refused there too
  for (const route of ctx.extension.routes.filter((x) => x.person)) {
    const r = await ask(route.method, route.path, callers.owner as Record<string, string>, WRITES.has(route.method) ? '{}' : undefined);
    if (r.status !== 403 || !r.text.includes(PERSON_ONLY_ERROR))
      problems.push(`owner token ${route.method} ${route.path} (module) → ${r.status} ${r.text.slice(0, 80)}`);
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});
