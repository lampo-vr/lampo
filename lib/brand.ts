// The product's name where people read it: the app, notifications, the OAuth consent, the MCP server's title. Agents
// know it as "lampo" too: the MCP server's key in their configs (MCP_NAME in lib/mcpConfig.ts), the `lampo` command
// (`vr`, its name before, still runs it), LAMPO_* settings (VR_* still read: lib/env.ts), lampo:// resources and the
// package @lampo-vr/lampo. What stays: MCP tool names, data paths and file formats, the formats agents parse.
export const BRAND_NAME = 'Lampo';
/**
 * The key people give the MCP server in their agent's config (`claude mcp add lampo …`, `[mcp_servers.lampo]`), so
 * also what Claude Code calls its prompts (/lampo:watch). Only the client knows it — the server never sees it — so a
 * setup made under the earlier default, `video-review`, or any other name keeps working unchanged
 * (`lampo mcp config <client> --name video-review` still prints one). lib/mcpConfig.ts re-exports it.
 */
export const MCP_NAME = 'lampo';
/** The product's site: where "Powered by Lampo" at the foot of the client's pages leads. */
export const SITE_URL = 'https://lampo.video';
