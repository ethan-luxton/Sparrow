import Ajv from 'ajv';
import type { ChatCompletionTool } from 'openai/resources/chat/completions';
import { logTool } from '../lib/db.js';
import { logger } from '../lib/logger.js';

function summarize(value: unknown, maxLen = 500) {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value);
    if (text.length <= maxLen) return text;
    return text.slice(0, maxLen) + '…';
  } catch {
    return '[unserializable]';
  }
}

export type Permission = 'read' | 'write';

export interface ToolDefinition {
  name: string;
  description: string;
  schema: object;
  permission: Permission;
  handler: (args: any, chatId: number) => Promise<unknown> | unknown;
}

export class ToolRegistry {
  private tools = new Map<string, ToolDefinition>();
  private ajv = new (Ajv as any)({ strict: false, coerceTypes: true, allErrors: true });

  register(tool: ToolDefinition) {
    this.tools.set(tool.name, tool);
  }

  get(name: string) {
    return this.tools.get(name);
  }

  list() {
    return Array.from(this.tools.values());
  }

  asOpenAITools(): ChatCompletionTool[] {
    return this.list().map(
      (t) =>
        ({
          type: 'function',
          function: { name: t.name, description: t.description, parameters: t.schema as any },
        }) as ChatCompletionTool
    );
  }

  async run(name: string, args: unknown, chatId: number) {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`Tool ${name} not registered`);
    const validate = this.ajv.compile(tool.schema);
    if (!validate(args)) {
      const errorsText = this.ajv.errorsText(validate.errors);
      // If only additionalProperties errors, try stripping unknown keys.
      const hasAdditional = (validate.errors ?? []).some((e: any) => e.keyword === 'additionalProperties');
      if (hasAdditional && tool.schema && typeof tool.schema === 'object' && (tool.schema as any).properties) {
        const props = Object.keys((tool.schema as any).properties);
        const cleaned =
          args && typeof args === 'object'
            ? Object.fromEntries(Object.entries(args as Record<string, unknown>).filter(([k]) => props.includes(k)))
            : args;
        if (validate(cleaned)) {
          const extraKeys =
            args && typeof args === 'object'
              ? Object.keys(args as Record<string, unknown>).filter((k) => !props.includes(k))
              : [];
          logger.warn(`tool.sanitize name=${name} dropped=${extraKeys.join(',') || 'none'} chatId=${chatId}`);
          args = cleaned;
        } else {
          throw new Error(`Invalid args for ${name}: ${errorsText}`);
        }
      } else {
        throw new Error(`Invalid args for ${name}: ${errorsText}`);
      }
    }
    const action = (args as any)?.action;
    logger.info(
      `tool.invoke name=${tool.name} action=${action ?? 'n/a'} permission=${tool.permission} chatId=${chatId} args=${summarize(args)}`
    );
    const result = await tool.handler(args, chatId);
    logTool(chatId, tool.name, 'invoke', args, result);
    logger.info(`tool.result name=${tool.name} action=${action ?? 'n/a'} chatId=${chatId} result=${summarize(result)}`);
    return result;
  }
}
