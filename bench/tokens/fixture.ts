// A realistic review to measure what talking to Lampo costs an agent: a portrait reel in Acme/Reels with 12 notes from a
// reviewer (ranges, drawings, a reference link and a frame of another render, a change to the words, replies, one note
// about the whole video; a part render allowed on one), an agent's question with choices, a House playbook (brief,
// rules) and two skills on Acme, and the reel's elements map (what its drawn notes point at).
// Call it after the environment points at a throwaway store (test/lib/helpers.ts isolatedEnv): lib/ reads it at import.
import path from 'node:path';
import { age, makeVideo } from '../../test/lib/helpers.ts';

export interface Fixture {
  video: string;
  slug: string;
  other: string;
  notes: string[];
  question: string;
}

const REVIEWER = 'Mia Hartmann';
const AGENT = 'agent:spot-edit';

export async function buildFixture(dir: string): Promise<Fixture> {
  const { openBackend } = await import('../../lib/backend/index.ts');
  const store = await import('../../lib/store.ts');
  const { slugify } = await import('../../lib/paths.ts');
  const playbooks = await import('../../lib/playbooks.ts');
  const b = openBackend();

  const video = makeVideo(path.join(dir, 'Acme', 'export', 'spring-launch_reel_v1.mp4'), { w: 1080, h: 1920, fps: 30, dur: 6, pattern: 'testsrc2' });
  const otherFile = makeVideo(path.join(dir, 'Acme', 'export', 'brand-film_master.mp4'), { w: 1920, h: 1080, fps: 25, dur: 4, pattern: 'testsrc' });
  age(video);
  age(otherFile);
  await b.track(video, { by: REVIEWER, folder: 'Acme/Reels' });
  await b.track(otherFile, { by: REVIEWER, folder: 'Acme' });
  const slug = slugify(video);
  const other = slugify(otherFile);

  const box = (x: number, y: number, w: number, h: number) => ({ type: 'box' as const, x, y, w, h });
  const arrow = (x1: number, y1: number, x2: number, y2: number) => ({ type: 'arrow' as const, x1, y1, x2, y2 });
  const notes: string[] = [];
  const add = async (
    frame: number,
    text: string,
    o: { severity?: 'must' | 'should' | 'nice' | 'idea'; tags?: string[]; drawing?: object[]; range?: { in: number; out: number }; overall?: boolean } = {},
  ) => {
    const { comment } = await b.addNote(slug, {
      v: 1,
      frame,
      range: o.range ?? null,
      text,
      tags: o.tags ?? [],
      severity: o.severity ?? 'should',
      kind: 'feedback',
      drawing: (o.drawing ?? []) as never,
      author: REVIEWER,
      ...(o.overall ? { scope: 'video' as const } : {}),
    });
    notes.push(comment.id);
    return comment.id;
  };

  await add(12, 'The logo lands a beat too early — hold it until the kick drum hits.', {
    severity: 'must',
    tags: ['timing', 'logo'],
    drawing: [box(320, 760, 440, 300)],
  });
  const linked = await add(36, 'Headline kerning is too tight between "SPRING" and "LAUNCH".', { tags: ['typography'], drawing: [box(140, 420, 800, 180)] });
  await add(48, 'Music is too loud under the voice-over in this whole stretch.', { severity: 'must', tags: ['audio'], range: { in: 48, out: 96 } });
  await add(60, 'Caption sits on her face — move it to the lower third.', {
    severity: 'must',
    tags: ['captions', 'layout'],
    drawing: [arrow(540, 900, 540, 1500)],
  });
  const framed = await add(75, 'Colour feels cold here, warm it up like the brand film.', { tags: ['color'] });
  await add(90, 'The swoosh transition feels cheap; try a cleaner wipe.', { severity: 'nice', tags: ['transition'], range: { in: 88, out: 104 } });
  await add(110, 'Product shot is soft, is this the right take?', { tags: ['footage'], drawing: [box(260, 980, 560, 520)] });
  await add(120, 'Safe zone: the CTA button is under the app UI on TikTok.', {
    severity: 'must',
    tags: ['layout', 'safe-zone'],
    drawing: [box(80, 1580, 920, 220)],
  });
  await add(135, 'Price text needs the € sign after the number for German.', { tags: ['text', 'localisation'] });
  await add(150, 'End card: logo smaller, URL bigger.', { tags: ['logo', 'end-card'], drawing: [box(300, 700, 480, 300), arrow(540, 1100, 540, 1300)] });
  await add(0, 'Overall it drags in the middle — tighten to 15 s if you can.', { severity: 'should', tags: ['pacing'], overall: true });
  await add(165, 'Maybe a subtle grain over the whole thing?', { severity: 'idea', tags: ['look'] });

  // A change to the words, as the transcript writes it; the reviewer allows a part render for it.
  const words = store.addComment(slug, {
    v: 1,
    frame: 20,
    range: { in: 20, out: 44 },
    text: '',
    tags: ['voice-over'],
    severity: 'should',
    kind: 'feedback',
    author: REVIEWER,
    text_edit: { from: 'Every morning we start', to: 'Every spring we start' },
    part: { in: 20, out: 44 },
  });
  notes.push(words.id);

  // Where the reel's named elements are, as its renderer wrote them (docs/agents.md): the drawn notes point at them.
  const shown = (from: number, to: number): [number, number][] => [[from, to]];
  const element = (id: string, name: string, kind: string, box: [number, number, number, number], runs = shown(0, 179)) => ({
    id,
    name,
    kind,
    keys: [[runs[0]?.[0] ?? 0, ...box]],
    runs,
  });
  await b.putElements(slug, 1, {
    v: 1,
    fps: 30,
    size: [1080, 1920],
    elements: [
      element('bg', 'Background', 'shape', [0, 0, 1080, 1920]),
      element('logo', 'Acme logo', 'image', [330, 770, 420, 280]),
      element('headline', 'SPRING LAUNCH', 'text', [150, 430, 780, 160]),
      element('caption', 'Caption', 'text', [120, 1400, 840, 120]),
      element('product', 'Product shot', 'image', [270, 990, 540, 500]),
      element('cta', 'Shop now', 'group', [90, 1590, 900, 200]),
      element('url', 'acme.example', 'text', [340, 1280, 400, 80], shown(140, 179)),
    ],
  });

  await b.attachRef(linked, { kind: 'link', url: 'https://example.com/moodboard/kerning-reference', caption: 'kerning like this', by: REVIEWER });
  await b.attachRef(framed, { kind: 'frame', video: other, v: 1, frame: 40, caption: 'this warmth', by: REVIEWER });
  await b.updateComment(notes[0], { note: 'Also check the logo sting on the end card, same timing issue.', by: REVIEWER });
  await b.updateComment(notes[3], { note: 'On phones the caption is fine at y≈1400.', by: AGENT });
  await b.updateComment(notes[3], { note: 'Yes, 1400 works.', by: REVIEWER });

  const { comment: q } = await b.addNote(slug, {
    v: 1,
    frame: 30,
    range: null,
    text: 'Is the claim "Spring starts here" final, or should I use the shorter "Spring is here"?',
    tags: [],
    severity: 'should',
    kind: 'question',
    drawing: [],
    author: AGENT,
    choices: ['Keep "Spring starts here"', 'Use "Spring is here"'],
  });

  playbooks.writeText(
    '',
    'brief',
    'Acme is a family-run outdoor brand. Tone: warm, direct, never ironic. Every video ends on the logo with the URL acme.example. Social cuts are 9:16 first, 15 s or less, captions always on.',
    { by: REVIEWER },
  );
  playbooks.writeText(
    '',
    'rules',
    [
      '- Logo: never before the first beat; hold at least 1.5 s.',
      '- Captions: lower third, never over faces; 64 px minimum at 1080 wide.',
      '- Safe zones: keep CTAs above 1500 px on 9:16 (TikTok/Reels UI).',
      '- Audio: voice-over −16 LUFS integrated, music ducked −8 dB under speech.',
      '- Colour: warm grade (the brand film is the reference), no teal-orange.',
      '- German: € after the number with a space (19,99 €).',
    ].join('\n'),
    { by: REVIEWER },
  );
  playbooks.putSkill(
    'Acme',
    {
      name: 'export-reels',
      description: 'Export 9:16 reels for TikTok and Instagram with the right codec, loudness and safe zones.',
      body: '# Export reels\n\n1. Render 1080×1920, 30 fps, H.264 High, 12 Mbit/s, AAC 320.\n2. Loudness −14 LUFS integrated, true peak −1 dBTP.\n3. Check the safe zones overlay before export.\n4. Name: <campaign>_<cut>_v<NN>.mp4.\n5. Upload with lampo push into Acme/Reels.',
    },
    { by: REVIEWER },
  );
  playbooks.putSkill(
    'Acme',
    {
      name: 'caption-style',
      description: 'How Acme captions look: font, size, position and timing rules.',
      body: '# Caption style\n\n- Font: Acme Sans Bold, 64 px at 1080 wide, white with a 30 % black box.\n- Position: lower third, centred; never over faces.\n- Timing: on with the first syllable, off 6 frames after the last.\n- Max 2 lines, 32 characters each.',
    },
    { by: REVIEWER },
  );

  return { video, slug, other, notes, question: q.id };
}
