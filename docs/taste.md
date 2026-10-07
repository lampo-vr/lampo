# The taste file

Every note is a data point about what the reviewer likes. The taste file sums up all the notes of a project in one
short page that an agent reads **before it renders**: what you keep asking for, what you love, the decisions that stand
and the fixes that worked. The first render then already matches more of what you would ask for, and the round trips
get fewer.

Nobody writes it: Lampo builds it from the notes, the same way every time, so the same notes always give the same page.
What the team decides on purpose belongs in a [playbook](playbooks.md).

## Seeing it

- **In the app:** *See what agents read*, under *Agents: right the first time* on *Insights*, shows it for all videos.
- **Agents:** MCP `get_taste({video})` or `get_taste({folder: "Acme"})`, or `lampo taste <video|folder>` in a terminal.
- **As a file:** `data/taste/acme.md` (the numbers in `acme.json` beside it), written each time an agent reads it.
  Against a hosted server, `lampo` keeps its copy in its cache folder.

## Which notes count

- A video's taste comes from its **project**, the top-level folder it is filed in (for example *Acme*): every video
  filed anywhere under it, plus videos without a project that sit in a folder of the same name on disk.
- Asked for a folder inside a project (*Acme/Reels*), it covers only the videos filed in that folder or below it.
- People's notes count, clients' notes from review links too. Agents' own notes (their questions) aren't asks, and
  videos removed from the library and the first run's sample are left out. A project that is archived keeps its
  taste: its notes still count, and agents can still read it.

## What it says

| Section | What it holds | What the agent does with it |
|---|---|---|
| The header | how many videos, notes and versions, versions per video, notes per version | sees how settled the project is |
| **Keep doing** | notes tagged *love-it*, word for word | repeats those choices |
| **Recurring asks** | notes grouped by tag, most frequent first, each with its five newest different examples and how many were must, should, nice or idea | gets ahead of them before you have to ask again |
| **Decisions that stand** | notes closed as *won't fix*, with the reason | never "fixes" them |
| **Fixes that worked** | agents' fixes on notes you later checked | reuses solutions that worked |
| **Numbers** | where marks cluster per tag (in video pixels and % of the height), values you asked for ("40px", "2 dB", "4 Frames"), values in checked fixes, the loudness of the current versions | concrete targets |
| **Open right now** | the open notes, must first | knows what is still outstanding |

Notes stay in the language they were written in; the headings are English.

## Details

- Through MCP, *Open right now* is only a count (`get_open_notes` has those notes, per video), and the answer ends with
  a stamp such as `taste 1a2b3c4d`. An agent that hands it back, `get_taste({…, known: "taste 1a2b3c4d"})`, gets a
  one-line answer when nothing changed.
- The file is named after its scope in lowercase with dashes: `acme.md`, `acme-reels.md`.
- Over HTTP: `GET /api/taste?video=…` (or `folder=`, `project=`) answers `{scope, markdown, stats}`.
- In code, `lib/taste.ts`: `buildTaste(reviews, {folder | project | title})` → `{scope, markdown, stats, generated}`,
  `scopeForVideo(path)`, `writeTaste(scope)` → the file's path. Its `recurringAsks` also feeds the playbook's *The
  notes keep asking for* ([playbooks.md](playbooks.md#suggestions-from-agents)).
