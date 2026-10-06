// Small word helpers shared by the spelling engines and the pre-review.

/** Edit distance with transpositions ("Skincrae" → "Skincare" is 1), case-insensitive. */
export function distance(a: string, b: string): number {
  const x = [...a.toLowerCase()];
  const y = [...b.toLowerCase()];
  const d = Array.from({ length: x.length + 1 }, (_, i) => Array.from({ length: y.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= x.length; i++)
    for (let j = 1; j <= y.length; j++) {
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (x[i - 1] === y[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && x[i - 1] === y[j - 2] && x[i - 2] === y[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  return d[x.length][y.length];
}

/** `guess` written the way `word` is: ALL CAPS, Capitalised or as is. */
export function matchCase(word: string, guess: string): string {
  if (word.length > 1 && word === word.toUpperCase()) return guess.toUpperCase();
  if (word[0] && word[0] === word[0].toUpperCase()) return guess[0].toUpperCase() + guess.slice(1);
  return guess;
}
