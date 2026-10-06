// Which agent is at work, at a glance: one mark per AgentKind (lib/agentKind.ts), drawn by AgentMark (ui/icons.tsx) in
// currentColor on a 24-unit grid. Logos (their path data in ui/agentLogos.ts) are from Simple Icons 16.33.0
// (https://simpleicons.org, CC0-1.0; GitHub Copilot's is MIT, from GitHub's Primer octicons); OpenAI's from Simple Icons 15.22.0, the last release that carried
// it (drawn from https://openai.com/brand). They are trademarks of their owners, used only to say which integration is
// connected (NOTICE.md). A kind without a mark to use gets a monogram tile — never draw a lookalike. Kinds with no
// company behind them get a glyph from the icon set.
import type { AgentKind } from '../../../lib/types.ts';
import type { AgentLogo } from './agentLogos.ts';

export type AgentMarkDef =
  /** A company's mark: one path on the 24-unit grid (ui/agentLogos.ts, loaded after the first paint). */
  | { type: 'logo'; logo: AgentLogo; owner: string }
  /** No mark to use: letters in a tile. */
  | { type: 'monogram'; letters: string }
  /** Not a product: a glyph of the icon set (ui/icons.tsx). */
  | { type: 'glyph'; icon: 'plug' | 'key' | 'terminal' };

export const AGENT_MARKS: Record<AgentKind, AgentMarkDef> = {
  'claude-code': { type: 'logo', logo: 'claude', owner: 'Anthropic' },
  claude: { type: 'logo', logo: 'claude', owner: 'Anthropic' },
  codex: { type: 'logo', logo: 'openai', owner: 'OpenAI' },
  chatgpt: { type: 'logo', logo: 'openai', owner: 'OpenAI' },
  cursor: { type: 'logo', logo: 'cursor', owner: 'Anysphere' },
  gemini: { type: 'logo', logo: 'gemini', owner: 'Google' },
  // VS Code's agent is GitHub Copilot; VS Code's own mark isn't in Simple Icons.
  vscode: { type: 'logo', logo: 'copilot', owner: 'GitHub' },
  // Simple Icons has no Antigravity mark (16.34.0)
  antigravity: { type: 'monogram', letters: 'AG' },
  windsurf: { type: 'logo', logo: 'windsurf', owner: 'Windsurf' },
  zed: { type: 'logo', logo: 'zed', owner: 'Zed Industries' },
  mcp: { type: 'glyph', icon: 'plug' },
  api: { type: 'glyph', icon: 'key' },
  cli: { type: 'glyph', icon: 'terminal' },
};
