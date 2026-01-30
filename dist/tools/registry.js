import Ajv from 'ajv';
import { logTool } from '../lib/db.js';
import { logger } from '../lib/logger.js';
function summarize(value, maxLen = 500) {
    try {
        const text = typeof value === 'string' ? value : JSON.stringify(value);
        if (text.length <= maxLen)
            return text;
        return text.slice(0, maxLen) + '…';
    }
    catch {
        return '[unserializable]';
    }
}
export class ToolRegistry {
    tools = new Map();
    ajv = new Ajv({ strict: false, coerceTypes: true, allErrors: true });
    register(tool) {
        this.tools.set(tool.name, tool);
    }
    get(name) {
        return this.tools.get(name);
    }
    list() {
        return Array.from(this.tools.values());
    }
    asOpenAITools() {
        return this.list().map((t) => ({
            type: 'function',
            function: { name: t.name, description: t.description, parameters: t.schema },
        }));
    }
    async run(name, args, chatId) {
        const tool = this.tools.get(name);
        if (!tool)
            throw new Error(`Tool ${name} not registered`);
        const validate = this.ajv.compile(tool.schema);
        if (!validate(args)) {
            const errorsText = this.ajv.errorsText(validate.errors);
            // If only additionalProperties errors, try stripping unknown keys.
            const hasAdditional = (validate.errors ?? []).some((e) => e.keyword === 'additionalProperties');
            if (hasAdditional && tool.schema && typeof tool.schema === 'object' && tool.schema.properties) {
                const props = Object.keys(tool.schema.properties);
                const cleaned = args && typeof args === 'object'
                    ? Object.fromEntries(Object.entries(args).filter(([k]) => props.includes(k)))
                    : args;
                if (validate(cleaned)) {
                    const extraKeys = args && typeof args === 'object'
                        ? Object.keys(args).filter((k) => !props.includes(k))
                        : [];
                    logger.warn(`tool.sanitize name=${name} dropped=${extraKeys.join(',') || 'none'} chatId=${chatId}`);
                    args = cleaned;
                }
                else {
                    throw new Error(`Invalid args for ${name}: ${errorsText}`);
                }
            }
            else {
                throw new Error(`Invalid args for ${name}: ${errorsText}`);
            }
        }
        const action = args?.action;
        logger.info(`tool.invoke name=${tool.name} action=${action ?? 'n/a'} permission=${tool.permission} chatId=${chatId} args=${summarize(args)}`);
        const result = await tool.handler(args, chatId);
        logTool(chatId, tool.name, 'invoke', args, result);
        logger.info(`tool.result name=${tool.name} action=${action ?? 'n/a'} chatId=${chatId} result=${summarize(result)}`);
        return result;
    }
}
