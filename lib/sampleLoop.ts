// The first run's sample as the app shows it (shared with the browser: the player and Get started): its agent named
// after the agent picked in the setup, and where a person stands with its loop (its fix checked, its question
// answered). Apart from lib/onboarding.ts so the first paint doesn't carry it.
import type { SetupAgent } from './types.ts';

/** The names the sample's agent is stored under (lib/sample.ts SAMPLE_SCRIPTS); the app shows the agent the person
 * picked in the setup in its place. */
export const SAMPLE_AGENTS: readonly string[] = ['agent:Sample agent', 'agent:Beispiel-Agent'];
export const isSampleAgent = (by: string): boolean => SAMPLE_AGENTS.includes(by);

/**
 * Where a person stands with the sample's loop: its fix checked (Looks right, or Still wrong with a reason) and its
 * agent's question answered — by `name` (replies keep names; one is unique in a workspace). Both: the loop is closed.
 */
interface LoopNote {
  kind?: string | null;
  author: string;
  status?: string | null;
  fixed_in_v?: number | null;
  replies?: readonly { by: string; text?: string | null; status?: string | null; answer?: unknown }[] | null;
}
export function sampleLoop(review: { comments: readonly LoopNote[] }, name: string): { checked: 'right' | 'wrong' | null; answered: string | null } {
  let checked: 'right' | 'wrong' | null = null;
  let answered: string | null = null;
  for (const c of review.comments) {
    const mine = (c.replies ?? []).filter((r) => r.by === name);
    if (c.kind === 'question' && isSampleAgent(c.author)) {
      const a = mine.find((r) => r.status === 'verified' || r.answer || r.text);
      if (a) answered = a.text || 'answered';
    } else if (c.fixed_in_v || c.status === 'fixed' || c.status === 'verified') {
      for (const r of mine) if (r.status === 'verified' || r.status === 'open') checked = r.status === 'verified' ? 'right' : 'wrong';
    }
  }
  return { checked, answered };
}

/** The agents' names as their makers write them (not translated): Get started's and the sample's words. */
export const SETUP_AGENT_LABELS: Record<SetupAgent, string | null> = {
  'claude-code': 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  other: null,
  none: null,
};
