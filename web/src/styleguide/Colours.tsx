// The colour tokens by name, each in both themes side by side: every cell is a theme island (base.css .theme-dark /
// .theme-light), so what it shows is the token as the app resolves it, whatever theme the page is in. Text colours
// carry their contrast on the page's surface (WCAG: AA 4.5, AAA 7).
import { type RefObject, useLayoutEffect, useRef } from 'react';

/** `text`: shown as type on the page, with its contrast there; `on`: shown as type on the fill it is made for. */
type Group = { name: string; note: string; tokens: string[]; text?: boolean; on?: Record<string, string> };

export const COLOUR_GROUPS: Group[] = [
  {
    name: 'Surfaces',
    note: 'Wells, the page, cards, floats, raised fills: one step lighter each (paper on paper in light).',
    tokens: ['--ink-0', '--ink-1', '--ink-2', '--ink-3', '--ink-4', '--ink-5', '--well', '--float-bg'],
  },
  {
    name: 'Lines',
    note: 'Hairlines and edges, quiet to strong; the float’s own edge.',
    tokens: ['--line', '--line-2', '--line-3', '--line-4', '--float-line'],
  },
  {
    name: 'Text',
    note: 'Body, secondary, quiet, faint (never for words people must read).',
    tokens: ['--fg', '--fg-2', '--muted', '--faint', '--fg-hi'],
    text: true,
  },
  {
    name: 'On a fill',
    note: 'Text on the ink fill, the brand orange, the danger crimson.',
    tokens: ['--on-fg', '--on-fg-2', '--on-fg-3', '--on-brand', '--brand-ink', '--on-must'],
    on: { '--on-fg': '--fg', '--on-fg-2': '--fg', '--on-fg-3': '--fg', '--on-brand': '--brand-deep', '--brand-ink': '--brand', '--on-must': '--danger' },
  },
  {
    name: 'Status',
    note: 'Severity and state: as text, as marks, as tints. Never the only sign: a glyph’s shape says it too.',
    tokens: ['--must', '--should', '--nice', '--idea', '--ok', '--agent'],
    text: true,
  },
  {
    name: 'Tints',
    note: 'A status as a ground, and the text that sits on it.',
    tokens: ['--must-bg', '--should-bg', '--idea-bg', '--ok-bg', '--agent-bg', '--must-2', '--ok-2', '--agent-2', '--agent-3'],
  },
  {
    name: 'Selection and floats',
    note: 'Selection is a flat fill (never raised, never orange); the dim behind a dialog.',
    tokens: ['--sel', '--sel-on', '--float-sel', '--backdrop', '--veil'],
  },
  {
    name: 'Brand',
    note: 'The logo’s orange, for brand moments only; a button in it is a shade deeper.',
    tokens: ['--brand', '--brand-deep', '--brand-hot', '--brand-glow', '--brand-haze'],
  },
  { name: 'Danger', note: 'What can’t be undone: a crimson, not the must colour.', tokens: ['--danger', '--danger-hi', '--danger-glow'] },
  {
    name: 'Passing messages',
    note: 'Tooltips and toasts: ink on paper, a lifted step in the dark.',
    tokens: ['--tip-bg', '--tip-fg', '--tip-fg-2', '--tip-ok'],
  },
  {
    name: 'Timeline',
    note: 'What the canvas reads.',
    tokens: ['--tl-bg', '--tl-film', '--tl-lane', '--tl-grid', '--tl-tick', '--tl-text', '--tl-wave-rms', '--tl-verified', '--playhead'],
  },
];

