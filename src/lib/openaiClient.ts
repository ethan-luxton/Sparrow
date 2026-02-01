import { SYSTEM_PROMPT } from './prompt.js';
import { getMessages, addMessage, getUserProfile, listNotes } from './db.js';
import { SparrowConfig } from '../config/config.js';
import { logger } from './logger.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import fs from 'fs-extra';
import path from 'node:path';
import { createChatClient, getChatModel, supportsTools } from './llm.js';
import type OpenAI from 'openai';

function summarize(text: string, maxLen: number) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

async function withTimeout<T>(promise: Promise<T>, ms: number) {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  let timeout: NodeJS.Timeout | undefined;
  const timer = new Promise<never>((_, reject) => {
    timeout = setTimeout(() => reject(new Error(`Model request timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([promise, timer]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

export class OpenAIClient {
  private client: OpenAI;
  private cfg: SparrowConfig;

  constructor(cfg: SparrowConfig) {
    this.client = createChatClient(cfg);
    this.cfg = cfg;
  }

  async chat(chatId: number, userText: string, tools: ToolRegistry) {
    const historyLimit = Math.max(1, Math.min(this.cfg.bot?.maxHistory ?? 12, 50));
    const rawHistory = getMessages(chatId, historyLimit * 3);
    const history = rawHistory.filter((m) => m.role !== 'tool').slice(-historyLimit);
    if (history.length && history[history.length - 1].role === 'user' && history[history.length - 1].content === userText) {
      history.pop(); // avoid duplicating the current user message
    }
    const profile = getUserProfile(chatId);
    const assistant = this.cfg.assistant;
    const user = this.cfg.user;
    const personality = loadPersonalityGuide();
    const cliGuide = loadCliGuide();
    const notes = listNotes(chatId, 3);
    const model = getChatModel(this.cfg);
    const debugIO = process.env.SPARROW_DEBUG_IO === '1';
    const baseMsgs: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(personality ? ([{ role: 'system', content: `Personality guide:\n${personality}` }] as ChatCompletionMessageParam[]) : []),
      ...(cliGuide ? ([{ role: 'system', content: `CLI tool guide:\n${cliGuide}` }] as ChatCompletionMessageParam[]) : []),
      ...(assistant
        ? ([
            {
              role: 'system',
              content: `Assistant profile:\n${JSON.stringify(
                {
                  name: assistant.name,
                  age: assistant.age,
                  hobbies: assistant.hobbies,
                  description: assistant.description,
                },
                null,
                2
              )}`,
            },
          ] as ChatCompletionMessageParam[])
        : []),
      ...(user
        ? ([
            {
              role: 'system',
              content: `User profile:\n${JSON.stringify(
                {
                  name: user.name,
                  role: user.role,
                  preferences: user.preferences,
                  timezone: user.timezone,
                },
                null,
                2
              )}`,
            },
          ] as ChatCompletionMessageParam[])
        : []),
      ...(notes.length
        ? ([
            {
              role: 'system',
              content:
                'User notes (most recent first):\n' +
                notes
                  .map((n) => `- ${n.title}: ${n.content.replace(/\s+/g, ' ').slice(0, 200)}`)
                  .join('\n'),
            },
          ] as ChatCompletionMessageParam[])
        : []),
      ...(profile ? ([{ role: 'system', content: `User working style profile:\n${profile}` }] as ChatCompletionMessageParam[]) : []),
      ...history.map((m) => ({ role: m.role as any, content: m.content })),
      { role: 'user', content: userText },
    ];

    const allowTools = supportsTools(this.cfg);
    const toolDefs: ChatCompletionTool[] = allowTools ? tools.asOpenAITools() : [];
    const openaiMsgs: ChatCompletionMessageParam[] = [...baseMsgs];
    logger.info(
      `chat.in chatId=${chatId} model=${model} tools=${toolDefs.length} text=${summarize(
        userText,
        debugIO ? 4000 : 400
      )}`
    );
    if (toolDefs.length) {
      // Let the model know explicitly which tools exist and when to use them.
      openaiMsgs.push({
        role: 'system',
        content: `Available tools: ${toolDefs
          .map((t) => (t as any).function?.name ?? '')
          .filter(Boolean)
          .join(
            ', '
          )}. Use them when they help. If a tool has an action field, choose the most appropriate action yourself; only ask the user if required inputs are missing. Minimize tool calls and avoid redundant steps.

CLI tool notes:
- Use action=run with a commands array for multi-step tasks.
- Allowed operators: pipe (|), &&, and one fallback (cmd1 || cmd2). Avoid ;, >, < (except /dev/null).
- Redirects are only allowed to /dev/null (e.g., 2>/dev/null).
- Prefer separate commands (e.g., "cd ~/projects", "ls -1", "git -C ~/projects/sparrow status").
- You can use action=start to create a session and reuse sessionId across calls to preserve cwd.
`,
      });
    }

    const accumulated: ChatCompletionMessageParam[] = [...openaiMsgs];

    let toolIterations = 0;
    const maxToolIterations = 12;
    const seenToolCalls = new Set<string>();

    while (true) {
      const request: any = {
        model,
        messages: accumulated,
      };
      if (toolDefs.length) {
        request.tools = toolDefs;
        request.tool_choice = 'auto';
      }
      const timeoutMs = Number(process.env.SPARROW_MODEL_TIMEOUT_MS ?? 120000);
      const completion = await withTimeout(this.client.chat.completions.create(request), timeoutMs);

      const msg = completion.choices[0].message;
      if (!msg) throw new Error('No completion message');
      if (debugIO) {
        logger.info(
          `chat.raw chatId=${chatId} finish=${completion.choices[0].finish_reason ?? 'n/a'} content=${summarize(
            msg.content ?? '',
            2000
          )}`
        );
      }

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        if (!toolDefs.length) {
          const text = 'Tool calls are disabled for the current model configuration.';
          addMessage(chatId, 'assistant', text);
          logger.warn(`chat.tool_calls_blocked chatId=${chatId} model=${model}`);
          return text;
        }
        const toolNames = msg.tool_calls
          .map((c) => (c.type === 'function' ? c.function?.name : undefined))
          .filter(Boolean)
          .join(',');
        logger.info(`chat.tool_calls chatId=${chatId} count=${msg.tool_calls.length} tools=${toolNames}`);
        toolIterations += 1;
        if (toolIterations > maxToolIterations) {
          const halt = 'Tool call limit reached; please clarify or simplify the request.';
          addMessage(chatId, 'assistant', halt);
          logger.warn(`chat.tool_limit chatId=${chatId} limit=${maxToolIterations}`);
          return halt;
        }
        // Store the assistant tool request
        accumulated.push({ role: 'assistant', tool_calls: msg.tool_calls, content: msg.content ?? '' });
        addMessage(chatId, 'assistant', msg.content ?? '[tool call issued]');

        for (const call of msg.tool_calls) {
          if (call.type !== 'function') continue;
          const signature = `${call.function.name}:${call.function.arguments}`;
          if (seenToolCalls.has(signature)) {
            const dedupe = `Skipping repeated tool call ${call.function.name}; please provide different arguments or stop.`;
            accumulated.push({ role: 'tool', tool_call_id: call.id, content: dedupe });
            addMessage(chatId, 'tool', dedupe);
            continue;
          }
          seenToolCalls.add(signature);
          try {
            const args = JSON.parse(call.function.arguments || '{}');
            const result = await tools.run(call.function.name, args, chatId);
            const text = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
            accumulated.push({ role: 'tool', tool_call_id: call.id, content: text });
            addMessage(chatId, 'tool', text);
          } catch (err) {
            const text = `Tool ${call.function.name} failed: ${(err as Error).message}`;
            accumulated.push({ role: 'tool', tool_call_id: call.id, content: text });
            logger.error(text);
          }
        }
        continue; // loop again for final answer
      }

      const content = msg.content ?? '';
      if (!content.trim()) {
        const fallback = 'No response generated by the model.';
        addMessage(chatId, 'assistant', fallback);
        logger.warn(`chat.empty_response chatId=${chatId} model=${model}`);
        return fallback;
      }
      addMessage(chatId, 'assistant', content);
      logger.info(`chat.out chatId=${chatId} chars=${content.length} text=${summarize(content, debugIO ? 4000 : 400)}`);
      return content;
    }
  }
}

function loadPersonalityGuide() {
  try {
    const file = path.resolve(process.cwd(), 'src', 'guides', 'personality.md');
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    logger.warn(`Failed to read personality.md: ${(err as Error).message}`);
    return '';
  }
}

function loadCliGuide() {
  try {
    const file = path.resolve(process.cwd(), 'src', 'guides', 'CLI.md');
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    logger.warn(`Failed to read CLI.md: ${(err as Error).message}`);
    return '';
  }
}
