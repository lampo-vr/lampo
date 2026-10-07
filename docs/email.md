# Email

A hosted server sends a few emails of its own: invites, confirming an address, password resets and notices about an
account. They are transactional, few and quiet. Nothing is sent for marketing, nothing tracks whether a message was
opened, and no message loads anything from the internet: the only picture is the app icon, carried inside the message.

To send them, give the server an SMTP relay and a sender:

```sh
VR_SMTP_URL='smtp://user:password@smtp.example.com:587'
VR_MAIL_FROM='Lampo <hello@review.example.com>'
```

Then try it on the server: `vr admin mail-test you@example.com` sends one message now and prints the relay's answer.
A self-hosted server's setup checks the same from the browser: its health check names the relay and sends a test mail to its owner (`POST /api/server/mail-test`).
With Brevo, the steps are [below](#sending-through-brevo). Without a relay nothing leaves the server: every message is
written to the **outbox** in the cache instead ([Testing without sending](#testing-without-sending)), and the server
says so in its log at start.

## What is sent, and when

| Email | Goes to | When | Link |
|---|---|---|---|
| Confirm your email address | the address someone signed up with | an open sign-up (`VR_SIGNUP=open`), or again with *Send it again* | `#/verify/vt_…`, once, 24 hours |
| Confirm your email address (invite) | the address someone gave when taking an invite on a hosted server | taking the invite | `#/verify/vt_…`, once, 24 hours; the person is in once it is opened (on the machine, an invite that named no address: the person is in already) |
| Confirm your new address | the new address | *Settings → Profile*: a new email | `#/verify/vt_…`, once, 24 hours; the old address stays until then |
| Your email address was changed | the old address | the new one was confirmed, or an admin changed it | — |
| Reset your password | the account's address | *Forgot password?* on the sign-in screen (a sign-up nobody confirmed gets its confirmation instead, whose page takes a new password too) | `#/reset/rt_…`, once, 60 minutes |
| Your password was changed | the account's address | a reset, a change in Profile, or an admin setting a temporary password | a link to *Forgot password?* |
| You're invited | the address an invite is made out to | *Settings → Users*: *Email the invite*, *Send again*, and on a hosted server *Add a user*; again when that address signs up (`VR_SIGNUP=invite`) | `#/invite/inv_…`, once, until the invite expires |
| Welcome | the person who signed up | the moment their address is confirmed | — |
| You already have an account | an existing account's address | someone tried to sign up with it | sign in, or *Forgot password?* |
| A new sign-in to your account | the account's address | a sign-in from a browser (or `vr login`) the account hasn't used before — **only when the person turned sign-in alerts on** (Settings → Notifications) | a link to *Forgot password?* |
| Your account was disabled / removed | the account's address | an admin disabled or removed it, or `vr admin delete-account --yes` deleted it | — |
| Your account is deleted | the account's address | the person deleted their own account (*Settings → Profile*) | — |
| Your workspace is suspended / works again | every member of the workspace not suspended there | the server's operator suspended the workspace, or lifted the suspension ([server-mode.md](server-mode.md#the-operators-pages)) | — |
| A workspace of yours was deleted | everyone who was in it, each told whether their account went with it | its owner (*Settings → Workspace*), the server's operator, or `vr admin delete-workspace --yes` deleted it | — |
| Email works | whoever you name | `vr admin mail-test` | — |
| A message about the workspace (a plan, a trial) | the workspace's owners and admins (or the roles asked for) | a billing provider asks ([server-mode.md](server-mode.md#a-billing-provider)) | a screen of the app, e.g. Settings → Billing |

Notices (changed, welcome, sign-in, disabled, removed, deleted, suspended) only go to an address that was confirmed: someone who typed a
wrong address never sends someone else their account's news. Accounts from before email count as confirmed, and so do
addresses an admin vouched for (the owner from setup, `vr admin create-user`, and on the machine *Add a user* and an
invite made out to that address; on a hosted server an invite vouches for nothing,
[below](#invites-on-a-hosted-server)).

Each email is in English or German: the language the account chose in Settings, else the language of the page the
person was on when they asked (sign-up, *Forgot password?*); an invite goes out in the inviter's language. A billing
provider's message carries its own words in each language it has (English always); the frame, the footer and the
button are the app's, and its link can only open a screen of this app. Like every notice it goes only to confirmed
addresses, never to a suspended member or a disabled account.

Every link is built from `VR_PUBLIC_URL`, with the token in the URL's fragment (`#/…`): browsers never send the fragment
to a server, so no token lands in the server's or a proxy's log. The page posts it. A newer link of the same kind
replaces the older one, and a new address or password ends every link sent before it: a reset link left in an inbox
the account moved away from resets nothing.

## Settings

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `VR_SMTP_URL` | `mail.smtp_url` | none: the outbox | `smtps://user:password@host:465` (TLS from the start) or `smtp://user:password@host:587` (STARTTLS, required). URL-encode `@` and `:` in the login and password (`%40`, `%3A`). A relay on this machine may be plain (`smtp://127.0.0.1:1025`). |
| `VR_MAIL_FROM` | `mail.from` | `Lampo <lampo@<public host>>` | The sender people see, e.g. `Lampo <hello@review.example.com>`. Required with SMTP; the relay must allow it (a verified sender or domain). |
| `VR_MAIL_REPLY_TO` | `mail.reply_to` | none | Where replies go. |
| `VR_MAIL_PER_HOUR` | `mail.per_hour` | 200 | The server's own cap: messages over it wait for the next hour instead of being dropped. Set it under your relay's quota. |
| `VR_MAIL_PER_WORKSPACE_HOUR` | `mail.per_workspace_hour` | a quarter of `VR_MAIL_PER_HOUR` | Each workspace's own share of that hour for the invites its admins email, and each account's for what it causes across all its workspaces (invites, address changes), so neither one team nor one account with several workspaces can use up everyone's budget. Over it, emailing an invite answers `429` with when to try again, before anything is made (the invite can still be made without emailing it, and its link copied), and an address change answers `429` too; an account changes its address at most 5 times an hour. Password resets go first, then sign-up confirmations, then the rest; the last quarter of `VR_MAIL_PER_HOUR` is kept for resets alone (all other mail takes three quarters at most, confirmations before the rest), so neither other mail nor a flood of sign-ups (anyone can sign up, a reset is someone locked out) holds a reset back past its link's hour. Of what one address asks for signed out (*Forgot password?*, *Send it again*), one message of a kind waits at a time; more are dropped, and the answer says the same. Only mail that went out counts toward the hour: a message whose link expired while it waited is dropped without counting. |
| `VR_SIGNUP` | `signup` | off | Who may sign up on their own ([below](#sign-up-vr_signup)). |
| `VR_TERMS_URL`, `VR_PRIVACY_URL` | `terms_url`, `privacy_url` | none | Linked from the sign-up screen (and the sign-in screen's foot); `VR_SIGNUP=open` needs both. |

The server refuses to start with settings that can't work, each with one sentence: an SMTP URL that isn't one, SMTP
without a sender, a sender or reply-to that isn't an email address, `VR_SIGNUP` other than off, invite or open,
sign-up without a public URL, `VR_SIGNUP=open` anywhere but a hosted server or without both `VR_TERMS_URL` and
`VR_PRIVACY_URL`, and terms or privacy links that aren't http(s). Credentials in `VR_SMTP_URL` are never logged and never sent to a browser; prefer the environment over
config.json for them.

### Sign-up (`VR_SIGNUP`)

- **`off`** (the default): no sign-up screen. Accounts come from setup, invites and admins (*Add a user with a
  temporary password*, which on a hosted server sends an invite instead).
- **`invite`**: *Create an account* on the sign-in screen, for addresses a pending invite is made out to. The person
  gives that address, and the invite goes to it again: its link makes the account (name and password are chosen
  there), in the invite's workspace and with its role (on a hosted server once that address is confirmed,
  [below](#invites-on-a-hosted-server)). Signing up makes no account and takes no invite, so knowing an
  invited address gets nobody anything. Any other address gets the same answer, and no email unless it has an account
  already.
- **`open`** (a hosted server only): anyone may sign up. Once their address is confirmed, each person gets a
  workspace of their own — empty, with them as its owner, named after them until they name it (their first run asks)
  — and never sees the existing team's ([server-mode.md → Workspaces](server-mode.md#workspaces)). Names only have to
  differ inside a workspace, so a sign-up is never told a name is taken by someone in another one. On a person's own
  machine `VR_SIGNUP=open` refuses to start.

An open sign-up is held until its address is confirmed: it can sign in, but sees only *Check your inbox* (send it
again, sign out), and the API answers `403` with `unconfirmed: true` for anything else. Its address can't change while
it is held: the confirmation goes to the address it signed up with and nowhere else, so a mistyped address is a new
sign-up. The confirm link lets it in and sends the welcome; which browser it signs in, and what it asks anywhere
else, is [below](#who-confirms-what-with-whose-password). Sign-ups nobody confirms within 7 days are removed; the
days count from the newest link sent to the address, so a link asked for late still finds its account. Nothing anyone
else does takes a held sign-up away, an invite's link for the same address included: its owner confirms it, takes the
address with *Forgot password?* (for a held sign-up that sends its confirmation, never a reset: the link goes to the
same inbox, and its page lets them in with a password of their own), or moves an account they have to it in
*Profile*. The link for a new address goes to an address only a held sign-up
has, and confirming it there removes the held sign-up; an address a confirmed account has gets no such link.

### Who confirms what, with whose password

A held account (an open sign-up, or an invite someone took on a hosted server) carries a password that whoever made
it chose, and that may not be the address's owner: anyone running a workspace can take their own invite with someone
else's address. The confirm link proves the inbox, never the password. So:

- **In the browser that chose the password** (the `vr_signup` mark the sign-up or the invite left there), or signed in
  as the held account itself, the link confirms the address, joins the invites taken with it and signs that browser in.
  The mark is per browser, not per sign-up: a second sign-up in the same browser keeps the first's link working there,
  and signing up again with the same password moves the link's sign-in to the browser that did.
- **Anywhere else** the page asks first and confirms nothing until it is answered (the link stays good): *type the
  password chosen when this account was made* (the same person on another device: confirmed, invites joined, signed
  in), or *choose a new one* (the address's owner when someone else made the account: their password from now on,
  every token and app the old one could have made is gone, and the invites taken with the old one are left behind,
  as after a reset). The page says what confirming would join: each invite's workspace (once named), role and inviter.
  Wrong passwords are limited per account.
- **Where someone else is signed in**, the link is refused and stays unused: opening someone's link never swaps a
  session.
- **Names tell people apart inside a workspace.** When someone there already goes by the account's name by the time it
  joins, the link is refused and stays unused, and the page asks for another name to join with.
- **A held account keeps the address it was made with.** One from an earlier release that still waits for a change of
  address loses it at the next start, and the link sent for it stops working: only the address's own inbox confirms it.
- **The address's owner never confirms someone else's password by asking.** Signing up with an address that has a held
  account: the same password sends its link again (now signing in this browser); any other password sends a reset
  link instead, so the inbox takes the address with the password just typed. With `VR_SIGNUP=invite`, asking for an
  invite sends the invites made out to the address as well as the held account's link. *Send it again* sends the held
  account's link, whose page asks as above.
- **Why *Send it again* sends the confirm link, not a reset.** Under the rules above the link is safe in anyone's hands
  but the person who chose the password: whoever else opens it must choose a password of their own, which drops the
  invites taken with the other one. A reset would also strand a real invitee who asks again from their own browser: the
  reset drops the invites they just took, and they would have to take them again.

### Invites on a hosted server

A hosted server has workspaces, and whoever runs one may be anyone (someone who signed up, with `VR_SIGNUP=open`, or
anyone signed in, with `VR_WORKSPACE_CREATE=anyone`): the person who made an invite holds its link as much as the
person it went to, so taking an invite proves no inbox. Someone who takes one gives a name, an address and a password,
and sees *Check your inbox*: the account is held (as above), in no workspace, until the confirm link mailed to that
address is opened. Then it joins the invite's workspace with its role, and the browser that took the invite is signed
in (opened anywhere else, the page asks for that password or a new one,
[above](#who-confirms-what-with-whose-password)). The invite stays pending until then, and the first account whose
address is confirmed takes it; a later one is told the invite was used.

An address that has an account joins with that account's own password (signed in, the invite screen asks only for
it). With anything else the answer is the same *Check your inbox* whatever the address, nothing changes, and the
address's inbox hears of it (an account's owner that someone tried, a held sign-up's owner a reset link). A reset link
proves the inbox too, but replaces the password the invite was taken with: after one, the person takes the invite
again. Without a mail relay these links wait in the outbox like everything else, so a hosted server meant for people
needs `VR_SMTP_URL`. On the machine (one team, no workspaces) an invite's link makes the account at once.

## Sending through Brevo

1. **The sender.** In Brevo, *Senders, Domains & Dedicated IPs → Domains → Add a domain* with the domain your `From`
   address uses (e.g. `review.example.com` or `example.com`), and add the DNS records it lists (see below). Then add the
   sender (`hello@review.example.com`) under *Senders*.
2. **An SMTP key.** *SMTP & API → SMTP*: note the **SMTP server** (`smtp-relay.brevo.com`), the **login** (it looks like
   an email address) and generate an **SMTP key** — not an API key; that is the password. Keep it out of chat and
   commits.
3. **The server** (the login's `@` written as `%40`):

   ```sh
   VR_SMTP_URL='smtp://123abc%40smtp-brevo.com:<smtp key>@smtp-relay.brevo.com:587'
   VR_MAIL_FROM='Lampo <hello@review.example.com>'
   VR_MAIL_PER_HOUR=12      # Brevo's free plan sends 300 a day
   ```

   Port 587 is upgraded with STARTTLS, and Lampo refuses to send without it. Port 465 works too (`smtps://…:465`, TLS
   from the start), but Hetzner Cloud blocks outgoing ports 25 and 465 by default: use 587 there.
4. **Try it** on the server: `vr admin mail-test you@example.com` sends one message now, through these settings, and
   prints the relay's answer or its error (a wrong key, a blocked port, a sender Brevo doesn't know). Then check the
   message's headers in your mail client: `dkim=pass`, `spf=pass`, `dmarc=pass`.

## SPF, DKIM, DMARC

Mail from your domain is believed when the receiving server can check it. Brevo's *Domains* page shows the exact records
for your account; add them as given, then press *Authenticate*.

- **Domain code**: a `TXT` record (`brevo-code:…`) that proves the domain is yours.
- **DKIM**: Brevo signs every message; the record (`TXT` or two `CNAME`s under `…._domainkey`) publishes the key that
  checks the signature. This is the one that matters most: it survives forwarding, and it aligns with your `From`
  domain, which is what DMARC asks for.
- **SPF**: says which servers may send for a domain. Brevo sends with its own bounce domain, so SPF passes for Brevo's
  domain; if your domain already has an SPF record for other senders, keep it to one record (`v=spf1 … ~all`).
- **DMARC**: tells receivers what to do when neither check aligns, and where to report. Start with monitoring, then
  tighten once the reports show only your own senders:

  ```
  _dmarc.example.com  TXT  "v=DMARC1; p=none; rua=mailto:dmarc@example.com"
  # weeks later
  _dmarc.example.com  TXT  "v=DMARC1; p=quarantine; rua=mailto:dmarc@example.com"
  ```

Gmail and Yahoo expect SPF or DKIM, and DMARC, from anyone sending them mail. Use a domain (or a subdomain such as
`mail.example.com`) you control; never a free-mail address as the sender.

## Testing without sending

With no `VR_SMTP_URL` every message goes to `<cache>/outbox/` (`VR_CACHE`, `cache/` next to the store by default) as
three files: `<time>-<n>-<kind>-<id>.json` (headers, text and HTML, the address, the language), `.eml` (the message as it
would be sent: open it in Mail or Thunderbird) and `.html` (a preview a browser opens). They hold live links, so they are
readable by the server's user only; the newest 300 are kept. Every test and every browser suite uses this transport and
reads the links back from the outbox; the suites drop any mail setting from the shell, so a test never reaches a relay.

A mail catcher on your own machine works too: `VR_SMTP_URL=smtp://127.0.0.1:1025` with Mailpit or MailHog (plain SMTP
is allowed only to this machine).

## Details

Answers that must not tell whether an address has an account (sign-up, *Forgot password?*, *Send it again*, taking an
invite) are the same either way, and what an existing address costs the server (a link made, an email queued) runs a
random 100–500 ms after the answer, never right after it, where the next request would feel it.

- **A request never waits for a relay.** It hands the message to a small queue (`data/mail/queue.json`, readable only
  by the server's user, each message sealed with a key derived from the store's secret, so the file alone gives no
  link away) and answers. The queue sends in the background and keeps what waits across restarts.
- **Retries**: a relay that is down or answers 4xx is tried again after 30 s, 2, 10 and 30 min, then 1, 2, 4 and 8 h
  (about 16 hours in all). A 5xx answer (an address that doesn't exist, a refused sender) is not tried again. A message
  whose link expired meanwhile is dropped.
- **Limits**: at most 8 messages an hour and 30 a day to one address (an address can't be flooded through *Forgot
  password?* or invites), and `VR_MAIL_PER_HOUR` for the whole server. Asking for links is limited too: 5 an hour per
  address asked about, 20 per 15 minutes per client, 30 wrong links per 15 minutes per client.
- **Answers that tell nothing**: sign-up, *Forgot password?* and *Send it again* answer `{ok: true}` whether or not the
  address has an account, and take as long either way.
- **One address, one spelling.** An address typed for a sign-up, an invite or a change of address is kept in Unicode
  NFKC and lower case, its domain in its ASCII form (`exämple.com` → `xn--exmple-cua.com`) without a trailing dot:
  full-width letters or the Kelvin sign are the same address, never a second account. The part before the @ is plain
  ASCII (the mailer speaks no SMTPUTF8, and a letter from another script that looks like ours would make another
  account), and nothing invisible (zero-width spaces, joiners, direction marks) or that no email can reach (quotes,
  commas, brackets, colons) is an address: whatever an account is made out to, the mailer sends to. Accounts made
  before keep their addresses and sign in and ask for links with them as they were typed; no second account can be made
  in another spelling of one. Sign-in limits count every spelling of an address as one.
- **Logs** name a recipient only by a keyed hash (`mail: sent reset to 3f9a1c27b0 (smtp)`) and never print a link, a
  token or an address. `<cache>/outbox/` is the only place a message's content is kept (the log transport only).

The API is in [api.md](api.md#email-sign-up-addresses-and-passwords); the settings next to the others in
[configuration.md](configuration.md#email) and [server-mode.md](server-mode.md#configuration).
