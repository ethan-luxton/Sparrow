import type Database from 'better-sqlite3';
import type { ToolRegistry } from '../tools/registry.js';
import { getDbHandle, addMessage, getLastMessageTimestamp, listChats } from '../lib/db.js';
import { deriveFactsFromMessage } from '../memory/derive.js';
import {
  addMemoryItem,
  recordAssistantMessage,
  recordDecision,
  recordDerivedFact,
  recordObservation,
  recordUserMessage,
  searchMemory,
  sealPendingBlocks,
} from '../memory/ledger.js';
import { getWorkingState, mergeWorkingState, saveWorkingState } from '../memory/workingState.js';
import { defaultProjectName, inferProjectName } from '../lib/workspace.js';
import type { LLMResult, SummaryInput } from './llm.js';
import {
  enqueueTask,
  getActiveObjective,
  getAgentState,
  getNextTask,
  listChatsWithQueuedTasks,
  markTaskCompleted,
  markTaskFailed,
  markTaskStarted,
  setActiveObjective,
  updateAgentState,
} from './store.js';

export interface AgentRuntimeOptions {
  tickMaxToolCalls?: number;
  tickMaxTokens?: number;
  proactiveIntervalMs?: number;
  proactiveIdleMs?: number;
}

export type Notifier = (chatId: number, text: string) => Promise<void>;

export interface AgentLLMLike {
  summarizeRepoRecon(input: SummaryInput, maxTokens?: number): Promise<LLMResult>;
  summarizeCalendar(input: SummaryInput, maxTokens?: number): Promise<LLMResult>;
  summarizeProactive(input: SummaryInput, maxTokens?: number): Promise<LLMResult>;
  phraseUserUpdate(input: { objective: string; content: string }, maxTokens?: number): Promise<LLMResult>;
}

export interface NotifyState {
  reason: 'checkpoint' | 'needs_user' | 'error' | 'none';
  message?: string;
}

const ALLOWED_RUNTIME_TOOLS = new Set([
  'cli',
  'file_snippet',
  'code_search',
  'doc_index',
  'project_summary',
  'google_calendar',
  'workspace',
  'git',
  'system_info',
  'disk_usage',
  'process_list',
  'service_status',
]);

const RUNTIME_SAFE_ACTIONS: Record<string, Set<string>> = {
  google_calendar: new Set(['list_events', 'list_calendars']),
  workspace: new Set(['ensure_workspace', 'list_projects', 'read_file', 'list_files', 'search']),
  git: new Set(['status', 'log', 'diff', 'show', 'branch_list', 'config_list']),
};

function summarize(text: string, maxLen = 800) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function detectRepoRecon(message: string) {
  const msg = message.toLowerCase();
  return /inspect|recon|scan|overview|structure/.test(msg) && /repo|codebase|project/.test(msg);
}

function detectCalendar(message: string) {
  const msg = message.toLowerCase();
  return /calendar|schedule|agenda/.test(msg);
}

function needsClarification(message: string) {
  const trimmed = message.trim();
  if (trimmed.length < 8) return true;
  if (/^help$/i.test(trimmed)) return true;
  return false;
}

function isScratchProject(name?: string | null) {
  if (!name) return true;
  return name.startsWith('scratch-');
}

export function shouldNotifyUser(state: NotifyState, lastNotifiedAt: string | null) {
  if (state.reason === 'none') return false;
  if (state.reason === 'error' || state.reason === 'needs_user') return true;
  if (!lastNotifiedAt) return true;
  const last = Date.parse(lastNotifiedAt);
  if (!Number.isFinite(last)) return true;
  return Date.now() - last > 60_000;
}

export class AgentRuntime {
  private tools: ToolRegistry;
  private llm: AgentLLMLike;
  private notify: Notifier;
  private opts: AgentRuntimeOptions;
  private db: Database.Database;
  private busy = new Set<number>();

  constructor(opts: { tools: ToolRegistry; llm: AgentLLMLike; notify: Notifier; db?: Database.Database; options?: AgentRuntimeOptions }) {
    this.tools = opts.tools;
    this.llm = opts.llm;
    this.notify = opts.notify;
    this.opts = opts.options ?? {};
    this.db = opts.db ?? getDbHandle();
  }

