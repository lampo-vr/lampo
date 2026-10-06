// A footage request in plain words → the filters it names (aspect, length, camera move, "no text", words on screen or
// said) and what the picture should show. The filters do as much as the model (bench/footage/RESULTS.md: the raw
// request embedded finds a right shot first 76 % of the time, parsed 91–93 %), so this is as measured there; flags given
// on their own win over the words. English, some German. Browser-safe.
import type { FootageMotion, FootageRead, FootageRequest, MotionWord } from './types.ts';

const MOTIONS: [RegExp, FootageMotion[]][] = [
  [/\b(?:push(?:ing)?[- ]?in|dolly(?:ing)?[- ]?in|zoom(?:ing)?[- ]in|ranfahrt|reinzoom\w*)\b/i, ['push-in']],
  [/\b(?:pull(?:ing)?[- ]?(?:out|back)|zoom(?:ing)?[- ]out|dolly(?:ing)?[- ]?out|rausfahrt)\b/i, ['pull-out']],
  [/\bpan(?:ning|s|ned)?\s+(?:to\s+the\s+)?left\b|\bschwenk\w*\s+(?:nach\s+)?links\b/i, ['pan-left']],
  [/\bpan(?:ning|s|ned)?\s+(?:to\s+the\s+)?right\b|\bschwenk\w*\s+(?:nach\s+)?rechts\b/i, ['pan-right']],
  // a bare "pan" is a camera move only where it can't be a frying pan
  [/\bpanning\b|\bpan(?:s|ned)?\s+(?:shot|across|over|along)\b|\bcamera pan\b|(?:^|,)\s*pan\s*(?=,|$)|\bschwenk\w*\b/i, ['pan-left', 'pan-right']],
  [/\btilt(?:ing|s|ed)?\s+up\b/i, ['tilt-up']],
  [/\btilt(?:ing|s|ed)?\s+down\b/i, ['tilt-down']],
  [/\btilt(?:ing|s|ed)?\b/i, ['tilt-up', 'tilt-down']],
  [/\bhand[- ]?held\b|\bshaky\b|\baus der hand\b/i, ['handheld']],
  [/\bstatic\b|\blocked[- ]off\b|\btripod\b|\bstatisch\w*\b|\bstill shot\b/i, ['static']],
];

/** The moves a motion word stands for. */
export function motionsOf(word: MotionWord): FootageMotion[] {
  if (word === 'pan') return ['pan-left', 'pan-right'];
  if (word === 'tilt') return ['tilt-up', 'tilt-down'];
  return [word];
}

