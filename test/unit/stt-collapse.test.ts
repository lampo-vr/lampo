// Lines Whisper invents over music and the windows it loses to them (lib/stt/hallucinations.ts, lib/stt/collapse.ts):
// the filter (credits, outros, sound tags — and real sentences that look a bit like them), the stretches that look
// collapsed, and the repair with a stand-in engine: a second listener that locates the speech, Whisper heard again from
// there, the second listener's own words when that fails, Whisper alone with a sweep of later starts. Then the wiring:
// a transcript and a voice note through an OpenAI-compatible stand-in, the timing a mixed transcript claims, the second
// listener found only on disk.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { test } from 'node:test';
import { isolatedEnv, makeVideo } from '../lib/helpers.ts';

const { dir } = isolatedEnv();
const { countWords, dropHallucinations, hallucinationKind, scrub, stripHallucinations } = await import('../../lib/stt/hallucinations.ts');
const { repairCollapses, sparseStretches, SWEEP } = await import('../../lib/stt/collapse.ts');
const { buildTranscript, TRANSCRIPT_VERSION } = await import('../../lib/transcript.ts');
const { sttConfig } = await import('../../lib/config.ts');
const { MODELS } = await import('../../lib/stt/models.ts');

type Timed = { text: string; t0: number; t1: number };
const line = (t0: number, t1: number, text: string): Timed => ({ text, t0, t1 });

// ---------------------------------------------------------------- the filter

test('credits Whisper learned from captions are invented, in every language and spelling', () => {
  for (const credit of [
    'Svensktextning.nu',
    'SVENSKTEXTNING.NU',
    'Undertexter från Amara.org-gemenskapen',
    'Untertitel im Auftrag des ZDF, 2017',
    'Untertitel im Auftrag des ZDF für funk, 2017',
    'Untertitelung des ZDF, 2020',
    'Untertitel der Amara.org-Community',
    'Die Sendung wurde vom NDR live untertitelt.',
    'Copyright WDR 2021',
    'Sous-titres réalisés par la communauté d’Amara.org',
    'Sous-titrage ST’ 501',
    'Ondertiteld door de Amara.org gemeenschap',
    'Subtitles by the Amara.org community',
    'Transcription by CastingWords',
    'Sottotitoli e revisione a cura di QTSS',
    'Teksting av Nicolai Winther',
    'Субтитры сделал DimaTorzok',
    '字幕由Amara.org社区提供',
  ])
    assert.equal(hallucinationKind(credit), 'credit', credit);
});

test('outros and sound tags are told apart from credits; real sentences stay speech', () => {
  for (const outro of [
    'Thank you for watching!',
    'Thanks for watching.',
    'Tack för att du tittade!',
    'Vielen Dank fürs Zuschauen!',
    'Merci d’avoir regardé cette vidéo !',
    'ご視聴ありがとうございました',
  ])
    assert.equal(hallucinationKind(outro), 'outro', outro);
  for (const tag of ['[Musik]', '(music)', '♪', '♪♪♪', '...', '.', 'Musik Musik', '*Applaus*']) assert.equal(hallucinationKind(tag), 'tag', tag);
  for (const said of [
    'Das Logo kommt zu früh.',
    'Thank you.',
    'Vielen Dank.',
    'Untertitel von der Agentur fehlen noch.',
    'Sous-titres trop petits.',
    'Subtitles by the client are wrong.',
    'Svensk text saknas i slutet.',
    'Wir drehen für das ZDF 2021 neu.',
    'Musik ist zu laut.',
    '',
  ])
    assert.equal(hallucinationKind(said), null, said);
});

