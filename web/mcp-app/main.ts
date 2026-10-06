// The review card (an MCP App view). The host hands us show_review's structuredContent; everything else goes through
// the host bridge as tool calls — review_frame for exact frames, reply / mark_fixed for actions. No network access.
import { App, applyDocumentTheme } from '@modelcontextprotocol/ext-apps';
import './review.css';

interface Note {
  id: string;
  status: string;
  severity: string;
  frame: number;
  timecode: string;
  text: string;
  author: string;
  agent: boolean;
  v: number;
  replies: { by: string; text: string; status: string | null }[];
}
interface Still {
  frame: number;
  timecode: string;
  v: number;
  kind: 'marked' | 'clean';
  note: string | null;
  image: string;
}
interface Card {
  slug: string;
  name: string;
  v: number;
  fps: number;
  frames: number;
  width: number;
  height: number;
  counts: { open: number; must: number; fixed: number; done: number };
  notes: Note[];
  selected: string | null;
  still: Still;
  playerUrl: string | null;
  canAct: boolean;
  canComment: boolean;
}

const root = document.getElementById('card') as HTMLElement;
const app = new App({ name: 'lampo card', version: '1.0.0' });
let card: Card | null = null;

// The host's theme (MCP Apps host context) when it says one, the device's otherwise; both can change while open.
const deviceLight = matchMedia('(prefers-color-scheme: light)');
const applyTheme = () => applyDocumentTheme(app.getHostContext()?.theme ?? (deviceLight.matches ? 'light' : 'dark'));
applyTheme();
app.addEventListener('hostcontextchanged', applyTheme);
deviceLight.addEventListener('change', applyTheme);
let busy = false;
let status = '';

app.ontoolresult = (result) => {
  const c = result.structuredContent as unknown as Card | undefined;
  if (c?.slug && c.still) {
    card = c;
    render();
  }
};
await app.connect();
applyTheme();
app.setupSizeChangedNotifications();

// ---------------------------------------------------------------- actions

async function call<T>(name: string, args: Record<string, unknown>): Promise<T> {
  const r = await app.callServerTool({ name, arguments: args });
  const text = r.content?.find((c) => c.type === 'text')?.text || '';
  if (r.isError) throw new Error(text.replace(/^Error: /, ''));
  return (r.structuredContent ?? { text }) as T;
}

async function run(label: string, fn: () => Promise<void>): Promise<void> {
  if (busy) return;
  busy = true;
  status = label;
  render();
  try {
    await fn();
    status = '';
  } catch (e) {
    status = (e as Error).message;
  }
  busy = false;
  render();
}

const show = (args: { frame?: number; note?: string }) =>
  run('', async () => {
    if (!card) return;
    card.still = await call<Still>('review_frame', { video: card.slug, ...args });
    card.selected = args.note ?? null;
  });

const step = (by: number) => card && show({ frame: Math.max(0, Math.min(card.frames - 1, card.still.frame + by)) });

async function refresh(noteId: string): Promise<void> {
  if (!card) return;
  card = await call<Card>('show_review', { video: card.slug, note: noteId });
}

const reply = (n: Note, text: string) =>
  run('Sending…', async () => {
    await call('reply', { id: n.id, note: text });
    await refresh(n.id);
  });

const markFixed = (n: Note, text: string) =>
  run('Marking fixed…', async () => {
    await call('mark_fixed', { id: n.id, note: text });
    await refresh(n.id);
  });

document.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('textarea, input')) return;
  if (e.key === 'ArrowLeft') step(e.shiftKey ? -10 : -1);
  if (e.key === 'ArrowRight') step(e.shiftKey ? 10 : 1);
});

// ---------------------------------------------------------------- view

function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string | boolean | ((e: Event) => void)> = {},
  ...kids: (Node | string | null | false)[]
) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false) el.setAttribute(k, v);
  }
  for (const k of kids) if (k !== null && k !== false) el.append(k);
  return el;
}

