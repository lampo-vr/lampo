// "#" in a note's text tags it: the word typed after a # suggests tags (by their id or their words in the UI's language),
// picking one takes the "#word" out of the text and puts the tag on the note; a whole "#timing" left in the text when
// the note is saved does the same. No React, no DOM (test/unit/hashtags.test.ts).

export interface HashWord {
  /** Where the "#" is. */
  start: number;
  /** The caret, just after the word. */
  end: number;
  /** The word after the "#", lower case (empty right after the "#"). */
  query: string;
}

const WORD = /[\p{L}\p{N}/&-]/u;

/** The "#word" the caret is at the end of (after a space or at the start of the text), or null. */
export function hashAt(text: string, caret: number): HashWord | null {
  const m = /(^|\s)#([\p{L}\p{N}/&-]*)$/u.exec(text.slice(0, caret));
  if (!m) return null;
  // the caret in the middle of a word ("#tim|ing") isn't at its end
  if (caret < text.length && WORD.test(text[caret])) return null;
  return { start: caret - m[2].length - 1, end: caret, query: m[2].toLowerCase() };
}

const words = (s: string) =>
  s
    .toLowerCase()
    .split(/[\s/&-]+/)
    .filter(Boolean);

/** The tags one of whose words (in the id or the label) starts with `query` — all of them for an empty query — in order. */
export function matchTags(tags: readonly string[], query: string, label: (tag: string) => string): string[] {
  const q = query.toLowerCase();
  if (!q) return [...tags];
  return tags.filter(
    (tag) => tag.startsWith(q) || label(tag).toLowerCase().startsWith(q) || [...words(tag), ...words(label(tag))].some((w) => w.startsWith(q)),
  );
}

/** `text` with the "#word" taken out (and the space it leaves doubled closed), and where the caret goes. */
export function dropHash(text: string, at: HashWord): { text: string; caret: number } {
  const before = text.slice(0, at.start);
  let after = text.slice(at.end);
  if ((before === '' || before.endsWith(' ')) && after.startsWith(' ')) after = after.slice(1);
  return { text: before + after, caret: before.length };
}

/** Whole tags typed as "#timing" or "#love-it" (a tag's id, or its label with dashes for spaces): the tags found, and
 * the text without them. Text without any comes back as it was. */
export function takeHashtags(text: string, tags: readonly string[], label: (tag: string) => string): { text: string; tags: string[] } {
  const found: string[] = [];
  const out = text.replace(/(^|\s)#([\p{L}\p{N}/&-]+)(?=$|[\s.,;:!?)])/gu, (all, pre: string, word: string) => {
    const w = word.toLowerCase();
    const tag = tags.find((x) => x === w || label(x).toLowerCase().replace(/\s+/g, '-') === w);
    if (!tag) return all;
    if (!found.includes(tag)) found.push(tag);
    return pre;
  });
  if (!found.length) return { text, tags: [] };
  return {
    text: out
      .replace(/[ \t]{2,}/g, ' ')
      .replace(/ +([.,;:!?])/g, '$1')
      .trim(),
    tags: found,
  };
}