  async handleUserMessage(chatId: number, text: string) {
    recordUserMessage(chatId, text);
    addMessage(chatId, 'user', text);

    const objective = setActiveObjective(chatId, text, this.db);
    const working = getWorkingState(chatId, this.db);
    const decisionNotes: string[] = [];

    const facts = deriveFactsFromMessage(text);
    for (const fact of facts) {
      const factEventId = recordDerivedFact(chatId, fact.text);
      addMemoryItem(this.db, { chatId, kind: fact.kind, text: fact.text, eventId: factEventId, project: working.currentProject });
    }

    if (detectRepoRecon(text)) {
      decisionNotes.push('Matched repo reconnaissance playbook.');
      this.enqueueRepoRecon(chatId, objective.id);
    } else if (detectCalendar(text)) {
      decisionNotes.push('Matched calendar overview playbook.');
      this.enqueueCalendarOverview(chatId, objective.id);
    } else if (needsClarification(text)) {
      decisionNotes.push('Need clarification to proceed.');
      enqueueTask(
        {
          chatId,
          objectiveId: objective.id,
          type: 'user_update',
          payload: { content: 'What outcome should I target for this task?' },
        },
        this.db
      );
    } else {
      decisionNotes.push('No playbook matched; queued a minimal update.');
      enqueueTask(
        {
          chatId,
          objectiveId: objective.id,
          type: 'user_update',
          payload: { content: 'Got it. I can take a closer look—tell me what you want optimized or analyzed.' },
        },
        this.db
      );
    }

    if (decisionNotes.length) {
      recordDecision(chatId, decisionNotes.join(' '));
    }

    const inferredProject = inferProjectName(text) ?? (working.currentProject || defaultProjectName());
    const updated = mergeWorkingState(
      working,
      {
        objective: objective.text,
        constraints: Array.from(
          new Set([
            ...(working.constraints ?? []),
            'CLI tool is read-only; no writes, sudo, kills, or installs.',
            'Ask at most one question only if needed.',
          ])
        ),
        currentProject: inferredProject,
      },
      { maxObservations: 6, maxNextActions: 6 }
    );
    saveWorkingState(chatId, updated, this.db);
    sealPendingBlocks(this.db, { force: true });
  }

