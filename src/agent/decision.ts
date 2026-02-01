import type { WorkingState } from '../memory/workingState.js';
import { PLAYBOOKS, repoReconPlaybook } from './playbooks.js';
import type { PlaybookAction } from './playbooks.js';
import type { ToolRiskTier } from './toolPolicy.js';

export interface DecisionResult {
  playbookId: string;
  actions: PlaybookAction[];
  plan: string[];
  question?: string;
  maxToolTier: ToolRiskTier;
  rationale: string;
}

function detectRepoRecon(message: string) {
  const msg = message.toLowerCase();
  const repoWords = /repo|codebase|project|files|structure|tree|overview|recon|scan|inspect|map/.test(msg);
  const requestWords = /summarize|overview|recon|scan|inspect|map|structure|layout/.test(msg);
  return repoWords && requestWords;
}

export function choose_next_step(state: WorkingState, userMessage: string): DecisionResult {
  const maxToolTier: ToolRiskTier = 2;

  let playbook = PLAYBOOKS.find((p) => p.id === 'repo_recon' && detectRepoRecon(userMessage));
  if (!playbook && detectRepoRecon(userMessage)) playbook = repoReconPlaybook;

  if (playbook) {
    const actions = playbook.actions.filter((a) => a.tier <= maxToolTier);
    return {
      playbookId: playbook.id,
      actions,
      plan: playbook.plan,
      question: playbook.question,
      maxToolTier,
      rationale: `Matched playbook ${playbook.id} based on request`,
    };
  }

  const plan = ['Use available evidence to proceed'];

  return {
    playbookId: 'direct',
    actions: [],
    plan,
    maxToolTier,
    rationale: state.objective ? 'No playbook match; proceed with current objective' : 'No playbook match',
  };
}
