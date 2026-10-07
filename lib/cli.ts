// `vr` — the agent side of video-review. Reads/writes the same files as the UI (data/), no server needed; after
// `vr login <url>` the same commands work against a hosted server (lib/backend).

import fs from 'node:fs';
import path from 'node:path';
import { cliAgent, openActivitySink } from './activity.ts';
import { cliActivity } from './activityText.ts';
import { archivedIn, archivedWords } from './archived.ts';
import { readCredentials } from './backend/credentials.ts';
import { type Backend, openBackend } from './backend/index.ts';
import type { PlaybookWhere, RefInput } from './backend/types.ts';
import { CHOICE_MAX, CHOICES_MAX, CHOICES_MIN, cleanChoices } from './choices.ts';
import { admin, login, logout, whoami } from './cliAccount.ts';
import { mcpCommand } from './cliMcp.ts';
import { render } from './cliRender.ts';
import { describeShape } from './drawing.ts';
import { ELEMENT_LIMITS, legendLine, NO_POINTERS, onWords, pointerFields, pointerIn, readElementMap } from './elements.ts';
import { eventLine, isInboxEvent, shortEventLine, tags, WATCH_TYPES } from './eventLine.ts';
import { undismissed } from './findings.ts';
import { folderName, normFolder } from './folders.ts';
import { stillOpenLine, WATCH_NOW_LINE } from './handoff.ts';
import { cleanAuthor } from './names.ts';
import { forAgents, SAMPLE_FOR_AGENTS } from './onboarding.ts';
import { optionLines, optionsSummary, picksToRender } from './options.ts';
import { partLine, partOk, partOkWords } from './part.ts';
import { seamLine } from './parts.ts';
import { isoLocal, slugify } from './paths.ts';
import { SKILL_FILE, SKILL_NAME, scopeLabel, skillMarkdown } from './playbookText.ts';
import { describePreview, projectPosition } from './previews.ts';
import { claudePrompt } from './prompt.ts';
import { platformOf } from './publish/platforms.ts';
import { postLines } from './publish/posts.ts';
import { describeRange, normalizeRange } from './range.ts';
import { describeRef } from './refLine.ts';
import { localStopLine } from './runs.ts';
import { enterProcessWorkspace } from './scope.ts';
import { currentSession, matchesSession, rankSessions } from './sessions.ts';
import { STAGE_LABELS } from './stage.ts';
import type { SessionInput } from './store.ts';
import { counts, describeSource } from './store.ts';
import { scopeOf } from './taste.ts';
import {
  CLIENT_NOTE_FLAG,
  compareTime,
  isAgent,
  isClient,
  isNoteKind,
  isRequired,
  isSeverity,
  keepLines,
  noteLabel,
  noteRank,
  oneLine,
  parseFramePosition,
  terminalText,
  timecode,
} from './time.ts';
import { textEditLine, toSrt, toVtt } from './transcript.ts';
import type {
  AskView,
  ClaudeSession,
  Comment,
  ElementMap,
  ElementsAttached,
  FrameRange,
  PostFields,
  PostVisibility,
  RenderSource,
  Review,
  ReviewPointers,
  Shape,
  TasteScope,
} from './types.ts';
import { checkProcessWorkspace } from './workspaces.ts';

const help = (where: string) => `vr — frame-exact video feedback for agents (${where})

Reading
  vr ls [--open] [--mine | --session <name>] [--folder <f>] [--archived]   videos under review with counts
  vr folders [--archived]                                    the project/folder tree with counts
  vr open <video|slug> [--all] [--brief]                     open comments of one video (--all: every status; --brief:
                                                             screenshot paths once, in the header)
  vr show <id>                                               one comment in full
  vr inbox [--since <iso>] [--limit N] [--mine | --session <name>]   newest human feedback across videos (50)
  vr prompt <video>                                          the "Copy for an agent" text
  vr watch [--mine | --session <name> | --everyone] [--all] [--brief]   one line per new comment, for a Monitor
                                                             (--brief: without the file paths at the end)

Acting
  vr fix <id> --note "…" [--v N] [--preview p_…]   mark fixed (N defaults to the newest version; a fresh render is picked up first)
  vr preview <id> <file> [--fixed --note "…"] [--frame N | --at 00:12:03 | --t 12.1] [--clip]   a still or ≤ 10 s clip
        [--app "After Effects" --project spot.aep --comp Main --time 12.4]   of the fix, before rendering (docs/agents.md)
  vr source <video> --app "After Effects" [--project spot.aep] [--comp Main] [--start-frame N] [--fps F] [--v N] | --clear
                                        where the render came from, so frame N maps to the project's time
  vr ref <id> <file|url> [--caption "…"] [--note "…"]   a reference on a note: an image, a clip (≤ 60 s) or a link
  vr ref <id> --video <video> (--frame N | --at mm:ss:ff) [--to N] [--v N] [--caption "…"] [--note "…"]
                                        a moment (or range) of another render; --note makes it a reply
  vr reply <id> --note "…"              reply without changing status
  vr wontfix <id> --note "reason"
  vr verify <id> [--note "…"] · vr reopen <id> [--note "…"]   a fix confirmed · a note open again
  vr add <video> --frame N --text "…"   pin a question for the reviewer to a frame (--overall: about the whole video)
        [--kind question|info|feedback]   question (the default for agents) · info = what you changed or decided
        [--at 00:12:03 | --t 12.1] [--to 00:14:10 | --range 360-372] [--tags a,b] [--severity must|should|nice|idea]
                                        --to: a range from the position to this end (timecode, seconds or fN)
        [--box x,y,w,h]… [--arrow x1,y1,x2,y2]…   (video pixels)
        [--choice "Yes" --choice "No, it's …"]   a question's likely answers (2–4), picked with one click
  vr ask (<video> | --folder P) --text "…" --options f.json   before rendering: options to pick from (f.json:
                                        [{id, label, pick, items: [{id, label, path}]}]) → ANSWERED … PICKED g=item
  vr track <video> [--me | --session <name> | --none] [--folder "Project/Sub"]   put a video under review
  vr push <file> [--folder "Project/Sub"] [--to <video>] [--name clip.mp4]   upload a render (new video, or its next version)
        [--elements map.json]           where its named elements are: notes then say "on #title"
  vr push <part> --to <video> --part-at <frame> [--handles 12]   only where a note says PART RENDER OK: the stretch (and
                                        its handles before and after), spliced into the newest version for review
  vr elements <video> <map.json> [--v N]   an elements map for a version already up (docs/agents.md)
  vr move <video> <folder> | --none     file a video into a project/folder (created if new)
  vr assign <video> (--me | --session <name> | --none)
  vr sync <video>                       register a re-render now (otherwise automatic)
  vr render [--to <video> --out <file>] [--detach] -- <command>   render with its progress in Lampo, then put
                                        <file> up as the next version; two lines back (docs/agents.md)
  vr render wait <id>                   a --detach render (past ~8 min): waits ≤ 9 min, says how far it is
  vr diff <video> [--v N]               what changed from v(N-1) to vN: changed ranges (with screen region), audio, retimes
  vr taste <video|folder>               the reviewer's taste for that project: read it before you render
  vr playbook [<video|folder>]          the team's playbook for it (brief, rules, skills; House without an argument):
                                        read it before you render
  vr playbook skill <name> [<video|folder>] [--files]   one skill's SKILL.md (--files: download its files here)
  vr playbook export [<video|folder>] [--to <dir>]      PLAYBOOK.md and every skill as <dir>/<name>/SKILL.md + files
                                        (default .lampo/playbook; --to .claude/skills works as a skills folder)
  vr playbook propose <video|folder> --section brief|rules|skill (--file f.md | --text "…") --reason "…" [--evidence c_1,c_2]
                                        suggest a change; a person accepts or rejects it
  vr playbook status <pp_…>             where a suggestion stands (accepted, rejected with the reason, pending)
  vr post draft <video> --platform yt|ig|fb [--title|--text|--tags|--cover|--at|--ai|--kids …]
                                        a final video's post; a person publishes · vr post [<video>]: where they stand
  vr qa <video> [--v N] [--rerun]       automatic pre-review: typos in burned-in text, safe zones, flash/black frames, audio
  vr transcript <video> [--v N] [--words | --srt | --vtt] [--rerun]   what is said, line by line on its frames
                                        (a CHANGE WORDS note names the line; --srt/--vtt: captions)
  vr footage find "<request>" [--aspect 9:16] [--min 2] [--motion push-in] [--no-text] [--sheet]   B-roll: shots with
                                        exact in–out frames · vr footage sheet <id…> | status | on | off | index
  vr status <video> "rendering v4" [--eta 90] | --clear   show what you are doing on the video's card
  vr sessions [--for <video>]           the agents running on this machine (ranked for a video)

Hosted server
  vr login <url> [--expires 90d] [--insecure]   use a Lampo server from now on: you allow it in the browser (over SSH:
                                        open the address it prints elsewhere; plain http to another machine: --insecure)
  vr login <url> --email you@example.com [--workspace <id>] | --token -   no browser (CI): password or API token
  vr logout                             back to the local store (revokes the token vr login made; a pasted one is
                                        only forgotten here)
  vr whoami                             which store or server this vr uses, and as whom
  vr admin invite [--role member|reviewer|admin|owner] [--email e] [--name n] [--days 7]   a one-time sign-up link
  vr admin invites · revoke-invite <id> · create-user --email e --name n [--role r] · reset-password --email e · list-users
  vr admin workspaces [list] · workspaces create --name n --owner e · workspaces migrate   (--workspace <id> on invite/invites/revoke-invite/create-user/list-users, else VR_WORKSPACE; invites --all)
                                        accounts, run on the server with its data directory
  vr admin repair-folders [--write] [--take-back <link id,…>]
                                        rebuild a damaged folders.json from what it still says, the videos and the
                                        review links (a dry run without --write); a link nothing vouches for is a
                                        person's call: --take-back gives it its folder
  vr admin mail-test <to> [--lang de]   send one test email now through the server's mail settings
  vr admin delete-account <who>|delete-workspace <id> [--yes] · export-account <who> --out f.zip · erasures
  vr export <out.tar> [--folder f]… · vr admin import <tar> --workspace w --owner e   move to a server (docs/moving.md)

Any agent over MCP (Claude Code, Codex, Cursor, VS Code, Antigravity, Windsurf, Gemini CLI, Zed, …)
  vr mcp config <client> [--stdio | --http] [--url <server>] [--token-env NAME] [--with-token] [--name lampo] [--json]
                                        a ready config: stdio here, or /mcp on this app or your server

Options: --json on every read command but prompt. --by <name> overrides the author (default: agent:<this session>).
Paths in output are absolute, so screenshots can be opened directly.`;

