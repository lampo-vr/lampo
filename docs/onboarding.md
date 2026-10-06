# The first run

What someone new sees in their first minutes, so they reach the moment Lampo is for — a note on a frame, an agent
picking it up, a fix checked — before anything else. It starts after the first successful sign-in (on the person's own
machine: the first start), teaches by doing, and gets out of the way.

An instance whose people know Lampo already turns it off for new accounts with `VR_ONBOARDING=off` (or
`onboarding: false` in config.json).

## Who sees it

An account starts with a first run when it is made: the owner who sets up a hosted server, someone who signs up on
their own (with a workspace of their own, [email.md](email.md#sign-up-vr_signup)), everyone who accepts an invite or is
created by an admin (`vr admin create-user` too), and the machine's owner on its very first start (a store without a
video). **Accounts from before the first run existed have none and never see it**: someone who already uses Lampo is
never greeted like a newcomer.

It lives on the account, so it follows the person from device to device. It has two parts: **the setup**, once, on the
first visit, and **Get started**, a card in the library until its steps are done or it is put away.

## The setup

A new account's first visit opens on `#/welcome` (the library sends it there while `setup_due` is set): Welcome, then a
few steps, **every one skippable** ("Skip setup" at the top, "Skip to the library" on Welcome). Each step has its
picture on a light table beside it (a band on top on a phone) that follows what is typed and picked: the workspace's
name on the review link's mail and the browser tab, the agent's status, the people invited. Which steps there are
depends on where the app runs (`setupVariant`, `setupStepsFor` in [lib/setupFlow.ts](../lib/setupFlow.ts)):

| Where | Steps after Welcome |
|---|---|
| **Lampo Cloud** (the owner of a workspace made at their own sign-up) | the workspace's name · who the videos are for · the agent · the team |
| **Invited** into someone else's workspace | the agent (Welcome names the workspace and who invited them) |
| **A self-hosted server** (an owner or admin of its first workspace) | the workspace's name · the health check · the team · the team's agents |
| **The machine** (the app on the person's own computer) | where exports land · the agent installed · the sample |

- **Welcome** on Lampo Cloud shows the trial ("Team trial · 14 days · no card", from the billing provider); a sign-up from
  the website's pricing (`?plan=cloud-solo|cloud-team|cloud-business` on the sign-up link, carried through the confirm
  link) is still a Team trial, and Get started offers the plan picked.
- **Who the videos are for** (for other brands, for our own brand, for my channel, something else in a few words; several at
  once) is kept on the workspace (`personas`, `personaOther`). It changes a few words, the role an invite starts with
  (in-house teams invite reviewers) and Get started's order. A channel alone has no team step.
- **The agent**: Claude Code, Codex, Cursor, ChatGPT, Claude or any MCP client, or none yet. Picking one shows its connect
  block in place (the line or the file it needs, made from the same snippets as Settings → Connect an agent), and its
  status is live: "Waiting for Claude Code…" turns into "Connected · Claude Code from Mia's MacBook" the moment it
  calls (the connected-agents registry, over the live events; no polling). On a hosted server "Use an API token
  instead" makes one in place. At the machine the agents installed say *Found* (looked for on PATH and in the usual
  places, never run).
- **The team**: rows of email and role. A pasted list splits into rows, each row checks itself (an address, not your
  own, not twice), *Send* sends the good ones. Without a mail relay the invites become links to send yourself. When a
  billing provider runs, the step says what a seat costs.
