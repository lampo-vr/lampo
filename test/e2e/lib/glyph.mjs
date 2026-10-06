// Where a round button's glyph stands against the button: the play triangle a nudge right of the middle (its weight sits
// left of its box), the pause bars exactly in it — and the glyph's box on whole pixels inside the button, since a half
// pixel is snapped one way or the other by the browser and the glyph then sits off the circle (dock.css .playbtn).

/** Play is drawn this far right of the button's middle, in px (lucide's own offset + --ic-play-nudge); pause at 0. */
export const PLAY_NUDGE = { min: 1, max: 2.5 };

/**
 * Measures the glyph of the button `sel`: `dx`/`dy` = the painted shapes' box centre minus the button's centre, `whole`
 * = the glyph's own box starts on a whole pixel inside the button, `glyph` = 'play' | 'pause' (by its icon class).
 * @param {import('puppeteer-core').Page} page
 * @param {string} sel
 */
export const glyphCentre = (page, sel) =>
  page.$eval(sel, (b) => {
    const box = b.getBoundingClientRect();
    const svg = b.querySelector('svg');
    const parts = [...svg.querySelectorAll('path, rect, circle, polygon')].map((e) => e.getBoundingClientRect());
    const left = Math.min(...parts.map((r) => r.left));
    const right = Math.max(...parts.map((r) => r.right));
    const top = Math.min(...parts.map((r) => r.top));
    const bottom = Math.max(...parts.map((r) => r.bottom));
    const s = svg.getBoundingClientRect();
    const near = (x) => Math.abs(x - Math.round(x)) < 0.01;
    const r2 = (x) => Math.round(x * 100) / 100;
    return {
      glyph: svg.classList.contains('i-play') ? 'play' : svg.classList.contains('i-pause') ? 'pause' : svg.getAttribute('class'),
      dx: r2((left + right) / 2 - (box.left + box.width / 2)),
      dy: r2((top + bottom) / 2 - (box.top + box.height / 2)),
      whole: near(s.left - box.left) && near(s.top - box.top),
      size: [r2(box.width), r2(s.width)],
    };
  });

/** The problems with a measured glyph (empty when it stands where it should). */
export function glyphProblems(m, where) {
  const out = [];
  if (!m.whole) out.push(`${where}: the ${m.glyph} glyph's box starts between pixels (${JSON.stringify(m)})`);
  if (Math.abs(m.dy) > 1) out.push(`${where}: the ${m.glyph} glyph is ${m.dy}px off the middle vertically`);
  if (m.glyph === 'pause' && Math.abs(m.dx) > 1) out.push(`${where}: the pause bars are ${m.dx}px off the middle`);
  if (m.glyph === 'play' && (m.dx < PLAY_NUDGE.min || m.dx > PLAY_NUDGE.max))
    out.push(`${where}: the play triangle stands ${m.dx}px from the middle, not its nudge of ${PLAY_NUDGE.min}–${PLAY_NUDGE.max}px`);
  return out;
}
