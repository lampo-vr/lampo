// A run Lampo started prints Claude Code's stream-json, one JSON object per line. This reads it as it grows — fed
// whatever bytes arrived, partial lines kept for the next feed — into what the UI shows: the step it is on, and the
// tokens (and, only when the run states it, the cost) used so far. Browser-safe and pure; server/agentRuns.ts tails
// the log into it. Nothing is asked of the agent: it is the output the run writes anyway.
import { toolActivity, words } from './activityText.ts';
import { oneLine } from './time.ts';
import type { ActivityWords } from './types.ts';

export interface RunTokens {
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
}

export interface StreamStep extends ActivityWords {
  /** `denied`: a permission the run was denied (its tool call refused): what it needs, and `allow`. */
  kind: 'tool' | 'say' | 'run' | 'denied';
  /** denied: the rule in Claude Code's settings syntax that would allow it, for the person to copy. */
  allow?: string;
}

export interface StreamState {
  step: ActivityWords | null;
  tokens: RunTokens;
  cost_usd: number | null;
  turns: number | null;
  done: boolean;
  error: boolean;
  /** Its last words to the person (the result's text, its first lines): the run's hand-back. */
  summary: string | null;
}

interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}

const n = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) && x >= 0 ? x : 0);
const tokensOf = (u: Usage | undefined): RunTokens => ({
  input: n(u?.input_tokens),
  output: n(u?.output_tokens),
  cache_read: n(u?.cache_read_input_tokens),
  cache_write: n(u?.cache_creation_input_tokens),
});
const short = (s: string, max: number) => {
  const t = oneLine(s).trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** A file the run touches, as the person reads it: relative to the session's folder, else just its name. */
export function shownPath(file: unknown, cwd: string): string {
  if (typeof file !== 'string' || !file) return 'a file';
  const root = cwd.replace(/\/+$/, '');
  if (root && file.startsWith(`${root}/`)) return file.slice(root.length + 1);
  return file.split('/').filter(Boolean).at(-1) || 'a file';
}

/** One tool call of the run as a step ("Editing src/Logo.tsx", "Running npm run render"). Inputs are never shown in
 * full: a path, a command's first words, a search pattern. */
export function toolStep(name: string, input: Record<string, unknown>, cwd: string): ActivityWords {
  const s = (k: string) => (typeof input[k] === 'string' ? (input[k] as string) : '');
  switch (name) {
    case 'Edit':
    case 'MultiEdit':
      return words('Editing {file}', { file: shownPath(input.file_path, cwd) });
    case 'Write':
      return words('Writing {file}', { file: shownPath(input.file_path, cwd) });
    case 'NotebookEdit':
      return words('Editing {file}', { file: shownPath(input.notebook_path, cwd) });
    case 'Read':
      return words('Reading {file}', { file: shownPath(input.file_path, cwd) });
    case 'Bash':
      return s('command') ? words('Running {command}', { command: short(s('command'), 60) }) : words('Running a command');
    case 'Grep':
    case 'Glob':
      return s('pattern') ? words('Searching for {pattern}', { pattern: short(s('pattern'), 40) }) : words('Searching the project');
    case 'WebFetch':
    case 'WebSearch':
      return words('Looking something up on the web');
    case 'Task':
    case 'Agent':
      return words('Handing part of it to a helper');
    case 'TodoWrite':
      return words('Planning the next steps');
    default: {
      // Its own tools through Lampo's MCP server read like the rest of Lampo's activity, whatever key the session gave
      // the server (lampo, video-review in older setups, or one of its own).
      const m = /^mcp__.+?__(.+)$/.exec(name);
      if (m) {
        const g = toolActivity(m[1], input);
        if (g) return { text: g.text, ...(g.key ? { key: g.key } : {}), ...(g.vars ? { vars: g.vars } : {}), ...(g.quote ? { quote: g.quote } : {}) };
        return words('Using {tool}', { tool: short(m[1].replace(/_/g, ' '), 40) });
      }
      return words('Using {tool}', { tool: short(name, 40) });
    }
  }
}

/** A word that ends a command's prefix: an option, a path, an assignment, a quote, an expansion. */
const NOT_PREFIX = /^-|[/=$`'"(){}<>*?]/;

/**
 * The start of a shell command that says what it runs — the program and up to two words after it (`npx remotion
 * render`, `vr render`, `ffmpeg`) — without its paths, options or values: what a permission rule allows. Of a chain,
 * the first part that isn't a `cd`; leading variable assignments are left out.
 */
export function commandPrefix(command: string): string {
  const parts = command
    .split(/&&|\|\||;|\||\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const part = parts.find((p) => !/^cd(\s|$)/.test(p)) ?? parts[0] ?? '';
  const said = part.split(/\s+/).filter(Boolean);
  while (said.length > 1 && /^[A-Za-z_]\w*=/.test(said[0] as string)) said.shift();
  const out: string[] = [];
  for (const w of said) {
    if (out.length >= 3 || (out.length > 0 && NOT_PREFIX.test(w)) || /[`$'"]/.test(w)) break;
    out.push(w);
  }
  return short(out.join(' '), 60);
}

