// What an agent is doing with a video right now ("rendering v4"), shown on the card and in the player header.
// Stored as review.agent_status = {text, by, at, until?}; cleared with null (and by the server when a new version lands).
import { isoLocal } from './paths.ts';
import { mutate } from './store.ts';
import type { AgentStatus } from './types.ts';

export function setAgentStatus(slug: string, status: { text?: string | null; eta_seconds?: number } | null, by = 'agent'): AgentStatus | null {
  return mutate(slug, (r) => {
    const text = String(status?.text || '').trim();
    if (!text) {
      delete r.agent_status;
      return null;
    }
    const s: AgentStatus = { text: text.slice(0, 200), by, at: isoLocal() };
    const eta = Number(status?.eta_seconds);
    if (Number.isFinite(eta) && eta > 0) s.until = isoLocal(new Date(Date.now() + eta * 1000));
    r.agent_status = s;
    return s;
  });
}
