# HTTP API

The web app and review links use this API, and so do `lampo` and the stdio MCP server when they work against a hosted
server. It is JSON over HTTP, with a stream of server-sent events for live updates.

This page is an overview. The route modules in [`server/routes/`](../server/routes) (accounts:
[`server/auth.ts`](../server/auth.ts)) are short and are the reference, and the answers' shapes are typed in
[`lib/types.ts`](../lib/types.ts).

## Quick start

Create an API token in **Settings → API tokens**, then:

```sh
export LAMPO_TOKEN=vr_…        # the token, shown once
curl -H "Authorization: Bearer $LAMPO_TOKEN" https://review.example.com/api/library
curl -N -H "Authorization: Bearer $LAMPO_TOKEN" https://review.example.com/api/events
```

The first call lists the videos; the second stays open and prints an event whenever something changes, until the access
it opened with ends (the token revoked, the member removed, the account disabled: at once). On your own
machine the app trusts calls from the machine itself, so no token is needed: `curl http://localhost:4747/api/library`.

The rules for every call:

- Request bodies and query strings are checked. A bad field gets `400 {error}` naming it (`?v=` is a positive whole
  number, or empty for the newest version).
- Errors are `{error}` with a fitting status. What the message says depends on who asks, not on the mode: only the
  machine's owner at the machine reads an error as it is. Anyone else (a review-link visitor, an API token, a session
  on another device, every caller of a hosted server) gets a `5xx`, or a `4xx` caused by a tool's output, an object
  store's or a speech engine's answer or naming a path on the server, as a plain sentence with a reference; the
  details go to the server log under that reference. An object store's refusal (S3 or Bunny answering `403`) is a
  `500`: the server's fault, not the caller's. A failed transcript or recording keeps the engine's own words for the
  owner at the machine; anyone else reads "the speech engine could not hear this version" or "the recording could
  not be heard". MCP tool errors follow the same rule.
- `<slug>` in a path is URL-encoded (`encodeURIComponent`).
- A `v` (in a path, the query or a body) names a version of the video; without one, the newest. A version the video
  doesn't have is `404 {error: "no v5"}`, never the newest instead: a note, a render source or a transcript lands on
  the version it names or nowhere, as with `lampo` on the machine.
- Paths match exactly: they are case-sensitive, and a trailing slash, `//` or a `.` segment is a `404`.

## Authentication

A call is identified by the first of these that it carries:

1. **An API token**: `Authorization: Bearer vr_…` (Settings → API tokens). A token that doesn't check out is nobody,
   even from the machine itself.
2. **A session cookie**, set when a person signs in in the browser: `__Host-vr_session` over https (this host only,
   `Secure`; a `vr_session` is never read over https: a browser that still holds one signs in once more),
   `vr_session` over plain http.
3. **On a person's own machine only:** a call from the machine itself (loopback, no proxy headers; on Linux only from
   the app's own OS account or root), or from a device that opened the LAN link (`--lan`; its key is kept as a cookie).
   Both act as the machine's owner account.

At `/mcp`, an access token from the OAuth sign-in (`Bearer vro_…`) works too, and only there.

Then these rules apply:

- **Signed out**, a call answers `401 {error: "please sign in"}`, except the public endpoints: `/healthz`, `/readyz`,
  `/robots.txt`, `/api/info`, `/api/auth/status|setup|login|token|logout`, `/api/auth/invite/peek|accept`, what emailed
  links and signed-out people ask (`/api/auth/signup|verify|verify/resend|forgot|reset|reset/peek`), review links,
  one-time upload URLs, `/mcp`, `/oauth/…` and `/.well-known/…` (these check credentials themselves), and the app's
  pages and static files.
- **Unconfirmed sign-ups.** An account that signed up on its own and hasn't confirmed its address yet gets
  `403 {error, unconfirmed: true}` from every private route except its own profile and status, the confirm and reset
  links, sending the link again, dropping a new address and signing out; `lampo login` gets no token until then.
- **Roles.** Each route needs an action from the role table ([server-mode.md](server-mode.md#accounts-and-tokens);
  per route: [`server/permissions.ts`](../server/permissions.ts)). Without it the answer is
  `403 {error: "your role (reviewer) can't do that"}`. A write that isn't in the table is refused to everyone
  (`403 not in the permission table`).
- **People only.** What makes or changes credentials and access is a person's, signed in in the app (a browser session,
  or the machine itself). With an API token it answers `403 {person: true}`, whatever the token's role (`PERSON_ONLY`
  in [`server/permissions.ts`](../server/permissions.ts)): making API tokens, signing out everywhere, adding, changing
  and removing members, making, emailing and revoking invites or getting their links again, revoking the workspace's
  tokens, disconnecting its apps, adding, changing, testing and removing webhooks, making or renaming a workspace, subscribing a device to push
  notifications, and making, changing or revoking a review link (whoever holds a link can act as the client through it,
  a client's approval included, and sign-off is people's). `PATCH /api/auth/me` with a `password` or a new `email`
  answers a token `403` too; a token may still change a name or preferences. Other things are a person's in the app as
  well (`403` with a token): approving, requesting changes or withdrawing a decision, carrying an approval over,
  marking final or reopening, editing playbooks and deciding on suggestions, drafts and recordings, and OAuth consent
  (a signed-in browser or the machine itself). Making or switching workspaces needs a signed-in browser. A token's
  watch report is answered `204` and not kept.
- **The machine only.** Some things need a call from the machine itself (not the LAN link, a token or a signed-in
  browser): linking files and browsing folders, starting agents and listing, stopping or reading the runs Lampo
  started, starting and stopping the tunnel, and the owner's first password and email.
- **Host names.** The app answers only to its own names, else `421 {error: "unknown host"}`: the public URL's host on a
  hosted server, the machine's names and LAN addresses on a person's own machine, and loopback names everywhere. Review
  links and one-time upload URLs on a person's machine answer on any host (the tunnel). `/healthz`, `/readyz` and
  `/robots.txt` skip the check.
- **Origin.** A write that carries another site's `Origin` is refused (`403 bad origin`), whatever its credentials,
  except at `/oauth/token`, `/oauth/register` and `/oauth/revoke`. Writes on a cookie must also come from the app's own
  pages.

### Workspaces and plan limits