/**
 * What a run needs to be allowed, for a tool call it was refused: the words for the person, and the rule in Claude
 * Code's settings syntax (`permissions.allow`) that would allow it. Lampo only shows it; the person adds it, or not.
 */
export function permissionFor(name: string, input: Record<string, unknown>): { words: ActivityWords; allow: string } {
  const clean = (rule: string) => short(rule, 120);
  if (name === 'Bash') {
    const prefix = commandPrefix(typeof input.command === 'string' ? input.command : '');
    return prefix
      ? { words: words('Needs permission to run {command}', { command: prefix }), allow: clean(`Bash(${prefix}:*)`) }
      : { words: words('Needs permission to use {tool}', { tool: 'Bash' }), allow: 'Bash' };
  }
  if (name === 'Edit' || name === 'MultiEdit' || name === 'Write' || name === 'NotebookEdit') return { words: words('Needs permission to edit files'), allow: 'Edit' };
  const mcp = /^mcp__(.+?)__(.+)$/.exec(name);
  if (mcp) {
    // Lampo's own tools, under whatever key the session gave the server: all of them at once
    const ours = mcp[1] === 'lampo' || mcp[1] === 'video-review';
    return ours
      ? { words: words('Needs permission to use {tool}', { tool: 'Lampo' }), allow: clean(`mcp__${mcp[1]}`) }
      : { words: words('Needs permission to use {tool}', { tool: short(mcp[2].replace(/_/g, ' '), 40) }), allow: clean(name) };
  }
  if (name === 'WebFetch' && typeof input.url === 'string') {
    try {
      return { words: words('Needs permission to use {tool}', { tool: 'WebFetch' }), allow: clean(`WebFetch(domain:${new URL(input.url).hostname})`) };
    } catch {}
  }
  return { words: words('Needs permission to use {tool}', { tool: short(name, 40) }), allow: clean(name) };
}

