import OpenAI from 'openai';
import { SYSTEM_PROMPT } from './prompt.js';
import { getMessages, addMessage, getUserProfile, listNotes } from './db.js';
import { getSecret, IronclerkConfig } from '../config/config.js';
import { logger } from './logger.js';
import { ToolRegistry } from '../tools/registry.js';
import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions';
import fs from 'fs-extra';
import path from 'node:path';

export class OpenAIClient {
  private client: OpenAI;
  private cfg: IronclerkConfig;

  constructor(cfg: IronclerkConfig) {
    const apiKey = getSecret(cfg, 'openai.apiKey');
    this.client = new OpenAI({ apiKey });
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
    const notes = listNotes(chatId, 3);
    const openaiMsgs: ChatCompletionMessageParam[] = [
      { role: 'system', content: SYSTEM_PROMPT },
      ...(personality ? ([{ role: 'system', content: `Personality guide:\n${personality}` }] as ChatCompletionMessageParam[]) : []),
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

    const toolDefs: ChatCompletionTool[] = tools.asOpenAITools();
    // Let the model know explicitly which tools exist and when to use them.
    openaiMsgs.push({
      role: 'system',
      content: `Available tools: ${toolDefs
        .map((t) => (t as any).function?.name ?? '')
        .filter(Boolean)
        .join(
          ', '
        )}. Use them when they help, especially web_search for live info. If a tool has an action field, choose the most appropriate action yourself; only ask the user if required inputs are missing. Minimize tool calls and avoid redundant steps.`,
    });

    const accumulated: ChatCompletionMessageParam[] = [...openaiMsgs];

    let toolIterations = 0;
    const maxToolIterations = 5;
    const seenToolCalls = new Set<string>();

    while (true) {
      const completion = await this.client.chat.completions.create({
        model: this.cfg.openai?.model ?? 'gpt-5-mini',
        messages: accumulated,
        tools: toolDefs,
        tool_choice: 'auto',
      });

      const msg = completion.choices[0].message;
      if (!msg) throw new Error('No completion message');

      if (msg.tool_calls && msg.tool_calls.length > 0) {
        toolIterations += 1;
        if (toolIterations > maxToolIterations) {
          const halt = 'Tool call limit reached; please clarify or simplify the request.';
          addMessage(chatId, 'assistant', halt);
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
      addMessage(chatId, 'assistant', content);
      return content;
    }
  }
}

function loadPersonalityGuide() {
  try {
    const file = path.resolve(process.cwd(), 'personality.md');
    if (!fs.existsSync(file)) return '';
    return fs.readFileSync(file, 'utf8').trim();
  } catch (err) {
    logger.warn(`Failed to read personality.md: ${(err as Error).message}`);
    return '';
  }
}