  private enqueueRepoRecon(chatId: number, objectiveId: number | null) {
    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'tool',
        payload: {
          tool: 'cli',
          args: { action: 'run', commands: ['rg --files -g \"!node_modules/**\" -g \"!dist/**\"', 'ls -1', 'cat package.json'] },
          observationLabel: 'Repo files and package.json',
        },
      },
      this.db
    );
    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'tool',
        payload: {
          tool: 'cli',
          args: { action: 'run', commands: ['rg -n \"(bin|main|module|exports|entry|cli)\" package.json', 'rg -n \"(cli|index|main|server|app)\\\\.(ts|js)\" src'] },
          observationLabel: 'Entrypoints scan',
        },
      },
      this.db
    );
    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'llm_summary',
        payload: { kind: 'repo_recon', notify: true },
      },
      this.db
    );
  }

  private enqueueCalendarOverview(chatId: number, objectiveId: number | null) {
    const now = new Date();
    const timeMin = now.toISOString();
    const timeMax = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();
    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'tool',
        payload: {
          tool: 'google_calendar',
          args: { action: 'list_events', calendarId: 'primary', timeMin, timeMax, maxResults: 20 },
          observationLabel: 'Upcoming calendar events',
        },
      },
      this.db
    );
    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'llm_summary',
        payload: { kind: 'calendar_summary', notify: true },
      },
      this.db
    );
  }

  private shouldQueueProactive(chatId: number) {
    const state = getAgentState(chatId, this.db);
    if (state.paused || state.canceled) return false;
    const lastMsgIso = getLastMessageTimestamp(chatId);
    if (!lastMsgIso) return false;
    const lastMsgMs = Date.parse(lastMsgIso);
    if (!Number.isFinite(lastMsgMs)) return false;
    const idleMs = Date.now() - lastMsgMs;
    const idleThreshold = this.opts.proactiveIdleMs ?? 30 * 60 * 1000;
    if (idleMs < idleThreshold) return false;

    const lastNotifyMs = state.lastNotifiedAt ? Date.parse(state.lastNotifiedAt) : 0;
    const intervalMs = this.opts.proactiveIntervalMs ?? 60 * 60 * 1000;
    if (Date.now() - lastNotifyMs < intervalMs) return false;

    return true;
  }

  private maybeQueueProactiveTasks(chatId: number) {
    if (!this.shouldQueueProactive(chatId)) return;
    if (getNextTask(chatId, this.db)) return;

    const objective = getActiveObjective(chatId, this.db);
    const working = getWorkingState(chatId, this.db);
    const intent = `${objective?.text ?? ''} ${working.objective ?? ''}`.trim();
    const objectiveId = objective?.id ?? null;

    if (detectCalendar(intent)) {
      this.enqueueCalendarOverview(chatId, objectiveId);
      return;
    }
    if (detectRepoRecon(intent)) {
      this.enqueueRepoRecon(chatId, objectiveId);
      return;
    }

    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'tool',
        payload: {
          tool: 'workspace',
          args: { action: 'list_projects' },
          observationLabel: 'Workspace projects',
        },
      },
      this.db
    );

    if (!isScratchProject(working.currentProject)) {
      enqueueTask(
        {
          chatId,
          objectiveId,
          type: 'tool',
          payload: {
            tool: 'git',
            args: { action: 'status', project: working.currentProject },
            observationLabel: `Git status (${working.currentProject})`,
          },
        },
        this.db
      );
    }

    enqueueTask(
      {
        chatId,
        objectiveId,
        type: 'llm_summary',
        payload: { kind: 'proactive_insight', notify: true },
      },
      this.db
    );
  }

  async tick(chatId: number) {
    if (this.busy.has(chatId)) return;
    const state = getAgentState(chatId, this.db);
    if (state.paused || state.canceled) return;
    const task = getNextTask(chatId, this.db);
    if (!task) return;
    this.busy.add(chatId);
    try {
      markTaskStarted(task.id, chatId, this.db);
      const payload = JSON.parse(task.payload || '{}') as Record<string, any>;
      if (task.type === 'tool') {
        const maxToolCalls = this.opts.tickMaxToolCalls ?? 1;
        if (maxToolCalls < 1) return;
        const toolName = String(payload.tool ?? '');
        const args = payload.args ?? {};
        const observationLabel = payload.observationLabel ?? toolName;
        const result = await this.runTool(toolName, args, chatId);
        const obsText = `${observationLabel}: ${summarize(result)}`;
        recordObservation(chatId, obsText, { tool: toolName, taskId: task.id });
        this.appendObservation(chatId, obsText);
        markTaskCompleted(task.id, chatId, this.db);
        sealPendingBlocks(this.db, { force: true });
        return;
      }

      if (task.type === 'llm_summary') {
        const maxTokens = this.opts.tickMaxTokens ?? 280;
        const objective = getActiveObjective(chatId, this.db);
        const working = getWorkingState(chatId, this.db);
        const memories = objective ? searchMemory(this.db, chatId, objective.text, 6, 200, working.currentProject) : [];
        const observations = working.lastObservations ?? [];
        const summaryInput = {
          objective: objective?.text ?? 'Summarize findings',
          observations,
          workingState: working,
          memories,
        };
        const summary =
          payload.kind === 'calendar_summary'
            ? await this.llm.summarizeCalendar(summaryInput, maxTokens)
            : payload.kind === 'proactive_insight'
              ? await this.llm.summarizeProactive(summaryInput, maxTokens)
              : await this.llm.summarizeRepoRecon(summaryInput, maxTokens);
        const cleaned = summary.text.trim();
        if (cleaned) {
          addMessage(chatId, 'assistant', cleaned);
          recordAssistantMessage(chatId, cleaned);
          recordObservation(chatId, summarize(cleaned, 500), { taskId: task.id });
          const notifyState = { reason: payload.notify ? 'checkpoint' : 'none', message: cleaned } as const;
          if (shouldNotifyUser(notifyState, getAgentState(chatId, this.db).lastNotifiedAt)) {
            await this.notify(chatId, cleaned);
            updateAgentState(chatId, { lastNotifiedAt: new Date().toISOString() }, this.db);
          }
        }
        markTaskCompleted(task.id, chatId, this.db);
        sealPendingBlocks(this.db, { force: true });
        return;
      }

      if (task.type === 'user_update') {
        const content = String(payload.content ?? '').trim();
        if (content) {
          const notifyState = { reason: 'needs_user', message: content } as const;
          if (shouldNotifyUser(notifyState, getAgentState(chatId, this.db).lastNotifiedAt)) {
            await this.notify(chatId, content);
            updateAgentState(chatId, { lastNotifiedAt: new Date().toISOString() }, this.db);
          }
          addMessage(chatId, 'assistant', content);
          recordAssistantMessage(chatId, content);
        }
        markTaskCompleted(task.id, chatId, this.db);
        sealPendingBlocks(this.db, { force: true });
        return;
      }

      if (task.type === 'patch') {
        const patch = String(payload.patch ?? '').trim();
        const note = String(payload.note ?? 'I need to make changes. Please apply this patch/diff:').trim();
        if (patch) {
          const message = `${note}\n\n${patch}`;
          const notifyState = { reason: 'needs_user', message } as const;
          if (shouldNotifyUser(notifyState, getAgentState(chatId, this.db).lastNotifiedAt)) {
            await this.notify(chatId, message);
            updateAgentState(chatId, { lastNotifiedAt: new Date().toISOString() }, this.db);
          }
          addMessage(chatId, 'assistant', message);
          recordAssistantMessage(chatId, message);
        }
        markTaskCompleted(task.id, chatId, this.db);
        sealPendingBlocks(this.db, { force: true });
        return;
      }
    } catch (err) {
      const message = (err as Error).message;
      markTaskFailed(task.id, chatId, message, this.db);
      const notifyState = { reason: 'error', message: `Blocked: ${message}` } as const;
      const notice = notifyState.message ?? `Blocked: ${message}`;
      addMessage(chatId, 'assistant', notice);
      recordAssistantMessage(chatId, notice);
      if (shouldNotifyUser(notifyState, getAgentState(chatId, this.db).lastNotifiedAt)) {
        await this.notify(chatId, notice);
        updateAgentState(chatId, { lastNotifiedAt: new Date().toISOString() }, this.db);
      }
    } finally {
      this.busy.delete(chatId);
    }
  }

  async tickAll() {
    const chats = listChats();
    for (const chatId of chats) {
      this.maybeQueueProactiveTasks(chatId);
    }
    const queued = listChatsWithQueuedTasks(this.db);
    for (const chatId of queued) {
      await this.tick(chatId);
    }
  }

  pause(chatId: number) {
    updateAgentState(chatId, { paused: 1 }, this.db);
  }

  resume(chatId: number) {
    updateAgentState(chatId, { paused: 0 }, this.db);
  }

  cancel(chatId: number) {
    updateAgentState(chatId, { canceled: 1 }, this.db);
  }

  private async runTool(name: string, args: Record<string, unknown>, chatId: number) {
    if (!ALLOWED_RUNTIME_TOOLS.has(name)) {
      throw new Error(`Tool not allowed: ${name}`);
    }
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool not found: ${name}`);
    if (tool.permission !== 'read') {
      const action = String((args as any)?.action ?? '');
      const allowed = RUNTIME_SAFE_ACTIONS[name]?.has(action);
      if (!allowed) {
        throw new Error(`Tool ${name} requires write permissions. Provide a patch/diff for the user to apply.`);
      }
    }
    const result = await this.tools.run(name, args, chatId);
    return typeof result === 'string' ? result : JSON.stringify(result, null, 2);
  }

  private appendObservation(chatId: number, observation: string) {
    const working = getWorkingState(chatId, this.db);
    const updated = mergeWorkingState(
      working,
      { lastObservations: [...(working.lastObservations ?? []), observation] },
      { maxObservations: 6 }
    );
    saveWorkingState(chatId, updated, this.db);
  }
}
