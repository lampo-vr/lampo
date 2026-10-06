// Lines Whisper invents when a window holds music, noise or silence instead of speech: subtitle credits it learned from
// the web's captions ("Svensktextning.nu", "Untertitel im Auftrag des ZDF, 2020", "… by the Amara.org community"),
// "thanks for watching" outros and sound tags ("[Musik]", "♪"). Matched against a whole segment or sentence, loosely
// (case, accents, punctuation), never inside a longer one. Credits are the known strings only, never a generic
// "subtitles by …" shape: a reviewer says "Untertitel von der Agentur fehlen noch" and means it. A credit nobody listed
// here that swallowed speech is still caught by the collapse repair (lib/stt/collapse.ts). Pure: no Node imports.

export type HallucinationKind = 'credit' | 'outro' | 'tag';

/** A line or word an engine heard, in seconds. */
export interface Timed {
  text: string;
  t0: number;
  t1: number;
}

/** Lowercase, without accents and punctuation, single spaces: "Sous-titres réalisés…" → "sous titres realises …". */
export function matchForm(text: string): string {
  return text
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

const BROADCASTERS = '(zdf|ard|wdr|swr|ndr|mdr|br|hr|funk)';
const YEAR = '(19|20)\\d\\d';

// Credits that are one token: cut out of any text they appear in, like a sound tag (a voice note's text is its
// segments joined, so "Svensktextning.nu Kom förbi." has no sentence end to split at).
const CREDIT_TOKEN = /(?<![\p{L}\p{N}])(svensk)?textning\.nu(?![\p{L}\p{N}])/giu;

// Known credits, on matchForm's text: a whole line (a segment, a sentence) that is one, never a longer line that only
// mentions something like it.
const CREDITS: RegExp[] = [
  /^(svensk)?textning nu$/, // "Svensktextning.nu"
  /\bamara org\b/, // "Subtitles by the Amara.org community" and its translations into every language
  new RegExp(`^untertitel(ung)?( im auftrag)? (des|der|von|vom|fur) ${BROADCASTERS}( fur funk)?( ${YEAR})?$`), // "Untertitel im Auftrag des ZDF, 2017"
  /^untertitel( ard text)? im auftrag von funk( (19|20)\d\d)?$/,
  /^untertitel von stephanie geiges$/,
  /^(die )?sendung wurde (vom|von|im) \S+( \S+)? (live )?untertitelt$/, // "Die Sendung wurde vom NDR live untertitelt."
  new RegExp(`^(copyright )?${BROADCASTERS} ${YEAR}$`), // "Copyright WDR 2021", "SWR 2020"
  /\bcastingwords\b/, // "Transcription by CastingWords"
  /^sous titrage (st \d+|societe radio canada)$/, // "Sous-titrage ST' 501"
  /\bqtss\b/, // "Sottotitoli e revisione a cura di QTSS"
  /^teksting av nicolai winther$/,
  /^субтитры (сделал|создавал|подготовил|by) /u, // "Субтитры сделал DimaTorzok"
  /^редактор субтитров /u,
  /请不吝点赞/u, // zh
  /^字幕由/u,
];
const CREDIT_MAX_WORDS = 14;

// "Thanks for watching" and friends: invented over a music outro, but people say them too. A render's line goes only
// when it is stretched far beyond its words (lib/stt/collapse.ts); a voice note keeps them.
const OUTROS: RegExp[] = [
  /^(thank you|thanks)( (so|very) much)?( all| guys| everyone)? for watching\b/,
  /^(please )?(like (and )?)?subscribe( to (my|the|our) channel)?$/,
  /^(vielen )?dank(e)?( schon| sehr)? (furs|fur das|fur s|fur ihr|fur eure) zu(sehen|schauen|horen)\b/,
  /^tack (for att|for) (du|ni) (har )?(tittade|tittat|sag pa|sett|lyssnade|lyssnat|kollade|kollat)\b/,
  /^tak (fordi|for at) (du|i) (sa med|sa|har set|kiggede)\b/,
  /^takk (for at|fordi) (du|dere) (sa pa|sa|har sett|ser)\b/,
  /^(bedankt|dank je( wel)?|dank u( wel)?) voor (het )?(kijken|luisteren)\b/,
  /^merci d avoir regarde\b/,
  /^gracias por (ver|mirar)\b/,
  /^grazie( a tutti)? per (la visione|aver guardato)\b/,
  /^obrigad[oa] por (assistir|ver)\b/,
  /^kiitos (katsomisesta|kun katsoit)\b/,
  /^dziek(i|uje) za (obejrzenie|ogladanie)\b/,
  /^спасибо за просмотр/u,
];
const OUTRO_PHRASES = ['ご視聴ありがとうございました', '谢谢观看', '感谢观看', '시청해주셔서 감사합니다'].map(matchForm);
const OUTRO_MAX_WORDS = 10;

// Sound tags in brackets or alone; after matchForm only the word is left ("[Musik]" → "musik", "♪" → "").
const TAGS = new Set(
  'music musik musique musica muziek musikk musiikki muzyka музыка 音乐 音楽 applause applaus applaudissements aplausos laughter lachen rires risas'.split(' '),
);
// A tag inside a line ("[Musik] Willkommen …") and music notes: not words anyone said.
const INLINE_TAG = /[[(*]\s*[\p{L} ]{2,24}?\s*[\])*]|[♪♫♬]+/gu;

/**
 * A line without what was never said inside it — bracketed sound tags, music notes, a credit token — and the kind of
 * what went (a credit outranks a tag), null when nothing did.
 */
export function scrub(text: string): { text: string; removed: HallucinationKind | null } {
  let removed: HallucinationKind | null = null;
  let out = text;
  if (/[[(*♪♫♬]/u.test(out))
    out = out.replace(INLINE_TAG, (tag) => {
      if (
        !/[♪♫♬]/u.test(tag) &&
        !matchForm(tag)
          .split(' ')
          .every((w) => TAGS.has(w))
      )
        return tag;
      removed ??= 'tag';
      return ' ';
    });
  out = out.replace(CREDIT_TOKEN, () => {
    removed = 'credit';
    return ' ';
  });
  return removed ? { text: out.replace(/\s+/g, ' ').trim(), removed } : { text, removed };
}

/** Which kind of invented line `text` is as a whole (a segment or a sentence), or null for speech. */
export function hallucinationKind(text: string): HallucinationKind | null {
  if (!text.trim()) return null;
  const m = matchForm(text);
  if (!m) return 'tag'; // only symbols and punctuation: "♪", "...", "."
  const words = m.split(' ');
  if (words.every((w) => TAGS.has(w))) return 'tag';
  if (words.length <= CREDIT_MAX_WORDS && CREDITS.some((re) => re.test(m))) return 'credit';
  if (words.length <= OUTRO_MAX_WORDS && (OUTROS.some((re) => re.test(m)) || OUTRO_PHRASES.some((p) => m.startsWith(p)))) return 'outro';
  return null;
}

/** Sentences of a text. */
export const sentences = (text: string): string[] =>
  text
    .split(/(?<=[.!?…。！？])\s+/u)
    .map((s) => s.trim())
    .filter(Boolean);

const invented = (s: string) => {
  const kind = hallucinationKind(s);
  return kind === 'credit' || kind === 'tag';
};

/**
 * A voice note's text without invented lines: credits and sound tags go, as the whole note, a sentence of it or a
 * token in it. Outros stay — a note has no timing to tell a stretched one from a said one, and the silence gate
 * already keeps Whisper from hearing an empty room.
 */
export function stripHallucinations(text: string): string {
  const clean = scrub(text).text.trim();
  if (invented(clean)) return '';
  const parts = sentences(clean);
  const kept = parts.filter((s) => !invented(s));
  return kept.length === parts.length ? clean : kept.join(' ');
}

// ---------------------------------------------------------------- timed lines (a render's transcript)

/** A "thanks for watching" faster than this (words a second) was said, not invented over music. */
const SPOKEN_OUTRO = 1.5;

// Chinese and Japanese write without spaces: two characters count as a word.
const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Words in a line, as a reader counts them (punctuation-only tokens aren't words). */
export function countWords(text: string): number {
  const form = matchForm(text);
  if (!form) return 0;
  return form.split(' ').reduce((n, w) => n + (CJK.test(w) ? Math.ceil([...w].length / 2) : 1), 0);
}
const rateOf = (x: Timed) => countWords(x.text) / Math.max(0.05, x.t1 - x.t0);
const mid = (x: Timed) => (x.t0 + x.t1) / 2;

export type Dropped = Timed & { kind: HallucinationKind };

/** A timed result without invented lines (credits, sound tags, stretched outros), and what went. */
export function dropHallucinations(r: { segments?: Timed[]; words?: Timed[] }): { segments: Timed[]; words: Timed[]; dropped: Dropped[] } {
  const dropped: Dropped[] = [];
  const invented = (x: Timed): HallucinationKind | null => {
    const kind = hallucinationKind(x.text);
    return kind === 'outro' && rateOf(x) >= SPOKEN_OUTRO ? null : kind;
  };
  const segments: Timed[] = [];
  for (const s of r.segments ?? []) {
    const { text, removed } = scrub(s.text);
    const kind = text ? invented({ ...s, text }) : (removed ?? 'tag');
    if (kind) dropped.push({ ...s, kind });
    else segments.push(text === s.text ? s : { ...s, text });
  }
  // Word-timed engines: words inside a dropped segment go with it, and so do invented sentences among the words.
  const gone = [...dropped];
  const kept: Timed[] = [];
  for (const w of r.words ?? []) {
    const { text, removed } = scrub(w.text);
    if (!text) dropped.push({ ...w, kind: removed ?? 'tag' });
    else if (!gone.some((d) => mid(w) >= d.t0 && mid(w) <= d.t1)) kept.push(text === w.text ? w : { ...w, text });
  }
  const words: Timed[] = [];
  for (const group of sentencesOf(kept)) {
    const line = { text: group.map((w) => w.text).join(' '), t0: group[0].t0, t1: group[group.length - 1].t1 };
    const kind = invented(line);
    if (kind) dropped.push({ ...line, kind });
    else words.push(...group);
  }
  return { segments, words, dropped };
}

/** Words grouped into sentences: up to a sentence's end or a pause of a second. */
function sentencesOf(words: readonly Timed[]): Timed[][] {
  const out: Timed[][] = [];
  let cur: Timed[] = [];
  for (const [i, w] of words.entries()) {
    cur.push(w);
    const next = words[i + 1];
    if (!next || /[.!?…。！？]["»”’)]*$/u.test(w.text) || next.t0 - w.t1 >= 1) {
      out.push(cur);
      cur = [];
    }
  }
  return out;
}