/** Claude Code's words in a refused tool call's result (a headless run has nobody to ask). */
const DENIED = /requested permissions? to (use|run|write|edit|read)|haven[’']t granted it/i;

/** Reads a run's stream-json as it arrives. `feed` returns the steps that are new since the last feed. */
export function createRunReader(cwd: string) {
  let partial = '';
  /** The latest usage per assistant message (the stream repeats a message's usage with each of its blocks). */
  const perMessage = new Map<string, RunTokens>();
  let unnamed = 0;
  let final: RunTokens | null = null;
  /** Its tool calls by id (the latest few hundred), for a refusal that names only the id. */
  const calls = new Map<string, { name: string; input: Record<string, unknown> }>();
  /** Refusals already told (by the call's id). */
  const refused = new Set<string>();
  const state: StreamState = {
    step: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost_usd: null,
    turns: null,
    done: false,
    error: false,
    summary: null,
  };

  const sum = (): RunTokens => {
    if (final) return final;
    const t: RunTokens = { input: 0, output: 0, cache_read: 0, cache_write: 0 };
    for (const u of perMessage.values()) {
      t.input += u.input;
      t.output += u.output;
      t.cache_read += u.cache_read;
      t.cache_write += u.cache_write;
    }
    return t;
  };

  function line(raw: string, out: StreamStep[]) {
    const text = raw.trim();
    if (!text.startsWith('{')) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const push = (s: StreamStep) => {
      if (state.step?.text === s.text && s.kind !== 'denied') return;
      const { kind: _, allow: _a, ...step } = s;
      state.step = step;
      out.push(s);
    };
    // A refused call, once: what it needs and the rule that would allow it.
    const deny = (id: string, name: string | undefined, input: Record<string, unknown> | undefined) => {
      if (!name || refused.has(id)) return;
      refused.add(id);
      const p = permissionFor(name, input ?? {});
      push({ kind: 'denied', ...p.words, allow: p.allow });
    };
    if (e.type === 'assistant' && e.message && typeof e.message === 'object') {
      const m = e.message as { id?: string; content?: unknown[]; usage?: Usage };
      if (m.usage) perMessage.set(m.id || `m${unnamed++}`, tokensOf(m.usage));
      for (const b of Array.isArray(m.content) ? m.content : []) {
        const block = b as { type?: string; name?: string; input?: Record<string, unknown>; text?: string };
        if (block.type === 'tool_use' && block.name) {
          const id = (block as { id?: string }).id;
          if (id) {
            calls.set(id, { name: block.name, input: block.input || {} });
            if (calls.size > 500) calls.delete(calls.keys().next().value as string);
          }
          push({ kind: 'tool', ...toolStep(block.name, block.input || {}, cwd) });
        }
        // What it says in its own words: the first sentence, shown as it is.
        else if (block.type === 'text' && block.text?.trim()) push({ kind: 'say', text: short(block.text.split(/(?<=[.!?])\s/)[0] || block.text, 100) });
        else if (block.type === 'thinking') push({ kind: 'say', ...words('Thinking') });
      }
      state.tokens = sum();
    } else if (e.type === 'user' && e.message && typeof e.message === 'object') {
      // a tool call refused for want of a permission: its result says so
      const m = e.message as { content?: unknown[] };
      for (const b of Array.isArray(m.content) ? m.content : []) {
        const r = b as { type?: string; tool_use_id?: string; is_error?: boolean; content?: unknown };
        if (r.type !== 'tool_result' || !r.is_error || !r.tool_use_id) continue;
        const said =
          typeof r.content === 'string' ? r.content : Array.isArray(r.content) ? r.content.map((c) => (c as { text?: string }).text ?? '').join(' ') : '';
        const call = calls.get(r.tool_use_id);
        if (DENIED.test(said) && call) deny(r.tool_use_id, call.name, call.input);
      }
    } else if (e.type === 'result') {
      // the refusals the run had, as its result lists them (permission_denials), any not told yet
      const denials = Array.isArray(e.permission_denials) ? e.permission_denials : [];
      for (const d of denials.slice(0, 20)) {
        const x = d as { tool_name?: unknown; tool_use_id?: unknown; tool_input?: unknown };
        if (typeof x.tool_name !== 'string') continue;
        const input = x.tool_input && typeof x.tool_input === 'object' ? (x.tool_input as Record<string, unknown>) : {};
        deny(typeof x.tool_use_id === 'string' ? x.tool_use_id : `${x.tool_name}:${JSON.stringify(input).slice(0, 200)}`, x.tool_name, input);
      }
      const usage = e.usage as Usage | undefined;
      if (usage) final = tokensOf(usage);
      state.tokens = sum();
      state.cost_usd = typeof e.total_cost_usd === 'number' && Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null;
      state.turns = typeof e.num_turns === 'number' ? e.num_turns : null;
      state.done = true;
      state.error = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
      if (typeof e.result === 'string' && e.result.trim()) state.summary = short(e.result, 300);
      push({ kind: 'run', ...words(state.error ? 'Stopped with an error' : 'Finished') });
    }
  }

  return {
    /** New bytes of the log, as text. */
    feed(chunk: string): StreamStep[] {
      const out: StreamStep[] = [];
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      // A runaway line (no newline for a long time) is dropped rather than kept growing.
      if (partial.length > 1_000_000) partial = '';
      for (const l of lines) line(l, out);
      return out;
    },
    state: (): StreamState => ({ ...state, step: state.step && { ...state.step }, tokens: { ...state.tokens } }),
  };
}