- **The health check** (a self-hosted server's owner): the public address, the storage (written and read back, the free
  space), the mail relay (with *Send a test mail* to the owner's own address, and the lines to set when there is none)
  and the speech engine (with the model's download progress). Nothing in it blocks.
- **Where exports land** (the machine): folders with videos in a few likely places (`~/Movies`, `~/Desktop`,
  `~/Downloads` and the folder *Add video* browses from), or *Another folder…*; *Link N videos* links them where they
  are, nothing copied.

The end of the setup (finished or skipped) is kept on the account (`setup_done`); `#/welcome` shows it again on request.

## Get started

A card above All videos: the steps on a keyframe track on the left, the selected one at work on the right — connect the
agent, link or upload a video, make a review link, invite someone, right there (an accordion on a phone). It folds to
one line ("Next: Share a review link"), `×` puts it away (with Undo; the account menu's **Get started · 2/5** brings it
back while a step is open), and a workspace that picked a plan on the website sees "You picked Team · add a card any
time" (to Settings → Billing). On the machine it offers `vr export` for later, to take everything to a server or Lampo
Cloud. Once every step is done it says *You're set* and folds away for good.

Each role gets the steps that make sense for it, in an order that follows where the app runs and who the videos are for
(`stepsFor` in [lib/onboarding.ts](../lib/onboarding.ts)):

| Who | Steps |
|---|---|
| reviewer | Try the sample · Leave a note on a frame · Approve a version |
| member | Try the sample · Connect your agent · Add your first video · Share a review link |
| the machine's owner | Try the sample · Link your first video · Connect your agent · Share a review link |
| a Cloud workspace's owner | Try the sample · Connect your agent · Add your first video · Share a review link · Invite a teammate (in-house: the invite before the video; a channel alone: no invite) |
| a self-hosted server's owner or admin | Try the sample · Add your first video · Connect your agent · Invite a teammate · Share a review link |

"Connect your agent" names the agent picked in the setup ("Connect Claude Code"). The steps go by the person's role
**in the workspace they work in** and count only what happens there: its videos, notes, links, invites, agents, tokens
and apps.

**A step ticks itself off from real state, never from a click on the list.** Lampo looks at what is there and records
each step the first time it sees it done, so deleting the video later doesn't take the tick back:

| Step | Done when |
|---|---|
| sample | the person checked the sample's fix (*Looks right* or *Still wrong*) or answered its agent's question |
| video | the library has a video that isn't the sample |
| note | a note of the person's own (by account) on any video, the sample included |
| agent | an agent connected for the person (over `/mcp` or `vr watch`; at the machine, any local agent), one of their API tokens or connected apps was used, or — at the machine — the live monitor saw an agent at work |
| share | a review link they made (revoked ones count) |
| invite | an invite they made (any state) |
| approve | they approved a version or requested changes on one |

The card follows what happens without a reload (a video added, a note, an agent connecting), and so do the empty states
that point at the next step: the bell's popover and the Inbox ("Connect an agent: its questions and the fixes it makes
land here for you"), and Insights' Agents card.

## The sample

*Lampo sample.mp4* (German: *Lampo-Beispiel.mp4*), in a project *Sample*: five seconds of Lampo's own brand film in
two versions, frame for frame the same, with the title "EVERY MILE, ON THE RECORD." over the car in V1 and moved onto
the hill in V2. On it, the loop as a team lives it: Alex's must on V1 where the title covers the car, fixed by the
agent in V2 and waiting for a check; Alex's idea on the opening with the agent's answer; and the agent's question on
V2 ("Should the title fade out before the bend, or hold to the end card?") with two answers to pick. The inbox shows
the question and the fix to check. The setup's last step on the machine and Get started open it in check mode on its
fix, and its agent wears the name of the one picked in the setup ("Claude Code · fixed in V2"; stored as *Sample
agent*). Once its fix is checked and its question answered during the visit, the player says **That's the loop** — a
note on an exact frame, the agent's fix in V2, the check before and after — with the way back to the library.

**It is in the library from the start.** When an account starts its first run in a workspace of its own — the one an
open sign-up's confirmation makes, the server's first workspace after its setup page, the machine's store on its first
start — the sample is made in the background in that workspace, in the person's language (`server/firstSample.ts`).
People invited into a workspace find its sample, if it still has one; they never make another. An instance that wants
no sample unasked turns it off with `VR_ONBOARDING_SAMPLE=off`; it is still made on request (`POST
/api/onboarding/sample`), once per workspace — asking again hands back the one there is.

It is **clearly a sample** (its name, its project, a *Sample* chip on its card) and **a playground**: none of its
events is logged, so no agent's feed (`vr watch`, `wait_for_feedback`), INBOX.md, webhook or push hears of it, and
agents' listings leave it out (`vr ls`, `vr folders`, MCP `list_videos`, `list_folders`, the `vr://review` resources):
asked for by name or id (`vr open`, `get_open_notes`, `vr show`, `get_note`), it says `SAMPLE: …` first, with no
notes to work through. Insights, the taste file and playbook suggestions leave it out, it never counts as the person's
first video or against a plan. *Remove sample* in its menu deletes it for good (the review, its notes and
screenshots, its renders in storage). Making or removing it takes the right to upload: a few times per workspace in
ten minutes (then `429`), never past a hosted server's full job queue.

**Where it comes from.** The two versions are committed in [lib/sample-film/](../lib/sample-film/) (about 320 KB each:
960 × 412, 24 fps, 121 frames, H.264 with a soft chord as sound) and uploaded like any render — copied first, through
the storage adapter (local disk, Bunny or S3) — so making the sample needs no browser, font or generator on the
server. The footage is Lampo's own, AI-generated with Higgsfield for the project's website; the full film it is cut
from isn't in this repository. To make the two files again from that film:

```sh
node scripts/sample-film.ts <film.mp4>
```

It sets the title in headless Chrome exactly as the onboarding's pictures set it (Instrument Sans), lays it over the
film with ffmpeg and prints the title boxes `SAMPLE_TITLE` in [lib/sample.ts](../lib/sample.ts) keeps; the same film
gives the same files, byte for byte. `test/unit/sample.test.ts` holds the pair to being frame-exact: the same frames,
and the same pixels everywhere but where the titles sit.

## Details

- The first run is the account's `prefs.onboarding` ([data-format.md](data-format.md)): when it started, each step's
  first time, `hidden`, `complete`. An account without it never sees one. `VR_ONBOARDING` decides only whether new
  accounts get it.
- `GET /api/onboarding` finds the facts and records them; `PUT /api/onboarding {hidden, setup, agent}` puts it away
  or brings it back, ends the setup and keeps the agent picked; `POST` and `DELETE /api/onboarding/sample` make and
  remove the sample; `GET /api/onboarding/folders` and `/agents` are the machine's finds; `GET /api/server/health` and
  `POST /api/server/mail-test` the health check; `PUT /api/workspaces/current/persona` who the videos are for
  ([api.md](api.md#the-first-run)).
- The steps per role are in [lib/onboarding.ts](../lib/onboarding.ts), the setup's in
  [lib/setupFlow.ts](../lib/setupFlow.ts), the sample in [lib/sample.ts](../lib/sample.ts). The screens are in
  `web/src/onboarding/` (the setup, its light table and Get started, each loaded on demand).
  The sample's review carries `onboarding_sample` from its first write (`isSample()`): anything that counts videos
  for a plan or a limit must skip it, as Insights and the event log do.
- Get started's room is held before the account is known because the browser remembers it showed
  (`web/src/lib/chromeHint.ts`). The room is the card's own height by design: every step's pane stands in one grid
  cell (only the selected one shown) inside a pane room set per width in `web/src/styles/onboarding.css`, taller
  while a picked agent's connect form shows; `roomOf` in `web/src/onboarding/state.ts` gives the first paint the
  same classes (folded, the machine's foot, a phone's number of steps). A new step or state must fit that room in
  English and German; `test/e2e/getstarted.mjs` holds the card and the library under it still to the pixel.
- What is inside Get started's panes is styled by `web/src/styles/getstarted.css`, which comes with its code: it
  uses the app's own controls and never another chunk's stylesheet.
