---
paths:
  - "lib/**"
  - "server/**"
  - "mcp/**"
  - "test/unit/access-ends.test.ts"
---

## Rules learned the hard way

The rules for this area of the code (AGENTS.md lists every rules file and the paths it covers).

### Permissions and accounts
- A new route goes in the permission table (`server/permissions.ts`): an unlisted write is refused to everyone.
- A route touching credentials, roles, members, invites, tokens, apps, webhooks, workspaces or links is `PERSON_ONLY`.
- Who runs the server is the operator list (`isOperator`, lib/operator.ts: LAMPO_OPERATOR, else #1's owners), never a role in workspace #1.
- Decide by capability (`ctx.capabilities`) or `req.auth.via`, never by mode.
- Sign-off (approve, carry, final, reopen) is a person's: API tokens get 403 (`signOffByPerson`).
- Publishing is a person's too (`publish`, `PERSON_ONLY`); agents only draft, and no tool or scope publishes.
- API tokens never read review-link tokens (`listedFor`).
- Anything that ends access calls `accessEnded()` (and gets a row in `access-ends.test.ts`); nothing else may.
- What a new password ends lives in `afterNewPassword`; new credential-bound things join it.
- Account answers are the same for every address (sign-up, reset, invite, add user): no enumeration.
- Read the session cookie with `sessionOf(req)` (`__Host-` over https), a query string with zod (`query`/`queryOr`).
