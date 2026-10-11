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
- A value that ends with its own full stop ("24 € zzgl. USt.", "Acme Inc.") drops the template's after it (`fill`,
  `rich`): end a sentence with `{amount}.` and let the filler decide, never a second template without the stop.
- An async step that starts something (tus's `start()`) checks after every await that it still owns it (`running.get(id)
  === upload`): a cancel or a sign-out meanwhile would be undone (tus revives an aborted upload).
- A wait that a timer ends is over when that timer runs (a handle set, then cleared in its callback), never by `Date.now() < until`: a timer can run before Date.now() gets there (Node's by up to 1 ms, a clock set back by more), and the step it turned away has no timer left to wake it (`files/uploadStore.ts` `holdAsking`: a 429's files stayed "waiting" for good).
- `npm run i18n` reads only literal keys: a key picked by a condition (`t(a ? 'x' : 'y')`, `<T k={…}>`) is one call per branch.
- Kept data and per-account localStorage are cleared in `afterSignOut`; none for review links.
- Inbox work never has "Got it": it leaves when done; dismissals only hide what informs.
- A hash route a link from outside opens (the website, an email, a campaign's utm tags) takes a query (`(?:\?.*)?` in `parseRoute`): without it `#/signup?plan=…` was the library, so the sign-in.
- What a moment says it costs waits for every answer it rests on (`undefined` while on its way, `null` for none) behind an `SkLine`: a fallback sentence said first is read out by a `role=status` box, then rewritten.
- A radio tile whose pick opens something (the setup's agent tiles → its connect block) listens for `click` too: a checked radio fires no `change`, so after going back, picking the same one again did nothing (`AgentTiles` in `onboarding/connect.tsx`).
- Prices are net and say so (`taxWord`: "excl. VAT", the website's way); the total with VAT stands only where someone commits (the plans' bar, a switch that bills now: `billedNow`), never as a headline.
- A test notification is "sent" once the push service takes it; that it showed is the service worker's word (`vr-push-test`), and whether it is on screen no page can know (a Mac's per-browser switch, Focus): say the next step, never that it arrived.