/**
 * A command's lines of the help: each line that starts `vr <name>` with the lines that continue it (indented deeper),
 * and the options every command takes. The whole help for a command it doesn't name.
 */
export function usageOf(name: string, text: string): string {
  const lines = text.split('\n');
  const out: string[] = [];
  let taking = false;
  for (const l of lines) {
    const head = /^ {2}vr ([a-z-]+)\b/.exec(l);
    if (head) taking = head[1] === name;
    else if (!/^ {3,}\S/.test(l)) taking = false;
    if (taking) out.push(l);
  }
  if (!out.length) return text;
  return [...out, '', ...lines.filter((l) => l.startsWith('Options: '))].join('\n');
}

// ---------------------------------------------------------------- args

type OptValue = string | true | string[];
type Opts = Record<string, OptValue | undefined>;

interface Args {
  pos: string[];
  opt: Opts;
  /** `vr render`: everything after `--`, the command as given. */
  cmd?: string[];
}

const MULTI = new Set(['box', 'arrow', 'choice']);
/** Options a command takes more than once beyond those (`vr export --folder A --folder B`). */
const MULTI_OF: Record<string, string[]> = { export: ['folder'] };

function parseArgs(argv: string[], multi: ReadonlySet<string> = MULTI): Args {
  const pos: string[] = [];
  const opt: Opts = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      const key = (eq > 0 ? a.slice(2, eq) : a.slice(2)).replace(/-/g, '_');
      const val: string | true = eq > 0 ? a.slice(eq + 1) : argv[i + 1] !== undefined && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      if (multi.has(key)) {
        const list = Array.isArray(opt[key]) ? (opt[key] as string[]) : [];
        list.push(String(val));
        opt[key] = list;
      } else opt[key] = val;
    } else pos.push(a);
  }
  return { pos, opt };
}

/** The option's value when it was given with a value (not as a bare flag). */
const str = (v: OptValue | undefined): string | undefined => (typeof v === 'string' ? v : undefined);
const list = (v: OptValue | undefined): string[] => (Array.isArray(v) ? v : []);

// What `vr` prints is read line by line (agents, Monitors): only `\n` ends a line (`keepLines`; JSON stays the same).
const out = (s: string): void => {
  process.stdout.write(`${keepLines(s)}\n`);
};
class Exit extends Error {}
// Report a usage error and stop the command: `die()` inside expressions, `throw exit()` where TypeScript should
// see the control flow end.
const exit = (msg: string): Exit => {
  process.stderr.write(`vr: ${terminalText(msg)}\n`);
  process.exitCode = 1;
  return new Exit(msg);
};
const die = (msg: string): never => {
  throw exit(msg);
};
/** A folder named for a write (`--folder`, `vr move`): refused here, before anything is sent, past 12 levels or 400 characters. */
const newFolder = (folder: string | undefined): string | undefined => {
  try {
    normFolder(folder);
  } catch (e) {
    die((e as Error).message);
  }
  return folder;
};

/**
 * Where a file a server named lands: `names` under `root`, or null when that would be anywhere else (A12 AGENT-8). The
 * server `vr` talks to may not be honest, so a name is one plain segment (no separator, no `..`, nothing absolute), and
 * what already exists on the way — a folder or the file itself — must still be inside `root` once symbolic links are
 * followed, or a link would write through to wherever it points.
 */
function insideFolder(root: string, ...names: string[]): string | null {
  const base = fs.realpathSync(root);
  if (names.some((n) => !n || n === '.' || n === '..' || /[/\\\0]/.test(n) || path.isAbsolute(n))) return null;
  const target = path.join(base, ...names);
  if (!target.startsWith(base + path.sep)) return null;
  const within = (p: string) => p === base || p.startsWith(base + path.sep);
  for (let p = target; ; p = path.dirname(p)) {
    let found = true;
    try {
      fs.lstatSync(p);
    } catch {
      found = false;
    }
    if (found) {
      try {
        return within(fs.realpathSync(p)) ? target : null;
      } catch {
        return null; // a link to nothing: writing would create whatever it names
      }
    }
    if (p === base) return target;
  }
}

/** The places a server's names land in `root`, every one checked before anything is written; stops the command otherwise. */
function landings(root: string, what: string, all: string[][]): string[] {
  return all.map(
    (names) =>
      insideFolder(root, ...names) ??
      die(`refused: the server named ${what} outside ${root} (${oneLine(JSON.stringify(names.join('/')))}); nothing was written`),
  );
}

/** An elements map file (`--elements`, `vr elements`), read and checked whole here; stops the command when it can't be one. */
function elementMapFile(arg: OptValue): { map: ElementMap; name: string } {
  const name = str(arg) ?? die('--elements needs a file: --elements map.json');
  const file = path.resolve(name);
  let text = '';
  try {
    if (fs.statSync(file).size > ELEMENT_LIMITS.bytes) die(`${name}: the elements map is refused: it is over 1 MB`);
    text = fs.readFileSync(file, 'utf8');
  } catch (e) {
    if (e instanceof Exit) throw e;
    die(`${name}: ${(e as NodeJS.ErrnoException).code === 'ENOENT' ? 'no such file' : (e as Error).message}`);
  }
  try {
    return { map: readElementMap(text), name };
  } catch (e) {
    return die(`${name}: ${(e as Error).message}`);
  }
}

const elementsLine = (a: ElementsAttached): string =>
  `elements: ${a.elements} named, ${a.keys} keys${a.scaled_from ? ` (scaled from ${a.scaled_from[0]}×${a.scaled_from[1]})` : ''}: notes say what they point at`;

function me(): ClaudeSession | null {
  const s = currentSession();
  return s?.name ? s : null;
}
function author(opt: Opts): string {
  // `--by`, VR_BY and a session's name go into the store and every agent's reading of it: one line, short (A12-D3).
  const by = cleanAuthor(str(opt.by) || '') || cleanAuthor(process.env.VR_BY || '');
  if (by) return by;
  const s = me();
  // Outside a named session still an agent, by a name a hosted server takes (`agent:<name>`): a bare "agent" is
  // refused there, and the note would go in as feedback from the person whose token it is.
  return (s && cleanAuthor(`agent:${s.name}`)) || 'agent:vr';
}

type SessionFilter = { name: string | null; sessionId?: string | null };

// Which session a filter means: --session X, --mine (this Claude session), or none.
function sessionFilter(opt: Opts): SessionFilter | null {
  const session = str(opt.session);
  if (session) return { name: session };
  if (opt.mine) {
    const s = me() || die('--mine only works inside a Claude Code session');
    return { name: s.name, sessionId: s.sessionId };
  }
  return null;
}

const latestOf = (review: Review) => review.versions.at(-1) || die(`${review.video} has no versions`);

// ---------------------------------------------------------------- formatting

// `brief` (vr open --brief): the screenshots' folder is said once in the header, so a note names its files only when
// they don't carry the usual names; references without where their files are (vr show has both).
// `pointers`: what the notes point at in their versions' elements maps (b.pointers): " · on #card" on the note's line.
function commentLines(b: Backend, review: Review, c: Comment, { full = false, brief = false, pointers = NO_POINTERS } = {}): string {
  const L: string[] = [];
  const range = c.range ? ` range ${c.range.in}-${c.range.out}` : '';
  const fps = review.versions.find((x) => x.v === c.v)?.fps || review.fps;
  const flags: string[] = [];
  if (c.check_again) flags.push(`CHECK AGAIN in v${c.carried_to}`);
  if (c.status === 'fixed') flags.push(`fixed in v${c.fixed_in_v}`);
  if (c.verified_on) flags.push(`verified on preview ${c.verified_on.preview}: the next render must contain it`);
  if (c.scope === 'video') flags.push('OVERALL: about the whole video');
  if (isAgent(c.author)) flags.push(`by ${c.author}`);
  if (isClient(c.author)) flags.push(CLIENT_NOTE_FLAG);
  if (c.status !== 'open' && picksToRender(c, review.versions.at(-1)?.registered)) flags.push('PICKED: render with these');
  L.push(
    `${c.id}  ${c.status.toUpperCase().padEnd(8)} ${noteLabel(c).padEnd(6)} ${c.timecode}  f${c.frame}${range}  v${c.v}  [${tags(c.tags)}]${flags.length ? `  ${flags.join(' · ')}` : ''}${onWords(pointerIn(pointers, c.id))}${partOkWords(partOk(review.versions, c))}`,
  );
  L.push(`    ${c.text || (c.text_edit ? '(a change to the words, below)' : '(no text, see marked frame)')}`);
  if (c.text_edit) L.push(`    ${textEditLine(c.text_edit, c, fps)}`);
  if (c.part && c.status === 'open') L.push(`    ${partLine(c.part)}`);
  if (c.range) L.push(`    range: ${describeRange(c.range, fps)}`);
  const project = projectPosition(review, c);
  if (project) L.push(`    project: ${project}`);
  for (const s of c.drawing || []) L.push(`    drawing: ${describeShape(s)}`);
  if (c.voice?.transcript && c.voice.transcript !== c.text) L.push(`    voice: ${c.voice.transcript}`);
  if (c.choices?.length) L.push(`    choices offered: ${c.choices.map(oneLine).join(' | ')}`);
  for (const l of optionLines(c.options || [])) L.push(`    ${l}`);
  const usual = c.shots?.marked === `${c.id}_marked.png` && c.shots?.clean === `${c.id}_clean.png` && (!c.shots.range || c.shots.range === `${c.id}_range.jpg`);
  if (!brief || (c.shots?.marked && !usual)) {
    L.push(`    marked: ${b.shotFile(review, c.shots?.marked)}`);
    if (c.shots?.range) L.push(`    range frames (first … last): ${b.shotFile(review, c.shots.range)}`);
    L.push(`    clean:  ${b.shotFile(review, c.shots?.clean)}`);
  }
  if (c.source === 'recording')
    L.push(`    recorded: said while watching${c.voice?.file && !brief ? ` · voice clip: ${b.shotFile(review, c.voice.file)}` : ''}`);
  else if (c.voice?.file && full) L.push(`    audio:  ${b.shotFile(review, c.voice.file)}`);
  const replies = full ? c.replies : c.replies.slice(-2);
  // a reply its author changed reads as it is now, marked so an agent that read it before knows to read it again
  for (const r of replies)
    L.push(`    ↳ ${r.by}${r.status ? ` [${r.status}${r.fixed_in_v ? ` v${r.fixed_in_v}` : ''}]` : ''}: ${r.text || '-'}${r.edited ? ' (edited)' : ''}`);
  for (const p of c.previews || []) L.push(`    preview ${describePreview(p)}`);
  for (const r of c.refs || []) {
    const where = r.file || r.still;
    L.push(`    ref ${describeRef(r)}`);
    if (where && !brief) L.push(`        ${b.refLocation(review, where)}`);
  }
  // One line per entry: what people wrote can't start a note of its own.
  return L.map(oneLine).join('\n');
}

