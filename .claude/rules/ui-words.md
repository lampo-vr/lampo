---
paths:
  - "web/**"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### UI: words and state
- Every UI string goes through `t('…')` or `<T k>`; then `npm run i18n` and translate the new keys.
- A language switch re-renders in place: words outside a component go through `perLang(() => …)`; a `memo` or a `useMemo` with words in it reads `useLang()` (`i18n.test.ts` finds the first two).
- `|` in a UI string separates plural forms; a literal bar is `∣`.
- `npm run i18n` reads only literal keys: a key picked by a condition (`t(a ? 'x' : 'y')`, `<T k={…}>`) is one call per branch.
- Kept data and per-account localStorage are cleared in `afterSignOut`; none for review links.
- Inbox work never has "Got it": it leaves when done; dismissals only hide what informs.
- A hash route a link from outside opens (the website, an email, a campaign's utm tags) takes a query (`(?:\?.*)?` in `parseRoute`): without it `#/signup?plan=…` was the library, so the sign-in.
