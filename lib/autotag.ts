// Guess tags and severity from a spoken or typed note (German + English), for walkie-talkie notes.
// Shared by UI and server; deliberately simple keyword rules — the reviewer can edit tags afterwards.
import type { Severity } from './types.ts';

const RULES: [string, RegExp][] = [
  ['timing', /(zu fr[üu]h|zu sp[äa]t|timing|tempo|schneller|langsamer|l[äa]nger|k[üu]rzer|zu lang|zu kurz|dauer|rhythm|beat|too (early|late|long|short))/i],
  ['cut', /(schnitt|\bcut\b|[üu]bergang|transition|jump ?cut|abschneid|k[üu]rzen|trim)/i],
  ['freeze', /(freeze|h[äa]ngt|ruckel|stockt|standbild|eingefroren|stutter)/i],
  ['text/typo', /(tippfehler|typo|rechtschreib|schreibfehler|falsch geschrieben|buchstabe|spelling|wort falsch)/i],
  [
    'layout/overlap',
    /([üu]berlapp|liegt (auf|[üu]ber)|verdeckt|[üu]berdeckt|zu hoch|zu tief|zu weit (links|rechts|oben|unten)|position|verschieb|\brand\b|safe ?zone|overlap|too (high|low))/i,
  ],
  ['color/grade', /(farbe|grading|\bgrade\b|zu warm|zu kalt|s[äa]ttigung|kontrast|helligkeit|zu dunkel|zu hell|hautton|colou?r)/i],
  ['audio/music', /(musik|audio|\blaut\b|leise|\bton\b|stimme|\bdb\b|lautst[äa]rke|\bmix\b|bass|music|voice|volume)/i],
  ['sfx', /(sfx|sound ?effekt|ger[äa]usch|whoosh|swoosh|klick|sound effect)/i],
  ['graphic', /(grafik|logo|icon|animation|sticker|emoji|bauchbinde|lower third|graphic)/i],
  ['idea', /(idee|vielleicht|k[öo]nnte man|was w[äa]re|alternativ|probier|idea|what if)/i],
  ['love-it', /(geil|perfekt|genau so|mag ich|liebe|\blove\b|mega|sehr gut|richtig gut|so lassen|keep this)/i],
];

export function autoTags(text: string | null | undefined): string[] {
  const t = String(text || '');
  return RULES.filter(([, re]) => re.test(t)).map(([tag]) => tag);
}

// Suggestions to try, not changes to make.
const IDEA =
  /(\bideen?\b|nur so ein gedanke|vielleicht k[öo]nnte man|k[öo]nnte man (mal|auch)|was w[äa]re,? wenn|probier(t|en)? (mal|doch)|just an idea|an idea|\bidea:|what if|how about|could be (cool|fun|nice)|might be (cool|fun|nice))/i;

export function autoSeverity(text: string | null | undefined): Severity {
  const t = String(text || '');
  if (/(muss|unbedingt|geht nicht|kaputt|falsch|fehler|must|broken|wrong)/i.test(t)) return 'must';
  // Before "nice": "vielleicht könnte man …" is an idea to try, "vielleicht etwas kürzer" a small change.
  if (IDEA.test(t)) return 'idea';
  if (/(vielleicht|optional|w[äa]re sch[öo]n|kleinigkeit|nice to have|maybe)/i.test(t)) return 'nice';
  return 'should';
}