// A question asked on a folder before any render (vr show): no video, no frames.
function askText(a: AskView): string {
  const L = [`${a.id}  ${a.status.toUpperCase().padEnd(8)} QUESTION  folder ${a.folder ?? '-'} (no video yet)  by ${a.author}`, `    ${a.text}`];
  for (const l of optionLines(a.options)) L.push(`    ${l}`);
  for (const r of a.replies) L.push(`    ↳ ${r.by}${r.status ? ` [${r.status}]` : ''}: ${r.text || '-'}`);
  return L.map(oneLine).join('\n');
}

// A note as `--json` gives it: its screenshots as paths here, what it points at (elements maps) and the stretch a part
// render for it may cover (`part_ok`, frames of the newest version) when a person allowed one.
const withAbsShots = (b: Backend, review: Review, c: Comment, pointers: ReviewPointers = NO_POINTERS) => {
  const ok = partOk(review.versions, c);
  return {
    ...c,
    shots: {
      clean: b.shotFile(review, c.shots?.clean),
      marked: b.shotFile(review, c.shots?.marked),
      ...(c.shots?.range ? { range: b.shotFile(review, c.shots.range) } : {}),
    },
    voice: c.voice ? { ...c.voice, file: b.shotFile(review, c.voice.file) } : null,
    video: review.video,
    ...pointerFields(pointerIn(pointers, c.id)),
    ...(ok ? { part_ok: ok } : {}),
  };
};

// A final video is done: agents fix nothing on it until someone reopens it (docs/workflow.md).
function finalNotice(b: Backend, review: Review): string | null {
  const s = b.stage(review);
  if (s.stage !== 'final' || !s.final) return null;
  return oneLine(
    `${path.basename(review.video)} is final (v${s.final.v}, by ${s.final.by})${s.final_superseded ? `, v${s.final_superseded} arrived since` : ''}`,
  );
}

// `legend`: the elements the listed notes point at, with their names (one line, legendLine), when any does.
function header(b: Backend, review: Review, legend = ''): string {
  const n = counts(review);
  const latest = review.versions.at(-1);
  const stage = b.stage(review);
  return [
    ...(review.onboarding_sample ? [SAMPLE_FOR_AGENTS] : []),
    `${review.video}${review.missing ? '  (FILE MISSING)' : ''}`,
    `  ${review.project} · v${latest?.v} · ${review.width}×${review.height} · ${review.fps} fps · ${review.frames} frames · ${review.duration}s`,
    `  session: ${review.session?.name || '-'} · open ${n.open} (must ${n.must}) · fixed ${n.fixed} · verified ${n.verified} · wontfix ${n.wontfix}${n.ideas ? ` · ideas ${n.ideas}` : ''}${n.questions ? ` · questions ${n.questions}` : ''}`,
    `  stage: ${STAGE_LABELS[stage.stage].toUpperCase()} — ${stage.detail}${stage.stage === 'final' ? ' (fix nothing until it is reopened)' : ''}`,
    ...(latest?.source ? [`  source: ${describeSource(latest.source)}`] : []),
    `  review: ${b.reviewData(review)}`,
    ...(legend ? [`  ${legend}`] : []),
  ]
    .map(oneLine)
    .join('\n');
}

// ---------------------------------------------------------------- commands

type Command = (args: Args, b: Backend) => void | Promise<void>;