test('a voice note loses invented credits and tags, never what was said', () => {
  assert.equal(stripHallucinations('Svensktextning.nu'), '');
  assert.equal(stripHallucinations('Das Logo ist zu klein. Untertitel im Auftrag des ZDF, 2017.'), 'Das Logo ist zu klein.');
  assert.equal(stripHallucinations('[Musik] Die Bauchbinde steht zu lange.'), 'Die Bauchbinde steht zu lange.');
  assert.equal(stripHallucinations('Thanks for watching!'), 'Thanks for watching!', 'outros stay in notes: no timing to judge them by');
  assert.equal(stripHallucinations('  Der Schnitt ist gut.  '), 'Der Schnitt ist gut.');
  assert.deepEqual(scrub('Willkommen (zurück) im Studio'), { text: 'Willkommen (zurück) im Studio', removed: null }, 'brackets that are words stay');
  assert.deepEqual(scrub('Svensktextning.nu Kom förbi.'), { text: 'Kom förbi.', removed: 'credit' });
  assert.deepEqual(scrub('♪ Hej ♪'), { text: 'Hej', removed: 'tag' });
});

test('a timed result: credits and tags go, a stretched outro goes, a said one stays; words follow their segments', () => {
  const r = dropHallucinations({
    segments: [
      line(0, 29.98, 'Svensktextning.nu'),
      line(30, 34, '[Musik] Kom förbi och säg hej.'),
      line(34, 34.4, '♪'),
      line(34.5, 35.6, 'Thanks for watching!'),
      line(40, 60, 'Tack för att du tittade!'),
    ],
  });
  assert.deepEqual(
    r.segments.map((s) => s.text),
    ['Kom förbi och säg hej.', 'Thanks for watching!'],
  );
  assert.deepEqual(
    r.dropped.map((d) => d.kind),
    ['credit', 'tag', 'outro'],
  );

  // word-timed engines (an OpenAI-compatible server's words): an invented sentence among the words goes too
  const w = dropHallucinations({
    words: [line(1, 1.4, 'Hej'), line(1.5, 2, 'där.'), line(5, 20, 'Svensktextning.nu'), line(21, 21.3, 'Kom'), line(21.4, 21.8, 'förbi.')],
  });
  assert.deepEqual(
    w.words.map((x) => x.text),
    ['Hej', 'där.', 'Kom', 'förbi.'],
  );
});

// ---------------------------------------------------------------- what looks collapsed

test('stretches that look collapsed: a dropped credit’s gap, a line stretched over its window, a stray word', () => {
  const after = [line(30, 34, 'Kom förbi och säg hej till oss i dag'), line(34.4, 38, 'Vi ses snart och tack för att ni kom förbi')];
  assert.deepEqual(sparseStretches(after, 40), [{ t0: 0, t1: 30, words: 0 }], 'the gap a dropped credit leaves');
  assert.deepEqual(sparseStretches([line(0.34, 30.32, 'Die Ischsen-Banduda'), ...after], 40), [{ t0: 0, t1: 30.32, words: 3 }]);
  assert.deepEqual(sparseStretches([line(0, 2, 'Zimtschnecken'), ...after], 40), [{ t0: 0, t1: 30, words: 1 }], 'a stray word joins its gap');
  // an ordinary music intro: Whisper pulls the first line back to 0.00, still well above a collapse's pace
  const intro = [line(0, 10.74, 'Välkommen till vårt lilla bageri vid torget.'), line(11.18, 16.08, 'Varje morgon bakar vi bröd, bullar och kakor med mjöl.')];
  assert.deepEqual(sparseStretches(intro, 18), []);
  assert.deepEqual(
    sparseStretches([line(0, 3, 'Ein ganz normaler Satz ohne Pause'), line(6, 9, 'und noch einer nach drei Sekunden')], 9),
    [],
    'a pause is not a stretch',
  );
  assert.deepEqual(sparseStretches(intro, 30), [{ t0: 16.08, t1: 30, words: 0 }], 'music after the last line');
  // word-timed: single words are not strays
  const words = Array.from({ length: 20 }, (_, i) => line(i * 0.4, i * 0.4 + 0.3, 'ord'));
  assert.deepEqual(sparseStretches(words, 8, false), []);
  assert.equal(countWords('Kom förbi, och säg hej!'), 5);
  assert.equal(countWords('谢谢观看'), 2);
});

