import type { ToolDefinition, Permission } from '../tools/registry.js';

export type ToolRiskTier = 0 | 1 | 2 | 3;

const NETWORK_TOOLS = new Set(['google_drive', 'gmail', 'google_calendar', 'weather', 'n8n', 'whisper_transcribe', 'todoist']);
const FORBIDDEN_TOOLS = new Set<string>();
const ACTION_TIERS: Record<string, Record<string, ToolRiskTier>> = {
  workspace: {
    ensure_workspace: 0,
    list_projects: 0,
    list_files: 0,
    read_file: 0,
    search: 0,
    ensure_project: 1,
    write_file: 1,
    apply_patch: 1,
  },
  git: {
    status: 0,
    log: 0,
    diff: 0,
    show: 0,
    branch_list: 0,
    fetch: 0,
    config_list: 0,
    init: 1,
    add: 1,
    branch_create: 1,
    checkout: 2,
    switch: 2,
    pull: 2,
    push: 2,
    commit: 2,
    stash: 2,
    restore: 2,
    reset: 2,
    merge: 2,
    rebase: 2,
    tag: 2,
  },
  todoist: {
    list_tasks: 1,
    filter_tasks: 1,
    get_task: 1,
    create_task: 2,
    update_task: 2,
    delete_task: 2,
  },
};

export function getToolRiskTier(name: string, permission?: Permission): ToolRiskTier {
  if (FORBIDDEN_TOOLS.has(name)) return 3;
  if (permission === 'write') return 2;
  if (NETWORK_TOOLS.has(name)) return 1;
  return 0;
}

export function getActionTier(name: string, action?: string, permission?: Permission): ToolRiskTier {
  if (action && ACTION_TIERS[name]?.[action]) return ACTION_TIERS[name][action];
  return getToolRiskTier(name, permission);
}

export function filterToolsByTier(tools: ToolDefinition[], maxTier: ToolRiskTier): ToolDefinition[] {
  return tools.filter((tool) => getToolRiskTier(tool.name, tool.permission) <= maxTier);
}
