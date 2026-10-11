// States you can't hold still on a page — hover, pressed, keyboard focus — shown side by side: beside every rule that
// names one, a copy with the pseudo-class swapped for a class (.sg-hover, .sg-active, .sg-focus) that only the
// styleguide's samples carry. The copy goes right after its rule in the same sheet, so it meets the same cascade; the
// copies go again when the styleguide does. What the samples show is the app's own rules.
import { useEffect } from 'react';

const SWAPS: [RegExp, string][] = [
  [/:hover\b/g, '.sg-hover'],
  [/:active\b/g, '.sg-active'],
  [/:focus-visible\b/g, '.sg-focus'],
  [/:focus(?![-\w])/g, '.sg-focus'],
];
const NAMED = /:hover\b|:active\b|:focus(?![-\w])|:focus-visible\b/;
const OURS = /\.sg-(hover|active|focus)\b/;

type Holder = CSSStyleSheet | CSSGroupingRule;

function addCopies(holder: Holder) {
  for (let i = 0; i < holder.cssRules.length; i++) {
    const rule = holder.cssRules[i];
    if (rule instanceof CSSStyleRule && NAMED.test(rule.selectorText)) {
      let selector = rule.selectorText;
      for (const [from, to] of SWAPS) selector = selector.replace(from, to);
      try {
        holder.insertRule(`${selector}{${rule.style.cssText}}`, i + 1);
        i++;
      } catch {} // a selector the swap made invalid: that state just isn't shown
    } else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) addCopies(rule);
  }
}

function removeCopies(holder: Holder) {
  for (let i = holder.cssRules.length - 1; i >= 0; i--) {
    const rule = holder.cssRules[i];
    if (rule instanceof CSSStyleRule && OURS.test(rule.selectorText)) holder.deleteRule(i);
    else if (rule instanceof CSSMediaRule || rule instanceof CSSSupportsRule) removeCopies(rule);
  }
}

function ownSheets(): CSSStyleSheet[] {
  return [...document.styleSheets].filter((s) => {
    try {
      return !!s.cssRules;
    } catch {
      return false; // another origin's sheet (a font service): nothing of ours in it
    }
  });
}

/** The copies, while the styleguide is on screen. */
export function usePseudoStates() {
  useEffect(() => {
    const sheets = ownSheets();
    for (const s of sheets) addCopies(s);
    return () => {
      for (const s of sheets) removeCopies(s);
    };
  }, []);
}
