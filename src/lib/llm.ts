import crypto from 'node:crypto';
import OpenAI from 'openai';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import { PixelTrailConfig, getSecret } from '../config/config.js';

export type AIProvider = 'openai' | 'anthropic';

type AnthropicContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string };

type AnthropicMessage = { role: 'user' | 'assistant'; content: string | AnthropicContentBlock[] };

export interface LLMChatCompletionRequest {
  model: string;
  messages: ChatCompletionMessageParam[];
  tools?: ChatCompletionTool[];
  tool_choice?: any;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
}

export interface LLMChatCompletionResponse {
  choices: Array<{
    message: {
      content?: string | null;
      tool_calls?: Array<{
        id: string;
        type: 'function';
        function: { name: string; arguments: string };
      }>;
    };
    finish_reason?: string;
  }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    input_tokens?: number;
    output_tokens?: number;
  };
}

export function getAIProvider(cfg: PixelTrailConfig): AIProvider {
  return (cfg.aiProvider ?? 'openai') === 'anthropic' ? 'anthropic' : 'openai';
}

export function getChatModel(cfg: PixelTrailConfig): string {
  if (getAIProvider(cfg) === 'anthropic') {
    return cfg.anthropic?.model ?? process.env.ANTHROPIC_MODEL ?? 'claude-3-7-sonnet-latest';
  }
  return cfg.openai?.model ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini';
}

export function getCodingModel(cfg: PixelTrailConfig): string {
  return cfg.openai?.codeModel ?? process.env.OPENAI_CODE_MODEL ?? 'gpt-5.1-codex-mini';
}

export function supportsTools(cfg: PixelTrailConfig): boolean {
  return true;
}

export function supportsWebSearch(cfg: PixelTrailConfig): boolean {
  return true;
}

export function createChatClient(cfg: PixelTrailConfig): OpenAI {
  const apiKey = getSecret(cfg, 'openai.apiKey');
  const baseURL = cfg.openai?.baseUrl ?? process.env.OPENAI_BASE_URL;
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export function createCodingClient(cfg: PixelTrailConfig): OpenAI {
  return createChatClient(cfg);
}

function normalizeContent(content: ChatCompletionMessageParam['content']): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((item: any) => (typeof item?.text === 'string' ? item.text : item?.content ?? ''))
      .filter(Boolean)
      .join('\n');
  }
  return '';
}