// ---------------------------------------------------------------- the repair, with a stand-in engine

// Synthetic "audio": every sample says which second it is in, so a stand-in engine knows where a cut starts. Loud
// enough not to be silence; `quiet` seconds are silent.
const RATE = 16000;
function audio(seconds: number, quiet: [number, number] | null = null): Float32Array {
  const pcm = new Float32Array(seconds * RATE);
  for (let i = 0; i < pcm.length; i++) {
    const s = Math.floor(i / RATE);
    pcm[i] = quiet && s >= quiet[0] && s < quiet[1] ? 0 : 0.05 + s * 0.001;
  }
  return pcm;
}
const startOf = (cut: Float32Array) => Math.round((cut[0] - 0.05) / 0.001);
const words = (n: number, from: number, step = 0.4): Timed[] => Array.from({ length: n }, (_, i) => line(from + i * step, from + i * step + 0.3, `ord${i}`));
const sentence = (n: number, t0: number, t1: number) => line(t0, t1, Array.from({ length: n }, (_, i) => `ord${i}`).join(' '));

// The render: music to 8 s, speech from 8 to 38; Whisper's first window collapsed into a credit.
const collapsed = () => {
  const r = dropHallucinations({ segments: [line(0, 29.98, 'Svensktextning.nu'), sentence(12, 30, 34), sentence(10, 34.5, 38)] });
  return { ...r, language: 'sv' };
};
const speechAt = (from: number) => words(50, 8 - from); // what the second listener hears in a cut starting at `from`

test('repair: the second listener locates the speech, Whisper hears it again from just before the first word', async () => {
  const cuts: number[] = [];
  const out = await repairCollapses(audio(40), collapsed(), {
    engine: 'local:whisper-turbo',
    secondEngine: 'local:parakeet-v3',
    second: async (cut) => speechAt(startOf(cut)).filter((w) => w.t0 >= 0),
    again: async (cut) => {
      const at = startOf(cut);
      cuts.push(at);
      // a cut that opens on speech is heard; one that opens on music collapses again
      return at >= 7
        ? { text: '', language: 'sv', segments: [sentence(25, 0.5, 11), sentence(22, 11.5, 22)] }
        : { text: '', language: 'sv', segments: [line(0, 29.98, 'Svensktextning.nu')] };
    },
  });
  assert.deepEqual(cuts, [7], 'one cut, half a second before the first word (8 s), whole seconds in this stand-in');
  assert.deepEqual(out.repairs, [{ t0: 7.5, t1: 30, engine: 'local:whisper-turbo' }]);
  assert.equal(out.timing, undefined, 'Whisper heard everything: line timing as before');
  assert.deepEqual(
    out.segments.map((s) => [s.t0, countWords(s.text)]),
    [
      [8, 25],
      [19, 22],
      [30, 12],
      [34.5, 10],
    ],
  );
  assert.ok(!out.segments.some((s) => hallucinationKind(s.text)));
});

test('repair: when Whisper collapses again, the second listener’s own words fill the stretch, timed per word', async () => {
  const out = await repairCollapses(audio(40), collapsed(), {
    engine: 'local:whisper-turbo',
    secondEngine: 'local:parakeet-v3',
    second: async (cut) => speechAt(startOf(cut)).filter((w) => w.t0 >= 0),
    again: async () => ({ text: '', language: 'sv', segments: [line(0, 22, 'Svensktextning.nu')] }),
  });
  assert.equal(out.repairs[0].engine, 'local:parakeet-v3');
  assert.equal(out.timing, 'line', 'mixed: the second listener’s words are timed, Whisper’s are spread over their lines');
  assert.equal(out.segments.length, 0);
  const inWindow = out.words.filter((w) => w.t0 < 30);
  assert.equal(inWindow.length, 50);
  assert.deepEqual([inWindow[0].t0, inWindow[0].t1], [8, 8.3], 'the second listener’s timing, exactly');
  assert.equal(out.words.filter((w) => w.t0 >= 30).length, 22, 'Whisper’s lines after the window, spread into words');
  // and through buildTranscript the claim stays honest
  const t = buildTranscript({ ...out, language: 'sv', engine: 'local:whisper-turbo' }, { hash: 'h', fps: 25, frames: 1000 }, 'now');
  assert.equal(t.timing, 'line');
  assert.deepEqual(t.repairs, out.repairs);
  assert.equal(t.transcript_version, TRANSCRIPT_VERSION);
});