**Workspaces.** A hosted server can hold several teams ([server-mode.md](server-mode.md#workspaces)). Every signed-in
request works in one workspace and sees only it: an API token's own (the one it was made in), the session's current one
(switched with `POST /api/workspaces/switch`), or, on a person's own machine, the only one there is. The role a request
has is the person's role in that workspace. A review link works in its own workspace, whoever opens it. Nothing on this
page reaches another workspace: its videos, notes, links, people, tokens, apps and events are `404` or absent, never
`403`. The person's other workspaces are listed (`GET /api/auth/status`, `/api/auth/me`, `/api/workspaces`) to their
browser only: an API token is told of its own workspace alone. On a hosted server a workspace's signed-in requests
share 20,000 a minute (then `429` with `Retry-After`).

**Plan limits.** A hosted service may limit what a workspace adds ([`server/extension.ts`](../server/extension.ts)):
a new upload, video, member or review link, a publishing connection or a post published is then refused with
`402 {error, reason, upgrade?, messages?}`, and `error` is a sentence to show as it is (`messages`: the same sentence in
other languages, by code). A self-hosted server has no such limits.

**Billing.** The `/api/billing…` routes are not part of this repository. They belong to a separate billing module,
which a hosted service that sells plans (Lampo Cloud does) loads through the one extension point (`LAMPO_CLOUD_MODULE`,
[`server/extension.ts`](../server/extension.ts), [server-mode.md](server-mode.md#a-billing-provider)). A self-hosted
server has none of them. They are described here because the open web app's Settings → Billing calls them where a
module provides billing.
Where a billing provider runs, `/api/info` says `billing: true` and `GET /api/billing` answers the workspace's plan for
Settings → Billing (`BillingInfo` in [`lib/types.ts`](../lib/types.ts)): its name and state (`trial`, `free`, `paid`,
`grace`, `read-only`, with the dates that go with it), what the workspace uses of what the plan holds, and — for owners
and admins signed in in the browser (`manage`) — the plans to choose from with their prices in minor units, and
`payments` (the provider's publishable key for its payment form) while paying works. Nothing sends anyone to the
provider's own pages: `POST /api/billing/checkout {plan, interval, currency?}`, `/payment-method` and `/invoice/pay`
answer `{clientSecret}`, which the page's payment form (the provider's elements, mounted on Settings → Billing) confirms
in place. `GET /api/billing/account` (`BillingAccount`) has the payment methods (a card's brand and last four), the
name, address and tax IDs on the invoices, and the invoices with their PDFs; `/details`, `/tax-id`, `/tax-id/remove`,
`/payment-method/default` and `/payment-method/remove` change them. `POST /api/billing/plan/preview {plan, interval}`
says what the next invoice will be, `/plan` switches a running plan, `/storage {tb}` sets the extra storage a running
plan carries (the terabytes in all, paid with the card on file), and `/cancel` and `/resume` end the plan at the
period's end or keep it. `POST /api/billing/nudge` is for someone who can't pay (not an owner or admin) when a payment
failed: it tells the workspace's owners and admins, once per failed payment. The module answers these routes; each
declares the lowest role that may call it and whether only a person may, and the server's guard holds it to that, a
`HEAD` as its `GET` (`403`, with `{person: true}` for an API token); a module's paths are literal, never patterns. An API token never changes what a workspace pays.

Consumers may buy. `vat: {rate}` is the VAT a consumer pays on the offers' prices: Settings → Billing shows them with
it. `reverseCharge: true` says the checkout offers reverse charge (the provider's seller has a VAT ID of its own): the
business's name and VAT ID are then the provider's tax ID field, and a business from another EU country pays no VAT.
Without it every buyer pays VAT, the page asks a business's name and VAT ID in fields of its own, and nothing on it says
reverse charge. Right before the checkout confirms an order, the page sends `POST /api/billing/checkout/consent {buyer:
consumer | business, start, vatId?}`: a consumer's express request to start at once (`start: true`, § 356(4) / § 357a
BGB), kept by the provider with the session and the terms and withdrawal pages the server links, and a business's VAT ID
for its invoices (without reverse charge). *Cancel contracts here* (§ 312k BGB) asks `GET /api/billing/cancel` as it
opens (`BillingCancelOptions`: `notice` with `endsAt` and `refund` when a consumer's yearly plan after its first year may
end with one month's notice, § 309 Nr. 9 BGB), sends `POST /api/billing/cancel {kind: ordinary | extraordinary | notice,
reason?}` (a reason for the second) and answers `{kind, receivedAt, endsAt, refund?}`; the provider confirms it by email
at once. While a cancellation with notice owes its refund, the plan's answer carries `refund: {amount, currency}`.

**Conversion moments and the funnel** (the server's own routes, where a billing provider runs). `GET /api/moments`
(`MomentsState`): what the signed-in person put away in this workspace (a moment's id → until when) and the one-time
moments waiting for them (`loop`: the first fix they checked on a video of the workspace's own; `link_open`: the first
time their review link was opened, by the link's name), each for a day; the SSE event `moment` tells their own pages.
`PUT /api/moments/:id {until: ISO | null}` puts one away (at most 90 days) or brings it back, kept with the account;
`POST /api/moments/:id/seen` marks a waiting one shown; `POST /api/moments/event {e, id, where?}` counts what a moment
did (`shown`, `used`, `dismissed`, `made_room`), per week and never by whom. The writes are a person's (an API token gets
`403`). `GET /api/operator/funnel?weeks=4|8|12` (`FunnelReport`) is for the server's operator only, signed in in the
browser: `403 {person: true}` for an API token, `404` for everyone else ([what is counted](server-mode.md#what-it-counts-and-what-it-never-does)).

**The operator's pages** ([server-mode.md](server-mode.md#the-operators-pages)): for the server's operator only
(`LAMPO_OPERATOR`, else the owners of the first workspace; a person in the browser), `404` for everyone else before any
input is read, `403` for an API token. Every answer is `no-store`.

| Route | What it answers |
|---|---|
| `GET /api/operator/workspaces` | `OperatorWorkspaces`: `plans` (a billing module answers for them) and every workspace: id, name, created, its first active owner (id, name, email), members, videos, bytes, its log's newest event (`active`), `suspended` (`{at, by, reason}`, while it is), and its `plan` with a module (`OperatorPlan`: plan, name, state, trial end, grace, storage, the override set by hand, `fixed`, `paying`) |
| `GET /api/operator/workspaces/:id` | `OperatorWorkspaceDetail`: the same row, its members (name, email, role, since, suspended, disabled) and the plans set by hand, newest first |
| `POST /api/operator/workspaces/:id/plan` | `{kind: 'complimentary', plan: 'solo'\|'team'\|'business', reason}`, `{kind: 'trial', until: 'YYYY-MM-DD', reason}` (to that day's end, UTC) or `{kind: 'normal', reason}`; a reason is one line of up to 300. Answers the detail; `409` with the module's `reason` (`fixed`, `paying`, `date`, `none`) or without a module |
| `POST /api/operator/workspaces/:id/suspend` · `…/unsuspend` | `{reason}` (one line of up to 300) to suspend, `{}` to lift it; answers the detail. A suspended workspace is read-only for its people (below), and they are emailed both times. The server's own workspace: `409` |
| `GET /api/operator/workspaces/:id/deletion` | `WorkspaceDeletionPlan`: what deleting it would take (members and how many accounts go with it, videos, bytes, review links, invites, tokens, apps), or `refused` for the server's own workspace |
| `POST /api/operator/workspaces/:id/delete` | `{name, reason}`: `name` typed as the workspace is called (else `400 {name: true}`); deletes it with everything it holds and emails its people → `{deleted: {id, name}, plan, accountsGone}`. The server's own workspace: `409` |
| `GET /api/operator/accounts` | `OperatorAccounts`: every account's id, name, email, created, `signedIn` (its last sign-in), `lastActive` (the later of that and its last request through a session, kept at most hourly; `null`: neither recorded), `neverSignedIn` (neither recorded, and made after the server began to keep them), `disabled`, `unverified`, workspaces and roles, `operator`, `you` |
| `GET /api/operator/accounts/:id` | `{account}` |
| `POST /api/operator/accounts/:id/disable`, `…/enable` | `{}`; disabling ends its sessions, tokens and apps at once (never one's own: `409`); answers `{account}` |

**A suspended workspace** keeps its people signed in and readable: they read, watch and download, but every other write
in it answers `423 {suspended: true, error}` (their own account and sessions, what they watched and what they put away
in the inbox excepted), its review links answer `410` like an ended link (oEmbed `404`), and `MyWorkspace.suspended`
says since when (never the reason).

## Accounts

| Route | What it does |
|---|---|
| `GET /api/auth/status` | whether setup is needed and who is signed in: `{mode, setup, user, via, workspace?, workspaces?}` (below) |
| `POST /api/auth/setup` | a hosted server's first account (the owner), with the one-time token from its log: `{token, email, name, password}` |
| `POST /api/auth/login` | sign in: `{email, password}` sets the session cookie → `{user, workspace?, workspaces?}`. `401` if wrong, `429` with `Retry-After` when throttled |
| `POST /api/auth/logout` | sign this browser out |
| `POST /api/auth/logout-everywhere` | end all your sessions, any OAuth authorization code not redeemed yet, and your devices' notifications (push subscriptions); this browser gets `Clear-Site-Data: "cache", "storage"`. API tokens keep working |
| `POST /api/auth/token` | what `lampo login` uses: `{email, password, name?, days?, workspace?}`, or from the browser `{code, code_verifier, redirect_uri}` ([below](#oauth-for-mcp-clients)) → `{token, info, user, several}` (`several`: the person works in more than one workspace) |
| `GET` · `PATCH /api/auth/me` | your profile and preferences (below) |
| `PUT` · `DELETE /api/auth/me/avatar` | your picture (below) |
| `GET /api/auth/me/export` | your data as a zip, `lampo-data-<day>.zip` (below) |
| `GET /api/auth/me/deletion` | what deleting your account means: `AccountDeletionPlan` (below) |
| `POST /api/auth/me/delete` | `{password}`, or `{confirm: true}` after a recent sign-in: deletes your account (below) → `{deleted: true, workspaces}` |
| `GET /api/people` | the pictures of the workspace's active members: `{people: [{name, avatar}]}` (`avatar` is a URL or `null`) |
| `GET /api/avatars/:file` | one picture of a member of the workspace (`u_…-<hash>.jpg`); anything else is a `404` |
| `GET` · `POST /api/auth/tokens` | your API tokens for the current workspace (`last_used`, `expires`; `workspace` when it isn't #1); `POST {name?, days?}` → `{token, info}` |
| `DELETE /api/auth/tokens/:id` | revoke one of your tokens |
| `GET` · `POST /api/admin/users` | owners and admins: the workspace's members, each with their role there; add someone with `{email, name, password, role, lang?}`: an account, or on a server with workspaces an invite (below) |
| `PATCH` · `DELETE /api/admin/users/:id` | change `{role}` here, or someone else's `{name, disabled, password}` (below); remove from the workspace |
| `GET /api/admin/tokens` · `DELETE /api/admin/tokens/:id` | owners and admins: the workspace's tokens |
| `GET` · `POST /api/admin/invites` | owners and admins: the workspace's invites (pending and the last 30 days); `POST {role, name?, email?, days?, send?, lang?}` → `{invite, url, sent}`; `429` past 60 an hour per account or 200 in the workspace waiting or ended unused in the last 30 days |
| `POST /api/admin/invites/:id/send` | email a pending invite (again) to its address: `{lang?}` → `{invite}` |
| `GET /api/admin/invites/:id/link` · `DELETE /api/admin/invites/:id` | a pending invite's link again; revoke it (`429` past 60 revoked an hour per account) |
| `POST /api/auth/invite/peek` | public: `{token}` → `{role, name, email, by, expires, several?, workspace?, you?, workspace_id?}` |
| `POST /api/auth/invite/accept` | public: `{token, name, email, password, lang?}` → `{user, workspace?, workspaces?}` and a session cookie, or on a hosted server `{held: true}` (below) |

Details:

- **Status.** `user.role` is the role in `workspace`, the session's current one (`MyWorkspace`: `{id, name, created,
  role, members, current, suspended?}`); `workspaces` lists every workspace the account belongs to. Signing in answers
  the same two.
- **Profile.** `PATCH /api/auth/me` takes `{name?, email?, password?, current_password?, prefs?, lang?}`. A new email
  or password needs `current_password`, except the machine owner's first ones, set from the machine itself. On a server
  that can email, a new email is kept as `pending_email` and a link goes to it, unless another account has it (the
  answer is the same; a sign-up nobody confirmed doesn't count, and confirming the link removes it); the address
  changes once the link is used. A held sign-up gets `403` for a new email: it keeps the address it signed up with. A
  new password (here, set by an admin, or from a reset link) ends the account's other sessions, its apps connected
  through OAuth (and any authorization code not redeemed yet) and its push devices; a reset ends its API tokens too.
  `lang` (`en` or `de`) is the language of what the change sends. `user.prefs.onboarding` (the first run) is read-only
  here.
- **Preferences** (`prefs`): `theme` (`light`, `dark`, `system`), `lang` (`en`, `de`, `auto`), `wake` (`ask`, `start`,
  `send`: what sending something to an agent that isn't running does), `voice_languages`: the ISO 639-1 codes (8
  at most) your voice notes and recorded feedback are heard in (`[]` is Automatic, any language, detected; `null`
  goes back to the server's list), and `signin_alerts`: `true` sends an email for each sign-in from a browser or `lampo`
  the account hasn't used before.
- **Picture.** `PUT {data}`: base64 PNG, JPEG, WebP or GIF, 8 MB and 8192 px a side at most → `{user}`. It is kept as a
  256 px square JPEG through the storage adapter (`avatars/…`). `DELETE` goes back to initials.
- **Your data** ([server-mode.md](server-mode.md#deleting-and-exporting)). These are a person's, in the app: an API
  token gets `403 {person: true}`. The export is JSON files and a README: your account, your workspaces and roles, your
  tokens' names and dates (never the tokens), apps and devices, and per workspace what you wrote and made (notes with
  your replies, your replies on others' notes by the note's id, drafts, unsent recordings with their audio, decisions,
  the review links you made without their addresses, what you watched, what you uploaded without the videos). A few an
  hour, then `429` with `Retry-After`. The deletion plan lists the workspaces that go with the account (`goWith`: only
  you work there), those you leave (`leave`), those you must hand over or delete first (`blockedBy`: others work there
  and you are the last owner), whether a password confirms it (`password`), and `refused` for the machine's own
  account. Deleting needs your password (wrong ones count like failed sign-ins: `403 {password: true}`, then `429`) or,
  for `{confirm: true}`, a sign-in in the last 10 minutes; `409` while `blockedBy` names a workspace, and on a person's
  own machine. It signs this browser out (`Clear-Site-Data`) and emails you.
- **Tokens.** A new token is shown once and acts in one workspace: the current one for `POST /api/auth/tokens`; for
  `POST /api/auth/token` (`lampo login`), `workspace` (one the person is a member of, else `403`) or else their first.
  `days` (1–3650) makes it expire; `info.expires` says when. An API token can't make tokens or sign out everywhere
  (`403`). Tokens are credentials of their own: signing out everywhere and a new password set in Profile or by an admin
  end browser sessions but keep them (revoke them one by one in Settings → API tokens, or
  `DELETE /api/auth/tokens/:id`); a password reset, for a lost password, ends them too (connected apps end with any new
  password).
- **Admins and owners.** Adding someone on a store without workspaces makes an account that joins this workspace
  (`{user}`), a member unless `role` says otherwise. With workspaces no account is made for someone else: the address
  gets an invite into this workspace instead (`{invite, url, sent}`; the password goes unused, as the invite's link
  makes the account with the person's own or adds the account they have), and the answer is the same for every address.
  Admins don't manage owners, their invites or their tokens; nobody removes themselves, and the last owner can't be
  removed, demoted or disabled. With workspaces, `role` is the role in this workspace, and `disabled` suspends the
  person here only: no role in this workspace (its sessions there, tokens, apps and the invites they sent end) until
  `disabled: false` lets them in again, while the account goes on everywhere else (sign-in, resets, other workspaces);
  `user.disabled` says so for this workspace. Someone else's account itself (name, password) can be changed only when
  they work in no other workspace (`403` otherwise), a password only for an account whose person never proved their
  address from their inbox, and someone else's address never: only its person changes it, in Profile. Your own password
  and address here go by Profile's rules exactly (`current_password`, a new address pending until its link is used, the
  same answer for every address). Removing takes the person out of this workspace and revokes their tokens, apps and
  invites there; an account left in none is deleted and hears so.
- **Invites.** `role` defaults to member, `days` is 1–90 (default 7). `send: true` emails the invite to `email` too
  (`409` when the server has no public URL to build links from); an invite that was emailed shows `sent` and
  `sent_count`. Sending again answers `400` for an invite without an address and `429` when that address had too many
  emails. Each workspace emails its invites out of its own share of the server's hourly mail: past it, an emailed
  invite (and adding someone on a server with workspaces) answers `429` with `Retry-After` before anything is made. An
  address with an account in another workspace may be invited.
- **Accepting.** Peeking answers `email: null` (the address stays with the admins), `404` when the invite was used,
  revoked or has expired, and `429` when guessing. On a server with several workspaces it adds `several` (an account
  here may join with its own password), `workspace` (its name, once someone named it: a sign-up's workspace starts out
  called after its owner) and, for someone signed in, `you`: `member` (in it already, `workspace_id` says which),
  `join` (their account may join it) or `other` (it is made out to another address, never which). A link made out to an
  email address must be accepted with that address.
  - **On a hosted server** (it has workspaces) the link proves no inbox, since whoever made the invite holds it too.
    An address whose account gives its own password joins now (a session in the invite's workspace; the link is
    used). Anything else answers `{held: true}` with nobody signed in, the same whatever the address: a free address
    gets a held account (in no workspace, the least role) and a confirm link, and the invite stays pending; the first
    account whose address is confirmed takes its workspace and role. The address's inbox hears of it. Every try counts
    like a failed sign-in (`429`); an address the invite isn't made out to answers `400`, five times per invite in 15
    minutes, then `429` for every address; someone signed in as the address gets `401` for a wrong password; without a
    public URL nothing could confirm an address (`409`).
  - **On one team without workspaces** (the machine) accepting makes an account with the invite's role and a session,
    and the link works once. An invite that named no address starts it unconfirmed, with a link to the address typed;
    an address that has an account, held or not, is refused (`400`).

### Email: sign-up, addresses and passwords

What emailed links start ([email.md](email.md)). Every token travels in a request body, never in a URL, and every
answer about an address is the same whether or not it has an account:

| Route | What it does |
|---|---|
| `POST /api/auth/signup` | public, with sign-up on (`LAMPO_SIGNUP` `invite` or `open`): `{email, lang?}` with `invite`, `{name, email, password, lang?, plan?}` with `open` → `{ok: true}`, always, and no session (below) |
| `POST /api/auth/verify` | public: `{token, password?, new_password?, name?, lang?}` (`vt_…`; `lang`, the page's language, is what a new workspace's sample is written in) → `{kind: "confirmed" \| "changed", email, released, signedIn, user}` (below) |
| `POST /api/auth/verify/resend` | the confirm link again: signed in, `{lang?}` → `{ok, to}` (your unconfirmed or new address, masked); signed out, `{email, lang?}` → `{ok: true}` (a held sign-up gets its link; with `invite`, an invited address its invite) |
| `POST /api/auth/email/cancel` | signed in: drop the new address that waits for its link → `{user}` |
| `POST /api/auth/forgot` | public: `{email, lang?}` → `{ok: true}`, always; an active account gets a reset link that works for 60 minutes, a sign-up nobody confirmed its confirmation link instead (its page takes a new password too) |
| `POST /api/auth/reset/peek` | public: `{token}` (`rt_…`) → `{email: "m•••@example.com", expires}` |
| `POST /api/auth/reset` | public: `{token, password}` → `{user}` and a session cookie (below) |

Details:

- **Signing up.** Every answer sets a `vr_signup` cookie, a random value that tells nothing (or the one this browser
  has already, so a second sign-up here keeps the first's link signing in); a new held account keeps its hash, so its
  confirm link signs in this browser only. With `open`, a new account starts held (`unverified`, `signup`) and gets a
  confirm link (24 hours). With `invite`, no account is made: an address a pending invite names gets that invite again,
  and only the invite's link makes the account, with its role. An address that has an account gets a "you already have
  an account" email instead. A held one (someone's sign-up, or an invite someone took) gets its confirm link again when
  the password is the one it was made with, and this browser becomes the one the link signs in; with another password
  it gets a reset link instead. With `invite`, a held address also gets the pending invites made out to it. An address
  no pending invite names gets nothing. `404` when sign-up is off or the server can't email, `400` for a password or
  name that can't be used, `429` when asked too often. `plan` is what the website's sign-up link named
  (`cloud-solo`, `cloud-team` or `cloud-business`): a new account keeps it with its first run (through the confirm
  link) for Get started to offer; any other value is dropped without an error.
- **Confirming.** A held account (an open sign-up, or an invite someone took) is let in (`released`) and the browser
  signed in (`signedIn`) at once only in the browser that chose its password (its `vr_signup` cookie) or signed in as
  it. Anywhere else the answer is `409 {state: "password", email, joins}` (the address masked; each invite it would
  join: `workspace?`, `role`, `by`) and the link stays unused until the request carries `password`, the one the account
  was made with (`403` with the same details if not; limited per account), or `new_password`, which replaces it: the
  invites taken with the old one are left behind, and its tokens and apps end. Then this browser is signed in. When
  someone in a workspace it would join already goes by its name, the answer is `409 {state: "name", name}` and the link
  stays unused until `name` gives another; when a workspace it would join has no room left on its plan (Lampo Cloud),
  `402`, unused. A new address replaces the old one, which gets a notice (`kind: "changed"`). When someone else is
  signed in in this browser, the link answers `409 {state: "other"}` and stays unused. A link that can't be used
  answers `404 {state: "invalid"}`, `410 {state: "expired" | "used", confirmed?}`, or `409 {state: "stale"}` when the
  address changed meanwhile. A held invite's confirm link that comes after another account took the invite answers
  `409 {state: "invite"}`, unused.
- **A new password.** The reset sets it; ends every other session of the account, its API tokens, its connected apps
  (whoever had the password may have made them) and its push subscriptions; spends the link and sends a notice. The
  answer carries `Clear-Site-Data: "cache", "storage"`: this browser keeps nothing from before, only its new session. A
  password that can't be used answers `400`, and someone else signed in in this browser `409 {state: "other"}`, both
  without spending the link. Peeking or resetting with a link that can't be used answers `404` or `410 {state}`, and
  `409 {state: "stale"}` when it went to an address the account no longer uses.
- **Addresses** have one spelling ([email.md](email.md#details)): what is typed is kept in Unicode NFKC and
  lower case, the domain in its ASCII form without a trailing dot. A local part that isn't plain ASCII, an invisible
  character or anything the mailer can't send to answers `400` for a sign-up, an invite or a new address. Accounts
  made before sign in, and ask for links, with their addresses as they were typed.
- **Limits.** 20 asks per 15 minutes from one address, 5 an hour about one email address, and 30 wrong links per 15
  minutes from one address (then `429` with `Retry-After`). Without a public URL nothing is emailed: resending and
  *Forgot password* answer `404`.

Whether email and sign-up work on a server: `mail` and `signup` in `GET /api/info` ([System](#system)).

### The first run

The steps a new account learns by doing ([onboarding.md](onboarding.md)), and the sample:

| Route | What it does |
|---|---|
| `GET /api/onboarding` | the first run as it stands for you: `{onboarding, steps: [{id, done}], sample, video, can_sample, plan, invited_by}`. It records on your account the steps it finds done, from real state; an account from before the first run gets `onboarding: null` and no steps |
| `PUT /api/onboarding` | `{hidden?: boolean, dismissed?: boolean, setup?: "done", agent?}` (at least one): put the card away or bring it back (`hidden`), hide the card and the sidebar's row for good or bring them back (`dismissed`), the setup over (finished or skipped), the agent picked in it (`claude-code`, `codex`, `cursor`, `chatgpt`, `claude`, `other`, `none`); your own, people only (an API token gets `403`), `404` without a first run → the same answer |
| `GET /api/onboarding/folders` | the machine itself only (`404` for anyone else): folders that hold videos in a few likely places (`~/Movies`, `~/Desktop`, `~/Downloads`, the folder Add video browses from, and its projects' `out`, `renders` or `exports`) → `{folders: [{path, count, files: [{name, path, size, mtime}]}]}`, at most 6, newest first |
| `GET /api/onboarding/agents` | the machine itself only (`404` for anyone else): the agents installed here, found by looking, never run → `{found: [{kind: "claude-code" \| "codex" \| "cursor", version}]}` (`version` when a file says it, else `null`) |
| `POST /api/onboarding/sample` | the upload action: `{lang?: "en" \| "de"}` → `{slug, name, created}`. Makes the sample (two versions of Lampo's brand film with a few notes, [onboarding.md](onboarding.md#the-sample)), or hands back the one there is (`created: false`; asks while it is being made share that making, and only the one that started it says `created: true`). Making it is a job: `503` when the workspace's queue is full, `429` (with `Retry-After`) after 5 in 10 minutes per workspace |
| `DELETE /api/onboarding/sample` | the upload action: removes the sample for good → `{ok, removed}` (its slug, or `null` when there was none); `409` while it holds a version someone uploaded onto it (the sample takes no new versions: an upload by its id is `409`); `429` after 5 removals in 10 minutes per workspace |

`sample` and `video` are `{slug, name}` or `null`: the sample, and the newest video that isn't the sample (else the
sample), where the steps lead; the sample also names its fixed note while that waits for a check (`check`, else
`null`) and its agent's question (`question`). `can_sample` says whether you may make one. `plan` is the plan picked on
the website before signing up (or `null`), `invited_by` who invited you into this workspace (`{name, role}`, as they
are now; `null` when nobody did or they left). The steps follow your role, the machine, whether the workspace was made
at your own sign-up and who its videos are for ([onboarding.md](onboarding.md)); a new account's first run carries
`setup_due` until the setup is over (`setup_done`), and `agent` and `plan` when they were given.

## Workspaces

On a hosted server ([server-mode.md](server-mode.md#workspaces)); the app on a person's own machine is one workspace.

| Route | What it does |
|---|---|
| `GET /api/workspaces` | `{workspaces, enabled, create}`: the account's workspaces (`MyWorkspace[]`), whether this server has workspaces at all (`false` on a person's own machine), and whether you may make one |
| `POST /api/workspaces` | `{name}` → `{workspace}`: a new workspace with you as its owner; the session moves into it (who may: below) |
| `POST /api/workspaces/switch` | `{id}` → `{workspace}`: the session works there from now on (a new cookie, the same session) |
| `PATCH /api/workspaces/current` | owners and admins: `{name}` renames the current workspace → `{workspace}` |
| `PUT /api/workspaces/current/persona` | owners and admins, people only (`403` with an API token): `{personas, personaOther?}` says who the current workspace's videos are for → `{workspace}` |
| `GET /api/workspaces/current/badge` | anyone in the workspace: `{shown, hidden, may}` — whether its review links show *Powered by Lampo*, whether its admins hid it, whether its plan may hide it (a billing provider says: a paid plan) |
| `PUT /api/workspaces/current/badge` | owners and admins, people only: `{hidden}` → `{shown, hidden, may}`; hiding answers `402` unless the plan may (showing it again always works), `409` on a person's own machine |
| `GET /api/workspaces/current/deletion` | its owners, people only: what deleting the current workspace takes with it (`WorkspaceDeletionPlan`, as on [the operator's pages](#workspaces-and-plan-limits)) |
| `POST /api/workspaces/current/delete` | its owners, people only: `{name}`, typed as the workspace is called (else `400 {name: true}`) → `{deleted: true, account}` (below) |

Details:

- **Making one** needs a signed-in browser (`403` with an API token or on the machine itself) and answers `409` on a
  server without workspaces. Only whoever runs the server may ([the operator](server-mode.md#the-operators-pages);
  `403` for anyone else), unless
  `LAMPO_WORKSPACE_CREATE=anyone`: then each account makes at most `LAMPO_WORKSPACE_CREATE_LIMIT` (3, the workspace its
  sign-up gave it included; `403` past it). `create` in the list says whether you may now; `429` after 10 a day per
  account. A name is 1 to 80 characters.
- **Switching** needs a signed-in browser too. A workspace you aren't a member of, or one that doesn't exist, is a
  `404`.
- **Renaming** answers `409` on a server without workspaces.
- **Deleting** ([server-mode.md](server-mode.md#deleting-and-exporting)) is for an owner (an admin gets `403`), on a
  hosted server with workspaces (`409` otherwise), never for the server's own workspace (`409`). Everything it holds
  goes, its people are emailed, and accounts that worked nowhere else go with it: `account: true` when yours did (this
  browser is then signed out).
- **Who the videos are for**: `personas` is a list of `agency`, `inhouse`, `creator` and `other`, each once (an empty
  list clears them); `personaOther`, "something else" in a few words (at most 120 characters, kept on one line), only
  with `other`. The words, Get started's order and the role an invite starts with follow them. They show as
  `personas` and `personaOther` on the current workspace (`MyWorkspace`) only. `409` on a server without workspaces.

## OAuth for MCP clients

The app is the authorization server for its own `/mcp` ([server-mode.md](server-mode.md#apps-that-sign-in-oauth)),
hosted and on a person's own machine alike (there at the machine's own names, not through the tunnel).

| Route | What it does |
|---|---|
| `GET /.well-known/oauth-protected-resource` (also `…/mcp`) | RFC 9728: `{resource, resource_name, authorization_servers, scopes_supported, bearer_methods_supported}` |
| `GET /.well-known/oauth-authorization-server` | RFC 8414: the endpoints, `code_challenge_methods_supported: ["S256"]`, `client_id_metadata_document_supported`, `authorization_response_iss_parameter_supported` |
| `GET /oauth/authorize` | starts a sign-in and redirects to the consent screen, `/?consent#/oauth/<request>` |
| `GET /api/oauth/requests/:id` | what the consent screen shows (`OAuthRequestView`; `workspace`: where the app will act, on a server with several) |
| `POST /api/oauth/requests/:id` | the person's decision: `{allow, workspace?}` → `{redirect}` |
| `POST /oauth/token` | a code or a refresh token for an access token |
| `POST /oauth/register` | dynamic client registration (RFC 7591) |
| `POST /oauth/revoke` | revoke a token (RFC 7009) |
| `GET /api/auth/apps` · `DELETE /api/auth/apps/:id` | your connected apps in the current workspace (`PublicApp`); disconnect one |
| `GET /api/admin/apps` · `DELETE /api/admin/apps/:id` | owners and admins: the workspace's (admins don't see owners') |

Details:

- **Where an app acts.** In the workspace the person worked in when they allowed it (the session's current one), with
  their role there now, narrowed to its scopes. Once they leave that workspace, its tokens answer `401`.
- **Authorize** takes `response_type=code`, `client_id`, `redirect_uri`, `code_challenge` with
  `code_challenge_method=S256`, `state`, `scope` (left out: every scope) and `resource`. Any problem (an unknown client
  or redirect URI, a malformed request, PKCE, the response type, the resource, the scope, more than 120 a minute
  from one address, or more than 50 requests waiting for a consent made from one address in ten minutes; an IPv6
  address counts as its /64) goes to Lampo's own page, `/#/oauth/error?error=<code>` (`invalid_client`,
  `invalid_request`, `unsupported_response_type`, `invalid_target`, `invalid_scope`, `slow_down`), never to the app:
  its redirect URI
  hears only the person's decision. This redirect and the consent page answer `Cross-Origin-Opener-Policy:
  unsafe-none` (every other answer `same-origin`), so an app that runs the sign-in in a popup keeps its
  `window.opener` and hears the answer.
- **The consent screen's API** answers a signed-in browser or the machine itself, not a token or the LAN link. One
  decision per request: the redirect carries `code` (or `error=access_denied`), `state` and `iss`. `workspace` is the
  one the screen named (on a server with several, required to allow); when the session works elsewhere by now, the
  answer is `409 {state: "workspace", workspace}` and the request waits to be shown again.
- **Token** takes a form or JSON: `grant_type=authorization_code` (`code`, `code_verifier`, `redirect_uri`, `client_id`,
  `resource`) or `refresh_token` (`refresh_token`, `client_id`, optionally a narrower `scope` and `resource`). It
  answers `{access_token, token_type, expires_in, refresh_token, scope}`. An access token lasts an hour, a refresh
  token 60 days and is replaced with every use. More than 240 calls a minute from one address get `429 slow_down`.
- **Register** takes `{redirect_uris, client_name?, client_uri?, application_type?, token_endpoint_auth_method?,
  grant_types?, response_types?}` and answers `201` with `client_id` (and `client_secret` for a confidential client);
  30 an hour from one address.
- **Revoke** takes `{token, client_id}` and answers `200` whether the token was known or not. A refresh token ends its
  whole connection.
- Confidential clients authenticate with `client_secret_basic` or `client_secret_post`; every other client is public
  and uses PKCE. The token, registration and revocation endpoints and the metadata answer any origin (CORS, no
  cookies).
- Errors on the token, registration and revocation endpoints follow OAuth: `{error, error_description}` with
  `invalid_grant`, `invalid_client`, `invalid_scope`, `invalid_target`, `unsupported_grant_type`, ….
- **`lampo login`** signs in here as a client of its own, `client_id=vr` (no registration, no `scope` or `resource`):
  `redirect_uri` is `http://127.0.0.1:<port>/` or `http://[::1]:<port>/` exactly as written (never `localhost`, a
  path, a query or another host), `state` and PKCE S256 are required, `machine` names the computer (one line, at most
  64 characters) and `days` (1–3650) how long the token works. The consent screen's request carries
  `vr: {machine, days, token}` (`token`: the name it gets, `lampo on <machine>`). The code lives 2 minutes and is redeemed
  only at `POST /api/auth/token` with `{code, code_verifier, redirect_uri}` for an API token in the workspace the
  screen named, the same `lampo login --email` makes; a failed try uses the code up, a repeat also revokes the token it
  made, and more than 30 tries in 15 minutes from one address get `429`. `/oauth/token` never redeems it.

## Library and folders

| Route | What it does |
|---|---|
| `GET /api/library` | every video (counts, version, folder, agent, approval, agent status and `stage`; `sample: true` on the first run's sample) and the folders: `{videos, folders}`. `?slug=` (up to 200) for only those videos |
| `POST /api/library` | link a file on this machine: `{path, folder?, session?}` → `{created, video}`. From the machine itself only |
| `DELETE /api/library/:slug` | remove a video (below) |
| `POST /api/library/:slug/restore` | bring back a video that was archived when removed |
| `GET /api/search?q=&limit=` | the ⌘K palette's search (below) |
| `GET /api/browse?dir=` | the file browser behind Add video → Link a file on this machine. From the machine itself only |
| `GET /api/folders?video=` | the folder tree, plus a suggestion for a video on disk |
| `POST` · `PATCH` · `DELETE /api/folders` | create `{path}`, rename `{from, to}`, delete `?path=` |
| `POST /api/folders/auto` | file every unsorted linked video where it belongs (uploads are left as they are) |
| `POST /api/folders/archive` | archive a project: `{path}` (below) |
| `POST /api/folders/restore` | restore an archived project: `{path}` |
| `PUT /api/review/:slug/folder` | move a video: `{folder}`, or `null` for no project |
| `GET /api/folders/download/info?folder=&kind=` | what the folder's zip holds: `ArchiveInfo` (files, bytes, `resumable` once every checksum is ready) |
| `GET /api/folders/download?folder=&kind=original\|preview` | the folder and its subfolders as one zip, originals by default ([archive notes](#review-links)) |
| `GET /api/review/:slug/download/info?v=` | what a version's download will be: `VersionDownload` (`v`, `name` like `spot V3.mp4`, `bytes`, `url`); the newest without `v` |
| `GET /api/review/:slug/download?v=` | that version's own file, as it was uploaded or linked, as an attachment named so (below) |

Details:

- **The library** includes archived videos, marked `archived`. For a role without the agents action, the assigned
  agent's folder is left out (`session.cwd: null`), here and in the review routes below. It lists every video and
  folder of an archived project too: `archived_projects` says which projects are (`{name: {at, by}}`, absent while
  none is), and their videos carry `project_archived` (when). `GET /api/folders` and `GET /api/reviews` answer
  `archived_projects` as well.
- **Archived projects.** Owners and admins archive a project (a top-level folder; a folder inside one is a `400`) and
  restore it, signed in in the app: an API token gets `403`. Nothing is moved or deleted. While it is archived nothing
  new goes into it: a note, a reply, a status, a reference, a draft, a recording, an approval, final or reopen, a new
  version (an upload, an upload URL, a re-render of a linked file, which waits on disk until it is restored), a folder
  made, renamed, moved or deleted in it, a video or folder moved into it (`POST /api/library` too, before the video is
  added), a review link, a question with options, a request to its agent, an agent assigned or its status, a change,
  reference, suggestion or decision on the playbook of the project or a folder in it, a change, publish or retry of a
  post of one of its videos. Each is refused with `423` and one sentence, `{archived: "<project>", error: "the project
  \"<project>\" is archived: it is read-only until a person restores it"}`. Owners and admins can still move a video
  out (`PUT /api/review/:slug/folder`), signed in in the app (an API token gets `403`, as for restoring); removing a
  video, cancelling or deleting a post and downloading work as before. Its review links play watch only meanwhile
  ([sharing.md](sharing.md#what-a-link-allows)). Storage counts toward the plan as before.
- **Removing** needs the remove action, or being the one who added the video. A video with notes is archived and can
  be restored. A video without notes is deleted: its review and its stored copies, uploads included. A linked file on
  disk is never touched.
- **Search** answers a `SearchResponse`: `videos` (stage, poster), `folders` (video count) and `notes` (video, frame,
  timecode, author, status, kind; `reply` when a reply matched), best first, at most `limit` (1–20, default 8) of
  each. Every word must match; case, accents and German spelling (ä = a = ae) don't matter. Without `q` it lists the
  most recently changed videos. Archived videos never appear, and no disk paths do. What matches in an archived
  project comes apart, only for a query: `archived: {folders, videos}` (absent when nothing does).
- **Downloads** need the download action. The zip works like a folder link's ([below](#review-links)): `425` while
  previews are being made, `404` with nothing to download, and `429` with `Retry-After` while 2 downloads from the same
  address are already running. One version's file is asked for by the video and `v` only (any other query is a `400`):
  `404` for a version the video doesn't have, `410` when its bytes are gone or the video was removed (restored, it
  downloads again). With Bunny, S3 or a media host of its own the answer is a `302` to a signed URL that works for 5
  minutes (the media host names the file; a bucket's URL keeps its own name); otherwise the file streams with ranges,
  and a range that asks for the rest of the file gets all of it. Nothing is recorded, as for a folder's zip.
- **Folder paths** are `/`-separated names of at most 60 characters each. One named for a write — made, renamed to,
  moved into, uploaded into (tus or ticket metadata), asked on — is at most **12 levels and 400 characters**; more is
  a `400` that says which, never a path cut to fit, and a rename can't carry a subfolder past either. Every `folder` /
  `path` field and query takes at most 400 characters. A folder made before these limits keeps its path: it lists,
  opens, downloads, is renamed and deleted as before.

## Reviews and notes

| Route | What it does |
|---|---|
| `GET /api/review/:slug` | one video in full: `{review, summary, approvals, media, …}`, the notes file plus what the player needs. `summary.stage` is where it stands, `approvals` the decisions so far |
| `GET /api/reviews` | every review in full, each with its `stage` (what `lampo` and MCP read against a server) |
| `GET /api/review/:slug/prompt` · `/md` | the Copy for an agent text; review.md, with paths on this disk only for the machine itself (everyone else, and every caller of a hosted server, gets `/data/…` and `/api/review/…` URLs) |
| `POST /api/review/:slug/sync` | register a re-render now |
| `POST /api/review/:slug/comments` | a new note (below); both screenshots are grabbed |
| `GET` · `PATCH` · `DELETE /api/comments/:id` | read a note; change or answer it (below); delete it with its screenshots, voice clip, previews and references |
| `PATCH` · `DELETE /api/comments/:id/replies/:n` | change the words of your own reply, or take it back (below) |
| `POST /api/comments/:id/previews` | a fix preview: a still or a clip of the fix (below) |
| `GET /api/previews/:slug/:file` | a preview's bytes: stills through the server, clips ranged or redirected to signed storage URLs |
| `PUT /api/review/:slug/versions/:v/source` | where a version was rendered from: `{app, project?, comp?, start_frame?, fps?}`, `{}` clears. Only the project's file name is kept. Answers the version |
| `PUT /api/review/:slug/versions/:v/elements` | where the version's named elements are, frame by frame: an elements map as the JSON body (≤ 1 MB; the format is in [agents.md](agents.md#notes-that-point-at-elements-the-elements-map)). Checked whole: a bad one is a `400` saying what is wrong, and the version keeps the map it had. Needs `upload` (API tokens too). Answers `{v, elements, keys, scaled_from?}` |
| `GET /api/review/:slug/elements` | what the video's notes point at in their versions' maps: `{notes: {<id>: {elements: [ids], near?}}, names: {<id>: name}}` (notes that point at nothing are left out) |
| `GET /api/review/:slug/part?v=&in=&out=` | the stretch a partial render of frames `in`–`out` would cover (below) |
| `POST /api/voice` | a voice note's raw audio (webm, mp4, ogg, wav) → `{id, transcript, whisper}`; pass the id as `voiceId` |

**A new note** (`POST /api/review/:slug/comments`). Every field is optional:

| Field | Means |
|---|---|
| `frame`, `v` | where; the newest version by default |
| `range: {in, out}` | about a stretch, both frames included; a range past the version's end is refused |
| `scope: "video"` | about the whole video: frame 0, no screenshots |
| `text`, `tags`, `drawing` | the words (20,000 characters at most; may be empty), tags (the first 12 are kept), the shapes in video pixels |
| `severity` | `must`, `should` (the default), `nice` or `idea`: kept for feedback only |
| `kind` | `feedback`, `question` or `info`; `question` by default when `by` is an agent |
| `choices` | a question's likely answers: 2 to 4, 80 characters each at most; kept on questions only |
| `text_edit: {from, to}` | change the words heard in the range: `from` as heard (not empty), `to` as wanted (empty: cut them). `text` may then be empty |
| `part: {in, out, …}` | allow an agent to render only these frames ([partial renders](agents.md#partial-renders-only-when-a-note-says-part-render-ok)); snapped to the shots again on the server, handles 12 by default |
| `voiceId`, `voiceTranscript` | a voice note from `POST /api/voice` |
| `refs` | links and moments of videos, 8 at most ([References on notes](#references-on-notes)) |
| `by` | `agent:<name>`, for an agent's own notes (below) |

**Changing a note** (`PATCH /api/comments/:id`) takes `{status?, note?, text?, text_edit_to?, tags?, severity?,
fixed_in_v?, preview?, ack?, by?}`:

- `note` alone is a reply. With a `status` it goes with the change (the fix, the reason, the answer).
- `status`: `verified` and `open` need the verify action, `fixed` and `wontfix` the resolve action (and so does
  `fixed_in_v`). With an API token, `fixed` and `wontfix` on a final video answer `409` until it is reopened; people
  in the app aren't held.
- `text`, `tags`, `severity` and `text_edit_to` (what a note that changes the words now asks for) need the note's author
  or the edit-notes action.
- `preview`, with `fixed` or `verified`: the fix preview it refers to. Verified with one means checked on the preview
  only.
- `ack: true`: the reviewer checked the new version and it is still wrong (the verify action).

**Your own reply** (`PATCH /api/comments/:id/replies/:n`, `{at, text}`; `DELETE …/replies/:n?at=`): `n` is the
reply's place in the note's `replies` (from 0), `at` the time it was written, so a thread that moved since it was read
(a reply above it deleted) answers `409` instead of changing another. Only its author may (by account, by name for older
replies; no role changes someone else's words: `403`), with an API token as with the person's own notes. Only a plain
reply changes: a status change, picks from options and a fix preview stay as they happened (`409`), and a reply that
brought references can't be deleted while they're on the note. An edit keeps `at` and sets `edited`; agents read the
reply as it is now (`↳ Sam: … (edited)`) and the change as an `edit` event with the reply (`EDITED REPLY …`), a deletion
as a `delete` event with it (`DELETED REPLY …`; the note stays). Review links' visitors can't change replies. → the note

**A fix preview** (`POST /api/comments/:id/previews`, the resolve action) takes `{kind: "still" | "clip", frame?,
source?: {app, project?, comp?, time?}, fixed?, note?, by?, data?}`:

- With `data` (base64, 8 MB at most) it answers `{preview, comment, slug}`. Without it, `{upload: {url, expires}}`: a
  one-time URL that takes one `PUT` of the file (200 MB at most), like [upload tickets](#uploads-tus).
- Stills are PNG, JPEG or WebP; clips are 10 s at most and kept as H.264 mp4. Both keep the newest version's frame
  shape. A refused file answers `422` with the reason.

**A partial render's stretch** (`GET /api/review/:slug/part`): `out` defaults to `in`. The answer is a
`PartSuggestion`, `{v, part: {in, out, shot, to_shot, handles}, whole, shots}`, snapped to version `v`'s shots
(`whole`: the video is one shot). The shots are found once per version in the background: `{pending: true}` until
then, `{none: true, error}` when they can't be.

**Who wrote it.** Agents label their own writes with `by: "agent:<name>"`. It counts only when the caller's role has the
agents action; otherwise, and for any other value, the caller's own name is used.

### Drafts

A person can keep notes as drafts (**Save**) and send them later (**Send**). Drafts are only ever their author's, in the
app: they are never in `review.json`, events, INBOX.md, `lampo`, MCP, review links or any count. An API token (even the
author's own) gets `403`, and anyone else's draft is a `404`.

| Route | What it does |
|---|---|
| `GET /api/review/:slug/drafts` | your unsent notes on this video (`DraftsResponse`: notes with `draft: true`, oldest first) |
| `POST /api/review/:slug/drafts` | Save: the same body as a new note (screenshots and voice note too), kept as a draft; 200 per person and video at most |
| `PATCH` · `DELETE /api/review/:slug/drafts/:id` | change `{text?, tags?, severity?, text_edit_to?}`; delete it with its files |
| `POST /api/review/:slug/drafts/:id/refs` · `DELETE …/refs/:ref` | references on a draft, as on a note (without `note`: drafts have no replies) |
| `GET /api/review/:slug/drafts/:id/:file` | a draft's screenshot or voice note |
| `POST /api/review/:slug/drafts/send` | send your drafts: `{ids?, recordings?, start?}` → `DraftsSent {notes, left, error?, run?}` (below) |
| `GET /api/drafts` | how many notes you haven't sent, per video: `{videos: {<slug>: n}}` |

Saving, changing and deleting a draft writes no event. **Sending** turns your drafts (all, or `ids`; with
`recordings`, your heard recordings' drafts too: `true` for all of them, or a list of their ids `d_…`, the rest staying
with their recording) into ordinary notes in one write. One draft alone is `{ids: [id]}`, or `{ids: [], recordings:
[id]}` for a recording's; that is how each draft gets its own Send. It is one batch of `comment` events, in
the order they were saved (then said). Each note is created now, on the newest version if one arrived meanwhile.
`start` (the agents action, from the machine itself, checked before anything is sent) starts the video's agent once
for the batch.

### Recorded feedback

A reviewer's recording (⇧R in the player) waits on the server until it is sent or discarded. Like drafts, recordings
are only ever their maker's, in the app: an API token (even the maker's own) gets `403` from every one of these routes,
and anyone else gets `404`.

| Route | What it does |
|---|---|
| `GET /api/review/:slug/recordings` | your recordings of this video that wait to be sent (`RecordingsResponse`: id, v, state `uploading` · `hearing` · `ready` · `failed`, duration, drafts) |
| `POST /api/review/:slug/recordings` | a new recording's event log: `{v, duration, events}` |
| `PUT /api/review/:slug/recordings/:id/audio` | its audio, raw (webm, mp4, ogg, wav; 64 MB at most, once) |
| `PATCH /api/review/:slug/recordings/:id` | `{drafts}`: the drafts as the person edited them |
| `POST /api/review/:slug/recordings/:id/send` | every draft (or `{ids}`) becomes an ordinary note → `{notes, left, error?}` |
| `POST /api/review/:slug/recordings/:id/hear` | hear a `failed` recording again |
| `GET …/recordings/:id/audio` · `DELETE …/recordings/:id` | its audio; discard it |

Details:

- **Events** (`RecordingEvent` in `lib/types.ts`): `frame`, `play`, `pause`, `seek`, `pointer` and `click` (0–1 over
  the picture), and `stroke` (a shape on a frame), each with its second `t` on the recording's clock. 600 s and 40,000
  events at most; `409` without speech-to-text; 60 recordings an hour per person.
- **The audio** is heard in the background; a `recording` event says when the drafts are there. Edited drafts keep
  their frames inside the version and their shapes cleaned.
- **Sending** gives each note its clip of the audio and `recording: {id, t0, t1}`. Drafts that fail stay; the recording
  goes once nothing is left.

## Options before a render

A question that offers groups of options to audition and pick (lib/options.ts): on a video it is a note
(`Comment.options`, `scope: "video"`, `kind: "question"`), before any render a question on a project or folder
(`data/asks.json`). Never on review links. All of them answer 404 for an id of another workspace.

| | |
|---|---|
| `POST /api/asks` | (`comment`) `{video? \| folder?, text, options: [{id, label?, pick?: "one" \| "many", items: [{id, label?, ref?}]}], answer_prompt?, by?}` — exactly one of `video` (a slug) and `folder`. Ids `[A-Za-z0-9][A-Za-z0-9_-]{0,23}`, unique; 1–8 groups of 2–9 items, ≤ 48 in all, ≤ 8 of them moments (`frame`). `ref`: `{kind: "link", url}`, `{kind: "frame", video, v?, frame, to_frame?}` or `{kind: "file", data?}` (base64 ≤ 8 MB; without `data`, an upload URL comes back for it — handed out before the question is written, so a `429` for too many open URLs leaves no question behind). A file without pictures is a sound (WAV, MP3, M4A, OGG, WebM; PCM, MP3, AAC, ALAC, FLAC, Vorbis, Opus or AC-3; ≤ 60 MB, ≤ 180 s, ≤ 192 kHz, ≤ 8 channels — a clip's sound too —, read from its header before anything decodes it, else 422): re-encoded to AAC in m4a without the file's tags and measured once (`loudness: {i, tp?}`, LUFS and dBTP; no `tp` when the peak couldn't be read); pictures and clips as references are. Files are worked on one at a time in the server's job queue, each ffmpeg run with a time limit; a hosted workspace whose queue is full answers `503` + `Retry-After`, and nothing is kept. A folder that doesn't exist is made for a role that may `organize`, else 422. A question on a folder is refused with `409` while 200 wait in the workspace, or when the questions waiting fill its file (8 MB: answered ones make room first). An item's upload URL used once the question is answered or closed answers `409`; the item stays as it was. → `AskCreated {id, slug, folder, uploads: {"group/item": {url, expires}}}` |
| `GET /api/asks` | the questions asked on folders (open first, newest first; answered ones a month, the oldest sooner when the workspace's file is full): `{asks: FolderAsk[]}` |
| `GET /api/asks/:id` | one, a note's or a folder's, as the audition reads it: `AskView {id, slug, name, folder, v, text, options, answer_prompt, status, author, created, replies, files: {<ref id>: {src, still}}, level: "gain" \| "volume"}` (`level`: whether the files are this server's, so the page may raise as well as lower a sound, or a bucket's) |
| `POST /api/asks/:id/answer` | (`comment`, and `verify` as for any answer) `{picks: {<group>: [<item>…]}, note?, by?}`: checked against what the question offers (one item in a `one` group; unknown ids 400; nothing picked and no note 400). The question is answered — a `status` event with the reply `{text: "PICKED voice=v3 music=- · note: \"…\"", answer: {picks, note?}}` — or, answered already, a `reply` event with the new picks; past 50 answers `409` (ask a new question). With an API token the answer is its person's, as with `PATCH /api/comments/:id` (`status: verified`, a reply): intended — an agent may answer for the person it acts for; sign-off (approvals, final) stays a person's. → the `AskView` |
| `POST /api/asks/:id/close` | (`comment` + `verify`) Done without an answer: `verified` with an empty reply |
| `DELETE /api/asks/:id` | (`comment`) its author's, or a role with `edit-notes`; with its files |
| `GET /api/asks/:id/files/:file` | an item's file, only one its items carry: sounds and clips ranged (or redirected to the bucket), pictures through the server |

## Status and sign-off

Where every video stands, and the steps that move it ([workflow.md](workflow.md)):

| Route | What it does |
|---|---|
| `GET /api/status` | `StatusResponse`: every video (slug, name, project, folder, version, poster hash, size, updated and the full `stage`; newest first), the `folders` (each top-level folder, `null` = no project, last: `counts` per stage and `total`) and `counts` per stage. Archived videos are left out |
| `PUT /api/review/:slug/approval` | the team's decision: `{status: "approved" \| "changes", note?, v?}`, or `{v?}` to withdraw it (the newest version by default) |
| `POST /api/review/:slug/approval/carry` | `{from?}`: carry an older version's approval (the newest approved one by default) over to the newest version, as the team's → `{approval, stage}` |
| `PUT /api/review/:slug/final` | `{v?, note?, confirm?}`: mark a version final (the newest by default) → `{final, stage}` |
| `DELETE /api/review/:slug/final` | `{note?}`: reopen → `{final: null, stage}`; `409` if the video isn't final |

Details:

- **Carrying over** answers `409` when there is nothing to carry over, when the version diff finds a change ("v4 is not
  identical to v3 (2 changes): review it instead"), or when a newer version arrived meanwhile.
- **Final** answers `404` for an unknown version, and `409 {error, open, needs_confirm: true}` while required notes are
  open and `confirm: true` isn't sent. It answers `409` even with `confirm` while a fix was checked on a fix preview
  only (render the next version first), and for a partial render, which is never final.
- **Who may.** Decisions need the approve action (carrying over too); final and reopen need finalize, which reviewers
  don't have. All four are people's decisions: with an API token (an agent, a script) they answer `403`. On a final
  video nothing changes for agents either: with an API token, `PATCH /api/comments/:id` to `fixed` or `wontfix`, and
  a fix preview with `fixed: true`, answer `409` ("… is final (v3, by alex): nothing to fix until the reviewer reopens
  it") until it is reopened.

## Publishing

Posts of a final video to YouTube, Instagram and Facebook, and the publish kit ([publishing.md](publishing.md)). Drafts
and the kit need `post` (members and up, agents too); connections and publishing need `publish` (owners and admins) and
are `PERSON_ONLY`: an API token gets `403 {person: true}`. Every id of another workspace is a `404`. No answer ever
carries a key, a client secret or a token.

| | |
|---|---|
| `GET /api/publish/connections` | (`post`) `ConnectionsResponse {connections: [{id, kind: "youtube" \| "zernio", label, state: "needs_auth" \| "ready" \| "error", error?, platforms, accounts: [{id, platform, name, detail?}], key_hint, redirect_uri? (YouTube), audited? (YouTube), holds_schedule, created, by, checked?}], hosted}` |
| `POST /api/publish/connections` | (`publish`, person) `{kind: "youtube", label?, client_id, client_secret}` → `needs_auth`; `{kind: "zernio", label?, api_key}` → checked at once (`ready` with its Instagram/Facebook accounts, or `error` with the reason). At most 20 per workspace |
| `PATCH /api/publish/connections/:id` | (`publish`, person) `{label?, audited?, client_id?, client_secret?, api_key?}`: a new YouTube client needs the sign-in again; a new key is checked |
| `DELETE /api/publish/connections/:id` | (`publish`, person) removed with its secret; a YouTube sign-in is revoked at Google first. Posts keep their history |
| `POST /api/publish/connections/:id/check` | (`publish`, person) asks the platform again: its accounts, or why not. 30 checks and sign-ins per 10 min per workspace (429) |
| `POST /api/publish/connections/:id/authorize` | (`publish`, person) YouTube: `{url}` of Google's sign-in (code + PKCE, a state good for 10 minutes, once, for this person in this workspace) |
| `GET /api/publish/oauth/callback` | (`publish`, person) where Google sends the browser back: exchanges the code, checks the channel, then `303` to `#/settings/publishing?connected=<id>` or `?publish_error=expired \| denied \| failed \| gone \| check` |
| `GET /api/posts?slug=` | `PostsResponse {posts: PostView[]}` — every post of the workspace, or a video's |
| `GET /api/review/:slug/posts` | the video's posts |
| `POST /api/review/:slug/posts` | (`post`) `{platform: "youtube" \| "instagram" \| "facebook" (or yt, ig, fb), connection?, account?, title?, description?, tags?, cover_frame?, visibility?, schedule_at?, ai_generated?, youtube?: {category?, made_for_kids?}, instagram?: {kind?: "reel" \| "feed", share_to_feed?}, by?}`: the draft of the final version for that platform, made (`201`) or changed (`200`). Not final: `409 {error, next}`. Published already: `409` |
| `PATCH /api/posts/:id` | (`post`) the same fields; a failed or cancelled post becomes a draft again (a person's only: an API token gets `403`); queued, sending, scheduled or posted: `409` |
| `DELETE /api/posts/:id` | (`post`) a draft; a failed or cancelled one too, by a person (`403` for an API token); one that went out before (`remote_id`): `409`, kept |
| `POST /api/posts/:id/publish` | (`publish`, person) `{confirm: {platform, account, digest}, again?: true}` — what the person confirmed: the platform and account, and the post's `digest` as they saw it (every field that goes out); the post must still be that (`409` otherwise, also after anyone's edit since). Refused with `409` and the reasons while the video isn't final or anything blocks (`problems` with `level: "block"`, including the required answers). A post that went out before (`remote_id`, or `sent`) only with `again: true`: `409` says what Lampo knows of it. → `queued` |
| `POST /api/posts/:id/cancel` | (`publish`, person) a queued or failed post → `cancelled` (→ `sent` when a try before got as far as the post: it may be out); one sending → `409`; one YouTube holds → `409 {error, next: <YouTube Studio URL>}` |
| `POST /api/posts/:id/retry` | (`publish`, person, the plan's gate) `{again?: true}`: a failed post that never reached the platform → `queued`; one the platform holds (`remote_id`, failed or `sent`) → `uploading`, and the queue asks the platform where it stands — nothing is sent; a `sent` post without an id → `409` unless `again: true` (sent again, a new round) |
| `GET /api/posts/:id/cover.jpg` | the cover frame as a JPEG (`404` without one) |
| `POST /api/posts/:id/kit` | (`post`) `202` + `KitInfo`: the kit is made in the background (a job like any other: `503` while the workspace's job queue is full) |
| `GET /api/posts/:id/kit` | (`post`) `KitInfo {state: "making" \| "ready" \| "failed" \| "none", error?, files: [{name, bytes, kind}], made?}` |
| `GET /api/posts/:id/kit/:file` | (`post`) one of the kit's files (`attachment`), only names it lists; `kit.zip` streams all of them |

A `PostView` is the `Post` (id, slug, video_id, v, render, platform, connection, account, the fields above, state,
created/by/by_id, updated, published_by/_at, remote_id, url, locked, error, attempts, next_try, progress, file,
history) plus `problems` (`{field, level: "block" \| "warn", code, message, vars?}`), `video`, `connection_label`,
`account_name`, `holds_schedule`, `studio_url` (YouTube), `kit` and `digest` (a hash of every field that goes out; the
publish confirmation carries it). `history` has every edit with who made it (`{state: "draft", by, note: "changed:
title, description"}`, one line while one person keeps editing). SSE: `posts` `{slug}` and `connections` on every
change; a video's stage carries `published` (`StageInfo.published`).

## Insights

| Route | What it does |
|---|---|
| `GET /api/insights?period=&tz=` | `Insights` across the library, for the Insights page (feedback notes only; below) |
| `POST /api/review/:slug/watch` | what a signed-in person's player played: `{v, seen, plays?, secs}` → `204` |
| `GET /api/review/:slug/audience?v=` | `VideoAudience`: who watched the video (below) |
| `GET /api/taste?video=\|folder=\|project=` | the taste file agents read before they render: `{scope, markdown, stats}`; without a parameter, across all videos |

**`GET /api/insights`.** `period` is `7d`, `30d` (the default), `90d` or `all`; `tz` is the viewer's
`Date.getTimezoneOffset()`. The answer's `board` is what the page shows. The page asks why a video takes so many
versions to approval; a *round* is one full version to the next (a partial render is a quick check, not a round), and
each of the parts below compares with the period of the same length before it (`before`; `null` for all time):

- `toApproval`: versions to approval of the videos approved in the period: `mean`, `median`, `n`, `before`, `target`
  (3: the page's target line), `minApprovals` (3: the page speaks of a figure from there), `projects` (per top folder,
  `""` = none, the most first: `mean`, `median`, `n`, and `open` videos with the version they are on, `openMean`) and
  `open` (videos not approved that moved in the period: `videos`, `mean`).
- `causes`: what caused the rounds that ended in the period. A round's causes are the people's notes written since the
  version before and the notes reopened as still wrong meanwhile, by topic: a note's tags (not `idea` or `love-it`),
  else the topic its words suggest (`lib/autotag.ts`). `rounds`, `withNotes`, `untagged` (rounds whose notes had no
  topic), `severity` (rounds by their most severe note), `minRounds` (3), `before` (`rounds`, `withNotes`, `top`) and
  `topics`, the most rounds first: `tag`, `rounds` and `share` (of `withNotes`; a round with two topics counts for
  both), `notes`, `must`, `back` (notes that came back), `scope` (the playbook a rule goes into: the project when all
  its rounds were in one, else `""` = the House), `covered` (a rule there or above names it) and `examples`.
- `stillWrong`: fixes reopened as still wrong in the period (`count`) of the fixes made in it (`fixes`), by `topics`
  (each with the `agents` whose fixes came back and its newest note as `example`: `id`, `slug`, `video`, `v`, `frame`,
  `text`, `reason`, `at`) and by `agents` (`name`, `kind`, `n`, `topics`, `example`); `before`.
- `turnaround`: rounds that ended in the period: `rounds`, `median` hours per round, `parties` (each party's median
  hours in a round: `you`, `agents`, `client`), `share` (each party's share of all the rounds' time) and `before`.
- `firstTime`: all agents' first fixes checked in the period: `checked`, `right` (before any "still wrong"), `rate`,
  `before`.
- `watching`: who watched what in the period, the team and review-link visitors alike (the page shows the clients). A
  client viewer also has `v` (the version they watched last), `vWatched` (the share of it), `link` (the review link's
  label), `plays` (how often each hundredth played for them) and `again` (their stretch watched again and again, or
  `null`). `videos` (per video: `viewers` with `kind` person or client, `name`, `sessions`, `secs`, `watched` of the
  newest version and `you` for the account asking; `views`, `secs`, `completion`; `heat`, how many viewers played each
  hundredth of the newest version (of `seenBy`); `plays`, how often each hundredth played; `rewatched`, stretches
  `{from, to, plays}` in hundredths; `duration` in seconds; `seenV`, the newest version anyone watched; and
  `retention`, 100 shares of the viewers per hundredth), `people` (per person: `videos`, `views`, `secs`, `top`,
  `you`), `unopened` (review links nobody opened), `viewers`, `views` and `secs`. A viewer's `sessions`, `secs` and
  `views` are their totals on the video, counted when their latest sitting falls in the period. An API token is never
  `you`.
- `flow`: whom videos waited on in the period (the page shows `stuck`). `hours`, `videos` and `perVideo` for `you`,
  `agents` and `client`, from each video's history replayed (approved work nobody has to move waits for no one);
  `rounds`, the version videos were approved on; `stuck`, what waits longest now (`waitingOn`, `hours`, `label` = the
  stage's next step, `kind`, `agent`: the agent assigned, whom the page's *Nudge agent* sends a request to).
- `agents`: per agent, over the period's fixes: `kind` (its agent kind, from a video it is assigned to, else an
  agent connected under that name; absent when neither says), `fixes`, `checked`, `right` (first fixes that looked
  right when checked, before any "still wrong"), `rate`, `fixHours` (median), `questions`, `wrongTopics`.
- `repeats` (no longer on the page; kept for API users): topics (tags) on 3 or more notes by people in the period, not
  agents or clients: `tag`, `count`, `videos`, `scope` (the project when all are in one, else `""` = the House
  playbook), `covered` (a rule there says it already), `examples`.

The answer keeps older parts for API users:

- `board.speed`: `fix` (median hours from note to fixed, by when fixed), `check` (fixed to verified), `renders`
  (average version number at approval) and `cameBack` (the share of the period's fixes that were reopened, `count` of
  `of`). Each has `value`, `n`, `before` (the period of the same length before; `null` for all time), `change`
  (relative: `-0.4` = 40 % less; `null` unless both periods have `minPoints`, 5) and `spark`: one value per bucket,
  oldest first, `null` without data. Buckets are whole days in the viewer's time zone, back from the next midnight
  (`sparkEnd`) and clipped to the period, so 7 days have 8. Also `days`, `from`, `bucketDays`, `minPoints`.
- `board.patterns`: `notes` and `tagged` in the period, and `topics` (by count, up to 3 `examples` each: `id`, `slug`,
  `video`, `v`, `frame`, `timecode`, `text`) only when at least 30 % of the notes are tagged (`minCoverage`; `idea` and
  `love-it` are kinds, not topics), plus `severity`.
- `board.projects`: per top folder, `videos`; `notes`, `renders` and `approved` in the period; `open` now.
- `board.attention` (deprecated: the inbox's "stalled" items are these, minus fixes to check): up to 8 videos that need
  someone now, whatever the period. Videos with fixes to check, 2 or more fixes that came back and aren't settled, 4 or
  more versions without approval, or nothing for 48 hours (never approved or final). Each has a `reason` with `count`,
  `waitingOn` (`you`, `agents` or `client`), `waitingHours`, `verify` (the fix check mode opens at), `agent` (whom a
  nudge goes to) and `hash` (the poster). `attentionTotal` counts them all.
- The older all-time `totals`, `tags`, `severity`, `status`, `perRender`, `turnaround` and `projects`.

**Watching.** The player reports every 15 s while it plays, on pause and when the page goes away, like a review link's
progress report: `seen` (25 hex digits: which hundredths of version `v` played), `plays` (100 counts) and `secs`. It is
kept in `data/<slug>/views.json` for the signed-in account. With an API token the answer is `204` and nothing is kept
(agents don't watch). `404` for an unknown version; 12 reports a minute per person and video.

**Audience.** `viewers` (the team and review-link visitors: `kind`, `name`, `link`, `v`, `watched`, `secs`, `sessions`,
`total_secs`, `total_sessions`, `first`, `last`), and for version `v` (default: the newest anyone watched)
`retention`, `plays` and `rewatched`. Each viewer has one record, for the newest version they watched.

## Media and analysis

| Route | What it does |
|---|---|
| `GET /media/:slug/v:v` | the playable bytes of a version (range requests; below) |
| `GET /api/poster/:slug.jpg` | the poster |
| `GET /api/sprite/:slug.jpg?h=&s=` | the newest version's hover-scrub sprite: 24 frames in a 6 × 4 grid (below) |
| `GET /api/waveform/:slug/:v` | one peak and RMS value per frame |
| `GET /api/review/:slug/frame?frame=&v=[&size=thumb]` | one exact frame as PNG; `size=thumb`: a JPEG at most 320 px on its long side (an Auto-check finding's picture); `503` + `Retry-After` while the workspace's places for pictures are taken, `429` + `Retry-After` past 200 frames nobody asked for before in ten minutes per account |
| `GET /data/:slug/:file` | a note's screenshots and voice notes |
| `GET /api/analysis/:slug/:v` | loudness and freezes |
| `GET /api/diff/:slug/:v` | what changed from the version before |
| `GET /api/qa/:slug/:v` · `POST …/rerun` | Auto-check: a `QaResult` (below); check again (the qa action) |
| `POST /api/qa/:slug/dismiss` | `{key, v?}`: dismiss a suggestion (the qa action) → `{ok}`. With `v` it is *That's intended*: where it was in that version is kept, and the same stretch stays dismissed in later versions |
| `POST /api/qa/:slug/accept` | `{key, v?}`: turn a suggestion into a note (the comment action) → the note |
| `GET /api/tracks/:slug` | project tracks found next to a linked file (Remotion `timeline.json`, `words.json`) |
| `GET /api/review/:slug/transcript?v=` | what is said in a version (below) |
| `GET /api/review/:slug/transcript.srt?v=` · `.vtt` | the lines as captions (an attachment); `409` while it is heard, `404` when there is none |
| `POST /api/review/:slug/transcript/rerun?v=` | hear it again (the qa action): forgets the kept transcript or a failure. `?language=sv` hears it in that language |

Details:

- **Playback.** `?s=1` serves the scrub copy. With Bunny (a pull zone) or S3 storage (unless `presign: false`), or a
  media host of its own (`LAMPO_MEDIA_ORIGIN`, [below](#the-media-host)), the answer is a `302` to a signed URL that
  works for 6 hours; a review link's (`/media/g/…`) works for 5 minutes, and the player asks for a fresh one when one
  stops working and plays on from the same frame. `425` while a copy the browser can play is being made, `410` when
  the version's bytes are gone.
- **Work in the background.** Analysis, diff and Auto-check answer `{pending: true}` while the work runs: watch for
  the matching event and ask again. Diff and Auto-check answer `{none: true, error?}` when there is nothing to compute
  (no version before, the bytes are gone); analysis answers `410` when the bytes are gone. An Auto-check that ran and
  couldn’t read the version answers `{none: true, failed: true, error}` (its event is sent too) and isn’t started again
  by asking: `POST …/rerun` tries it once more.
- **Freezes** (`Analysis.freezes`, `FreezeScan` in `lib/types.ts`): stretches where neither the picture as a whole nor
  any patch of it moves, each with `motion` — how the picture moves at its edges and inside it (`HoldMotion`). A scan
  by older rules (another `v`, or none) is made again on the next request; until then the answer is pending.
- **Auto-check** items (`QaResult.items`) have `key`, `kind`, `severity`, `tags`, `frame`, `range?`, `text`, `detail?`,
  `box?` and `zone?`. They may also carry `likely` (`intended` or `problem`: a freeze judged by the motion at its
  edges, its sound and its shot), `why` (what flagged it), `holds`, `word`, `guess`, `line` and `value`; a result has
  `spelling`. A finding's picture is `GET /api/review/:slug/frame?size=thumb`. Accepting answers `404` when the
  suggestion isn't in the current result.
- **The sprite** is laid out by `lib/sprite.ts` (`spriteUrl()`); `s` is the layout version, so a new layout isn't
  served from old caches. It is made on the first request, as the least urgent background job: `202 {preparing: true}`
  with `Retry-After` until then, `404` if it can't be made.
- **The transcript** answers `{state: "ready", v, transcript}` (`Transcript` in `lib/types.ts`: `words` and `lines`
  with seconds `t0`/`t1` and frames `f0`/`f1`, `language`, `engine`, `timing` `word` or `line`, and `repairs` where
  stretches were heard again), `{state: "pending", v}` while it is heard (a `transcript` event says when it is done),
  `{state: "off", v, error?}` without a speech engine (or when the bytes are gone), or `{state: "failed", v, error}`. A
  version is heard once per its bytes, after the analysis in the job queue, in the language it detects.

### The media host

With `LAMPO_MEDIA_ORIGIN` set ([server-mode.md](server-mode.md#a-host-of-its-own-for-video)), a second host name of the
same server answers video by signed URLs, and nothing else:

| Route (on the media host only) | What it does |
|---|---|
| `GET /media/s/:sealed/:name` | a file: a version, its scrub copy, a fix preview's or reference's clip, a question's clip or sound; ranges, `Content-Disposition` for a download (whose ranges run to the end asked for) |
| `GET /media/z/:sealed/:name` | a folder's zip (the team's, or a review link's: the link is asked again when it starts) |
| `PUT` · `GET /api/uploads/direct/:ticket` | one-time uploads, as on the app host |
| `GET /healthz` · `/readyz` · `/robots.txt` | as on any host |

- `:sealed` is the whole credential: AES-256-GCM under a key derived from the store's secret, so it names no video,
  folder or workspace and can't be changed. Its end is rounded up to the minute (5-minute URLs) or the hour (6-hour
  URLs), so the same file asked for again within that step gets the same URL. `:name` is only the file's name.
- `403` once a URL has ended or when it was changed, `410` when the file is gone, `404` for every other path and on
  any other host. No cookie is read or set there; answers carry `Cross-Origin-Resource-Policy: cross-origin` and
  `Access-Control-Allow-Origin` with the public URL's origin.
- `GET /media/:slug/v:v`, `/media/g/…`, downloads, `/api/folders/download` and `/api/g/:token/archive` answer `302`
  to it instead of streaming the bytes themselves.

## Footage search

Shots from the workspace's own videos, each with its exact in and out frames ([footage.md](footage.md)). The answers
are `FootageAnswer` and `FootageStatus` in [`lib/footage/types.ts`](../lib/footage/types.ts); a shot's `file` (the
render on this disk) is only for the machine itself.

| Route | What it does |
|---|---|
| `GET /api/footage/find?q=&aspect=&min_s=&max_s=&motion=&text=&said=&limit=` | (view) the shots that fit the request, best first: `FootageAnswer` (what the request was read as, the shots, how many were looked at, how far the index is). `q` is the request in words (≤ 500), `aspect` `16:9`, `9:16` or `1:1`, `motion` one of the moves in footage.md, `limit` 1–50 (default 6) |
| `GET /api/footage/sheet?ids=s1,s2` | (view) one labelled contact sheet of one to nine shots by id, as a JPEG; `404` when none of them is in the workspace's index |
| `GET /api/footage/status` | (view) `FootageStatus`: on or off (and why), videos, indexed, waiting, failed, shots, the model and whether it is downloaded (`download`: 0–1 while it is) |
| `PUT /api/footage/settings` | (admin) `{on}`: the workspace's switch → `FootageStatus`; turned on, every video is queued; `409` for turning it on while footage search is off for the whole server |

A video's index changing is the `footage` event ([Live updates](#live-updates)).

## Playbooks

What the team decided before a render ([playbooks.md](playbooks.md)). A playbook is named by `folder` (a folder path;
empty or left out: the House) or by `video` (a slug: that video's folder).

Everyone signed in reads them. Writes and decisions need the playbook action **and a person in the app**: with an API
token they answer `403` (agents suggest instead). Suggesting needs the comment action. Review links never reach these
routes. Every change broadcasts `playbook` (`{scope}`) on `/api/events`.

| Route | What it does |
|---|---|
| `GET /api/playbooks` | `{playbooks: PlaybookSummary[]}`: every playbook with content or waiting suggestions (`scope`, `rev`, `updated`, `skills`, `pending`) |
| `GET /api/playbook?folder=\|video=` | `PlaybookView` (below) |
| `PUT /api/playbook/text` | `{folder?, section: "brief" \| "rules", content, message?, base_rev?}` → `{rev, playbook}` |
| `GET /api/playbook/skill?folder=\|video=&name=` | one skill in force there: its fields, `from` (whose playbook) and `markdown` (the SKILL.md) |
| `PUT /api/playbook/skill` | `{folder?, name, description, body, extra?, rename_from?, message?, base_rev?}`, or a whole SKILL.md as `{folder?, markdown, rename_from?, …}` → `{rev, playbook}` |
| `DELETE /api/playbook/skill?folder=&name=` | remove a skill and its files |
| `POST /api/playbook/skill/files` | `{folder?, skill, name, data}` (base64, 2 MB and 10 files per skill at most) |
| `GET` · `DELETE /api/playbook/skill/files?folder=&skill=&name=` | download a skill's file (always as an attachment, never inline); remove it |
| `POST /api/playbook/refs` | a reference (below) → `{ref, rev, playbook}` |
| `DELETE /api/playbook/refs?folder=&id=` | remove one |
| `GET /api/playbook/refs/:file?folder=` | a reference's picture or still, only through the playbook that names it |
| `POST /api/playbook/proposals` | a suggestion: `{folder? \| video?, section: "brief" \| "rules" \| "skill", content, reason, evidence?, by?}` → `201` with the proposal (`pp_…`, `pending`) |
| `GET /api/playbook/proposals/:id` | the proposal, and `current`: what its section says now (the diff's left side) |
| `POST /api/playbook/proposals/:id/accept` | `{message?, base_rev?}` → `{proposal, rev}`; `409` when its section changed after the suggestion was made (or after `base_rev`) |
| `POST /api/playbook/proposals/:id/reject` | `{reason?}` → the proposal, `rejected` with the reason the agent reads |

Details:

- **`PlaybookView`**: `scope`, `label`, the `playbook` itself (brief, rules, refs, skills, history, proposals), the
  `layers` above it (House first), the `skills` in force (each with `from`), the `stamp` a render made now would get,
  the `markdown` agents read, and for people with the playbook action `suggestions` (recurring asks no rule names yet)
  and `below`: the playbooks of folders inside this one with suggestions waiting (`{scope, pending}`, by path).
- **Conflicts.** A text write answers `rev: null` when nothing changed, and `409` when someone changed the same section
  after `base_rev`. Accepting a suggestion is refused (`409` with `by`, `changed_rev`, `rev` and, when it was another
  suggestion accepted, its `proposal`) when its section changed after the suggestion was made: the person looks at the
  diff against the section as it is now, then accepts with that revision as `base_rev` to replace the change on
  purpose. Another section's changes never hold a suggestion up.
- **References**: a link `{folder?, kind: "link", url, caption?}`, a frame-exact still of a video
  `{folder?, kind: "frame", video, v?, frame, to_frame?, caption?}`, or an image `{folder?, kind: "image", data,
  caption?}` (base64).
- **Suggestions.** `content` is the whole new text; for a skill, its SKILL.md (the name in its frontmatter picks the
  skill; a new name adds one). `evidence` lists note ids. A new suggestion broadcasts `playbook` and `for-you`.
- **Accepting** makes the content the next revision (`by` the proposer, `accepted_by` you). It answers
  `409 {by, changed_rev, base_rev, rev}` when someone changed that section after the suggestion was made: accepting
  would replace their change, so reject it or ask for a new one.

## Project files

The material a project is made from: footage, music, fonts, project files ([files.md](files.md)). Files attach to the
House, a project or a folder, named by `folder` (a folder path; empty or left out: the House). The shapes are in
[`lib/types.ts`](../lib/types.ts) ("project files"); paths inside an area follow
[`lib/fileText.ts`](../lib/fileText.ts) `cleanFilePath` (`400` otherwise).

Reading needs `files`, every change `files-write` (owners, admins and members). **Reviewers get `404`** on every
route here: they don't see files. Review links never reach them. OAuth apps need `files:read` or `files:write`. Ids
are `fl_…` (a file) or `fd_…` (a folder inside an area); another workspace's answer `404`. Every change broadcasts
`files` (`{area, rev}`) on `/api/events`, to streams that may read files only.

| Route | What it does |
|---|---|
| `GET /api/files?folder=&path=&deep=&own=&kind=&q=&limit=&cursor=` | `FilesListing`: the chain's areas (deepest first: `area`, `rev`, `files`, `bytes`, `trash`, `trash_bytes`), the folders directly under `path` (`dirs`: `id`, `area`, `path`, `files`, `bytes`; empty ones too), and a page of files (`FileInfo`): directly in `path`, or every one under it with `deep=1` (and with `q`, a part of the path, or `kind`). A deeper area's path hides the same path above. `own=1`: the folder's own area only. `limit` ≤ 1000 (default 200); `cursor` from the last page |
| `GET /api/files/summary?folder=` | `FilesSummary`: per area of the chain, its top-level folders and files with counts, bytes and kinds |
| `GET /api/files/trash?folder=` | `FilesTrash`: the area's trash, newest first (`purge_at` on each), and folders trashed whole (`dirs`) |
| `GET /api/files/usage` | `FilesUsage`: live files, the bytes that count (`pending` of them: uploads waiting for their commit), the bytes kept and not counted (trash, replaced versions), the safety net's cap (`kept_cap`, always set) |
| `GET /api/files/:id` | `FileInfo` (`TrashedFileInfo` in the trash; `FileDirInfo` for a folder's id) |
| `GET /api/files/:id/history` | `FileHistory`: its versions (newest first; `kept_until` on older ones) and its journal (`changes`) |
| `GET /api/files/:id/download?v=&inline=` | the version's bytes: a `302` to a short-lived signed URL on the media host, else streamed. An attachment (`application/octet-stream`, `nosniff`, `sandbox`) with ranges; `inline=1` shows pictures, video, sound, PDF and text as themselves, never SVG or HTML. `410` when the bytes are gone |
| `POST /api/files/urls` | `{ids, v?}` (≤ 100) → `FileUrls`: a signed URL per file for one pull step (an hour for an API token, six for a person) and the ids not found (`missing`) |
| `POST /api/files/missing` | `{hashes}` (≤ 5,000 sha256) → `{missing}`: the bytes this workspace doesn't hold |
| `POST /api/files/uploads` | `FileUploadRequest` `{folder?, files: [{path, size, sha256?, base?}], commit?, conflict?, agent?, agent_kind?, via?, machine?}` (≤ 1,000 files) → `FileUploadAnswer`: per file `stored: true` (its bytes are here: commit it) or a one-time `url` and `ticket` (15 minutes), and the `tus` endpoint |
| `POST /api/files/commit` | `{folder?, add: [{path, sha256, size, base?}], conflict?, agent?, …}` → `FileCommitAnswer`: files whose bytes are stored, as one change |
| `POST /api/files/dirs` | `{folder?, path}` → `FileDirInfo`: an empty folder inside the area (one there already answers as it is) |
| `PATCH /api/files/:id` | `{path?, folder?}`: rename, move inside the area, or move to another area (`folder`, `''` the House) → `FileInfo`; a folder's id moves everything under it → `FileDirInfo`. `409` when the place is taken |
| `DELETE /api/files/:id` | to the trash → `TrashedFileInfo` (a folder's id: with everything under it → `TrashedDirInfo`). Members trash what they added (`403` otherwise) |
| `POST /api/files/:id/restore` | `{}`: out of the trash (beside its old path as `name (restored)` when that is taken) · `{v}`: an older version back as the newest (its bytes the file's already: nothing changes) → `FileInfo` (a folder's id: `FileDirInfo`). `402` with the plan's refusal when what comes back doesn't fit |

Details:

- **The version check.** Each file of a push names `base`, the version it replaces: absent or `0` for a new file. A
  path that is taken (also one differing only in case) without a base, or with an older one, is a conflict: `409` with
  `FileConflictAnswer` (`{error, conflicts: [{path, id, v, base, by, agent?, at}]}`), checked by `uploads` before any
  byte and again when the bytes arrive or are committed. Nothing is written. `conflict: "copy"` keeps the file beside
  it instead (`state: "copy"`, `asked`: the path pushed to). The same bytes again are `state: "same"`.
- **The bytes.** A ticket takes one `PUT` (`curl -T file <url>`; the URL is its own credential, on the media host when
  there is one) or one tus upload at `/api/uploads` with `Upload-Metadata: ticket <b64>, filename <b64>`, signed in as
  the account that asked (another account or workspace: `404`). The ticket is spent when the upload is made; the
  upload then resumes for a day. The `PUT` and the last `PATCH` answer `FileUploadResult` (`{stored, commit?}`), or the
  `409` above; `202 {pending, id}` when hashing a big file takes longer (the result at `/api/upload-results/:id`). The
  bytes are hashed on arrival: a mismatch with the named `sha256` or `size` is `400`, nothing kept.
- **Refusals before any byte**: `402` with the plan's refusal (`reason`, `needed`, `room`, `fits`: [plan
  limits](#workspaces-and-plan-limits)) for the bytes that would start counting, `507` when the server's disk is short,
  `423` in an archived project, `429` past the open tickets one account may hold.
- **Attribution.** `agent` (cleaned, ≤ 80 characters) and `agent_kind` are kept for callers who may write as agents;
  `via` (`vr`, `mcp`) and `machine` say how it came. Every version carries `by` and `by_id` of the account.
- **Signed URLs** (`/media/f/…` on the media host) ask again on every request whether whoever they were handed to may
  still read files, and answer CORS: any origin for an attachment (a render may stream it), the app's own for a
  preview.

## Sessions, agents and the inbox

| Route | What it does |
|---|---|
| `GET /api/sessions?video=` | the agents you can assign, ranked for a video (below) |
| `PUT /api/review/:slug/session` | assign `{name, sessionId?, cwd?, agent?}` (`agent`: the kind, as `/api/sessions` lists it), or `{}` to unassign. The name is kept as one line of printable text, 80 characters at most (`400` when nothing printable is left); the session id and folder lose line breaks and control characters |
| `POST /api/review/:slug/request` | ask the assigned agent: `{text?, start?, part?, nudge?}` (it arrives as a `REQUEST` in `lampo watch`) → `{ok, run}` |
| `POST /api/review/:slug/wake` | start the assigned agent without a request of its own (its question was answered): `{text?}` → `{run}` |
| `GET /api/agent-runs?slug=` | runs Lampo started on this machine, newest first: `{runs}` (below) |
| `POST /api/agent-runs/:id/stop` | end a run and everything it started (SIGINT, SIGTERM after 5 s, then SIGKILL after 5 s more) |
| `GET /api/agent-runs/:id/log` | the end of a run's output (256 KB at most, text) |
| `PUT /api/review/:slug/agent-status` | an agent's status on the video's card: `{text, eta_seconds?, by?}`; empty text clears it |
| `POST /api/agents/heartbeat` | an agent checking in: `{session_id, name, cwd?, host?, kind?}` (below) |
| `GET /api/agents` | the agents that checked in within the last 90 s |
| `GET /api/agent-activity?slug=&agent=` | what agents are doing (below) |
| `POST /api/agents/activity` | what `lampo` and the stdio MCP server report to a hosted server (below); answers `{ok, lines?}`, `lines` being what the agent is told now (the person stopped its work) |
| `GET /api/inbox?since=&limit=&all=` · `GET /api/inbox.md` | the newest feedback from people, as events or as INBOX.md |

Details:

- **Sessions** answers `{sessions, at, refreshing}`: running Claude Code sessions (on a person's own machine, with the
  runs Lampo started) and connected agents (`lampo watch`, MCP clients over HTTP), each with its `score` and `reason` for
  the video. `?fresh=1` reads the machine's sessions again. A role without the agents action doesn't see their folders.
- **A request** needs `text` or `part`. `part` (like a note's) allows a partial render of the newest version: the
  request's text then ends with its PART RENDER OK line, and the event carries `part`.
- **Starting an agent.** `start: true` on a request (and `/wake`) also starts the assigned session when it isn't
  running. That works only on a person's own machine, from the machine itself; anywhere else (a hosted server, the LAN
  link, a token, a signed-in browser) it answers `403`, checked before the request is logged. `409` when no agent is
  assigned or it isn't a Claude Code session with its id and folder. After the request is logged: `400` when the
  session's folder is gone, `409` while a run of that session is going, `429` after five starts per session in ten
  minutes. `run` is an `AgentRunInfo`, or `null` when the agent was running already.
- **Runs** (`AgentRunInfo`): `id`, `slug`, `name`, `session_id`, `cwd`, `by`, `started`, `ended`, `state` (`running`,
  `finished`, `failed`, `stopped`, `timeout`), `exit`, and `live` once the run printed something:
  `{step, tokens: {input, output, cache_read, cache_write}, cost_usd, turns, updated}` from its stream-json (`cost_usd`
  only when the run states it). Runs are kept in memory (running ones and the last 20), so the list is empty after a
  restart. The event `agent-runs` says when one starts, moves on (at most every 0.5 s) or ends. These routes need the
  agents action and the machine itself.
- **A heartbeat**'s `kind` is an agent kind (the mark the app shows; `400` for an unknown one). `lampo watch` sends one
  every 30 s from inside a Claude Code session, as `claude-code`; without `kind` an agent counts as `cli` (shown as
  "lampo"); a script on the HTTP API sends `api`. Names are listed as one line of printable text, the name 80 characters
  at most, and end in whose agent it is (`claude · Alex`) unless it runs on the machine itself. A heartbeat speaks
  for its own account only: a `session_id` another account's agent is listed under answers `409`, and ids starting
  with `mcp-` (the MCP server's own) `400`.
- **Activity** (the agents action) answers `{agents: AgentLive[]}`. With `slug`: that video's agents (each
  `{agent, slug, current, recent}`, newest first, 12 lines at most, including what the agent did that named no video;
  `agent` adds the assigned one before it touched the video). Without: every agent's latest. A line is `{at, agent,
  slug, kind, text, key?, vars?, quote?, target?, since?, pct?, progress?, run?}`: `kind` is one of `read`, `note`,
  `fix`, `reply`, `ask`, `upload`, `render`, `wait`, `playbook`, `status`, `tool`, `say`, `run`, `error`; `text` is the
  English line, `key` and `vars` its template (`ACTIVITY_KEYS` in `lib/activityText.ts`) for the app's language,
  `since` when a wait began, `pct` an upload's progress (older readers). `progress` is a render or upload under way
  (`lampo render`: `RunProgress` in `lib/types.ts`, `{what, stage, pct, frames?, eta_s?, tool?, v?}`); an `error` is a
  render that failed, its `quote` the tool's last words (300 characters at most, secrets taken out); `run` the run the
  agent works for, when Lampo started it for one (`LAMPO_RUN`). Kept in memory only.
- **Reporting activity**: `{entries: [...]}`, 20 at most, each a line's fields without `slug` and with `video` naming
  the video, only the kinds an agent's own calls make (`lampo render`'s `render` and `error` among them); at most every
  2 s. `progress` takes only the stages and tools `lampo render` knows and bounded numbers, `run` only a run id's shape.
  Each line is listed as `<agent> · <account>` (unless the name already ends with the sending account), and its `at`
  is held to the last 5 minutes.
- **Reporting activity** may name `run` (`run_…`, from `LAMPO_RUN`): a hint, taken only when that run is the same
  agent's (as listed, with its account), on the same video, in the same workspace; otherwise the line joins the open
  run of its agent and video like any other ([below](#agent-runs)).
- **The inbox** lists 50 events unless `limit` says otherwise (5,000 at most); `all` adds agents' events and every
  event type. Screenshots are paths on the server's disk only for the machine itself, here, in `/api/inbox.md` and
  over MCP; anyone else (the LAN link, a token, every caller of a hosted server) reads them as `/data/<slug>/<file>`
  URLs, and so does everyone on the live stream.

## Agent runs

A run is one stretch of an agent's work on one video: opened when a team member sends the video's agent notes, asks,
nudges, answers its question or tries again (or by the agent's own first write), ended when it hands back
([agents.md](agents.md#your-work-as-the-person-sees-it-runs)). Its plan is the notes sent, its result a version.

| Route | What it does |
|---|---|
| `GET /api/runs?slug=` · `?folder=` | a video's runs, newest first: `{runs: Run[]}`; `folder` for runs on a folder's question before any render |
| `GET /api/runs/:id` | one run and its kept steps, newest first: `{run, steps: RunStepLine[]}` |
| `POST /api/runs/:id/stop` | stops it at once: `stopped`; a run this machine started ends its process too (SIGINT, SIGTERM, SIGKILL); an agent that listens gets `stop_pending` until its next call tells it → `{run}` |
| `POST /api/runs/:id/retry` | Try again: `{start?}` opens the follow-up run on the notes still open (`follows`, `opened_by.how: "retry"`), told to the agent as a `REQUEST` → `{run}` |
| `POST /api/runs/:id/nudge` | `{text?, start?}`: a `REQUEST` to the same agent about the same run (a run not heard from works again at its next sign) → `{run}` |
| `GET /api/runs/:id/log` | the end of the raw log of a run this machine started (256 KB at most, text) |

Details:

- **Who.** Reading needs the view action (reviewers too); nothing of a run is reachable through a review link. Roles
  without the agents action read where a run stands and never what it worked on, as `/api/agent-activity` is closed to
  them: `/api/runs/:id` gives them no `steps`; `now`, `error` and `needs.text` only as templates whose fill-ins name
  nothing of the project (a note, a frame, an exit code; "Running a command" for a command, nothing for a file), never
  a `quote`; no `result.summary` or `needs.allow`; no `agent.session_id` or `agent.runner`. The same holds for each
  video's `run` in the library. Stop, retry and nudge need the agents action and a person: an API token gets `403`;
  stopping a run whose process this machine runs needs the machine itself (like `/api/agent-runs/:id/stop`). The log
  answers only on a person's own machine, from the machine itself (like `/api/agent-runs/:id/log`), and names no path.
- **Whose.** A run is its agent's account's (by its id, kept with the run, never shown): the first agent heard at it
  claims it, and a run a person sends to a connected agent is that agent's account's from the start. Activity of
  another account never joins, takes or hears it, whatever name it posts under. An account's name can't contain "·",
  which separates an agent's name from whose it is (`claude-code · Sam`).
- **Opening.** Send (`POST …/drafts/send`, a recording's send), a request (`nudge: true` for a nudge), an answer to
  the agent's question (`PATCH /api/comments/:id` to `verified` with words, `POST /api/asks/:id/answer`) and retry
  open a run for the video's assigned agent, or add their notes to the one it has open (`added: true` once it began):
  only for a person whose role has the agents action, never a reviewer, a review link visitor or an API token. Their
  notes and requests go out all the same. An agent's own write (a note, a fix, a reply, a question, an upload, a
  status) with no run open opens one (`opened_by.how: "agent"`, working); reads and waits never do. Those are bounded:
  a video holds a dozen open runs, one account's agents a few dozen in a workspace, opened so often; past that the
  activity still shows live and opens nothing (a person's Send always opens its run).
- **A `Run`** (`lib/types.ts`): `id`, `slug` (or `null` and `folder`), `agent {name, kind, session_id?, runner?}`,
  `opened_by {who, id?, how}`, `delivery` (`listening`, or `machine` for one this machine started), `state`
  (`queued` → `starting` → `working` ⇄ `needs_you` → `done` · `failed` · `stopped` · `lost`), `started`, `ended`,
  `seen` (its last sign), `worked_s` (as of the answer; never the time it waited for a person), `plan` (`[{id, state:
  todo | doing | fixed | asked | wontfix | replied, at, v?, added?}]`), `now` (the newest step or what the agent said,
  with its `type` and `at`), `progress` (a render or upload under way), `result {v?, fixed, asked, wontfix, summary?,
  tokens?, cost_usd?}`, `error`, `needs` (`{kind, note?, text?, allow?}`: `allow` is the settings rule a permission it
  was refused needs), `request`, `follows`, `log`, `stop_pending` (stopped by a person, its agent not told yet).
- **Stop and the agent.** A run that isn't a process Lampo runs (`delivery` other than `machine`) and had begun gets
  `stop_pending`; the agent's next Lampo call (an MCP tool, a `lampo` command about the video, a batch to
  `POST /api/agents/activity`, which then answers `lines`) ends with one line, once: `The person stopped this work on
  <file>: stop now, render nothing, mark nothing, and say you stopped.` A wait clears it without the line; a new
  Send, request or nudge to the same agent clears it too. A request (Tell it…) while a run is open joins that run: its
  `request` and a step `{name} asked`.
- **Permissions.** A run this machine started that is refused a tool call (its stream-json says so) turns `needs_you`
  with `needs.kind: "permission"`, its words and `allow`; it stays so when its process ends (`ended` set).
- **States.** A run begins at its agent's first sign (a wait that hands the notes over included). `needs_you` comes
  with the agent's question or options and goes with the answer. `failed` with an error (`lampo render`) or a non-zero
  exit. No sign for 20 minutes (5 for a run this machine started, 10 more while a render reports) reads as `lost`; any
  sign revives it; an hour later it is closed as `stopped`, without an error. It is `done` by the first of: its process
  exits 0 with no question open (else it ends `needs_you`), the agent waits again after handing back (a version, or
  every planned note answered), or a version arrived with every planned note answered.
- **Steps** are kept with the video, 200 at most per run (render progress keeps its first and last line), for 90 days
  after it ended; what an agent said comes only from its own words to the person, never its hidden reasoning.
- **The library** (`GET /api/library`, `?slug=`) carries each video's `run` (`RunBrief`): the open run, else the last
  that ended in the past 24 hours, with `planned` and `answered` counts.
- **Events.** SSE `run` `{slug, id}` (at most once per run every 0.3 s) says which to fetch again. The event log gets
  `run` events (`phase`: `opened`, `started`, `needs_you`, `ended`; `text`: how it was opened or how it ended), which
  `lampo watch --all` prints as `AGENT RUN OPENED`, `AGENT RUN WORKING`, `AGENT RUN NEEDS YOU` and `AGENT RUN ENDED
  <STATE>`; INBOX.md, `lampo inbox`, `wait_for_feedback` and `lampo watch` without `--all` leave them out.

## Uploads (tus)

`/api/uploads` speaks the [tus](https://tus.io) protocol for resumable uploads (the upload action). Its metadata is
`filename`, plus either `folder` (a new video) or `slug` (the next version of an uploaded video). Details:
[server-mode.md](server-mode.md#uploads).

- **The answer** to the last `PATCH` is `{slug, v, created, duplicate, video, part?}`. When registering the render
  takes longer than 45 s, it is `202 {pending: true, id}` instead, and the result appears at
  `GET /api/upload-results/:id` (`{status: processing | done | failed, result?, error?}`, kept for an hour).
- **Refusals**: `400` when the size isn't known up front, `507` when the disk is short (counting what the uploads
  under way still bring: those that moved in the last ten minutes, anyone else's up to half the room; also on a
  `PATCH` whose rest no longer fits beside them), `402` when the workspace's plan has no room for
  it with its uploads under way ([plan limits](#workspaces-and-plan-limits)), `429` when the account has 50 uploads
  under way, `422` when the file isn't a render Lampo can read.
- **A partial render**: with `slug`, `part_at` (and `handles`, default 12) makes the upload a partial render of the
  newest version ([agents.md](agents.md#partial-renders-only-when-a-note-says-part-render-ok)). `409` when no note or
  request allows one there, when its size or frame rate differs, or when its length changed (it must end on a shot
  boundary). The version it becomes has `part: {of, at, frames, handles, seam}` and plays as the whole video.

**Upload tickets** are for agents without a tus client. `POST /api/uploads/tickets` with
`{filename, folder?, slug?, part_at?, handles?}` (the upload action) answers `{url, expires}`: a one-time URL
(`/api/uploads/direct/vrup_…`), valid for 15 minutes, that takes one `PUT` with the file as the body. On a server
with a media host of its own (`LAMPO_MEDIA_ORIGIN`) the URL is on that host, so a whole render never meets the request
limit of a proxy in front of the app ([below](#the-media-host)).

- The `PUT` answers like the last tus `PATCH`, or `202 {pending: true}` for a slow render; a `GET` on the same URL
  reports the outcome for an hour.
- `410` when the URL was used or has expired, `411` without a `Content-Length`, `413` when the file is too big, `507`
  when the disk is short, `402` when the workspace's plan has no room for it (uploads under way count for both, as
  for tus), `422` when the render is refused.
- Whoever asked for the URL is checked again when it is used: removed from the workspace, the token or app revoked, the
  account disabled, or no longer allowed the action (a member made a reviewer), the `PUT` answers `403` and nothing is
  stored. The same holds for the one-time URLs of fix previews and references. An app connected through sign-in is
  checked by its grant, not the hour-long access token it asked with, so a URL outlives a refresh and ends when the app
  is disconnected.
- One account holds at most 50 URLs open at once (unused and unexpired), a workspace's team 500 and one review link's
  visitors 500 together; past that, asking for one answers `429` with `Retry-After`.
- The URL is its own credential; MCP clients get one from `request_upload`. Fix previews use the same tickets (`POST
  /api/comments/:id/previews` without `data`, MCP `attach_preview`): the `PUT` then answers `{preview, comment, slug}`
  (200 MB at most).

### References on notes

What a note means by "like this" ([agents.md](agents.md#references-what-like-this-means)):

| Route | What it does |
|---|---|
| `POST /api/review/:slug/comments` with `refs` | links `{kind: "link", url, caption?}` and moments `{kind: "frame", video, v?, frame, to_frame?, caption?}`, 8 at most |
| `POST /api/comments/:id/refs` | add one: a link, a moment, or a file (`{kind: "file" \| "image" \| "clip", data?}`) |
| `PATCH /api/comments/:id/refs/:ref` · `DELETE` | change its `{caption}`; remove it |
| `GET /api/refs/:slug/:file` | the files: pictures through the server; clips ranged, or a redirect to signed storage |

Details:

- **A file** goes inline as base64 (8 MB at most). Without `data` the answer is `{upload: {url, expires}}`, a one-time
  URL that takes one `PUT` and answers `{ref, comment, slug}`. Images are 20 MB at most, clips 200 MB and 60 s. A note
  that has 8 references already answers `422`.
- **Whose.** Without `note`, the reference belongs to the note (its author, or the edit-notes action). With `note` it
  comes as a reply (anyone who may comment). Changing and removing: who added it, the note's author, or the edit-notes
  action.
- **File names**: `r_<id>.<ext>`; stills `.t.jpg`, a clip's strip `.s.jpg`, a range's end frame `.e.jpg`.
- **Review links**: `POST /api/g/:token/comments/:id/refs` (on the visitor's own note, or with a reply; moments only of
  videos the link covers, named by the link's ids), `DELETE …/refs/:ref` for references added through the same link,
  files at `/api/g/:token/refs/<video id>/<file>`. A link never shows agents' references or moments of videos it
  doesn't cover.

## Live updates

`GET /api/events` is a stream of server-sent events. Each event names what changed, so a client fetches exactly that
again. A stream hears only its own workspace. A person holds at most 32 streams at once (a browser holds one for all
its tabs; `lampo watch` and each agent's stdio MCP server hold one each; the machine itself isn't counted), and one more
answers `429` with `Retry-After`. The events:

| Event | Data | Meaning |
|---|---|---|
| `library` | `{slug?}` | the list of videos or folders changed; with `slug`, only that video's row (`GET /api/library?slug=`) |
| `review` | `{slug}` | a review changed: notes, versions, decisions, status, a review link that covers it |
| `sessions` | | the agents you can assign changed |
| `events` | | the event log changed (any write, the CLI's included) |
| `event` | a `ReviewEvent` | every new line of the event log, as `events.jsonl` has it but with screenshot URLs (`/data/…`) instead of paths on the server's disk: what remote `lampo watch` and `/mcp` follow |
| `poster` | `{slug}` | a poster is ready |
| `sprite` | `{slug, v}` | a hover-scrub sprite is ready |
| `analysis` · `diff` · `qa` | `{slug, v}` | a background result is ready |
| `qa-progress` | `{slug, v, step, done, total}` | Auto-check progress |
| `transcript` | `{slug, v}` | a version's transcript is ready, or failed |
| `recording` | `{slug, id}` | a recording was uploaded, heard, sent or discarded (no content) |
| `playbook` | `{scope}` | a playbook changed |
| `for-you` | | someone's inbox changed: items dismissed, put aside or brought back, a playbook suggestion made or decided |
| `agent-runs` | `{slug}` | a run Lampo started began, moved on or ended |
| `run` | `{slug, id}` | an agent's run opened, moved or ended (at most once per run every 0.3 s; `GET /api/runs/:id` says what) |
| `agent-activity` | `{agent, slug}` | an agent did something (at most once per agent and video every 0.3 s; `GET /api/agent-activity` says what) |
| `drafts` | `{slug}` | your drafts on a video changed: sent only to your own streams in the app, never to others or to an API token |
| `asks` | | a question on a folder was asked, answered, closed or given a file (a video's questions come as `review`) |
| `posts` | `{slug}` | a post of a final video changed: drafted, published, sending, out or failed |
| `connections` | | a publishing connection was added, checked, changed or removed |
| `footage` | `{slug}` | a video's footage index changed: its newest version indexed, or failed |
| `files` | `{area, rev}` | an area's project files changed (`area`: its folder's path, `''` the House); only streams that may read files hear it |
| `moment` | `{id}` | a conversion moment waits for you (where a billing provider runs): sent only to your own streams |

## Review links

What they allow and why: [sharing.md](sharing.md). A link's settings are `{label, comment, approve, notes: own | all,
versions: latest | all, download: off | preview | original, expires: ISO | null, password: string | null, embed?}`.
`embed: true` makes an Embed link (one video's player for another site): watch only whatever else is sent, never on a
folder and never with a password (`400` with the reason). A link is an embed from when it is made or never: a `PATCH`
whose `embed` would change that is a `400` ("make a new link"); the same value changes nothing. By default
a link takes notes and decisions, shows each visitor their own notes and only the newest version, has no downloads and
no expiry, and is labelled "Review link". A label is 80 characters at most, a password at least 4. Visitors see a
link's label only when it was given one (`label` is `""` in `/api/g/…` otherwise).

**The owner's side** (the share action; reviewers get `403`). A listing gives each link's `token` to a person's own
browser (a session, or the machine itself), which copies, changes and revokes by it. With an API token the listings
leave `token` out, so an agent can't hold every client link in one call, and making, changing or revoking a link
answers `403 {person: true}`: an agent never holds a link it could approve through as the client.

| Route | What it does |
|---|---|
| `GET /api/review/:slug/shares` | the video's links and the folder links that include it, as `ShareInfo`, plus `sharer`, `tunnel` and `lan` (below) |
| `POST /api/review/:slug/shares` | a link for one video (settings optional) |
| `GET /api/folder-shares?folder=` · `POST /api/folder-shares {folder, …}` | links for a folder and its subfolders |
| `GET /api/shares` | every link of the workspace that isn't revoked, newest first (`SharesResponse`). `gone: true` marks one whose video or folder was deleted outside the app: it opens nothing, and this is where it can still be found and revoked |
| `PATCH /api/shares/:token` | change the settings; `password: null` removes it, a new password signs every visitor out |
| `DELETE /api/shares/:token` | revoke it |
| `GET /api/shares/:token/qr?base=` | `{url, svg}`: a QR code for `<base>/g/<token>` |

`ShareInfo` holds the settings, `id`, `token` (see above), `kind`, `name`, `password` (true or false), `expired`,
`sharer` (who visitors are told the link is from; `null` until a name is chosen), `stats {opens, last_opened,
reviewers, notes, downloads}` and `activity {visitors, videos: [{name, v, watched, heat, viewers}], events, secs}`,
summed up from the link's records.

**The visitor's side** (`/g/<token>`; the token is the only credential):

| Route | What it does |
|---|---|
| `GET /api/g/:token` | `GuestLinkResponse`: what the link is and which videos it shows (below) |
| `POST /api/g/:token/unlock` | `{password}`: sets the link's cookie; `403` if wrong, `429` with `Retry-After` when guessing |
| `POST /api/g/:token/visit` | `{name?, visitor?, slug?, v?}`: counts a visit (below); with a video of the link (an embed's first play), its view too |
| `POST /api/g/:token/progress` | `{visitor, slug, v, seen, plays?, secs, name?}`: which hundredths of version `v` played, how often and for how long → `204` |
| `GET /api/g/:token/review/:id?v=` | `GuestReviewResponse`: one video, its versions (if allowed; each with its frame size, `width` and `height`), download URLs, the visible notes with `frameHere` for the version shown |
| `GET /api/g/:token/review/:id/compare?v=` | links that show every version: another version to play beside the one on screen (`GuestCompareResponse`: `v`, `fps`, `frames`, `width`, `height`, `media`, `preparing?`, `busy?`), without notes, decisions or downloads, and not counted as a view; `403` on a link that shows only the newest version, `400` without `v` |
| `GET /media/g/:token/:id/v:v` | playback |
| `GET /api/g/:token/waveform/:id?v=` · `/poster/:id` · `/sprite/:id` | the waveform, the poster, the hover-scrub sprite (`202` until it is made) |
| `GET /data/g/:token/:id/:file` | screenshots of the notes the link shows |
| `GET /api/g/:token/download/:id/v:v?kind=preview\|original&name=` | a download, when the link allows it |
| `GET /api/g/:token/archive/info?kind=` | folder links: `ArchiveInfo` for Download all (files, bytes, `preparing` previews, `resumable`); starts computing the checksums |
| `GET /api/g/:token/archive?kind=&name=` | folder links: the zip (below) |
| `POST /api/g/:token/comments` | a note from `guest:<name>` (below) → `{id, timecode}` |
| `GET /api/g/:token/review/:id/transcript?v=` | on links that take notes: what is said, as above, without the version's hash, the engine or `repairs`; `403` on watch-only links |
| `POST /api/g/:token/comments/:id/replies` | `{name, text}` on a note the link shows |
| `POST /api/g/:token/comments/:id/check` | `{name, verdict: confirm \| reopen, text?}` on a note marked fixed |
| `POST /api/g/:token/approval` | the client's decision (below) → `{approval}` |
| `GET /api/g/:token/embed` | Embed links: what the player at `/e/<token>` plays (`EmbedResponse`: `title`, `slug`, `v`, `fps`, `frames`, `width`, `height`, `duration`, `media`, `preparing?`, `busy?`, `poster`, `sprite`, `chapters` `[{frame, title}]`, `captions` URL or `null`, `captions_lang?`, `badge`; `chapters` as read when the version arrived); `404` for any other link, `410` expired, `429` when one address asks too often |
| `GET /api/g/:token/captions/:id?v=` | Embed links: the transcript's lines as WebVTT; `404` when the version wasn't heard, `429` as above |
| `GET /oembed?url=&format=json&maxwidth=&maxheight=` | oEmbed for an Embed link's `/e/<token>` or `/g/<token>` address on this server: `{version, type: video, title, html, width, height, thumbnail_url, thumbnail_width, thumbnail_height, provider_name?, provider_url?}`. The size is the video's own scaled down (never up) to fit `maxwidth` × `maxheight`, else 1280 × 1280; the thumbnail is the poster, 640 px on its long side; `provider_*` only while the workspace shows the badge. `404` for anything else, `501` for another format; any origin may ask |
| `GET /e/:token` | the Embed link's player, a page of its own: the one page another site may frame ([sharing.md](sharing.md#embedding-a-video)) |

Details:

- **The link.** `GuestLinkResponse` has the label, who shared it (`reviewer`: a name they chose, `null` for a machine's
  owner still named after the computer's account), the team (`org`: `org_name`; on a hosted server with several
  workspaces, the name of the link's own workspace for all but workspace #1, and `null` while a sign-up's workspace
  still has the name it started with, its owner's), the kind (`video` or `folder`), `folder` (a folder link's own name,
  never the folders above it; `null` for a video link and while locked; each video's `folder` is where it sits below
  it), `source` (where the instance's source is: `source_url`), `badge` (*Powered by Lampo* at the foot: `false` only
  when the link's workspace is on a plan that may hide it and its admins did), `imprint_url` and `privacy_url` (the
  operator's pages, [configuration.md → Legal pages](configuration.md#legal-pages)), the permissions and the videos. A
  password link answers `locked: true` and no videos until it is unlocked; until then every other route answers `401`.
  `404` when unknown or revoked; `410` with `{error, by, expired}` when it expired (whom to ask, and since when), and a
  plain `410 {error}` on every route while the link's workspace is suspended. `reviewer_avatar` is reserved: pictures
  are for signed-in people. An Embed link's token is in other sites' pages, so its answers name nobody: `label` `""`,
  `reviewer` and `org` `null` (here and in the video's answer), no video's `updated` nor version's `registered`, no `by`
  when it expired, and none of the visitors' notes or decisions.
- **Visits and watching.** A visit counts once per visitor and half hour, never for the team checking its own link (the
  owner's machine, or a signed-in account). `visitor` is the random id the page keeps, `name` what the visitor typed,
  if anything (an Embed link's visits are anonymous: its visits and reports keep no `name`). 60 visits a minute per
  link and address, then `429`. Progress: `seen` is 25 hex digits (`lib/watch.ts`), `plays` 100 counts, `secs` 3600 at
  most; nothing is kept for the team; 12 reports a minute per visitor and 240 per address
  ([sharing.md](sharing.md#what-a-link-records)).
- **Opening a video** counts a view of that video and version in the link's `stats.videos` (once per address, video
  and version per half hour, never for the team): that is what makes a stage *Out for review*. `media` is `null`
  with `preparing: true` while the link's preview copy is being made; `busy: true` with it says the server's queue is
  full and the copy is made once there is room (ask again in about 15 s, not sooner).
- **Playback and downloads.** The video's own bytes play only on links whose downloads are `original`; every other link
  plays the preview copy (`425` with `Retry-After` while it is made). Downloads redirect to signed storage with Bunny
  or S3 (a URL that lives 5 minutes, like the link's renders, previews and reference clips: the server checks the link
  each time it hands one out), and are counted once per visitor and half hour.
- **The zip** is `original` when the link offers it, else `preview`. It has an exact `Content-Length`; once every
  checksum is cached it has an `ETag`, `Accept-Ranges: bytes` and answers `Range` (with `If-Range`) with `206`; before
  that `Accept-Ranges: none`. `403` when downloads are off (or for `original` on a preview link), `404` on a video link
  or with nothing to download, `425` while previews are being made, and `429` with `Retry-After` while 2 downloads per
  visitor (or 6 per link) are already running.
- **A visitor's note**: `{name, slug?, v?, frame, text, drawing, idea?, range?, scope?, text_edit?, refs?}`. `slug` is
  the video's id within the link; `idea: true` makes it an idea; `refs` takes up to 8 links or moments of videos the
  link covers. Every field is optional, but something must be written or marked (`400`). The text is kept to 2,000
  characters. Notes, replies and references: 30 tries a minute per visitor (the link and the visitor's address), and
  in a day 500 per visitor and 2,000 per link, counting only writes that landed; then `429`. A video takes at most
  2,000 client notes through each link (`409`), and no notes or references while the server's disk is down to its
  reserve (`507`).
- **The client's decision**: `{name, slug?, v, status?: approved | changes, note?}` (`approved` by default; the note is
  kept to 500 characters). `v` is the version on the visitor's screen and must be the newest: when a newer version
  arrived since the page opened, the answer is `409 {error, latest}`, nothing is recorded, and the page shows the new
  version first. It is recorded as the client's (`guest:<name>`, with the link's id). Visitors see only the client's
  decisions, never the team's; on a link that shows its own notes (`notes: own`), only those made through it. 20
  decisions a minute and 50 a day per visitor (the link and the visitor's address), and they count in the day's 500
  per visitor and 2,000 per link like notes (only those that landed; the same decision again counts nothing); then
  `429`. A link keeps its newest 20 decisions on each version; the one that stands is always among them.
- **Video ids.** `:id` (and `slug` in bodies) is the video's id within the link (`v_…`, from
  `GuestLinkResponse.videos[].slug`): stable per link and video, different between links, because a slug is the
  owner's disk path on their own machine. Slugs from before ids are still accepted, but never sent. Links from before
  folder links still answer at `/media/g/:token/v:v`, `/api/g/:token/waveform` and `/data/g/:token/:file`.
- **Writes** must come from the review page (the `Origin` is checked).

## Webhooks

Owners and admins (on a person's own machine: its owner) manage them:

| Route | What it does |
|---|---|
| `GET /api/admin/webhooks` | `{webhooks}`: every hook (from config, the environment and Settings) as `WebhookInfo`, with its last delivery |
| `POST /api/admin/webhooks` | add one: `{url, label?, format?, events?, secret?}` → the `WebhookInfo` |
| `PATCH /api/admin/webhooks/:id` | change one made in Settings (an empty secret keeps it, `null` removes it) |
| `DELETE /api/admin/webhooks/:id` | remove one made in Settings |
| `POST /api/admin/webhooks/:id/test` | send a sample note; answers with the delivery |

`format` is `json` (the default), `slack` or `discord`. `events` lists event types, or `client` (the default: what
visitors do through review links) or `all`; 20 at most. A bad URL or format, or an address that isn't public on a
hosted server, answers `400`. Hooks from config or the environment can't be changed here (`400`) or removed (`404`);
they belong to workspace #1 and hear only it, and every other workspace lists and hears only the hooks it added.
What a delivery looks like: [sharing.md](sharing.md#webhooks).

## For you, notifications and phones

What they are for: [mobile.md](mobile.md).

| Route | What it does |
|---|---|
| `GET /api/for-you?limit=` | `ForYouResponse`: the caller's inbox (below) |
| `POST /api/for-you/dismiss` | `{keys}`: hide items that inform (below) |
| `POST /api/for-you/snooze` | `{keys, until}`: Later (below) |
| `POST /api/for-you/unsnooze` | `{keys}`: bring items you put aside back at once |
| `GET /api/push?endpoint=` | `PushState`: the server's VAPID public key, your `subscription` on that endpoint (`id`, `name`, `prefs`, `created`, `last_ok`) and how many devices you have |
| `POST /api/push/subscribe` | `{subscription: {endpoint, keys: {p256dh, auth}}, name?, prefs?}` → `PushState`; a person's, in the app (`403` with an API token). Any new password (Profile, an admin, a reset) ends the account's subscriptions |
| `PATCH /api/push/prefs` | `{endpoint, prefs: {questions?, fixes?, versions?, clients?, answers?, posts?, agents?, quiet?}}` → `PushState`; `404` for an unknown device |
| `POST /api/push/unsubscribe` · `POST /api/push/test` | `{endpoint}`; the test answers `404` when the device isn't subscribed, `502` when its push service refuses |

Details:

- **The inbox** has `items` (kind `question`, `blocked`, `failed`, `verify`, `review`, `client`, `playbook`, `approval`,
  `answer`, `version`, `post` or `stalled`, each with the video, frame, timecode, text and marked screenshot) and
  `counts` per kind plus `total`, for whoever asks. `blocked` (an agent's run waits for a permission it was refused)
  and `failed` (its run failed), and `stalled` with `reason: lost` (no word from it) or `queued` (sent, picked up by
  nobody in 10 minutes), carry `run` (`ForYouRun`: agent, state, delivery, times, `error`, `needs` with `allow`, the
  rule to copy, `now`, `log`, plan counts) and are listed only for roles with the agents right. A `failed` item is
  dismissed once it was opened; a `blocked` one leaves when its run goes on, is stopped or sent again. `?limit=n` returns at most n items of each kind, with `truncated: true`; the counts stay complete.
- **Dismissing** (1–500 keys) hides only items that inform: `client`, `approval`, `answer`, `version` and `stalled`.
  Work (a question, a fix to check, a version to review, a playbook suggestion) stays until it is done. Dismissing and
  bringing back answer your `ForYouResponse`.
- **Stalled** items (for people who may approve, last): a video whose fixes keep coming back (`reason: reopened`,
  `count`), at its 4th version without approval (`rounds`), or quiet for 48 hours (`waiting`, `waitingHours`), with
  `waitingOn` (`agents`, `client` or `you`) and `agent`. Never a video another item names. Their key changes when the
  video moves, and they count in `counts.stalled`, not in `total`, the bell's number.
- **Later** puts items aside for you until `until` (an ISO time within 30 days; the app sends tomorrow 9:00 in your
  day) or until their video moves (a version, a note, a reply, a decision), whichever comes first. It works on any
  kind, work too, and changes nothing on the note or the video. It answers your `ForYouResponse`, where those items
  are no longer in `items` or `counts.total` but in `later` (each with `snoozed`: its time), `counts.later`, and
  `wake` (the earliest time one comes back by itself).
- **Push endpoints** must be https and belong to Apple's, Google's, Mozilla's or Microsoft's push services, with
  well-formed keys (`400` otherwise). A subscription belongs to the account that made it; only that account sees or
  changes it.

## System

| Route | What it does |
|---|---|
| `GET /healthz` | `{ok: true}`, no sign-in: liveness for Docker and load balancers |
| `GET /readyz` | `{ok, stopping, checks: {data, disk, ffmpeg, storage, public_url}}` (`public_url` on a hosted server), no sign-in: `200` when this instance can work, `503` when a check fails or it is shutting down (reasons in the log, see [docker.md](docker.md#running-it)) |
| `GET /robots.txt` | no sign-in: lets crawlers fetch, so they see the `X-Robots-Tag: noindex, nofollow` that the app's answers carry |
| `GET /api/info` | `InfoResponse`, public, so it holds nothing private (below) |
| `GET /api/tunnel` | the Cloudflare quick tunnel for review links: `{available, running, url}` (the share action) |
| `POST /api/tunnel/start` · `/stop` | on a person's own machine, from the machine itself: start it (`{url}`; `501` without cloudflared, `504` when it isn't up within 30 s) or stop it (`{ok}`) |
| `GET /api/server/health` | the server's own owners and admins (workspace #1; anyone else's workspace `404`), people only: what a team will need, checked now → `ServerHealth` (below) |
| `POST /api/server/mail-test` | the same people: `{lang?}` → `{ok: true, to}`, one test mail sent now to your own confirmed address (the outbox without a relay); `502` with a sentence when the relay refuses, `429` after 3 in 10 minutes |

`InfoResponse` has the mode, the version, the public URL and `source_url`; `capabilities`, what this instance can do
(`linkFiles`, `localAgents`, `reveal`, `visionOcr`, `projectFiles`, `inboxFile`, `tunnel`, `lan`, `wakeAgents`; all
false on a hosted server), and `features` for older clients; `stt`, the speech engine (`backend`, `available`, `state`,
`model`, `device`, `error`, `progress`, `languages`: `model` is the model's name and `error` only says that the engine
isn't working, except for the server's operator ([whoever runs it](server-mode.md#the-operators-pages), signed in in the
browser on a hosted server; the machine's owner at the machine), who reads the model's path and the engine's own words;
the owner of another workspace gets the name only); `whisper`, `user` and `lan`; and for email and sign-up `mail` (email
flows work here: there is a public URL to build links from), `signup` (`off`, `invite` or `open`), the operator's legal
pages (`terms_url`, `privacy_url`, `imprint_url`, `withdrawal_url`, `cancel_url`:
[configuration.md](configuration.md#legal-pages); `null` when not set), `billing: true` where a billing provider runs,
plus, for admins, `mail_transport` (`log`: written to the server's outbox instead of sent, or `smtp`). Only a call from
the machine itself also gets the LAN link with its key (`urls`, `qr`) and the machine's paths (`dataDir`, `home`,
`root`).

`ServerHealth` (the server setup's health check): `public_url` `{ok, url}` (ok when set and https, or plain http on
this machine); `storage` `{ok, kind, writable, free_bytes, where}` (a local disk is written to and read back, with its
free space, and its data folder only for a call from the machine itself — `where` is `null` for anyone else, a phone
through the LAN link or a hosted server's admins; a bucket is checked and named, never its keys); `mail` `{ok, transport, from, relay}` (`relay`
the relay's host and port, never its user or password; `log` writes to the outbox); `stt` `{ok, state, model, device,
progress}` as in `/api/info`.

## MCP

| Route | What it does |
|---|---|
| `/mcp` | the MCP server over Streamable HTTP (below). Tools, resources and how to connect each client: [mcp.md](mcp.md) |

It speaks the current MCP spec (2026-07-28, stateless) and still serves 2025-06-18 and 2025-11-25 clients. On a
person's own machine it follows the same rules as the rest of the app; on a hosted server it needs
`Authorization: Bearer <API token or OAuth access token>`.

- **Signed out**, the answer is `401` with a `WWW-Authenticate: Bearer` challenge that names `resource_metadata` and the
  scopes (with `error="invalid_token"` when a token was sent but doesn't check out).
- **Scopes.** A tool call outside an OAuth app's scopes gets `403 insufficient_scope`.
- **Limits.** 600 requests a minute per account and 6,000 per workspace (then `429` with `Retry-After`); a request
  body is 1 MiB at most (`413`). Open waits and listens are capped per connection and per person
  ([mcp.md](mcp.md#security-hosted)).
- **Workspaces.** A token works in its own workspace, an OAuth app in the one it was allowed into.
- **Tools.** `?tools=lean` (or a comma-separated list of names) picks the tools it offers.
- **Change notifications** come through `subscriptions/listen`.
