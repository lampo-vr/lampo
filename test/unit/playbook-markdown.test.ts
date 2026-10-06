// The playbook's markdown (web/src/playbook/markdown.ts): what it recognises, what stays text, and that text anyone
// who may write a playbook (or an agent's suggestion shown in one) chooses can't freeze a viewer's tab — parsing is
// linear. The link pattern used to backtrack over the rest of the line for every "[": 40,000 of them took seconds.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { blocks, type Inline, inlineTokens } from '../../web/src/playbook/markdown.ts';

const flat = (tokens: Inline[]): string =>
  tokens
    .map((t) =>
      t.t === 'text'
        ? t.text
        : t.t === 'code'
          ? `<code>${t.text}</code>`
          : t.t === 'link'
            ? `<a ${t.href}>${t.label}</a>`
            : `<${t.t}>${flat(t.children)}</${t.t}>`,
    )
    .join('');

test('inline: code, bold, italics, links and bare links; anything else stays its text', () => {
  assert.equal(flat(inlineTokens('Use `H.264`, **never** _ever_ *this*.')), 'Use <code>H.264</code>, <strong>never</strong> <em>ever</em> <em>this</em>.');
  assert.equal(
    flat(inlineTokens('See [the board](https://example.com/b) or https://example.com/c.')),
    'See <a https://example.com/b>the board</a> or <a https://example.com/c.>https://example.com/c.</a>',
  );
  // a link's label may hold "[" (up to the first "]"), and bold may hold a link
  assert.equal(flat(inlineTokens('[a [b](https://x.test)')), '<a https://x.test>a [b</a>');
  assert.equal(flat(inlineTokens('**[a](https://x.test)**')), '<strong><a https://x.test>a</a></strong>');
  // not labelled links: unsafe schemes, empty labels, spaces in the url, unclosed brackets (an http(s) address in
  // them is still a bare link, its own text)
  for (const s of ['[x](javascript:alert(1))', '[](https://x.test)', '[x](https://x.test y)', '[x](https://x.test', '[x] (https://x.test)', 'a [ b ] c'])
    assert.equal(
      inlineTokens(s).every((t) => t.t === 'text' || (t.t === 'link' && t.label === t.href)),
      true,
      `${s}: ${JSON.stringify(inlineTokens(s))}`,
    );
  assert.equal(flat(inlineTokens('[x](javascript:alert(1))')), '[x](javascript:alert(1))');
});

test('blocks: headings, lists (wrapped lines continue the item), quotes, code, rules, paragraphs', () => {
  const b = blocks('# Brief\n\nWarm, honest.\nNever salesy.\n\n- one\n  wrapped\n- two\n\n1. a\n2. b\n\n> quoted\n\n```\ncode\n```\n\n---');
  assert.deepEqual(
    b.map((x) => x.t),
    ['h', 'p', 'ul', 'ol', 'quote', 'code', 'hr'],
  );
  assert.deepEqual(b[1], { t: 'p', text: 'Warm, honest. Never salesy.' });
  assert.deepEqual(b[2], { t: 'ul', items: ['one wrapped', 'two'] });
});

test('linear: text chosen to make a pattern backtrack parses in time that grows with its length, not its square', () => {
  // Each input at full size and at a tenth: linear work takes ~10× as long, quadratic ~100× (the old parser: 40,000 "["
  // took 2,357 ms). A ratio holds on a busy machine where a fixed millisecond budget doesn't; the ceiling is a backstop.
  const nasty: ((n: number) => string)[] = [
    (n) => '['.repeat(n * 4),
    (n) => '[a]('.repeat(n),
    (n) => '[a](https://x.test '.repeat(n / 2),
    (n) => '*'.repeat(n * 4),
    (n) => '_'.repeat(n * 4),
    (n) => '`'.repeat(n * 4),
    (n) => '**a'.repeat(n * 1.5),
    (n) => '__a_'.repeat(n),
    (n) => `*a${' b'.repeat(n * 2)}`,
    (n) => 'https://'.repeat(n / 2),
  ];
  const parse = (s: string) => {
    const t0 = performance.now();
    for (const b of blocks(s)) {
      if ('text' in b) inlineTokens(b.text);
      else if ('items' in b) b.items.map(inlineTokens);
    }
    inlineTokens(s);
    return performance.now() - t0;
  };
  // Warmed up first and the best of five: one GC pause or a JIT tier-up on a busy machine is not growth. Below 2 ms the
  // timer and the scheduler dominate, so the small run counts as at least 2 ms (quadratic is still ~100× and seconds).
  const best = (s: string) => {
    parse(s);
    return Math.min(...Array.from({ length: 5 }, () => parse(s)));
  };
  for (const make of nasty) {
    const big = make(10_000);
    const small = make(1_000);
    const [tBig, tSmall] = [best(big), Math.max(best(small), 2)];
    const what = `${JSON.stringify(big.slice(0, 12))}… (${big.length} chars): ${tBig.toFixed(1)} ms, a tenth of it ${tSmall.toFixed(1)} ms`;
    assert.ok(tBig / tSmall < 30, `grows faster than its length: ${what}`);
    assert.ok(tBig < 1000, what);
  }
});