test('repair: music the second listener hears nothing in is left alone, without asking Whisper again', async () => {
  let asked = 0;
  const out = await repairCollapses(
    audio(40),
    { segments: [sentence(30, 10, 25)], words: [], language: 'de' },
    {
      engine: 'w',
      second: async () => [],
      again: async () => {
        asked++;
        return { text: '', language: 'de', segments: [] };
      },
    },
  );
  assert.equal(asked, 0);
  assert.deepEqual(out.repairs, []);
  assert.deepEqual(
    out.segments.map((s) => s.t0),
    [10],
  );
});

test('repair: Whisper alone tries later starts after a credit, keeps the earliest that is plainly speech', async () => {
  const cuts: number[] = [];
  const out = await repairCollapses(audio(40), collapsed(), {
    engine: 'w',
    again: async (cut) => {
      const at = startOf(cut);
      cuts.push(at);
      if (at < 8) return { text: '', language: 'sv', segments: [line(0, 29.98 - at, 'Svensktextning.nu')] };
      return { text: '', language: 'sv', segments: [sentence(24, 0.2, 10), sentence(20, 10.5, 20)] };
    },
  });
  assert.deepEqual(cuts, [0, SWEEP, 2 * SWEEP]);
  assert.deepEqual(out.repairs, [{ t0: 8, t1: 30, engine: 'w' }]);
  assert.equal(countWords(out.segments.map((s) => s.text).join(' ')), 24 + 20 + 12 + 10);
});

test('repair: a long stretch after a credit — later starts hear a window and a step, not the rest of the music', async () => {
  const asked: [number, number][] = [];
  const first = { ...dropHallucinations({ segments: [line(0, 29.98, 'Svensktextning.nu')] }), language: 'sv' };
  const out = await repairCollapses(audio(100), first, {
    engine: 'w',
    again: async (cut) => {
      asked.push([startOf(cut), cut.length / RATE]);
      return startOf(cut) >= 8 ? { text: '', language: 'sv', segments: [sentence(40, 0.5, 21)] } : { text: '', language: 'sv', segments: [] };
    },
  });
  assert.deepEqual(asked, [
    [0, 100],
    [4, 34],
    [8, 34],
  ]);
  assert.deepEqual(out.repairs, [{ t0: 8, t1: 42, engine: 'w' }]);
});

test('repair: the second listener deaf to a voice under a credit → Whisper alone still sweeps', async () => {
  const cuts: number[] = [];
  const out = await repairCollapses(audio(40), collapsed(), {
    engine: 'w',
    second: async () => [],
    again: async (cut) => {
      cuts.push(startOf(cut));
      return startOf(cut) >= 4 ? { text: '', language: 'sv', segments: [sentence(30, 4, 20)] } : { text: '', language: 'sv', segments: [] };
    },
  });
  assert.deepEqual(cuts, [0, 4]);
  assert.equal(out.repairs.length, 1);
});

test('repair: Whisper alone keeps music music — an invented line, too few words, another language or garble are refused', async () => {
  for (const answer of [
    { text: '', language: 'de', segments: [line(1, 9, 'Vielen Dank fürs Zuschauen!')] }, // stretched outro → dropped
    { text: '', language: 'de', segments: [line(1, 9, 'Musik und so')] }, // too few, too slow
    { text: '', language: 'en', segments: [sentence(30, 1, 9)] }, // another language
    { text: '', language: 'de', segments: [line(1, 9, 'Doorщ das样 Kafféé日本 ok')] }, // garble
  ]) {
    let asked = 0;
    const out = await repairCollapses(
      audio(30),
      { segments: [sentence(30, 0, 10)], words: [], language: 'de' },
      {
        engine: 'w',
        again: async () => {
          asked++;
          return answer;
        },
      },
    );
    assert.equal(asked, 1, 'a plain gap with no collapse marks: one try, no sweep');
    assert.deepEqual(out.repairs, [], JSON.stringify(answer));
  }
});

