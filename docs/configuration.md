# Configuration

Lampo needs no configuration: start it and it works. To change something, set an environment variable or put the
setting in a config.json file. The environment wins over the file, and both are read when the app starts, so restart
it after a change.

Most people only ever touch a few settings:

| You want to… | Set |
|---|---|
| use another port | `LAMPO_PORT` |
| keep the store somewhere else | `data_dir` in config.json, or `LAMPO_HOME` |
| run a server for a team | `LAMPO_MODE=server` and `LAMPO_PUBLIC_URL` ([server-mode.md](server-mode.md)) |
| keep renders in Bunny or S3 | `LAMPO_STORAGE` and its keys ([below](#where-renders-live-hosted)) |
| send invites and password resets by email | `LAMPO_SMTP_URL` and `LAMPO_MAIL_FROM` ([below](#email)) |
| turn voice notes off | `LAMPO_STT=off` |

Every other setting is in the tables below, grouped by topic, with its default.

## config.json

Lampo uses the first of these files that exists:

1. the file named by `LAMPO_CONFIG`;
2. `config.json` in the app's own folder (where you cloned it);
3. `~/.video-review/config.json` (in the folder named by `LAMPO_HOME`, when that is set).

A config.json for your own machine might be:

```json
{
  "user": "Alex",
  "browse_root": "~/work",
  "data_dir": "~/Reviews/data"
}
```

Folders in it may start with `~`, and a relative folder counts from the file's own folder. A file that isn't valid
JSON is ignored as a whole: the app then starts with the defaults.

The app's Settings page holds what people change while it runs: their profile, theme, language and API tokens, the
export of their own data (and on a hosted server, deleting their account), and for admins the users, invites,
webhooks and, on a hosted server, the workspace's name (its owners also delete it there). It also shows what the
settings on this page add up to (the speech engine, Auto-check's dictionary, ready-to-copy agent configs, the
version, the legal pages), but it doesn't change them.

## Where data lives

A store is three folders:

- **data** holds the reviews, notes and screenshots: the files agents read. Back it up.
- **versions** holds the bytes of every version of every video. It can't be rebuilt: back it up.
- **cache** holds posters, waveforms, playback copies, analysis, transcripts and the speech model. It is rebuilt when
  needed, so it is safe to delete while the app is stopped, except for `cache/uploads/` (uploads in progress).

<!-- picture: store-folders — the three folders of a store side by side: data (reviews and screenshots, back up), versions (every render, can't be rebuilt, back up), cache (rebuilt on demand) -->

Where the store is, first match wins:

| When | data | versions |
|---|---|---|
| `LAMPO_DATA` names a folder | that folder | the same name with `-versions` added |
| config.json has `data_dir` | that folder | `versions` next to it if the folder is called `data`, else the name with `-versions` added |
| the app's folder has a `data` folder (a checkout used in place) | `data` in the app's folder | `versions` in the app's folder |
| otherwise | `~/.video-review/data` | `~/.video-review/versions` |

The cache goes next to data the same way; a data folder with another name gets a cache named after it, ending in
`-cache`. With `LAMPO_DATA`, the cache is the one in the app's folder (when that has a data folder) or in
`~/.video-review`.

You can move single folders too:

- `LAMPO_CACHE` or `cache_dir` in config.json puts the cache anywhere;
- `versions_dir` in config.json puts the versions anywhere (not with `LAMPO_DATA`, which always keeps its own);
- `LAMPO_HOME` moves `~/.video-review` as a whole, its config.json included. The Docker image sets `LAMPO_HOME=/data`, so
  one volume holds everything.

`LAMPO_DATA` is how tests and the demo get a store of their own: its versions never mix with another store's.

## Settings

Every variable is named `LAMPO_…`. Its older spelling, `VR_…` (the command was `vr` before it was `lampo`), is still
read wherever the `LAMPO_` one is unset or empty, so an env file from before works unchanged; where both are set,
`LAMPO_` wins. The checks at start name a setting the way you wrote it. A setting given in both spellings with different
values is named once in the log at start (names only, never the values), and so is an empty `LAMPO_` setting that
leaves its `VR_` one in force: remove the older line, or give the new one a value. `LAMPO_SERVER` and `LAMPO_TOKEN`
come as a pair: both `LAMPO_` when either is set, else both `VR_`, so one server's token never goes to another.

### Running the app

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_PORT` | `port` | 4747 | The port to listen on. |
| `LAMPO_HOST` | `host` | 127.0.0.1 on your machine, 0.0.0.0 on a server | The address to listen on. |
| `LAMPO_LAN` | | off | `1` also serves your Wi-Fi, like `npm run lan` (on your machine only). |
| `LAMPO_USER` | `user` | your OS account name | On your machine, the name your owner account starts with (change it later in Settings → Profile). Also the author of writes that name nobody. Unlike every other setting, config.json wins over the variable here. |
| | `browse_root` | your home folder | Where *Link a file on this machine* starts browsing. Project names are counted from it. |
| `TMPDIR` | | the system's | Where temporary files go (Auto-check's frames, pictures and clips being checked). The Docker image puts it on its volume. |

To start it on your machine:

```sh
npm start      # http://localhost:4747, signed in as you (builds the UI on first start)
npm run dev    # the same with hot reload, for work on the UI
npm run lan    # also on your Wi-Fi: prints a link with an access token for your phone
```

A phone on your network opens the printed link once; from then on a cookie lets it in. The machine itself needs
nothing. For phones away from home, run a hosted server.

### Hosting

These matter on a server other people reach. Setting one up: [server-mode.md](server-mode.md) and
[docker.md](docker.md).

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_MODE` | `mode` | local | `server` makes this a hosted server: everyone signs in, and nothing on the machine it runs on is reachable (no linked files, no Claude Code sessions). |
| `LAMPO_PUBLIC_URL` | `public_url` | none | The address people open: scheme and host only, such as `https://review.example.com` (a path is refused). Only this host name (and localhost) is served, writes must come from this address, emailed links are built from it, and on https cookies are marked Secure. Required on a hosted server. Plain `http://` is refused at start unless the host is this machine or `LAMPO_ALLOW_HTTP=1`. |
| `LAMPO_ALLOW_HTTP` | | off | `1` lets a hosted server start with a plain-http `LAMPO_PUBLIC_URL` on another host (a closed test network); passwords and cookies then cross the network unencrypted. |
| `LAMPO_ALLOW_NO_PUBLIC_URL` | | off | `1` starts a hosted server without a public URL anyway, for a quick local test. It then reports itself not ready. |
| `LAMPO_TRUST_PROXY` | `trust_proxy` | none | Behind a reverse proxy: which proxies may tell the app the visitor's address and that the connection is https. Addresses, subnets, `loopback` (a proxy on this machine), `uniquelocal` (a private network, such as the compose network) or `linklocal`, separated by commas. Hosted servers only. Required when `LAMPO_PUBLIC_URL` is https: the server refuses to start without it (`false` says on purpose that no proxy forwards addresses). |
| `LAMPO_MEDIA_ORIGIN` | `media_origin` | none | A second host name of this server that serves video by signed URLs and nothing else, such as `https://media.example.com`: scheme and host only, https unless it is this machine, never the public URL's host. The player, review links, downloads and folder zips are redirected there, and one-time upload URLs point there. For an app host behind a CDN proxy that must not carry video ([server-mode.md](server-mode.md#a-host-of-its-own-for-video)). Hosted servers only. |
| `LAMPO_SOURCE_URL` | `source_url` | the project's repository, `https://github.com/lampo-vr/lampo` (`repository` in package.json) | Where people get this instance's source code. The default is right for an unmodified copy. The AGPL-3.0 asks anyone who runs a changed copy for others to offer its source: point this at your fork. The sign-in screen, Settings, review-link pages and the MCP server link to it; a hosted server with none at all (a package.json without `repository`, and nothing set) warns at start. |
| `LAMPO_ORG_NAME` | `org_name` | none | Your team's name (an agency, a studio), shown on review links next to the person who shared them: "Alex · Northwind Studio shared …". On a hosted server with several workspaces it is the first workspace's: the links of every other workspace show that workspace's own name, and no team name while a sign-up's workspace still has the name it started with. It also names the team in the subject of invite emails, and is the first workspace's name until someone renames it. |
| `LAMPO_WORKSPACE_CREATE` | `workspace_create` | `owners` | Who may make a [workspace](server-mode.md#workspaces) in the app on a hosted server: `owners` (whoever runs the server: `LAMPO_OPERATOR`, else the first workspace's owners), or `anyone` signed in, each account up to `LAMPO_WORKSPACE_CREATE_LIMIT`. Sign-up (`LAMPO_SIGNUP=open`) gives each person a workspace of their own either way. |
| `LAMPO_WORKSPACE_CREATE_LIMIT` | `workspace_create_limit` | 3 | With `LAMPO_WORKSPACE_CREATE=anyone`: how many workspaces one account may make, the one its sign-up gave it included. Whoever runs the server has no limit. |
| `LAMPO_OPERATOR` | | the owners of the first workspace | Who runs this server: accounts by email address (once confirmed) or account id, separated by commas or spaces, at most 20. They see the [operator's pages](server-mode.md#the-operators-pages) (every workspace and account; suspending or deleting a workspace), the server's setup and health check, and make workspaces without a limit. An entry that matches no account is named in the log at start. Hosted servers only. |
| `LAMPO_CLOUD_MODULE` | | none | The file of a module that adds plans and billing to a hosted server, loaded at start ([server-mode.md → A billing provider](server-mode.md#a-billing-provider)). Lampo Cloud's is one, kept outside this repository. Leave it unset: a self-hosted server is complete without it. A module that can't be loaded stops the start. |
| `LAMPO_DOMAIN` | | none | Docker compose only: the domain Caddy gets a certificate for. |

### Uploads and disk

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_UPLOAD_MAX` | `upload_max_bytes` | 20 GB | The largest upload accepted. The variable takes a size like `50GB`; config.json takes bytes. |
| `LAMPO_MIN_FREE` | `min_free_bytes` | 2 GB | Free disk to keep for data, cache and locally stored renders. Below it the server reports not ready, and uploads that don't fit are refused (with what the uploads under way still have to send). `0` keeps no reserve. |
| `LAMPO_MAX_SIDE` | | 8192 | The most pixels an uploaded render may have on either side. |
| `LAMPO_MAX_DURATION` | | 14400 (4 hours) | The longest an uploaded render may be, in seconds. |
| `LAMPO_MAX_ASPECT` | | 8 | How much longer an uploaded render's long side may be than its short one: 8 allows 8:1 and 1:8. Raise it for LED ribbon boards and the like; analyses squeeze anything taller than 1:4 either way, so a thin render costs no more than a square one. |
| `LAMPO_MEDIA_TIMEOUT` | | 3600 | Seconds one ffmpeg run may take before it is stopped. |

Uploads are also refused above 240 frames per second and under 32 pixels on a side; those limits are fixed.

### Where renders live (hosted)

On your machine renders always stay on disk. A hosted server can keep them in Bunny Storage or any S3-compatible
bucket instead; the steps are in [server-mode.md](server-mode.md#storage). In config.json these settings sit in a
`storage` section (example under [Details](#details)).

| Variable | config.json `storage` | Default | What it does |
|---|---|---|---|
| `LAMPO_STORAGE` | `kind` | local | `local`, `bunny` or `s3`. |
| `LAMPO_BUNNY_ZONE` | `bunny.zone` | | The storage zone's name. Required for Bunny. |
| `LAMPO_BUNNY_ACCESS_KEY` | `bunny.access_key` | | The storage zone's password (under *FTP & API Access*), not your account's API key. Required for Bunny. |
| `LAMPO_BUNNY_REGION` | `bunny.region` | de (Frankfurt) | The zone's region: de, uk, ny, la, sg, se, br, jh or syd. |
| `LAMPO_BUNNY_CDN_URL` | `bunny.cdn_url` | none | The pull zone in front of the storage zone; needs `LAMPO_BUNNY_TOKEN_KEY`. Without it the server streams the video itself. |
| `LAMPO_BUNNY_TOKEN_KEY` | `bunny.token_key` | none | The pull zone's token authentication key: video links are signed and expire after 6 hours. Required with `LAMPO_BUNNY_CDN_URL`: a server with a CDN address and no key refuses to start. |
| `LAMPO_BUNNY_PREFIX` | `bunny.prefix` | none | A folder inside the zone. |
| `LAMPO_BUNNY_STORAGE_URL` | `bunny.storage_url` | the region's address | Another Bunny Storage API address (a region added later, or a test double). |
| `LAMPO_S3_ENDPOINT` | `s3.endpoint` | | The provider's S3 address. Required for S3. |
| `LAMPO_S3_REGION` | `s3.region` | auto | The provider's region name. |
| `LAMPO_S3_BUCKET` | `s3.bucket` | | Required for S3. |
| `LAMPO_S3_ACCESS_KEY_ID` | `s3.access_key_id` | | Required for S3. |
| `LAMPO_S3_SECRET_ACCESS_KEY` | `s3.secret_access_key` | | Required for S3. |
| `LAMPO_S3_PREFIX` | `s3.prefix` | none | A folder inside the bucket. |
| `LAMPO_S3_PRESIGN` | `s3.presign` | true | Browsers fetch video straight from the bucket, with links that expire after 6 hours. `false` streams it through the server. |
| `LAMPO_WORK_CACHE` | `work_cache_bytes` | 20 GB | The most disk the local working copies of remote renders may take (ffmpeg needs files). |

### Accounts and sign-up

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_SESSION_DAYS` | | 30 | A sign-in lasts at most this many days. |
| `LAMPO_SESSION_IDLE_DAYS` | | 14 | A sign-in ends after this many days without use. |
| `LAMPO_SIGNUP` | `signup` | off | Who may sign up on their own: `off`, `invite` (an address a pending invite names gets the invite again, and its link makes the account) or `open` (anyone, each into a workspace of their own; a hosted server only). Anything but `off` needs `LAMPO_PUBLIC_URL` ([email.md](email.md#sign-up-vr_signup)). |
| `LAMPO_TERMS_URL`, `LAMPO_PRIVACY_URL` | `terms_url`, `privacy_url` | none | Your terms and privacy policy, linked from the sign-up screen, the sign-in screen's foot, *Settings → About*, the checkout of a billing provider, and a review link's foot (privacy). `LAMPO_SIGNUP=open` refuses to start without both ([legal pages](#legal-pages)). |
| `LAMPO_ONBOARDING` | `onboarding` | on | New accounts start with the first-run checklist ([onboarding.md](onboarding.md)); `off` for an instance whose people know Lampo already. Accounts from before never get one. |
| `LAMPO_ONBOARDING_SAMPLE` | `onboarding_sample` | on | With `onboarding`: an account that starts in a workspace of its own (an open sign-up, the server's setup, the machine's first start) finds the sample in its library, made in the background ([onboarding.md](onboarding.md#the-sample)); `off`: only when someone asks for it. |

### Legal pages

Lampo links your own pages; it never writes them. Each must be an http(s) URL, or the server refuses to start. None is
required, except the terms and the privacy policy for an open sign-up. The withdrawal and cancellation pages matter
only where a billing provider sells plans ([server-mode.md](server-mode.md#a-billing-provider)).

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_IMPRINT_URL` | `imprint_url` | none | Who runs this server (an imprint, § 5 DDG in Germany): at the foot of the sign-in screens and of every review link's page, and in *Settings → About*. |
| `LAMPO_TERMS_URL`, `LAMPO_PRIVACY_URL` | `terms_url`, `privacy_url` | none | As above; open sign-up needs both. |
| `LAMPO_WITHDRAWAL_URL` | `withdrawal_url` | none | The withdrawal information for consumers, linked above the checkout's order button and in *Settings → About*. |
| `LAMPO_CANCEL_URL` | `cancel_url` | none | A page where anyone cancels a contract without signing in (*Cancel contracts here*, § 312k BGB), linked at the foot of the sign-in screens and in *Settings → About*. Without it, where a billing provider runs, the same link opens *Settings → Billing*'s own cancellation, after signing in. |

### Email

A hosted server emails invites, sign-up confirmations, password resets and account notices ([email.md](email.md)).
In config.json these settings sit in a `mail` section.

| Variable | config.json `mail` | Default | What it does |
|---|---|---|---|
| `LAMPO_SMTP_URL` | `smtp_url` | none | The relay email goes out through: `smtps://user:password@host:465`, or `smtp://user:password@host:587` (STARTTLS, required unless the relay is on this machine). URL-encode `@` and `:` in the login and password. Without it every email is written to `outbox/` in the cache instead. |
| `LAMPO_MAIL_FROM` | `from` | `Lampo <lampo@<public host>>` | The sender people see; required with `LAMPO_SMTP_URL`. |
| `LAMPO_MAIL_REPLY_TO` | `reply_to` | none | Where replies go. |
| `LAMPO_MAIL_PER_HOUR` | `per_hour` | 200 | The server's own cap on emails an hour; more wait for the next hour. |
| `LAMPO_MAIL_PER_WORKSPACE_HOUR` | `per_workspace_hour` | a quarter of `LAMPO_MAIL_PER_HOUR` | Each workspace's own share of that hour for the invites it emails, and each account's across its workspaces (invites, address changes); password resets and sign-up confirmations go first ([email.md](email.md#settings)). |

### Notifications

Webhooks tell Slack, Discord or any other service about client activity ([sharing.md](sharing.md#webhooks)). One can
come from the environment, more from config.json (a `webhooks` list), and admins add others in Settings →
Notifications. Hooks from config.json or the environment belong to the first workspace; every other workspace adds
its own there.

| Variable | config.json `webhooks[]` | Default | What it does |
|---|---|---|---|
| `LAMPO_WEBHOOK_URL` | `url` | none | Where to send. |
| `LAMPO_WEBHOOK_FORMAT` | `format` | json | `json`, `slack` or `discord`. |
| `LAMPO_WEBHOOK_SECRET` | `secret` | none | Signs each delivery (the `X-VR-Signature` header). |
| `LAMPO_WEBHOOK_EVENTS` | `events` | client | `client` (clients' notes, replies, fix checks, approvals and downloads), `all`, or event types separated by commas. |

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_WEBHOOK_ALLOW_PRIVATE` | `webhooks_allow_private` | off | A hosted server sends webhooks to public addresses only. `1` lets the first workspace's webhooks (the operator's own team) reach private ones too (a chat server on your own network); every other workspace's stay on public addresses. On your machine they go anywhere. |
| `LAMPO_PUSH_SUBJECT` | `push_subject` | the public URL when it is https, else `mailto:lampo@localhost` | The contact Apple, Google, Mozilla and Microsoft see with each push notification: a `mailto:` address or an https URL ([mobile.md](mobile.md#notifications)). |

### Voice notes and transcripts

What each option does, and how to pick a model: [speech.md](speech.md#configuration). In config.json these sit in an
`stt` section.

| Variable | config.json `stt` | Default | What it does |
|---|---|---|---|
| `LAMPO_STT` | `backend` | local | `local` (on this machine), `http` (an OpenAI-compatible server) or `off`. |
| `LAMPO_STT_MODEL` | `model` | auto | `auto` takes Whisper turbo where there is a GPU and Parakeet v3 on a CPU. Or `whisper-turbo`, `parakeet-v3`, `qwen3-asr-1.7b`, or the path of a .gguf file. |
| `LAMPO_STT_LANGUAGES` | `languages` | any language | The languages people speak, such as `de,en`, for those who haven't chosen their own in Settings → Voice notes. A note heard as another language is heard again in the first one. |
| `LAMPO_STT_VOCABULARY` | `vocabulary` | none | Words for Whisper's prompt (brand names), separated by commas. |
| `LAMPO_STT_THREADS` | `threads` | up to 4 | CPU threads for the engine. |
| `LAMPO_STT_IDLE_MINUTES` | `idle_unload_minutes` | 30 | Unload the model (1–3 GB of memory) after this many idle minutes. |
| `LAMPO_STT_PREFETCH` | `prefetch` | off (on in the Docker image) | Download the model at start instead of with the first voice note. |
| `LAMPO_STT_MODELS_DIR` | `models_dir` | `models` in the cache | Where downloaded models are kept. |
| `LAMPO_STT_URL` | `http.url` | none | With `http`: the server's address (`/v1/audio/transcriptions` is added). |
| `LAMPO_STT_API_KEY` | `http.api_key` | none | With `http`: its key. |
| `LAMPO_STT_HTTP_MODEL` | `http.model` | whisper-1 | With `http`: the model name it expects. |
| | `http.response_format` | json | `verbose_json` also returns the language it heard. |

### Auto-check

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_OCR` | | auto | How Auto-check reads text in the picture: `auto` (macOS's own text recognition on a Mac with Xcode's command line tools, else tesseract), `vision`, `tesseract` or `off`. |
| `LAMPO_TESSERACT` | | tesseract, found on the PATH | The tesseract program, with German and English language data. |
| `LAMPO_HUNSPELL` | | hunspell, found on the PATH | The spell checker where macOS's isn't used, with the de_DE and en_US dictionaries. |

Words the spelling check should accept (brand names, product names) go in `data/qa-dictionary.txt`, one per line.

### Footage search

What it indexes and when: [footage.md](footage.md). A workspace's own switch is `lampo footage on` / `off`.

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_FOOTAGE` | `footage` | auto | `auto`: on for the machine, on a hosted server per workspace (its owners and admins turn it on). `off`: nothing is indexed and no model is downloaded, anywhere. |
| `LAMPO_FOOTAGE_MODELS` | | `models` in the cache | Where the image/text model (213 MB, downloaded on first use) is kept. Files put there by hand are checked and used. |
| `LAMPO_FOOTAGE_THREADS` | | half the cores, at most 4 | CPU threads for the model's worker. |
| `LAMPO_FOOTAGE_IDLE_MINUTES` | | 10 | Stop the model's worker (about 0.5 GB) after this many idle minutes. |
| `LAMPO_FOOTAGE_HWACCEL` | | on, on a Mac | `off`: decode footage in software instead of with VideoToolbox. |

### Agents

| Variable | config.json | Default | What it does |
|---|---|---|---|
| `LAMPO_AGENT_RUN_TIMEOUT` | | 1800 (30 minutes) | On your machine: how many seconds a Claude Code run that Lampo started may go without a sign (output, or a call to Lampo) before it is stopped (1 second to 24 hours); 3 hours is the most any run takes ([agents.md](agents.md#when-youre-not-running-the-machine-can-start-you)). |
| `LAMPO_CLAUDE_BIN` | | the first `claude` found | The Claude Code program, used to list running sessions and to start a run. |
| `LAMPO_MCP_TOOLS` | | all | Which MCP tools are offered: `all`, `lean` (the review loop only) or tool names separated by commas. The stdio server reads it, and the app uses it for `/mcp` unless a client asks with `/mcp?tools=…`. |
| `LAMPO_MCP_LOG` | | on | `off`: the app logs no line per `/mcp` tool call. A line names the workspace, the agent's session id, the tool, how long it took and how it ended — never what it was given or answered ([mcp.md](mcp.md#what-the-server-logs)). |

### The lampo CLI and the stdio MCP server

These are read on the machine where the agent works.

| Variable | Default | What it does |
|---|---|---|
| `LAMPO_SERVER` with `LAMPO_TOKEN` | none | Work against that hosted server with that API token, without `lampo login` (CI, containers). Both in one spelling: a `VR_TOKEN` never goes with a `LAMPO_SERVER`. |
| `LAMPO_TOKEN` | none | On its own: the token `lampo login <url>` signs in with when given neither `--email` nor `--token`. |
| `LAMPO_REMOTE` | | `0` ignores `lampo login` and `LAMPO_SERVER`, and uses the local store. |
| `LAMPO_WORKSPACE` | `w1` | The workspace `lampo` and the stdio MCP server use on a hosted server's own store ([server-mode.md](server-mode.md#workspaces)); an id the store has no workspace for is refused at the start. After `lampo login`, a token acts in its own workspace instead. |
| `LAMPO_BY` | `agent:` and the Claude Code session's name | The author of what `lampo` and the stdio MCP server write. The `--by` option wins. Outside a Claude Code session, `vr` writes as `agent:vr` and the MCP server as `agent:` and its client's name. |
| `LAMPO_PASSWORD` | asked for | The password for `lampo login --email …`, `lampo admin create-user` and `lampo admin reset-password`, without a prompt. |
| `XDG_CONFIG_HOME` | `~/.config` | Where `lampo login` keeps its credentials (`lampo/credentials.json`, readable only by you; an older `video-review/credentials.json` is read while there is none). |
| `BROWSER` | the system's | The browser `lampo login` opens (a program and its arguments, run without a shell, the address last). Without it: `open` on macOS, `xdg-open` on Linux with a screen; over SSH (`SSH_CONNECTION`) none, and `lampo login` prints the address to open elsewhere. |
| `XDG_CACHE_HOME` | `~/.cache` | Where screenshots and frames from a hosted server are downloaded (`lampo/<host>/`). |
| `LAMPO_NODE` | found | The Node that `lampo` and `lampo-mcp` (and `vr`, `vr-mcp`) switch to when the one that started them is older than 22.18. Without it they look in Homebrew, `/usr/local/bin`, `/usr/bin` and nvm. |
| `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PID` | set by Claude Code | Tell `lampo` and the stdio MCP server which Claude Code session they run in (their author name, `--mine`). Nothing to set yourself. |

### Tools

| Variable | Default | What it does |
|---|---|---|
| `LAMPO_FFMPEG`, `LAMPO_FFPROBE` | the first found in `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, else the PATH | The ffmpeg and ffprobe programs. |
| `LAMPO_PUBLISH_ENDPOINTS` | the real ones | Publishing's platform endpoints as JSON (`googleAuth`, `googleToken`, `googleRevoke`, `youtube`, `youtubeUpload`, `zernio`), for tests' fake platforms or a staging proxy; the hosts it names may be private and plain http ([publishing.md](publishing.md)). A value that isn't a JSON object of http(s) URLs stops the start with one line. |

### For people working on Lampo

| Variable | Default | What it does |
|---|---|---|
| `LAMPO_STYLEGUIDE` | on | `0` when building leaves the #/styleguide page out of the app (the Docker image does). |
| `LAMPO_PORT` | a free port | `npm run demo` serves its demo store on this port. |
| `CHROME_PATH` | found | The Chrome that `npm run screenshots` uses. The test suites' own variables are in [CONTRIBUTING.md](../CONTRIBUTING.md). |

## Language

The app is in English for everyone; the browser's language doesn't change it. Anyone can switch to German in Settings
→ Appearance → Language. It switches in place, without a reload. The choice is kept on their account, so their other
devices follow, and it applies before the first paint. In German the team's pages say "du"; review links, the folder
room and the printout say "Sie", as an agency writes to a client. Clients have no Settings, so on their own devices
they see review links in English for now.

What agents read (`lampo`, the MCP server, INBOX.md, events) stays in English: it is a data contract.

To add UI text, write it in English through `t('…')` (or `<T k="…">` for a sentence with markup), run `npm run i18n`,
and translate the new keys in `web/src/i18n/de.ts` (`de.client.ts` for the client pages). The typecheck names every
key that is missing.

Switching changes the words in place, without a reload. So words that live outside a component (a module's labels
or options) go through `perLang(() => …)` from `web/src/i18n/index.ts`, and a memo'd component or a `useMemo` with
words in it reads `useLang()` (`web/src/i18n/T.tsx`); `test/unit/i18n.test.ts` finds words worked out when a module
loads.

## Other files in data

Besides the reviews, data holds a few files the app writes and reads by itself. Back them up with the rest of data.
What's in each: [data-format.md](data-format.md).

- `qa-dictionary.txt`: words Auto-check's spelling check should accept, one per line. The only one you edit by hand.
- `users.json`, `invites.json` and `secret.key`: accounts, pending invites, and the key that signs sign-in cookies.
  Readable only by the app's user.
- `avatars/`: profile pictures (with Bunny or S3 storage, in the bucket instead).
- `shares.json` and `share-secret.key`: review links, and the key their tokens are sealed with.
- `webhooks.json`: webhooks added in Settings → Notifications.
- `push/`: the key that signs push notifications and the devices that receive them. Deleting the key turns
  notifications off on every device until people turn them on again.
- `for-you.json`: what each person cleared from their inbox (*Got it*, kept 30 days) or put aside (*Later*).
- `oauth/`: apps connected through sign-in, and their tokens.
- `account-links.json` and `mail/`: emailed one-time links (hashed) and the emails waiting to go out (sealed).
- `publish/`: posts of final videos and the publishing connections, their keys and tokens sealed
  ([publishing.md](publishing.md)).
- On a hosted server: `workspaces.json` (each workspace and its members), `links.json` (which workspace a review link
  belongs to), `w/<id>/` (every workspace but the first), `backups/` (copies made before the move to workspaces) and
  `erasures.jsonl` (the accounts and workspaces deleted, by id: what to delete again after restoring a backup,
  [server-mode.md](server-mode.md#deleting-and-exporting)).

## Details

- **Sizes** are written like `20GB`, `500 MB`, `1e9`, or plain bytes. Units count in thousands: a GB is 10⁹ bytes
  (GiB is read the same way).
- **On and off**: `LAMPO_STT_PREFETCH`, `LAMPO_WEBHOOK_ALLOW_PRIVATE`, `LAMPO_ALLOW_NO_PUBLIC_URL`, `LAMPO_ALLOW_HTTP`,
  `LAMPO_ONBOARDING` and `LAMPO_ONBOARDING_SAMPLE` are off for `0`, `false`, `no` or `off`, and on for anything else. `LAMPO_LAN` needs exactly `1`,
  `LAMPO_REMOTE` exactly `0`, `LAMPO_S3_PRESIGN` turns off only with `false`, and `LAMPO_STYLEGUIDE` only with `0`.
- **Numbers**: `0` or something that isn't a number falls back to the default (`LAMPO_MEDIA_TIMEOUT`, `LAMPO_MAX_SIDE`,
  `LAMPO_MAX_DURATION`, the session days); so does a `LAMPO_AGENT_RUN_TIMEOUT` outside 1 to 86400.
- **Timeouts**: ffprobe runs get 30 seconds, and the playback copy of a long render gets 3 seconds per second of
  video when that is more than `LAMPO_MEDIA_TIMEOUT`.
- **`trust_proxy` from older setups**: `true` or a hop count means `loopback, uniquelocal` now, and the server warns
  at start. Name the proxy's address or subnet to be exact.
- **`mode`**: only `server` switches; anything else means your own machine.
- **Old speech keys**: a `whisper_language` from the days of the Python engine becomes `stt.languages` (that language,
  then English). `whisper_python` and `whisper_model` are ignored.
- **Storage in config.json**, for example S3:

  ```json
  {
    "mode": "server",
    "public_url": "https://review.example.com",
    "storage": {
      "kind": "s3",
      "s3": {
        "endpoint": "https://<account>.r2.cloudflarestorage.com",
        "bucket": "review",
        "access_key_id": "…",
        "secret_access_key": "…"
      },
      "work_cache_bytes": 20000000000
    }
  }
  ```

  Variables layer over this section key by key, so a secret can come from the environment while the rest stays in
  the file.