function render(): void {
  root.classList.remove('loading');
  root.replaceChildren();
  if (!card) {
    root.append('Loading the review…');
    return;
  }
  const c = card;
  const sel = c.notes.find((n) => n.id === c.selected) || null;
  const parts: (HTMLElement | null)[] = [
    h(
      'header',
      { class: 'head' },
      h('h1', {}, c.name),
      h(
        'span',
        { class: 'meta' },
        `v${c.v} · ${c.width}×${c.height} · ${c.fps} fps · open ${c.counts.open}${c.counts.must ? ` (must ${c.counts.must})` : ''} · fixed ${c.counts.fixed}`,
      ),
    ),
    h(
      'figure',
      { class: 'frame' },
      h('img', { src: c.still.image, alt: `Frame ${c.still.frame}` }),
      h('figcaption', {}, h('b', {}, c.still.timecode), ` f${c.still.frame} · v${c.still.v}`, c.still.kind === 'marked' ? ' · marked' : ''),
    ),
    h(
      'nav',
      { class: 'transport', 'aria-label': 'Frame' },
      button('−10', () => step(-10), 'Back 10 frames (shift ←)'),
      button('−1', () => step(-1), 'Previous frame (←)'),
      button('+1', () => step(1), 'Next frame (→)'),
      button('+10', () => step(10), 'Forward 10 frames (shift →)'),
      h('span', { class: 'grow' }),
      c.playerUrl
        ? button('Open in the player', () => app.openLink({ url: withFrame(c.playerUrl as string, c.still.frame) }), 'Plays the video frame-exact', 'primary')
        : null,
    ),
    status ? h('p', { class: 'status', role: 'status' }, status) : null,
    h('ol', { class: 'notes' }, ...c.notes.map((n) => noteItem(n, n === sel))),
    c.notes.length ? null : h('p', { class: 'empty' }, 'No open notes.'),
  ];
  root.append(...parts.filter((p): p is HTMLElement => p !== null));
}

function noteItem(n: Note, open: boolean): HTMLElement {
  const li = h(
    'li',
    { class: `note ${n.status} sev-${n.severity}${open ? ' open' : ''}` },
    h(
      'button',
      { class: 'note-head', type: 'button', onclick: () => show({ note: n.id }), 'aria-expanded': open ? 'true' : 'false' },
      h('span', { class: 'dot', 'aria-hidden': 'true' }),
      h('span', { class: 'tc' }, n.timecode),
      h('span', { class: 'text' }, n.text || '(drawing only)'),
      h('span', { class: 'tag' }, n.status === 'fixed' ? `fixed` : n.severity),
    ),
  );
  if (!open) return li;
  const body = h('div', { class: 'note-body' }, h('p', { class: 'by' }, `${n.id} · ${n.author}${n.v !== card?.v ? ` · made on v${n.v}` : ''}`));
  for (const r of n.replies) body.append(h('p', { class: 'reply' }, h('b', {}, r.by), r.status ? ` [${r.status}]` : '', r.text ? ` ${r.text}` : ''));
  if (card?.canComment) {
    const ta = h('textarea', { rows: '2', placeholder: 'Reply, or what you changed…', 'aria-label': 'Reply' }) as HTMLTextAreaElement;
    body.append(
      ta,
      h(
        'div',
        { class: 'actions' },
        button('Reply', () => ta.value.trim() && reply(n, ta.value.trim())),
        card.canAct && n.status === 'open'
          ? button('Mark fixed', () => markFixed(n, ta.value.trim() || 'fixed'), 'After the re-render: say what changed', 'primary')
          : null,
      ),
    );
  }
  li.append(body);
  return li;
}

function button(label: string, onclick: () => unknown, title = '', kind = ''): HTMLButtonElement {
  return h('button', { type: 'button', class: `btn ${kind}`, title, disabled: busy, onclick: () => void onclick() }, label) as HTMLButtonElement;
}

const withFrame = (url: string, frame: number) => url.replace(/([?&])f=\d+/, `$1f=${frame}`);