/** The colour a computed value names, as #rrggbb plus its opacity when it has one. */
function hexOf(value: string): { hex: string; rgb: [number, number, number]; a: number } | null {
  let m = value.match(/^rgba?\((\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?),\s*(\d+(?:\.\d+)?)(?:,\s*([\d.]+))?\)$/);
  let rgb: [number, number, number];
  let a = 1;
  if (m) {
    rgb = [Number(m[1]), Number(m[2]), Number(m[3])];
    a = m[4] === undefined ? 1 : Number(m[4]);
  } else {
    m = value.match(/^color\(srgb ([\d.e-]+) ([\d.e-]+) ([\d.e-]+)(?: \/ ([\d.e-]+))?\)$/);
    if (!m) return null;
    rgb = [Number(m[1]) * 255, Number(m[2]) * 255, Number(m[3]) * 255];
    a = m[4] === undefined ? 1 : Number(m[4]);
  }
  const hex = `#${rgb
    .map((c) =>
      Math.round(Math.max(0, Math.min(255, c)))
        .toString(16)
        .padStart(2, '0'),
    )
    .join('')}`;
  return { hex, rgb, a };
}

const luminance = ([r, g, b]: number[]) => {
  const lin = (v: number) => (v / 255 <= 0.03928 ? v / 255 / 12.92 : ((v / 255 + 0.055) / 1.055) ** 2.4);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
};
const contrast = (a: number[], b: number[]) => {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
};

/** Fills in each cell's value (and a text colour's contrast on its island's page) once the cells have their styles. */
function useValues(root: RefObject<HTMLDivElement | null>) {
  useLayoutEffect(() => {
    for (const cell of root.current?.querySelectorAll<HTMLElement>('[data-token]') ?? []) {
      const chip = cell.querySelector<HTMLElement>('.sg-chip');
      const out = cell.querySelector<HTMLElement>('.sg-val');
      const on = cell.querySelector<HTMLElement>('.sg-on');
      if (!chip || !out) continue;
      // type on a fill: the type's colour, measured against that fill; otherwise the swatch, against the page
      const c = hexOf(on ? getComputedStyle(on).color : getComputedStyle(chip).backgroundColor);
      const ground = hexOf(getComputedStyle(on ? chip : cell).backgroundColor);
      if (!c) continue;
      let words = c.a < 1 ? `${c.hex} · ${Math.round(c.a * 100)} %` : c.hex;
      if ((on || cell.dataset.text !== undefined) && ground && c.a === 1) {
        const r = contrast(c.rgb, ground.rgb);
        words += ` · ${r.toFixed(1)}:1${r >= 7 ? ' AAA' : r >= 4.5 ? ' AA' : ''}`;
      }
      out.textContent = words;
    }
  });
}

export function Colours() {
  const root = useRef<HTMLDivElement>(null);
  useValues(root);
  return (
    <div className="sg-colours" ref={root} data-testid="sg-colours">
      <div className="sg-colours-head" aria-hidden="true">
        <span />
        <span>Dark</span>
        <span>Light</span>
      </div>
      {COLOUR_GROUPS.map((g) => (
        <section key={g.name} className="sg-colour-group" aria-label={g.name}>
          <h3 className="sg-sub">{g.name}</h3>
          <p className="sg-note">{g.note}</p>
          {g.tokens.map((name) => (
            <div key={name} className="sg-colour-row">
              <code className="sg-token">
                {name}
                {g.on?.[name] && <span className="sg-token-on"> on {g.on[name]}</span>}
              </code>
              {(['dark', 'light'] as const).map((theme) => (
                <div key={theme} className={`sg-colour theme-${theme}`} data-token={name} data-text={g.text ? '' : undefined}>
                  {g.on?.[name] ? (
                    <span className="sg-chip" style={{ background: `var(${g.on[name]})` }}>
                      <span className="sg-on" style={{ color: `var(${name})` }}>
                        Aa
                      </span>
                    </span>
                  ) : (
                    <span className="sg-chip" style={{ background: `var(${name})` }} />
                  )}
                  {g.text && (
                    <span className="sg-aa" style={{ color: `var(${name})` }}>
                      Aa
                    </span>
                  )}
                  <span className="sg-val" />
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}
