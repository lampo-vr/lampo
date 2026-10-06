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

export interface RunStep extends ActivityWords {
  kind: 'tool' | 'say' | 'run';
}

export interface RunState {
  step: ActivityWords | null;
  tokens: RunTokens;
  cost_usd: number | null;
  turns: number | null;
  done: boolean;
  error: boolean;
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

/** Reads a run's stream-json as it arrives. `feed` returns the steps that are new since the last feed. */
export function createRunReader(cwd: string) {
  let partial = '';
  /** The latest usage per assistant message (the stream repeats a message's usage with each of its blocks). */
  const perMessage = new Map<string, RunTokens>();
  let unnamed = 0;
  let final: RunTokens | null = null;
  const state: RunState = {
    step: null,
    tokens: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
    cost_usd: null,
    turns: null,
    done: false,
    error: false,
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

  function line(raw: string, out: RunStep[]) {
    const text = raw.trim();
    if (!text.startsWith('{')) return;
    let e: Record<string, unknown>;
    try {
      e = JSON.parse(text) as Record<string, unknown>;
    } catch {
      return;
    }
    const push = (s: RunStep) => {
      if (state.step?.text === s.text) return;
      const { kind: _, ...step } = s;
      state.step = step;
      out.push(s);
    };
    if (e.type === 'assistant' && e.message && typeof e.message === 'object') {
      const m = e.message as { id?: string; content?: unknown[]; usage?: Usage };
      if (m.usage) perMessage.set(m.id || `m${unnamed++}`, tokensOf(m.usage));
      for (const b of Array.isArray(m.content) ? m.content : []) {
        const block = b as { type?: string; name?: string; input?: Record<string, unknown>; text?: string };
        if (block.type === 'tool_use' && block.name) push({ kind: 'tool', ...toolStep(block.name, block.input || {}, cwd) });
        // What it says in its own words: the first sentence, shown as it is.
        else if (block.type === 'text' && block.text?.trim()) push({ kind: 'say', text: short(block.text.split(/(?<=[.!?])\s/)[0] || block.text, 100) });
        else if (block.type === 'thinking') push({ kind: 'say', ...words('Thinking') });
      }
      state.tokens = sum();
    } else if (e.type === 'result') {
      const usage = e.usage as Usage | undefined;
      if (usage) final = tokensOf(usage);
      state.tokens = sum();
      state.cost_usd = typeof e.total_cost_usd === 'number' && Number.isFinite(e.total_cost_usd) ? e.total_cost_usd : null;
      state.turns = typeof e.num_turns === 'number' ? e.num_turns : null;
      state.done = true;
      state.error = e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success');
      push({ kind: 'run', ...words(state.error ? 'Stopped with an error' : 'Finished') });
    }
  }

  return {
    /** New bytes of the log, as text. */
    feed(chunk: string): RunStep[] {
      const out: RunStep[] = [];
      const lines = (partial + chunk).split('\n');
      partial = lines.pop() ?? '';
      // A runaway line (no newline for a long time) is dropped rather than kept growing.
      if (partial.length > 1_000_000) partial = '';
      for (const l of lines) line(l, out);
      return out;
    },
    state: (): RunState => ({ ...state, step: state.step && { ...state.step }, tokens: { ...state.tokens } }),
  };
}