/** Splits a request in plain words into filters and what the picture should show. */
export function parseRequest(q: string): FootageRead {
  let s = ` ${q.replace(/\s+/g, ' ')} `;
  const p: FootageRead = { show: '' };
  const cut = (re: RegExp) => {
    s = s.replace(re, ' , ');
  };
  // quoted words: on screen or said
  const quoted = /["“„«]([^"“”„«»]{2,})["”“»]|'([^']{2,})'/.exec(s);
  if (quoted) {
    p.words = (quoted[1] || quoted[2] || '').trim();
    s = s.replace(quoted[0], ' ');
  }
  const saidCue = /\b(?:voice[- ]?over|voiceover|narrat\w*|spoken|speaks?|said|sprecher\w*|stimme|sagt|gesagt|spricht)\b/i;
  const textCue = /\b(?:sign|text|caption|title|lower third|banner|words?|reads?|schrift|bauchbinde|titel)\b/i;
  p.words_in = saidCue.test(s) ? 'said' : textCue.test(s) ? 'text' : 'any';
  // unquoted words after a cue: "where the voice-over says the battery lasts all week", "with the name Anna Berg"
  if (!p.words) {
    const after = /\b(?:says|saying|that reads|reads|with the words|with the name|named|called|sagt|mit dem namen)\s+(?:the\s+(?=\w+\s+\w))?([^,;]+)/i.exec(s);
    if (after?.[1]) {
      p.words = (after[0].match(/\bsays\s+the\s/i) ? `the ${after[1]}` : after[1]).trim();
      s = s.replace(after[0], ' ');
      // capitals after "says" are on the screen, unless a voice is named
      if (p.words_in === 'any' && p.words === p.words.toUpperCase()) p.words_in = 'text';
    }
  }
  // words in capitals are text in the picture ("the STREET CLOSED sign"); they stay in the description too
  if (!p.words) {
    const caps = /\b([A-ZÄÖÜ]{2,}(?:[ -]+[A-ZÄÖÜ0-9%]{2,})+|[A-ZÄÖÜ]{4,})\b/.exec(s.replace(/\b\d+\s*:\s*\d+\b/g, ''));
    if (caps?.[1]) {
      p.words = caps[1];
      if (p.words_in === 'any') p.words_in = 'text';
    }
  }
  if (p.words && p.words_in === 'said') cut(/\bwhere\b|\bwo\b|\b(?:the\s+)?voice[- ]?over\b|\bdie sprecherin\b|\bder sprecher\b|\bsagt\b/gi);
  // aspect
  if (/\b9\s*:\s*16\b|\bvertical\b|\bportrait\b|\bhochkant\b/i.test(s)) p.aspect = '9:16';
  else if (/\b16\s*:\s*9\b|\bhorizontal\b|\blandscape\b|\bwidescreen\b|\bquerformat\b/i.test(s)) p.aspect = '16:9';
  else if (/\b1\s*:\s*1\b|\bsquare\b|\bquadratisch\b/i.test(s)) p.aspect = '1:1';
  cut(
    /\b9\s*:\s*16\b|\b16\s*:\s*9\b|\b1\s*:\s*1\b|\bvertical\b|\bportrait\b|\bhochkant\b|\bhorizontal\b|\blandscape\b|\bwidescreen\b|\bquerformat\b|\bsquare\b|\bquadratisch\b/gi,
  );
  // length
  const num = '(\\d+(?:[.,]\\d+)?)\\s*(?:s|sec|secs|seconds?|sekunden|sek)\\b';
  const min = new RegExp(`(?:≥|>=|>|at least|min(?:imum)?\\.?|longer than|more than|over|mindestens|länger als)\\s*${num}`, 'i').exec(s);
  if (min) {
    p.min_s = Number((min[1] as string).replace(',', '.'));
    s = s.replace(min[0], ' , ');
  }
  const max = new RegExp(`(?:≤|<=|<|at most|max(?:imum)?\\.?|shorter than|less than|under|höchstens|kürzer als)\\s*${num}`, 'i').exec(s);
  if (max) {
    p.max_s = Number((max[1] as string).replace(',', '.'));
    s = s.replace(max[0], ' , ');
  }
  // no text
  const noText = /\b(?:no|without)\s+(?:text|titles?|captions?|graphics|overlays?|lower thirds?)\b|\bclean plate\b|\bohne\s+(?:text|schrift|titel)\b/gi;
  if (noText.test(s)) {
    p.no_text = true;
    cut(noText);
  }
  // camera move (+ slow/fast next to it)
  for (const [re, kinds] of MOTIONS) {
    const m = re.exec(s);
    if (!m) continue;
    p.motion = kinds;
    const around = s.slice(Math.max(0, m.index - 12), m.index);
    if (/\b(?:slow|slowly|gentle|langsam\w*)\s*$/i.test(around)) p.speed = 'slow';
    if (/\b(?:fast|quick|rapid|schnell\w*)\s*$/i.test(around)) p.speed = 'fast';
    s = s.replace(new RegExp(`(?:\\b(?:slow|slowly|gentle|fast|quick|rapid|langsame?|schnelle?)\\s+)?(?:${re.source})(?:\\s+shot)?(?:\\s+of)?`, 'i'), ' , ');
    break;
  }
  // what is left describes the picture
  p.show = s
    .replace(/\b(?:the|a|an)\s+(?:shot|clip|footage|b-roll)\s+(?:with|of|that)\b/gi, ' ')
    .replace(/\b(?:shot|clip)\s+(?:that|which|where)\b|\b(?:that|which|where)\s*$/gi, ' ')
    .replace(/\b(?:shot|clip|footage|b-roll)\b(?=\s*(?:,|$))/gi, ' ')
    .replace(/\s*,\s*(?:,\s*)*/g, ', ')
    .replace(/^[\s,.;:–-]+|[\s,.;:–-]+$/g, '')
    .replace(/^(?:the|a|an)\s+/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (p.words && p.words_in === 'text' && !p.show.toLowerCase().includes(p.words.toLowerCase())) p.show = `${p.show} ${p.words.toLowerCase()}`.trim();
  if (!p.words) {
    delete p.words;
    delete p.words_in;
  }
  return p;
}

/** The request as searched: what its words say, with the filters given on their own put over them. */
export function readRequest(r: FootageRequest): FootageRead {
  const p = parseRequest(r.query || '');
  if (r.aspect) p.aspect = r.aspect;
  if (r.min_s !== undefined) p.min_s = r.min_s;
  if (r.max_s !== undefined) p.max_s = r.max_s;
  if (r.motion) {
    p.motion = motionsOf(r.motion);
    if (r.motion === 'static' || r.motion === 'handheld') delete p.speed;
  }
  const text = r.text?.trim();
  if (text && /^(?:none|no|no text|-)$/i.test(text)) p.no_text = true;
  else if (text) {
    p.words = text;
    p.words_in = 'text';
    delete p.no_text;
  }
  const said = r.said?.trim();
  if (said) {
    p.words = said;
    p.words_in = 'said';
  }
  return p;
}

/** The filters of a request in a few words, for the head of the compact list: `9:16 · slow push · ≥2s · no text`. */
export function readFilters(p: FootageRead): string[] {
  const move = p.motion ? (p.motion.length > 1 ? (p.motion[0] as string).split('-')[0] : p.motion[0]) : '';
  return [
    p.aspect ?? '',
    move ? `${p.speed ? `${p.speed} ` : ''}${move}` : '',
    p.min_s !== undefined ? `≥${p.min_s}s` : '',
    p.max_s !== undefined ? `≤${p.max_s}s` : '',
    p.no_text ? 'no text' : '',
    p.words ? `${p.words_in === 'said' ? 'said' : 'text'} "${p.words}"` : '',
  ].filter(Boolean);
}
