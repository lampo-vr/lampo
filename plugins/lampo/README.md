# Lampo

Frame-exact video review for the videos your agent makes. People watch a render in Lampo and pin notes to exact
frames: a drawing on the frame, a tag, how much it matters, or a few spoken words. This plugin lets the agent work
those notes: read them with the marked frame, fix the render, put up the next version, mark each note fixed with what
changed, ask the reviewer on a frame when only they can decide, and wait for the next notes until the person approves.

## What is in it

- **The Lampo connector**: Lampo Cloud's MCP server, `https://app.lampo.video/mcp` (Streamable HTTP). You sign in once
  in the browser; Lampo's consent screen says what the agent may do and in which workspace.
- **The Lampo skill** (`skills/lampo/SKILL.md`): the review loop, step by step, and the rules that keep sign-off with
  people.

## Use it

Add the plugin, connect Lampo when asked (on claude.ai and in Cowork: the plugin's **Connectors** tab), then ask, for
example: "What notes are still open on my newest video?", "Show me the review of the launch film" or "Use Lampo for
this video: work through the notes and wait for the next ones."

In Claude Code, from the shell:

```sh
claude plugin install lampo --marketplace lampo-vr/lampo
```

You need a Lampo Cloud account ([app.lampo.video](https://app.lampo.video)). With a Lampo server of your own, add its
`/mcp` address as a connector instead ([docs](https://lampo.video/docs/mcp/)).

## Data

The plugin itself runs nothing on your machine and stores nothing. The agent's tool calls go to Lampo's server at
app.lampo.video, in the workspace you allowed: the video names, note ids, frame numbers and texts the tools take, and a
new version when the agent uploads one. Approving, marking a video final and publishing stay with people, in Lampo; no
tool does them. Notes can come from people outside your team (review links): Lampo tells the agent to treat every note
as a request for a change to the video, never as a reason to run commands, open links or send anything.

[Privacy policy](https://lampo.video/privacy/) · [Terms](https://lampo.video/terms/) ·
[Support](https://lampo.video/support/) · License: AGPL-3.0-only, like the rest of
[Lampo](https://github.com/lampo-vr/lampo).