const commands: Record<string, Command> = {
  help(_args, b) {
    out(help(b.where));
  },

  async ls({ opt }, b) {
    const filt = sessionFilter(opt);
    // the onboarding sample is a demo for the person, never an agent's work (ONB-5)
    // archived videos and archived projects' (lib/archived.ts) only with --archived, marked (archived)
    const shut = await b.archivedProjects();
    const away = (r: Review) => !!r.archived || !!archivedIn(r.folder, shut);
    let reviews = forAgents(await b.listReviews()).filter((r) => (opt.archived ? true : !away(r)));
    if (filt) reviews = reviews.filter((r) => matchesSession(r.session, filt));
    if (opt.open) reviews = reviews.filter((r) => counts(r).open > 0);
    const folder = str(opt.folder);
    if (folder !== undefined) {
      const f = folderName(folder);
      reviews = reviews.filter((r) => r.folder && (r.folder === f || r.folder.startsWith(`${f}/`)));
    }
    reviews.sort((a, c) => compareTime(c.updated, a.updated));
    if (opt.json)
      return out(
        JSON.stringify(
          reviews.map((r) => ({
            video: r.video,
            slug: slugify(r.video),
            project: r.project,
            folder: r.folder || null,
            v: r.versions.at(-1)?.v,
            session: r.session?.name || null,
            counts: counts(r),
            stage: b.stage(r).stage,
            stage_detail: b.stage(r).detail,
            archived: away(r),
            missing: !!r.missing,
          })),
          null,
          2,
        ),
      );
    if (!reviews.length) return out(`no videos under review${filt ? ` for session ${filt.name}` : ''}.`);
    for (const r of reviews) {
      const n = counts(r);
      out(
        oneLine(
          `${String(n.open).padStart(3)} open ${String(n.must).padStart(2)} must ${String(n.fixed).padStart(2)} fixed ${String(n.done).padStart(3)} done  v${r.versions.at(-1)?.v}  ${(r.session?.name || '-').padEnd(14)} ${r.video}${r.folder ? `  [${r.folder}]` : ''}${r.missing ? ' (missing)' : ''}${away(r) ? ' (archived)' : ''}  stage:${b.stage(r).stage}`,
        ),
      );
    }
  },

  async open({ pos, opt }, b) {
    const { slug } = await b.resolve(pos[0]);
    const review = await b.review(slug);
    // the onboarding sample: a demo for the person, its notes examples — nothing here is an agent's to work on
    if (review.onboarding_sample) {
      if (opt.json) return out(JSON.stringify({ video: review.video, slug, sample: true, note: SAMPLE_FOR_AGENTS, comments: [] }, null, 2));
      out(header(b, review));
      out('');
      return out('no work here.');
    }
    // Picks answered since the newest render stay listed: they are what the next render is made of.
    const newest = review.versions.at(-1)?.registered;
    const list = review.comments
      .filter((c) => (opt.all ? true : c.status === 'open' || picksToRender(c, newest)))
      .sort((a, c) => (opt.all ? a.t - c.t : noteRank(a) - noteRank(c) || a.t - c.t));
    await b.fetchShots(review, list);
    const pointers = await b.pointers(review, list);
    if (opt.json)
      return out(
        JSON.stringify(
          {
            video: review.video,
            slug,
            v: latestOf(review).v,
            fps: review.fps,
            width: review.width,
            height: review.height,
            session: review.session,
            stage: b.stage(review),
            comments: list.map((c) => withAbsShots(b, review, c, pointers)),
          },
          null,
          2,
        ),
      );
    const brief = !!opt.brief;
    const shots = brief ? b.shotFile(review, '-') : null;
    out(header(b, review, legendLine(Object.values(pointers.notes), pointers.names)));
    if (shots) out(`  shots: ${path.dirname(shots)}/<id>_marked.png · <id>_clean.png · <id>_range.jpg (vr show <id>: one note in full)`);
    out('');
    if (!list.length) return out(opt.all ? 'no comments.' : 'no open comments.');
    for (const c of list) out(`${commentLines(b, review, c, { brief, pointers })}\n`);
  },

  async ask({ pos, opt }, b) {
    const usage = 'usage: vr ask (<video> | --folder "Project/Sub") --text "…" --options options.json [--prompt "…"]';
    const folder = str(opt.folder);
    if (!pos[0] === !folder) throw exit(usage);
    newFolder(folder);
    const text = str(opt.text) ?? die(`ask needs --text "…"\n${usage}`);
    const file = str(opt.options) ?? die(`ask needs --options <file.json>\n${usage}`);
    const raw = file === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path.resolve(file), 'utf8');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw exit(`${file}: not JSON (${(e as Error).message})`);
    }
    // A list of groups, or { groups, prompt? }; an item's path is read from where the file is.
    const doc = (Array.isArray(parsed) ? { groups: parsed } : parsed) as { groups?: unknown; prompt?: unknown };
    if (!Array.isArray(doc.groups)) throw exit(`${file}: expected a list of groups [{id, label, pick, items: [{id, label, path}]}]`);
    const from = file === '-' ? process.cwd() : path.dirname(path.resolve(file));
    const groups = (doc.groups as Record<string, unknown>[]).map((g) => ({
      id: String(g.id ?? ''),
      label: typeof g.label === 'string' ? g.label : undefined,
      pick: g.pick === 'many' ? ('many' as const) : ('one' as const),
      items: (Array.isArray(g.items) ? (g.items as Record<string, unknown>[]) : []).map((it) => ({
        id: String(it.id ?? ''),
        label: typeof it.label === 'string' ? it.label : undefined,
        ...(typeof it.path === 'string' ? { path: path.resolve(from, it.path) } : {}),
        ...(typeof it.url === 'string' ? { url: it.url } : {}),
      })),
    }));
    const slug = pos[0] ? (await b.resolve(pos[0])).slug : undefined;
    const prompt = str(opt.prompt) ?? (typeof doc.prompt === 'string' ? doc.prompt : undefined);
    const made = await b.ask({
      ...(slug ? { slug } : { folder }),
      text,
      groups,
      ...(prompt ? { answer_prompt: prompt } : {}),
      by: author(opt),
      makeFolder: true,
    });
    if (opt.json) return out(JSON.stringify(made, null, 2));
    out(oneLine(`${made.id} asked ${slug ? `on ${pos[0]}` : `on folder ${made.folder} (no video yet)`}: ${optionsSummary(groups)}`));
    out('The person auditions and picks in Lampo; vr watch brings: ANSWERED … PICKED <group>=<item> … · note: "…"');
  },

  async show({ pos, opt }, b) {
    const hit = await b.findComment(pos[0] || die('missing <id>'));
    if (!hit) {
      // A question asked on a folder before any render: its options and answers.
      const ask = (await b.askView(pos[0])) || die(`no comment ${pos[0]}`);
      if (opt.json) return out(JSON.stringify(ask, null, 2));
      out(askText(ask));
      return;
    }
    await b.fetchShots(hit.review, [hit.comment]);
    const pointers = await b.pointers(hit.review, [hit.comment]);
    if (opt.json) return out(JSON.stringify(withAbsShots(b, hit.review, hit.comment, pointers), null, 2));
    out(header(b, hit.review, legendLine(Object.values(pointers.notes), pointers.names)));
    out('');
    out(commentLines(b, hit.review, hit.comment, { full: true, pointers }));
  },

  fix({ pos, opt }, b) {
    return setStatus(b, pos[0], 'fixed', opt);
  },
  async preview({ pos, opt }, b) {
    const [id, file] = pos;
    if (!id || !file) throw exit('usage: vr preview <id> <file> [--fixed --note "…"] [--frame N | --at 00:12:03] [--clip]');
    const hit = (await b.findComment(id)) || die(`no comment ${id}`);
    const fixed = !!opt.fixed;
    const lock = fixed ? finalNotice(b, hit.review) : null;
    if (lock) die(`${lock}: nothing to fix until the reviewer reopens it.`);
    const latest = latestOf(await b.review(hit.slug, { wait: true }));
    // As in vr add: --frame N, --at mm:ss:ff or --t seconds; default: the note's frame in the newest render.
    const at = str(opt.at) ?? str(opt.t);
    const frame =
      opt.frame !== undefined ? parseInt(String(opt.frame), 10) : at ? (parseFramePosition(at, latest.fps) ?? die(`bad position "${at}"`)) : undefined;
    if (frame !== undefined && !Number.isFinite(frame)) die('--frame expects a number');
    const kind = opt.clip || !/\.(png|jpe?g|webp)$/i.test(file) ? 'clip' : 'still';
    const app = str(opt.app);
    const time = str(opt.time);
    const source = app ? { app, project: str(opt.project), comp: str(opt.comp), ...(time ? { time: Number(time) } : {}) } : undefined;
    const r = await b.attachPreview(id, path.resolve(file), { kind, frame, source, fixed, note: str(opt.note), by: author(opt) });
    if (opt.json) return out(JSON.stringify(r, null, 2));
    out(`${r.comment.id}: preview ${describePreview(r.preview)}${fixed ? ' · marked fixed' : ''}`);
  },

  async source({ pos, opt }, b) {
    const { slug } = await b.resolve(pos[0]);
    const v = str(opt.v) ? Number(str(opt.v)) : undefined;
    let source: RenderSource | null = null;
    if (!opt.clear) {
      const app = str(opt.app) || die('say where it was rendered: --app "After Effects" (or --clear)');
      const num = (x: string | undefined) => (x === undefined ? undefined : Number.isFinite(Number(x)) ? Number(x) : die(`not a number: ${x}`));
      source = { app, project: str(opt.project), comp: str(opt.comp), start_frame: num(str(opt.start_frame)), fps: num(str(opt.fps)) };
      for (const k of Object.keys(source) as (keyof RenderSource)[]) if (source[k] === undefined) delete source[k];
    }
    const ver = await b.setSource(slug, v, source, author(opt));
    out(`v${ver.v}: ${ver.source ? describeSource(ver.source) : 'source cleared'}`);
  },

  wontfix({ pos, opt }, b) {
    const note = str(opt.note) || str(opt.reason) || die('wontfix needs --note "reason"');
    return setStatus(b, pos[0], 'wontfix', { ...opt, note });
  },
  verify({ pos, opt }, b) {
    return setStatus(b, pos[0], 'verified', opt);
  },
  reopen({ pos, opt }, b) {
    return setStatus(b, pos[0], 'open', opt);
  },

  async reply({ pos, opt }, b) {
    const note = str(opt.note) ?? die('reply needs --note "…"');
    const c = await b.updateComment(pos[0] || die('missing <id>'), { note, by: author(opt), fixed_in_v: str(opt.v) });
    out(`${c.id}: reply added`);
  },

  async add({ pos, opt }, b) {
    const res = await b.resolve(pos[0], { mustExist: false });
    const review = res.fresh ? (await b.track(res.video, { by: author(opt) })).review : await b.review(res.slug, { wait: true });
    const slug = slugify(review.video);
    const lock = finalNotice(b, review);
    if (lock) process.stderr.write(`vr: note: ${lock}; this note waits until someone reopens it.\n`);
    const ver = opt.v ? review.versions.find((x) => x.v === Number(opt.v)) || die(`no v${opt.v}`) : latestOf(review);
    const at = str(opt.at);
    const t = str(opt.t);
    const overall = !!opt.overall;
    const frame = overall
      ? 0
      : opt.frame !== undefined
        ? parseInt(String(opt.frame), 10)
        : at
          ? parseFramePosition(at, ver.fps)
          : t
            ? parseFramePosition(t, ver.fps)
            : null;
    if (frame === null || !Number.isFinite(frame)) throw exit('give the position with --frame N, --at mm:ss:ff or --t seconds (or --overall)');
    if (frame < 0 || frame >= ver.frames) die(`frame ${frame} is outside 0–${ver.frames - 1}`);
    const text = str(opt.text) ?? die('add needs --text "…"');
    const nums = (s: string, n: number, what: string) => {
      const v = String(s).split(',').map(Number);
      if (v.length !== n || v.some((x) => !Number.isFinite(x))) die(`--${what} expects ${n} comma-separated numbers`);
      return v;
    };
    const drawing: Shape[] = [
      ...list(opt.box).map((x): Shape => {
        const [bx, by, w, h] = nums(x, 4, 'box');
        return { type: 'box', x: bx, y: by, w, h };
      }),
      ...list(opt.arrow).map((a): Shape => {
        const [x1, y1, x2, y2] = nums(a, 4, 'arrow');
        return { type: 'arrow', x1, y1, x2, y2 };
      }),
    ];
    let range: FrameRange | null = null;
    if (opt.range) {
      const [a, c] = String(opt.range)
        .split(/[-–:]/)
        .map((x) => parseInt(x, 10));
      if (!Number.isFinite(a) || !Number.isFinite(c)) die('--range expects IN-OUT frame numbers');
      range = { in: a, out: c };
    } else if (str(opt.to) !== undefined) {
      // --to: from the note's position to this end ("from 0:12 to 0:14 the music is too loud").
      const end = parseFramePosition(String(opt.to), ver.fps) ?? die(`bad --to "${opt.to}" (timecode mm:ss:ff, seconds or fN)`);
      range = { in: frame, out: end };
    }
    if (range && !overall)
      try {
        range = normalizeRange(range, ver.frames);
      } catch (e) {
        die((e as Error).message);
      }
    const severity = str(opt.severity);
    const kind = str(opt.kind);
    if (kind !== undefined && !isNoteKind(kind)) die('--kind is question, info or feedback');
    // A question's likely answers: each --choice once, 2–4 of them, one short line each.
    const offered = list(opt.choice);
    const choices = offered.length ? cleanChoices(offered) : null;
    if (offered.length && (!choices || choices.length !== offered.length || offered.some((x) => x.trim().length > CHOICE_MAX)))
      die(`--choice: give ${CHOICES_MIN}–${CHOICES_MAX} different answers, each one line of at most ${CHOICE_MAX} characters`);
    if (choices && (kind ?? (isAgent(author(opt)) ? 'question' : 'feedback')) !== 'question') die('--choice goes with a question (--kind question)');
    const { comment: c, review: after } = await b.addNote(slug, {
      v: ver.v,
      frame,
      range,
      text,
      tags: opt.tags
        ? String(opt.tags)
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [],
      severity: isSeverity(severity) ? severity : 'should',
      ...(isNoteKind(kind) ? { kind } : {}),
      drawing: overall ? [] : drawing,
      author: author(opt),
      ...(overall ? { scope: 'video' as const } : {}),
      ...(choices ? { choices } : {}),
    });
    if (opt.json) return out(JSON.stringify(withAbsShots(b, after, c), null, 2));
    const where = overall
      ? 'about the whole video'
      : `pinned at ${c.timecode} (f${c.frame}, v${c.v})${c.range ? `, range ${describeRange(c.range, ver.fps)}` : ''}`;
    out(`${c.id} ${where} by ${c.author}${c.kind && c.kind !== 'feedback' ? ` · ${c.kind}` : ''}`);
    if (c.choices) out(`    choices: ${c.choices.map(oneLine).join(' | ')}`);
    if (!overall) out(`    marked: ${b.shotFile(after, c.shots?.marked)}`);
  },

  // A reference on a note: an image, a clip or a link (the second argument), or a moment of a render (--video).
  async ref({ pos, opt }, b) {
    const [id, what] = pos;
    const usage = 'usage: vr ref <id> <file|url> [--caption "…"] [--note "…"]  or  vr ref <id> --video <video> --frame N [--to N] [--v N]';
    if (!id || (!what && !opt.video)) throw exit(usage);
    const hit = (await b.findComment(id)) || die(`no comment ${id}`);
    const base = { caption: str(opt.caption), note: str(opt.note), by: author(opt) };
    let input: RefInput;
    if (opt.video) {
      const res = await b.resolve(String(opt.video));
      const review = await b.review(res.slug);
      const ver = opt.v ? review.versions.find((x) => x.v === Number(opt.v)) || die(`no v${opt.v}`) : latestOf(review);
      const at = str(opt.at);
      const frame = opt.frame !== undefined ? parseInt(String(opt.frame), 10) : at ? parseFramePosition(at, ver.fps) : null;
      if (frame === null || !Number.isFinite(frame)) throw exit('a moment needs --frame N or --at mm:ss:ff');
      // --to like --at (mm:ss:ff, 12.1s, f363); a plain number is a frame, as it always was.
      const to = str(opt.to);
      const toFrame = to === undefined ? undefined : /^\d+$/.test(to) ? parseInt(to, 10) : parseFramePosition(to, ver.fps);
      if (toFrame === null || (toFrame !== undefined && !Number.isFinite(toFrame))) throw exit(`bad --to "${to}" (timecode mm:ss:ff, seconds, fN or a frame)`);
      input = { kind: 'frame', video: res.slug, v: ver.v, frame, ...(toFrame !== undefined ? { to_frame: toFrame } : {}), ...base };
    } else if (/^https?:\/\//i.test(what as string)) input = { kind: 'link', url: what as string, ...base };
    else input = { kind: 'file', path: path.resolve(what as string), ...base };
    const r = await b.attachRef(hit.comment.id, input);
    if (opt.json) return out(JSON.stringify(r, null, 2));
    out(`${r.comment.id}: reference ${describeRef(r.ref)}`);
  },

  async track({ pos, opt }, b) {
    const folder = newFolder(str(opt.folder));
    const res = await b.resolve(pos[0] || die('missing <video>'), { mustExist: false });
    const session = await pickSession(b, opt);
    let review: Review;
    let created = false;
    if (b.kind === 'remote' && !res.fresh) {
      // Already on the server: only the assignment and folder can change here (new renders go up with vr push).
      if (session !== undefined) await b.assign(res.slug, session, author(opt));
      review = folder !== undefined ? await b.move(res.slug, folder, author(opt)) : await b.review(res.slug);
    } else ({ review, created } = await b.track(res.video, { by: author(opt), session, folder }));
    out(oneLine(`${created ? 'added' : 'already under review'}: ${review.video} (v${latestOf(review).v})`));
    out(oneLine(`    session: ${review.session?.name || '-'} · folder: ${review.folder || 'Unsorted'}`));
    // the person reviews it now: the last line says how to hear their notes (lib/handoff.ts)
    out(WATCH_NOW_LINE);
  },

  async push({ pos, opt }, b) {
    const file = path.resolve(pos[0] || die('missing <file>: vr push render.mp4 [--folder "Project/Sub"] [--to <video>]'));
    newFolder(str(opt.folder));
    // Where its named elements are: read and checked before a byte goes up, attached once the version is there.
    if (opt.elements !== undefined && opt.part_at !== undefined) die('a part takes no elements map: attach one to a full render');
    const elements = opt.elements !== undefined ? elementMapFile(opt.elements) : undefined;
    const to = str(opt.to) ? (await b.resolve(str(opt.to))).slug : null;
    // A partial render (only where a note says PART RENDER OK): the frame its stretch starts at in the newest version.
    let part: { at: number; handles?: number } | undefined;
    if (opt.part_at !== undefined) {
      if (!to) die('a part goes into a video: vr push part.mp4 --to <video> --part-at <frame> [--handles 12]');
      const latest = latestOf(await b.review(to as string));
      // a plain number is a frame (as the note's PART RENDER OK line names it); timecodes, seconds and fN work too
      const raw = String(opt.part_at);
      const at = /^\d+$/.test(raw) ? Number(raw) : parseFramePosition(raw, latest.fps);
      if (at === null || !Number.isInteger(at)) die(`bad --part-at "${opt.part_at}" (a frame, fN, or a timecode mm:ss:ff)`);
      const handles = opt.handles !== undefined ? Number(opt.handles) : undefined;
      if (handles !== undefined && !Number.isInteger(handles)) die(`bad --handles "${opt.handles}" (frames)`);
      part = { at: at as number, ...(handles !== undefined ? { handles } : {}) };
    }
    process.stderr.write(`uploading ${path.basename(file)}${b.kind === 'remote' ? ` to ${b.where.replace(/^server: /, '')}` : ''}…\n`);
    const r = await b.push(file, { by: author(opt), folder: str(opt.folder) ?? null, name: str(opt.name), to, ...(part ? { part } : {}) });
    // The render is up whatever becomes of its map: a refused one says so, and how to send it again.
    let attached: ElementsAttached | undefined;
    if (elements)
      try {
        attached = await b.putElements(slugify(r.review.video), r.v, elements.map);
      } catch (e) {
        die(`v${r.v} is up, but its elements map was refused: ${(e as Error).message} (fix it, then: vr elements <video> ${elements.name} --v ${r.v})`);
      }
    if (opt.json)
      return out(
        JSON.stringify(
          {
            video: r.review.video,
            slug: slugify(r.review.video),
            v: r.v,
            created: r.created,
            duplicate: r.duplicate,
            ...(r.part ? { part: r.part } : {}),
            ...(attached ? { elements: attached } : {}),
            next: WATCH_NOW_LINE,
          },
          null,
          2,
        ),
      );
    const mapLine = attached ? `    ${elementsLine(attached)}` : null;
    // what the person reviews now (an unchanged one too): the last line says how to hear their notes (lib/handoff.ts)
    if (r.duplicate) {
      out(`unchanged: ${r.review.video} is already v${r.v} with these exact bytes`);
      if (mapLine) out(mapLine);
      return out(WATCH_NOW_LINE);
    }
    if (r.part) {
      const fps = latestOf(r.review).fps;
      out(
        oneLine(
          `new version: ${r.review.video} (v${r.v}, a part: frames ${r.part.at}–${r.part.at + r.part.frames - 1} of v${r.part.of}) · ${seamLine(r.part, fps)}`,
        ),
      );
      out('    a part is never final: send a full render once it is approved');
      out(WATCH_NOW_LINE);
      return;
    }
    out(oneLine(`${r.created ? 'added' : `new version`}: ${r.review.video} (v${r.v})${r.review.folder ? `  [${r.review.folder}]` : ''}`));
    const carried = r.review.comments.filter((c) => c.status === 'open' && c.carried_to === r.v).length;
    if (carried) out(`    ${carried} open comment(s) carried forward: check them against v${r.v}`);
    if (mapLine) out(mapLine);
    out(WATCH_NOW_LINE);
  },

  async elements({ pos, opt }, b) {
    const usage = 'usage: vr elements <video> <map.json> [--v N]';
    if (!pos[0] || !pos[1]) throw exit(usage);
    const { slug } = await b.resolve(pos[0]);
    const v = opt.v !== undefined ? Number(opt.v) : undefined;
    if (v !== undefined && !(Number.isInteger(v) && v > 0)) throw exit(`bad --v "${opt.v}" (a version number)\n${usage}`);
    const { map } = elementMapFile(pos[1]);
    const attached = await b.putElements(slug, v, map);
    if (opt.json) return out(JSON.stringify(attached, null, 2));
    out(`v${attached.v}: ${elementsLine(attached)}`);
  },

  async move({ pos, opt }, b) {
    const { slug, video } = await b.resolve(pos[0] || die('missing <video>'));
    if (!opt.none && !pos[1]) die('say where: vr move <video> "Project/Folder"  (or --none for Unsorted)');
    if (!opt.none) newFolder(pos[1]);
    // out of an archived project: the machine's owner may (a server refuses a token: a person takes one out in the app)
    const r = await b.move(slug, opt.none ? null : pos[1], author(opt), { out: true });
    out(oneLine(`${video} → ${r.folder || 'Unsorted'}`));
  },

  async folders({ opt }, b) {
    // archived projects (and what is in them) only with --archived, marked (archived)
    const shut = await b.archivedProjects();
    const reviews = forAgents(await b.listReviews()).filter((r) => !r.archived && (opt.archived || !archivedIn(r.folder, shut)));
    const folders = (await b.folders(reviews)).filter((f) => opt.archived || !archivedIn(f, shut));
    const count = (f: string) => reviews.filter((r) => r.folder && (r.folder === f || r.folder.startsWith(`${f}/`)));
    const openIn = (l: Review[]) => l.reduce((s, r) => s + counts(r).open, 0);
    if (opt.json)
      return out(
        JSON.stringify(
          folders.map((f) => ({ folder: f, videos: count(f).length, open: openIn(count(f)), ...(archivedIn(f, shut) === f ? { archived: true } : {}) })),
          null,
          2,
        ),
      );
    if (!folders.length) return out('no folders yet. Create one with: vr move <video> "Project/Folder"');
    for (const f of folders) {
      const l = count(f);
      const depth = f.split('/').length - 1;
      out(
        oneLine(
          `${'  '.repeat(depth)}${f.split('/').at(-1)}  (${l.length} video${l.length === 1 ? '' : 's'}, ${openIn(l)} open)${archivedIn(f, shut) === f ? ' (archived)' : ''}`,
        ),
      );
    }
    const unsorted = reviews.filter((r) => !r.folder).length;
    if (unsorted) out(`Unsorted  (${unsorted})`);
  },

  async assign({ pos, opt }, b) {
    const { slug, video } = await b.resolve(pos[0] || die('missing <video>'));
    const session = await pickSession(b, opt, { required: true });
    await b.assign(slug, session || null, author(opt));
    out(`${video} → ${session?.name || 'no session'}`);
  },

  async sync({ pos }, b) {
    const { slug } = await b.resolve(pos[0] || die('missing <video>'));
    const r = (await b.sync(slug)) || die(`no review for ${slug}`);
    const latest = latestOf(r.review);
    if (r.version) out(`registered v${latest.v}${r.carried ? `, ${r.carried} open comment(s) carried forward` : ''}`);
    // a new render waits on disk: nothing new in an archived project
    else if (r.archived) die(archivedWords(r.archived));
    else if (r.pending) out(`the file is still being written; try again in a moment (current v${latest.v})`);
    else out(`unchanged, v${latest.v}`);
  },

  async sessions({ opt }, b) {
    const sessions = await b.sessions();
    const target = str(opt.for);
    const video = target ? (await b.resolve(target, { mustExist: false })).video : null;
    const ranked = video ? rankSessions(sessions, video, await b.listReviews()) : sessions;
    if (opt.json) return out(JSON.stringify(ranked, null, 2));
    const self = me();
    for (const s of ranked)
      out(
        `${(s.name || '').padEnd(34)} ${String(s.kind || '').padEnd(12)} ${String(s.status || '').padEnd(8)} ${s.cwd || ''}${self && s.sessionId === self.sessionId ? '  (this session)' : ''}${'reason' in s && s.reason ? `  ← ${s.reason}` : ''}`,
      );
  },

  async qa({ pos, opt }, b) {
    const { slug } = await b.resolve(pos[0] || die('missing <video>'));
    const review = await b.review(slug, { wait: true });
    const ver = opt.v ? review.versions.find((x) => x.v === Number(opt.v)) || die(`no v${opt.v}`) : latestOf(review);
    const r = await b.qa(review, ver, { rerun: !!opt.rerun, progress: (m) => process.stderr.write(`${m}\n`) });
    const dismissed = new Set(review.qa_dismissed || []);
    // a finding dismissed in an earlier version stays dismissed on the same stretch (lib/findings.ts)
    const items = undismissed(r.items, review, ver.fps);
    if (opt.json) return out(JSON.stringify({ ...r, items, dismissed: [...dismissed] }, null, 2));
    out(
      `v${ver.v}: ${items.length} suggestion(s)${dismissed.size ? `, ${dismissed.size} dismissed` : ''}${r.text_language ? ` · text language ${r.text_language}` : ''}`,
    );
    for (const x of items)
      out(
        `  ${x.severity.toUpperCase().padEnd(6)} ${x.kind.padEnd(12)} ${timecode(x.frame, ver.fps)} f${x.frame}${x.range ? `-${x.range.out}` : ''} — ${x.text}${x.detail ? ` [${x.detail}]` : ''}${x.box ? `  box x${x.box.x} y${x.box.y} w${x.box.w} h${x.box.h}` : ''}`,
      );
    for (const n of r.notes || []) out(`  note: ${n}`);
  },

  async transcript({ pos, opt }, b) {
    const { slug } = await b.resolve(pos[0] || die('missing <video>'));
    const review = await b.review(slug, { wait: true });
    const ver = opt.v ? review.versions.find((x) => x.v === Number(opt.v)) || die(`no v${opt.v}`) : latestOf(review);
    const t = await b.transcript(review, ver, { rerun: !!opt.rerun, progress: (m) => process.stderr.write(`${m}\n`) });
    if (opt.json) return out(JSON.stringify(t, null, 2));
    if (opt.srt) return out(toSrt(t));
    if (opt.vtt) return out(toVtt(t));
    out(`v${ver.v} · ${t.language || 'language not reported'} · ${t.timing === 'word' ? 'word timings' : 'line timings (words spread over each line)'}`);
    if (!t.words.length) return out('  nothing is said in this render');
    if (opt.words) for (const w of t.words) out(`  ${timecode(w.f0, t.fps)}  f${w.f0}–f${w.f1}  ${oneLine(w.text)}`);
    else for (const l of t.lines) out(`  ${timecode(l.f0, t.fps)}–${timecode(l.f1, t.fps)}  f${l.f0}–f${l.f1}  ${oneLine(l.text)}`);
  },

  // Footage search (docs/footage.md): B-roll from the workspace's videos, as shots with exact in and out frames.
  async footage({ pos, opt }, b) {
    const [sub = 'status', ...args] = pos;
    const usage = 'vr footage find "<request>" [--aspect 9:16] [--min 2] [--max 8] [--motion push-in] [--no-text] [--sheet [f.jpg]] [--json]';
    if (sub === 'find') {
      // a bare flag before the request takes the request as its value: give it back
      const words = [...args];
      if (typeof opt.no_text === 'string') words.push(opt.no_text);
      if (typeof opt.sheet === 'string' && !/\.jpe?g$/i.test(opt.sheet)) words.push(opt.sheet);
      const sheetTo = typeof opt.sheet === 'string' && /\.jpe?g$/i.test(opt.sheet) ? path.resolve(opt.sheet) : undefined;
      const query = words.join(' ').trim();
      const aspect = str(opt.aspect);
      if (aspect && !['16:9', '9:16', '1:1'].includes(aspect)) die('--aspect is 16:9, 9:16 or 1:1');
      const motion = str(opt.motion);
      const { MOTION_WORDS } = await import('./footage/types.ts');
      if (motion && !(MOTION_WORDS as readonly string[]).includes(motion)) die(`--motion is one of ${MOTION_WORDS.join(', ')}`);
      const num = (v: OptValue | undefined, name: string) => {
        if (v === undefined) return undefined;
        const n = Number(v);
        return Number.isFinite(n) && n >= 0 ? n : die(`--${name} needs a number of seconds`);
      };
      const text = opt.no_text ? 'none' : str(opt.text);
      if (!query && !aspect && !motion && !text && !str(opt.said) && opt.min === undefined && opt.max === undefined) die(usage);
      const a = await b.findFootage({
        query,
        ...(aspect ? { aspect: aspect as '16:9' | '9:16' | '1:1' } : {}),
        ...(opt.min !== undefined ? { min_s: num(opt.min, 'min') } : {}),
        ...(opt.max !== undefined ? { max_s: num(opt.max, 'max') } : {}),
        ...(motion ? { motion: motion as (typeof MOTION_WORDS)[number] } : {}),
        ...(text ? { text } : {}),
        ...(str(opt.said) ? { said: str(opt.said) } : {}),
        ...(opt.limit !== undefined ? { limit: Math.max(1, Math.min(50, Math.round(num(opt.limit, 'limit') ?? 6))) } : {}),
      });
      const sheet =
        opt.sheet && a.shots.length
          ? (
              await b.footageSheet(
                a.shots.slice(0, 9).map((s) => s.id),
                sheetTo,
              )
            ).file
          : undefined;
      if (opt.json) return out(JSON.stringify(sheet ? { ...a, sheet } : a, null, 2));
      const { compactList } = await import('./footage/lines.ts');
      out(compactList(a));
      if (sheet) out(`sheet ${sheet}`);
      return;
    }
    if (sub === 'sheet') {
      const ids = args.flatMap((x) => x.split(',')).filter(Boolean);
      if (!ids.length) die('vr footage sheet <id…> [--out f.jpg]  (ids from vr footage find)');
      const r = await b.footageSheet(ids, str(opt.out) ? path.resolve(str(opt.out) as string) : undefined);
      return out(opt.json ? JSON.stringify(r) : `sheet ${r.file}`);
    }
    if (sub === 'on' || sub === 'off') {
      const s = await b.setFootage(sub === 'on', author(opt));
      if (opt.json) return out(JSON.stringify(s, null, 2));
      out(
        `footage search is ${s.on ? 'on' : 'off'} for this workspace${s.on && b.kind === 'local' ? ': the app indexes new versions as they come (and the rest at its next start); vr footage index does it now' : ''}`,
      );
      return;
    }
    if (sub === 'index') {
      if (b.kind !== 'local') die('the server indexes its footage on its own: vr footage status says how far it is');
      const ix = await import('./footage/indexer.ts');
      const { footageState } = await import('./footage/settings.ts');
      const st = footageState();
      if (!st.on) die(st.why ?? 'footage search is off');
      let list = ix.targets();
      if (args.length) {
        const slugs = new Set<string>();
        for (const a of args) slugs.add((await b.resolve(a)).slug);
        list = list.filter((t) => slugs.has(slugify(t.review.video)));
      }
      const n = await ix.indexNow(list, { progress: (m) => process.stderr.write(`vr footage: ${keepLines(m)}\n`) });
      const s = await b.footageStatus();
      if (opt.json) return out(JSON.stringify(s, null, 2));
      return out(`indexed ${n} now · ${s.indexed} of ${s.videos} videos searchable · ${s.shots} shots${s.failed ? ` · ${s.failed} failed` : ''}`);
    }
    if (sub === 'status') {
      const s = await b.footageStatus();
      if (opt.json) return out(JSON.stringify(s, null, 2));
      if (!s.on) return out(s.note ?? 'footage search is off');
      out(
        `footage search: ${s.indexed} of ${s.videos} videos indexed${s.waiting ? `, ${s.waiting} waiting` : ''}${s.failed ? `, ${s.failed} failed` : ''} · ${s.shots} shots · model ${s.model}${s.model_ready ? '' : s.download !== undefined ? ` (downloading, ${Math.round(s.download * 100)} %)` : ' (downloads on first use)'}`,
      );
      if (s.note) out(`  ${s.note}`);
      return;
    }
    die(`vr footage find | sheet | status | on | off | index  (${usage})`);
  },

  async taste({ pos, opt }, b) {
    const arg = pos[0] || die('missing <video|folder>');
    let scope: TasteScope;
    try {
      scope = scopeOf(await b.review((await b.resolve(arg)).slug));
    } catch {
      scope = { folder: folderName(arg) };
    }
    const { taste: t, file } = await b.taste(scope);
    if (opt.json) return out(JSON.stringify({ scope: t.scope, stats: t.stats, file }, null, 2));
    out(t.markdown);
    out(`\n(saved to ${file})`);
  },

  async playbook({ pos, opt }, b) {
    const sub = ['skill', 'export', 'propose', 'status'].includes(pos[0]) ? pos[0] : null;
    const args = sub ? pos.slice(1) : pos;
    // A folder of that exact name, else a video when one matches, else a folder; nothing (or "house") is the House.
    const whereOf = async (arg: string | undefined): Promise<PlaybookWhere> => {
      if (!arg || /^house$/i.test(arg)) return { folder: '' };
      const folder = folderName(arg);
      if (folder && (await b.folders(await b.listReviews())).includes(folder)) return { folder };
      try {
        return { video: (await b.resolve(arg)).slug };
      } catch {
        return { folder: folderName(arg) || '' };
      }
    };
    if (sub === 'status') {
      const p = await b.proposal(args[0] || die('missing <suggestion id> (pp_…)'));
      if (opt.json) return out(JSON.stringify(p, null, 2));
      out(
        oneLine(
          `${p.id} · ${p.section} of ${scopeLabel(p.scope)} · ${p.status}${p.decided_by ? ` by ${p.decided_by}` : ''}${p.rev ? ` (revision ${p.rev})` : ''}`,
        ),
      );
      if (p.reject_reason) out(oneLine(`why: ${p.reject_reason}`));
      return;
    }
    if (sub === 'propose') {
      const section = str(opt.section);
      if (section !== 'brief' && section !== 'rules' && section !== 'skill') return die('--section brief, rules or skill');
      const file = str(opt.file);
      const content = file ? fs.readFileSync(file, 'utf8') : (str(opt.text) ?? die('the new text: --file new.md or --text "…"'));
      const reason = str(opt.reason) || die('--reason "why": the person deciding reads it first');
      const evidence = (str(opt.evidence) || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const p = await b.proposePlaybook(await whereOf(args[0] || die('missing <video|folder> (or "house")')), {
        section,
        content,
        reason,
        evidence,
        by: author(opt),
      });
      if (opt.json) return out(JSON.stringify(p, null, 2));
      return out(oneLine(`suggested ${p.section} for ${scopeLabel(p.scope)}: ${p.id} (pending; a person decides — vr playbook status ${p.id})`));
    }
    if (sub === 'skill') {
      const name = args[0] || die('missing <skill name>');
      const s = await b.skill(await whereOf(args[1]), name);
      if (opt.json) return out(JSON.stringify(s, null, 2));
      // Into this folder only: every name the server gave is checked before the first file is written (A12 AGENT-8).
      const targets = opt.files
        ? landings(
            process.cwd(),
            'a file',
            s.files.map((f) => [f.name]),
          )
        : [];
      if (opt.files && s.files.some((f) => !SKILL_FILE.test(f.name)))
        die('refused: the server named a skill file that is not a plain file name; nothing was written');
      out(s.markdown.trimEnd());
      out(`\n${oneLine(`(from ${scopeLabel(s.from)}, updated ${s.updated} by ${s.by})`)}`);
      for (const [i, f] of s.files.entries()) {
        if (!opt.files) {
          out(oneLine(`- ${f.name} (${Math.max(1, Math.round(f.size / 1024))} KB)`));
          continue;
        }
        const got = await b.skillFile(s.from, s.name, f.name);
        if (!got) {
          out(`- ${f.name}: gone`);
          continue;
        }
        fs.copyFileSync(got, targets[i]);
        out(`- ${f.name} → ${targets[i]}`);
      }
      return;
    }
    const view = await b.playbook(await whereOf(args[0]));
    if (sub === 'export') {
      const dir = path.resolve(str(opt.to) || '.lampo/playbook');
      // Every skill first, and every name it gives checked inside `dir`, before the first file is written: the server
      // names the folders and files (A12 AGENT-8).
      const where = await whereOf(args[0]);
      const skills = [];
      for (const summary of view.skills) skills.push(await b.skill(where, summary.name));
      if (skills.some((s) => !SKILL_NAME.test(s.name) || s.files.some((f) => !SKILL_FILE.test(f.name))))
        die(`refused: the server named a skill or a skill file that is not a plain name; nothing was written to ${dir}`);
      fs.mkdirSync(dir, { recursive: true });
      const places = landings(dir, 'a skill or a file', [
        ['PLAYBOOK.md'],
        ...skills.flatMap((s) => [[s.name], [s.name, 'SKILL.md'], ...s.files.map((f) => [s.name, f.name])]),
      ]);
      fs.writeFileSync(places[0], view.markdown);
      const written = ['PLAYBOOK.md'];
      let at = 1;
      for (const s of skills) {
        const [sdir, skillFile] = [places[at], places[at + 1]];
        const files = places.slice(at + 2, at + 2 + s.files.length);
        at += 2 + s.files.length;
        fs.mkdirSync(sdir, { recursive: true });
        fs.writeFileSync(skillFile, skillMarkdown(s));
        written.push(`${s.name}/SKILL.md`);
        for (const [i, f] of s.files.entries()) {
          const got = await b.skillFile(s.from, s.name, f.name);
          if (got) {
            fs.copyFileSync(got, files[i]);
            written.push(`${s.name}/${f.name}`);
          }
        }
      }
      if (opt.json) return out(JSON.stringify({ dir, files: written, stamp: view.stamp }, null, 2));
      out(oneLine(`${view.label}: ${written.length} file${written.length === 1 ? '' : 's'} in ${dir}`));
      for (const w of written) out(`  ${w}`);
      return;
    }
    if (opt.json) return out(JSON.stringify(view, null, 2));
    out(view.markdown.trimEnd());
    if (view.stamp.length) out(`\n${oneLine(`revisions in force: ${view.stamp.map((x) => `${scopeLabel(x.scope)} r${x.rev}`).join(' · ')}`)}`);
    const mine = view.playbook.proposals.slice(-5);
    if (mine.length) out(`suggestions: ${mine.map((x) => `${x.id} ${x.status}`).join(' · ')}`);
  },

  // A post of a final video: drafted here, published by a person in the app (docs/publishing.md). `vr post` / `vr posts`
  // read where posts stand.
  async post({ pos, opt }, b) {
    const sub = pos[0] === 'draft' || pos[0] === 'list' ? pos[0] : 'list';
    const rest = pos[0] === sub ? pos.slice(1) : pos;
    if (sub === 'list') {
      const slug = rest[0] ? (await b.resolve(rest[0])).slug : undefined;
      const posts = await b.posts(slug);
      if (opt.json) return out(JSON.stringify(posts, null, 2));
      if (!posts.length) return out(slug ? 'no posts yet (vr post draft <video> --platform yt writes one for a final video)' : 'no posts yet');
      for (const p of posts) out(`${slug ? '' : `${oneLine(p.video)} · `}${postLines(p)}`);
      return;
    }
    const { slug } = await b.resolve(rest[0] || die('missing <video>'));
    const platform = platformOf(str(opt.platform)) || die('say where: --platform youtube|instagram|facebook (or yt, ig, fb)');
    const yesNo = (k: string): boolean | undefined => {
      const v = opt[k];
      if (v === undefined) return undefined;
      if (v === true || /^(yes|y|true|1)$/i.test(String(v))) return true;
      if (/^(no|n|false|0)$/i.test(String(v))) return false;
      return die(`--${k.replace(/_/g, '-')} takes yes or no`);
    };
    const review = await b.review(slug);
    const ver = review.versions.find((x) => x.v === review.final?.v) ?? latestOf(review);
    const cover = str(opt.cover);
    const coverFrame =
      cover === undefined ? undefined : /^\d+$/.test(cover) ? Number(cover) : (parseFramePosition(cover, ver.fps) ?? die(`bad --cover "${cover}"`));
    const text = str(opt.text) ?? (str(opt.file) ? fs.readFileSync(str(opt.file) as string, 'utf8') : undefined);
    const ai = yesNo('ai');
    const kids = yesNo('kids');
    const fields: PostFields = {
      ...(str(opt.title) !== undefined ? { title: str(opt.title) } : {}),
      ...(text !== undefined ? { description: text } : {}),
      ...(str(opt.tags) !== undefined ? { tags: String(str(opt.tags)).split(',') } : {}),
      ...(coverFrame !== undefined ? { cover_frame: coverFrame } : {}),
      ...(str(opt.visibility) ? { visibility: str(opt.visibility) as PostVisibility } : {}),
      ...(opt.at !== undefined ? { schedule_at: str(opt.at) || null } : {}),
      ...(ai !== undefined ? { ai_generated: ai } : {}),
      ...(platform === 'youtube' && (kids !== undefined || str(opt.category))
        ? { youtube: { ...(kids !== undefined ? { made_for_kids: kids } : {}), ...(str(opt.category) ? { category: str(opt.category) } : {}) } }
        : {}),
      ...(platform === 'instagram' && (opt.reel || opt.feed) ? { instagram: { kind: opt.feed ? ('feed' as const) : ('reel' as const) } } : {}),
    };
    if (fields.visibility && !['public', 'unlisted', 'private'].includes(fields.visibility)) die('--visibility is public, unlisted or private');
    const who = author(opt);
    const { post, created } = await b.draftPost({ slug, platform, fields, by: who });
    if (opt.json) return out(JSON.stringify(post, null, 2));
    out(`${created ? 'drafted' : 'updated'}: ${postLines(post)}`);
    out('a person checks and publishes it in Lampo (agents can’t)');
  },

  posts: (args, b) => commands.post({ pos: ['list', ...args.pos], opt: args.opt }, b),

  async status({ pos, opt }, b) {
    const { slug } = await b.resolve(pos[0] || die('missing <video>'));
    const text = opt.clear ? null : pos.slice(1).join(' ').trim() || die('say what you are doing: vr status <video> "rendering v4"  (or --clear)');
    const s = await b.setStatus(slug, text ? { text, eta_seconds: opt.eta ? Number(opt.eta) : undefined } : null, author(opt));
    out(s ? `status: "${s.text}"${s.until ? ` until ${s.until}` : ''}` : 'status cleared');
  },

  async diff({ pos, opt }, b) {
    const { slug } = await b.resolve(pos[0] || die('missing <video>'));
    const review = await b.review(slug, { wait: true });
    const v = opt.v ? Number(opt.v) : latestOf(review).v;
    const nv = review.versions.find((x) => x.v === v) || die(`no v${v}`);
    const ov = review.versions.find((x) => x.v === v - 1) || die(`v${v} has no previous version to compare with`);
    process.stderr.write(`comparing v${ov.v} → v${nv.v}…\n`);
    const d = await b.diff(review, ov, nv);
    if (opt.json) return out(JSON.stringify(d, null, 2));
    if (d.incomparable !== undefined) return out(`v${ov.v} → v${nv.v}: not comparable (${d.incomparable})`);
    const s = d.summary;
    out(
      `v${ov.v} → v${nv.v}: ${s.identical ? 'identical picture and sound' : `${s.changes} picture change(s), ${s.changed_seconds}s · ${s.audio_changes} audio change(s) · ${s.retimes} retime(s)`}`,
    );
    for (const r of d.ranges)
      out(
        `  ${r.kind.padEnd(5)} ${timecode(r.in, nv.fps)}–${timecode(r.out, nv.fps)}  f${r.in}-${r.out}${r.box ? `  region x${r.box.x} y${r.box.y} w${r.box.w} h${r.box.h}${r.whole ? ' (whole frame)' : ''}` : ''}`,
      );
    for (const t of d.retimes)
      out(
        `  retime ${timecode(t.frame, nv.fps)}  f${t.frame}  content shifted by ${t.shift_frames > 0 ? '+' : ''}${t.shift_frames} frames (${t.seconds}s) from here on`,
      );
  },

  async prompt({ pos }, b) {
    const { slug } = await b.resolve(pos[0]);
    const review = await b.review(slug);
    if (b.kind === 'local') return out(claudePrompt(review));
    await b.fetchShots(
      review,
      review.comments.filter((c) => c.status === 'open'),
    );
    out(claudePrompt(review, { shot: (f) => b.shotFile(review, f), dataFile: b.reviewData(review) }));
  },

  async inbox({ opt }, b) {
    const filt = sessionFilter(opt);
    const since = str(opt.since);
    let evs = (await b.events(5000)).filter(isInboxEvent);
    if (since) evs = evs.filter((e) => new Date(e.at) > new Date(since));
    if (filt) evs = evs.filter((e) => matchesSession({ name: e.session, id: e.session_id }, filt));
    evs = evs.reverse().slice(0, Number(opt.limit) || 50);
    if (opt.json) return out(JSON.stringify(evs, null, 2));
    if (!evs.length) return out('nothing new.');
    for (const e of evs) out(eventLine(e));
  },

  watch({ opt }, b) {
    const self = me();
    let filt: SessionFilter | null = null;
    const session = str(opt.session);
    if (session) filt = { name: session };
    else if (!opt.everyone && self) filt = { name: self.name, sessionId: self.sessionId };
    if (opt.mine && !self) die('--mine only works inside a Claude Code session');
    const scope = filt ? `videos assigned to ${filt.name}` : 'all videos';
    process.stderr.write(
      `vr watch: ${scope}${opt.all ? ', including agent events' : ''}${b.kind === 'remote' ? ` on ${b.where.replace(/^server: /, '')}` : ''}. Ctrl-C to stop.\n`,
    );
    return b.watch(
      (e) => {
        if (!opt.all && isAgent(e.by)) return;
        if (!opt.all && !WATCH_TYPES.includes(e.type)) return;
        if (self && e.by === `agent:${self.name}`) return;
        if (filt && !matchesSession({ name: e.session, id: e.session_id }, filt)) return;
        out(opt.json ? JSON.stringify(e) : opt.brief ? shortEventLine(e) : eventLine(e));
      },
      { session: self },
    );
  },

  // This store as a bundle for another (lib/bundleExport.ts): always the store on this machine, whatever vr logs in to.
  async export({ pos, opt }) {
    const file = pos[0] || die('vr export <out.tar> [--folder <name>]…  (docs/moving.md)');
    const { exportBundle } = await import('./bundleExport.ts');
    const r = await exportBundle({
      out: file,
      folders: list(opt.folder),
      log: (line) => process.stderr.write(`vr export: ${keepLines(line)}\n`),
    });
    const m = r.manifest;
    if (opt.json) return out(JSON.stringify({ file: r.file, bytes: r.bytes, ...m, files: m.files.length, warnings: r.warnings }, null, 2));
    const c = m.counts;
    out(`wrote ${r.file} (${(r.bytes / 1e9).toFixed(2)} GB), bundle ${m.id}`);
    out(
      `  ${c.reviews} videos · ${c.versions} versions (${(c.version_bytes / 1e9).toFixed(2)} GB) · ${c.notes} notes · ${c.replies} replies · ${c.drawings} drawings · ${c.approvals} sign-offs`,
    );
    out(
      `  ${c.files} files · ${c.events} events · ${c.folders} folders · ${c.playbooks} playbooks · ${c.views} videos with watching · taste for ${m.taste.length}`,
    );
    out(`  notes by ${m.owner.names.map((n) => oneLine(n)).join(', ') || '(no owner on this store)'} become the --owner account's on the server`);
    if (m.people.length) out(`  other people by account: ${m.people.map((p) => oneLine(p.name)).join(', ')} (map them with --people "Name=email")`);
    const l = m.left_out;
    out(
      `  left here: ${l.links} review links, ${l.drafts} drafts, ${l.recordings} unsent recordings, ${l.asks} questions on folders, ${l.samples} samples, ${l.events} events of videos or kinds that stay`,
    );
    for (const w of r.warnings) out(`  note: ${w}`);
    out('next: copy it to the server and run vr admin import there (docs/moving.md)');
  },

  login: ({ pos, opt }) => login({ pos, opt }),
  logout: () => logout(),
  whoami: ({ opt }) => whoami({ opt }, author(opt)),
  admin: ({ pos, opt }) => admin({ pos, opt }),
  mcp: ({ pos, opt }) => mcpCommand({ pos, opt }),
  render: ({ pos, opt, cmd = [] }, b) => render({ pos, opt, cmd }, b, { out, fail: die, by: author(opt) }),
};

async function setStatus(b: Backend, id: string | undefined, status: Comment['status'], opt: Opts): Promise<void> {
  if (!id) throw exit('missing <id>');
  const hit = (await b.findComment(id)) || die(`no comment ${id}`);
  const lock = status === 'fixed' || status === 'wontfix' ? finalNotice(b, hit.review) : null;
  if (lock) die(`${lock}: nothing to fix until the reviewer reopens it.`);
  if (status === 'fixed') await b.review(hit.slug, { wait: true });
  const c = await b.updateComment(id, { status, note: str(opt.note) ?? '', fixed_in_v: str(opt.v), preview: str(opt.preview), by: author(opt) });
  out(`${c.id}: ${c.status}${c.status === 'fixed' ? ` in v${c.fixed_in_v}` : ''}`);
  // An agent closed a note: how many of the video's notes are still open, or (none) how to hear the person's (lib/handoff.ts).
  if (status === 'fixed' || status === 'wontfix') {
    const open = (await b.review(hit.slug)).comments.filter((x) => x.status === 'open' && isRequired(x)).length;
    out(open ? stillOpenLine(open) : WATCH_NOW_LINE);
  }
}

// The session named on the command line: null = explicitly none, undefined = not mentioned (leave as is).
async function pickSession(b: Backend, opt: Opts, { required = false } = {}): Promise<SessionInput | null | undefined> {
  if (opt.none) return null;
  if (opt.me) {
    const s = me() || die('--me only works inside a Claude Code session');
    return { name: s.name || '', sessionId: s.sessionId, cwd: s.cwd };
  }
  const name = str(opt.session);
  if (name) {
    const sessions = await b.sessions();
    const s = sessions.find((x) => x.name === name || x.sessionId === name);
    return s ? { name: s.name || name, sessionId: s.sessionId, cwd: s.cwd } : { name };
  }
  if (required) die('say which session: --me, --session <name> or --none');
  return undefined;
}

export async function main(argv: string[]): Promise<void> {
  // The local store's workspace (VR_WORKSPACE, else #1): what every command below reads and writes — one it has.
  try {
    const ws = enterProcessWorkspace();
    if (!readCredentials()) checkProcessWorkspace(ws);
  } catch (e) {
    process.stderr.write(`vr: ${terminalText((e as Error).message)}\n`);
    process.exitCode = 1;
    return;
  }
  const [cmd = 'help', ...rest] = argv;
  const name = cmd === '--help' || cmd === '-h' ? 'help' : cmd;
  const fn = Object.hasOwn(commands, name) ? commands[name] : null;
  if (!fn) {
    process.stderr.write(`vr: unknown command "${terminalText(cmd)}"\n\n${help(openBackend().where)}\n`);
    process.exitCode = 2;
    return;
  }
  // `vr render … -- <command>`: what follows `--` is the agent's command, never vr's options.
  const split = name === 'render' ? rest.indexOf('--') : -1;
  const args: Args =
    split >= 0 ? { ...parseArgs(rest.slice(0, split)), cmd: rest.slice(split + 1) } : parseArgs(rest, new Set([...MULTI, ...(MULTI_OF[name] ?? [])]));
  // `vr push --help`: the command's own lines of the help, on stdout (tools read what a command takes from it).
  if (args.opt.help === true && name !== 'help') {
    out(usageOf(name, help(openBackend().where)));
    return;
  }
  // What an agent does with `vr` shows live in the app (lib/activity.ts): the command it ran anyway, no extra tokens.
  // A person running `vr` by hand records nothing.
  const agent = cliAgent();
  const guess = agent ? cliActivity(name, args.pos, args.opt) : null;
  const sink = guess ? openActivitySink() : null;
  const record = () => {
    if (guess && agent && sink) sink.record({ ...guess, at: isoLocal(), agent, target: guess.target ?? null, video: guess.video ?? null });
  };
  try {
    // A watch is told as it starts, without holding the watch up (the process outlives the send).
    if (name === 'watch') {
      record();
      sink?.flush().catch(() => {});
    }
    await fn(args, openBackend());
    if (name !== 'watch') {
      record();
      // The person stopped this agent's work and it hasn't heard yet: one line after the command's own output, once —
      // read from this machine's runs, or what the hosted server answered the activity with.
      const local = guess && !readCredentials() ? localStopLine(agent, { kind: guess.kind, video: guess.video ?? null, target: guess.target ?? null }) : null;
      const lines = [...(local ? [local] : []), ...((await sink?.flush()) ?? [])];
      for (const l of lines.slice(0, 2)) out(l);
    }
  } catch (e) {
    if (!(e instanceof Exit)) {
      process.stderr.write(`vr: ${terminalText((e as Error).message)}\n`);
      process.exitCode = 1;
    }
  }
}
