import type { ToolDefinition, Permission } from '../tools/registry.js';

export type ToolRiskTier = 0 | 1 | 2 | 3;

const NETWORK_TOOLS = new Set(['google_drive', 'gmail', 'google_calendar', 'weather', 'n8n']);
const FORBIDDEN_TOOLS = new Set<string>();

export function getToolRiskTier(name: string, permission?: Permission): ToolRiskTier {
  if (FORBIDDEN_TOOLS.has(name)) return 3;
  if (permission === 'write') return 2;
  if (NETWORK_TOOLS.has(name)) return 1;
  return 0;
}

export function filterToolsByTier(tools: ToolDefinition[], maxTier: ToolRiskTier): ToolDefinition[] {
  return tools.filter((tool) => getToolRiskTier(tool.name, tool.permission) <= maxTier);
}
