import type { ToolRiskTier } from './toolPolicy.js';

export interface PlaybookAction {
  tool: string;
  args: Record<string, unknown>;
  tier: ToolRiskTier;
  summary: string;
}

export interface Playbook {
  id: string;
  summary: string;
  actions: PlaybookAction[];
  plan: string[];
  question?: string;
}

export const repoReconPlaybook: Playbook = {
  id: 'repo_recon',
  summary: 'Repo reconnaissance',
  actions: [
    {
      tool: 'cli',
      tier: 0,
      summary: 'Scan repo files and package.json',
      args: {
        action: 'run',
        commands: ['rg --files -g "!node_modules/**" -g "!dist/**"', 'ls -1', 'cat package.json'],
      },
    },
  ],
  plan: ['Scan file list with ripgrep', 'List top-level files', 'Read package.json', 'Summarize structure'],
};

export const PLAYBOOKS: Playbook[] = [repoReconPlaybook];