test('repair: silence is not a stretch to hear again; a failing engine leaves the stretch as it was', async () => {
  let asked = 0;
  const quiet = await repairCollapses(
    audio(40, [10, 40]),
    { segments: [sentence(30, 0, 10)], words: [], language: 'de' },
    {
      engine: 'w',
      again: async () => {
        asked++;
        return { text: '', language: 'de', segments: [] };
      },
    },
  );
  assert.equal(asked, 0);
  assert.deepEqual(quiet.repairs, []);

  const logs: string[] = [];
  const broken = await repairCollapses(audio(40), collapsed(), {
    engine: 'w',
    second: async () => {
      throw new Error('worker gone');
    },
    again: async () => {
      throw new Error('speech engine stopped');
    },
    log: (m) => logs.push(m),
  });
  assert.deepEqual(broken.repairs, []);
  assert.deepEqual(
    broken.segments.map((s) => s.t0),
    [30, 34.5],
    'the transcript as heard, minus the credit',
  );
  assert.ok(logs.some((l) => l.includes('second listener failed')) && logs.some((l) => l.includes('again failed')), logs.join('\n'));
});

// ---------------------------------------------------------------- the wiring

test('a transcript and a voice note through an OpenAI-compatible server lose the credit it invented', async () => {
  const srv = http.createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        text: 'Svensktextning.nu Kom förbi.',
        language: 'swedish',
        segments: [
          { text: 'Svensktextning.nu', start: 0, end: 1.5 },
          { text: 'Kom förbi.', start: 1.6, end: 2 },
        ],
        words: [
          { word: 'Svensktextning.nu', start: 0, end: 1.5 },
          { word: 'Kom', start: 1.6, end: 1.8 },
          { word: 'förbi.', start: 1.8, end: 2 },
        ],
      }),
    );
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${(srv.address() as AddressInfo).port}/v1`;
    const s = sttConfig({ stt: { backend: 'http', http: { url } } }, {});
    const file = makeVideo(path.join(dir, 'clip.mp4'), { dur: 2 });
    const { transcribeTimed, transcribeFile } = await import('../../lib/stt/index.ts');
    const t = await transcribeTimed(file, s, () => {}, { repair: true });
    assert.deepEqual(
      t.words.map((w) => w.text),
      ['Kom', 'förbi.'],
    );
    assert.equal(t.text, 'Kom förbi.');
    assert.equal(await transcribeFile(file, s, () => {}), 'Kom förbi.');
  } finally {
    srv.close();
  }
});

test('the second listener is only ever a model already on disk, never the engine itself', async () => {
  const { secondListenerModel } = await import('../../lib/stt/index.ts');
  const models = path.join(dir, 'models');
  fs.mkdirSync(models, { recursive: true });
  const s = sttConfig({ stt: { model: 'whisper-turbo', models_dir: models } }, {});
  assert.equal(secondListenerModel(s), null, 'not downloaded: none');
  const file = path.join(models, MODELS['parakeet-v3'].file);
  fs.writeFileSync(file, 'partial');
  assert.equal(secondListenerModel(s), null, 'a partial file is not a model');
  fs.truncateSync(file, MODELS['parakeet-v3'].bytes); // sparse: takes no room
  assert.equal(secondListenerModel(s)?.id, 'parakeet-v3');
  assert.equal(secondListenerModel({ ...s, model: 'parakeet-v3' }), null, 'Parakeet hearing the render has no second opinion of itself');
});