function toAnthropic(messages: ChatCompletionMessageParam[]) {
  const systemParts: string[] = [];
  const output: AnthropicMessage[] = [];
  let pendingResults: AnthropicContentBlock[] = [];

  const flushToolResults = () => {
    if (pendingResults.length) {
      output.push({ role: 'user', content: pendingResults });
      pendingResults = [];
    }
  };

  for (const msg of messages) {
    if (msg.role === 'system') {
      const text = normalizeContent(msg.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (msg.role === 'tool') {
      const toolCallId = (msg as any).tool_call_id;
      const content = normalizeContent(msg.content);
      if (!toolCallId) continue;
      pendingResults.push({ type: 'tool_result', tool_use_id: String(toolCallId), content });
      continue;
    }

    flushToolResults();
    if (msg.role === 'assistant' && (msg as any).tool_calls?.length) {
      const toolCalls = (msg as any).tool_calls as Array<any>;
      const blocks: AnthropicContentBlock[] = [];
      const text = normalizeContent(msg.content);
      if (text) blocks.push({ type: 'text', text });
      for (const call of toolCalls) {
        if (!call?.function?.name) continue;
        let input: unknown = {};
        try {
          input = call.function.arguments ? JSON.parse(call.function.arguments) : {};
        } catch {
          input = {};
        }
        blocks.push({ type: 'tool_use', id: call.id ?? crypto.randomUUID(), name: call.function.name, input });
      }
      output.push({ role: 'assistant', content: blocks.length ? blocks : '' });
      continue;
    }

    const text = normalizeContent(msg.content);
    if (msg.role === 'user' || msg.role === 'assistant') {
      output.push({ role: msg.role, content: text });
    }
  }

  flushToolResults();
  return { system: systemParts.join('\n\n').trim(), messages: output };
}

function toAnthropicTools(tools?: ChatCompletionTool[]) {
  if (!tools?.length) return undefined;
  return tools
    .filter((tool) => tool.type === 'function')
    .map((tool) => ({
      name: tool.function?.name ?? '',
      description: tool.function?.description ?? '',
      input_schema: tool.function?.parameters ?? {},
    }));
}

function toAnthropicToolChoice(toolChoice: any) {
  if (!toolChoice) return undefined;
  if (toolChoice === 'auto') return { type: 'auto' };
  if (toolChoice === 'none') return { type: 'none' };
  if (toolChoice?.type === 'function' && toolChoice?.function?.name) {
    return { type: 'tool', name: toolChoice.function.name };
  }
  return undefined;
}

async function createAnthropicCompletion(cfg: PixelTrailConfig, request: LLMChatCompletionRequest): Promise<LLMChatCompletionResponse> {
  const apiKey = getSecret(cfg, 'anthropic.apiKey');
  const baseURL = cfg.anthropic?.baseUrl ?? process.env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com';
  const version = cfg.anthropic?.version ?? process.env.ANTHROPIC_VERSION ?? '2023-06-01';
  const maxTokens = request.max_completion_tokens ?? request.max_tokens ?? cfg.anthropic?.maxTokens ?? 1024;
  const { system, messages } = toAnthropic(request.messages);
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: maxTokens,
    messages,
    temperature: request.temperature ?? 0.2,
    ...(system ? { system } : {}),
  };
  const tools = toAnthropicTools(request.tools);
  if (tools?.length) body.tools = tools;
  const toolChoice = toAnthropicToolChoice(request.tool_choice);
  if (toolChoice && tools?.length) body.tool_choice = toolChoice;

  const resp = await fetch(`${baseURL.replace(/\/$/, '')}/v1/messages`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': version,
    },
    body: JSON.stringify(body),
  });
  const raw = await resp.text();
  if (!resp.ok) {
    throw new Error(`Anthropic API error ${resp.status}: ${raw}`);
  }
  const data = JSON.parse(raw) as any;
  const contentBlocks = Array.isArray(data.content) ? data.content : [];
  const textParts: string[] = [];
  const toolCalls: Array<{ id: string; type: 'function'; function: { name: string; arguments: string } }> = [];
  for (const block of contentBlocks) {
    if (block.type === 'text') {
      textParts.push(String(block.text ?? ''));
    } else if (block.type === 'tool_use') {
      toolCalls.push({
        id: String(block.id ?? ''),
        type: 'function',
        function: { name: String(block.name ?? ''), arguments: JSON.stringify(block.input ?? {}) },
      });
    }
  }
  const content = textParts.join('\n').trim();
  const usage = data.usage
    ? {
        prompt_tokens: data.usage.input_tokens,
        completion_tokens: data.usage.output_tokens,
        total_tokens: (data.usage.input_tokens ?? 0) + (data.usage.output_tokens ?? 0),
      }
    : undefined;
  return {
    choices: [
      {
        message: {
          content: content || '',
          tool_calls: toolCalls.length ? toolCalls : undefined,
        },
        finish_reason: data.stop_reason ?? undefined,
      },
    ],
    usage,
  };
}

export async function createChatCompletion(
  cfg: PixelTrailConfig,
  request: LLMChatCompletionRequest
): Promise<LLMChatCompletionResponse> {
  if (getAIProvider(cfg) === 'anthropic') {
    return createAnthropicCompletion(cfg, request);
  }
  const client = createChatClient(cfg);
  const completion = await client.chat.completions.create(request as any);
  return completion as unknown as LLMChatCompletionResponse;
}
