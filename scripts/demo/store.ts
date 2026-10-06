// Fill a running server with a believable review history, through the same HTTP API the UI and agents use: videos in
// folders and assigned to sessions, reviewer notes with drawings, agent replies and fixes, a re-render with a diff, a
// client note through a share link, an approval, and the automatic pre-review.
import fs from 'node:fs';
import type { Comment, Shape } from '../../lib/types.ts';
import type { DemoMedia } from './media.ts';
import { DEMO_SESSIONS } from './server.ts';

export interface DemoStore {
  film: string;
  social: string;
  teaser: string;
  cutdown: string;
  shareToken: string;
  /** An open note on the film's newest render with a drawing (the player screenshot selects it). */
  filmNote: string;
}

type Json = Record<string, unknown>;

export async function populate(url: string, media: DemoMedia): Promise<DemoStore> {
  const send = (method: string, p: string, body?: object) =>
    fetch(url + p, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined });
  const api = async <T = Json>(method: string, p: string, body?: object): Promise<T> => {
    // A pooled keep-alive socket the server has closed in the meantime fails once; a fresh one works.
    const res = await send(method, p, body).catch(() => send(method, p, body));
    const text = await res.text();
    if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text}`);
    return (text ? JSON.parse(text) : null) as T;
  };
  const session = (name: string) => {
    const s = DEMO_SESSIONS.find((x) => x.name === name);
    return s ? { name: s.name, sessionId: s.sessionId, cwd: s.cwd } : null;
  };
  const track = async (file: string, folder: string, sessionName?: string) =>
    (await api<{ video: { slug: string } }>('POST', '/api/library', { path: file, folder, session: sessionName ? session(sessionName) : null })).video.slug;
  const note = (slug: string, frame: number, text: string, tags: string[], severity: string, drawing: Shape[] = []) =>
    api<Comment>('POST', `/api/review/${encodeURIComponent(slug)}/comments`, { frame, text, tags, severity, drawing });
  const agent = (id: string, body: { status?: string; note: string }, name: string) => api('PATCH', `/api/comments/${id}`, { ...body, by: `agent:${name}` });
  const ellipse = (cx: number, cy: number, rx: number, ry: number): Shape => ({
    type: 'freehand',
    points: Array.from({ length: 33 }, (_, i) => [
      Math.round(cx + rx * Math.cos((i / 32) * 2 * Math.PI)),
      Math.round(cy + ry * Math.sin((i / 32) * 2 * Math.PI)),
    ]),
  });

  // ---------------------------------------------------------------- a teaser in progress and an untouched cutdown
  const teaser = await track(media.teaser, 'Studio/Field Notes', 'teaser-edit');
  await note(teaser, 50, 'Subtitle tracking is too wide. Tighten it so it sits under "Field Notes".', ['graphic'], 'should', [
    { type: 'box', x: 700, y: 640, w: 520, h: 70 },
  ]);
  await note(teaser, 150, 'The cut to "Soon." feels abrupt. Try a short dissolve.', ['cut'], 'must');
  await api('PUT', `/api/review/${encodeURIComponent(teaser)}/agent-status`, { text: 'rendering v2', eta_seconds: 120, by: 'agent:teaser-edit' });

  const cutdown = await track(media.cutdown, 'Northwind/Launch film');

  // ---------------------------------------------------------------- the launch film: v1, notes, a re-render, fixes
  const film = await track(media.film, 'Northwind/Launch film', 'launch-edit');
  const title = await note(film, 30, 'The title lands too early. Let the first frame breathe for half a second.', ['timing'], 'should', [
    { type: 'box', x: 520, y: 370, w: 880, h: 290 },
  ]);
  const line = await note(film, 180, 'This line reads a little flat. Something with more weight?', ['idea'], 'nice', [
    { type: 'arrow', x1: 1560, y1: 760, x2: 1290, y2: 590 },
  ]);
  const typo = await note(
    film,
    324,
    'Typo: "Availble". And lift the line a bit, it sits too close to the letterbox.',
    ['text/typo', 'layout/overlap'],
    'must',
    [{ type: 'box', x: 730, y: 690, w: 460, h: 96 }],
  );
  const glow = await note(film, 168, 'The glow flares up here. Pull it back a touch so the line stays the hero.', ['color/grade'], 'should', [
    ellipse(1250, 230, 360, 130),
  ]);
  await agent(line.id, { note: 'Trying "Every mile, on the record." in v2.' }, 'launch-edit');
  await api('PUT', `/api/review/${encodeURIComponent(film)}/agent-status`, { text: 'rendering v2', eta_seconds: 60, by: 'agent:launch-edit' });

  media.renderFilmV2();
  const settled = new Date(Date.now() - 60_000);
  fs.utimesSync(media.film, settled, settled);
  await api('POST', `/api/review/${encodeURIComponent(film)}/sync`);
  await agent(typo.id, { status: 'fixed', note: 'Fixed the typo and lifted the line 40 px (y 710 → 670).' }, 'launch-edit');
  await agent(title.id, { status: 'fixed', note: 'The title now fades in at 1.0 s instead of 0.4 s.' }, 'launch-edit');
  await agent(line.id, { status: 'fixed', note: 'New line: "Every mile, on the record."' }, 'launch-edit');
  await note(film, 372, 'Hold the end card for one more second before the cut to black.', ['timing'], 'nice');

  // ---------------------------------------------------------------- the social cut: a client link and an approval
  const social = await track(media.social, 'Northwind/Social', 'launch-edit');
  await note(social, 60, 'Love the gradient here, keep it exactly like this.', ['love-it'], 'nice');
  const share = await api<{ token: string }>('POST', `/api/review/${encodeURIComponent(social)}/shares`, { label: 'Northwind marketing' });
  await api('POST', `/api/g/${share.token}/comments`, {
    name: 'Mia',
    frame: 250,
    text: 'Can the caption sit a bit higher? On my phone it hides behind the buttons.',
    drawing: [{ type: 'box', x: 150, y: 1655, w: 780, h: 115 }],
  });
  await api('PUT', `/api/review/${encodeURIComponent(social)}/approval`, { status: 'approved', note: 'Approved, caption tweak can ride along.' });

  // ---------------------------------------------------------------- let the background work finish
  const settle = async (p: string) => {
    for (let i = 0; i < 600; i++) {
      const r = await api<{ pending?: boolean }>('GET', p);
      if (!r?.pending) return r;
      await new Promise((res) => setTimeout(res, 500));
    }
    throw new Error(`still pending: ${p}`);
  };
  for (const [slug, v] of [
    [film, 2],
    [social, 1],
    [teaser, 1],
    [cutdown, 1],
  ] as const) {
    await settle(`/api/analysis/${encodeURIComponent(slug)}/${v}`);
    await settle(`/api/qa/${encodeURIComponent(slug)}/${v}`);
  }
  await settle(`/api/diff/${encodeURIComponent(film)}/2`);
  return { film, social, teaser, cutdown, shareToken: share.token, filmNote: glow.id };
}
