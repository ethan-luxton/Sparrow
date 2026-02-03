import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createChatClient, getChatModel } from '../lib/llm.js';
import type { PixelTrailConfig } from '../config/config.js';
import type { WorkingState } from '../memory/workingState.js';
import type { RetrievedMemory } from '../memory/ledger.js';
import { injectMarkdown } from '../lib/markdown/injector.js';
import { migrateWorkspaceDocs } from '../lib/markdown/migration.js';

export interface SummaryInput {
  objective: string;
  observations: string[];
  workingState: WorkingState;
  memories: RetrievedMemory[];
}

export interface LLMResult {
  text: string;
  tokens?: number;
}

export class AgentLLM {
  private client: OpenAI;
  private model: string;

  constructor(cfg: PixelTrailConfig) {
    this.client = createChatClient(cfg);
    this.model = getChatModel(cfg);
  }

  private workspaceMsg(userText: string): ChatCompletionMessageParam | null {
    migrateWorkspaceDocs();
    const injection = injectMarkdown({ userText, tools: [] });
    if (!injection.text) return null;
    return { role: 'system', content: `Workspace docs:\n${injection.text}` };
  }

  private formatMemories(memories: RetrievedMemory[]) {
    if (!memories.length) return '(none)';
    return memories
      .map((m) => `- ${m.text} [${m.citation.blockId}:${m.citation.eventId}]`)
      .join('\n');
  }

  private formatWorkingState(state: WorkingState) {
    return JSON.stringify(state, null, 2);
  }

  async summarizeRepoRecon(input: SummaryInput, maxTokens = 280): Promise<LLMResult> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are a concise operator. Summarize repo structure and risks based on observations. Use citations like [block_id:event_id] when referencing memory snippets. Keep it brief and actionable.',
      },
      ...(this.workspaceMsg(input.objective) ? [this.workspaceMsg(input.objective) as ChatCompletionMessageParam] : []),
      { role: 'system', content: `Objective:\n${input.objective}` },
      { role: 'system', content: `Working state:\n${this.formatWorkingState(input.workingState)}` },
      { role: 'system', content: `Memories:\n${this.formatMemories(input.memories)}` },
      {
        role: 'user',
        content:
          'Summarize the repo structure and any risks. Use observations as primary evidence; cite memories only if used.',
      },
      { role: 'assistant', content: `Observations:\n${input.observations.join('\n') || '(none)'}` },
    ];

    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    return { text };
  }

  async summarizeCalendar(input: SummaryInput, maxTokens = 240): Promise<LLMResult> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You summarize upcoming calendar events. Keep it concise, mention dates/times, and flag conflicts if obvious. If no events, say so.',
      },
      ...(this.workspaceMsg(input.objective) ? [this.workspaceMsg(input.objective) as ChatCompletionMessageParam] : []),
      { role: 'system', content: `Objective:\n${input.objective}` },
      { role: 'system', content: `Working state:\n${this.formatWorkingState(input.workingState)}` },
      { role: 'user', content: 'Summarize the upcoming events from these observations:' },
      { role: 'assistant', content: input.observations.join('\n') || '(none)' },
    ];
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    return { text };
  }

  async phraseUserUpdate(input: { objective: string; content: string }, maxTokens = 120): Promise<LLMResult> {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You are a minimal, natural-language updater for a local autonomous agent. Keep it short and avoid rigid templates.',
      },
      ...(this.workspaceMsg(input.objective) ? [this.workspaceMsg(input.objective) as ChatCompletionMessageParam] : []),
      { role: 'system', content: `Objective: ${input.objective}` },
      { role: 'user', content: `Turn this into a brief user update:\n${input.content}` },
    ];
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
    });
    const text = completion.choices[0]?.message?.content?.trim() ?? '';
    return { text };
  }
}
