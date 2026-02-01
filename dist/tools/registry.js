import Ajv from 'ajv';
import { logTool } from '../lib/db.js';
import { logger } from '../lib/logger.js';
import { redactSensitiveObject, redactSensitiveText, isSensitivePath, isSensitiveQuery } from '../lib/redaction.js';
import { recordToolCall, recordToolResult } from '../memory/ledger.js';
function summarize(value, maxLen = 500) {
    try {
        const raw = typeof value === 'string' ? value : JSON.stringify(value);
        const text = redactSensitiveText(raw);
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
        enforceSensitiveAccess(tool.name, args);
        const action = args?.action;
        enforceToolPolicy(tool, args);
        logger.info(`tool.invoke name=${tool.name} action=${action ?? 'n/a'} permission=${tool.permission} chatId=${chatId} args=${summarize(args)}`);
        try {
            recordToolCall(chatId, tool.name, action, args);
        }
        catch (err) {
            logger.warn(`tool.ledger_call_failed name=${tool.name} err=${err.message}`);
        }
        const result = await tool.handler(args, chatId);
        const safeArgs = redactSensitiveObject(args);
        const safeResult = redactSensitiveObject(result);
        logTool(chatId, tool.name, 'invoke', safeArgs, safeResult);
        logger.info(`tool.result name=${tool.name} action=${action ?? 'n/a'} chatId=${chatId} result=${summarize(result)}`);
        try {
            recordToolResult(chatId, tool.name, action, safeResult);
        }
        catch (err) {
            logger.warn(`tool.ledger_result_failed name=${tool.name} err=${err.message}`);
        }
        return safeResult;
    }
}
const ALLOW_ACTIONS = {
    google_calendar: new Set(['list_calendars', 'list_events']),
    google_drive: new Set(['list', 'search', 'metadata', 'export_doc', 'export_pdf', 'export_docx', 'extract_text']),
    n8n: new Set(['list_workflows', 'get_workflow', 'list_executions', 'workflow_schema']),
    filesystem: new Set(['read', 'list', 'read_pdf_text', 'read_docx_text']),
    notes: new Set(['add', 'list']),
    workspace: new Set([
        'ensure_workspace',
        'list_projects',
        'ensure_project',
        'read_file',
        'write_file',
        'apply_patch',
        'list_files',
        'search',
    ]),
    git: new Set([
        'status',
        'log',
        'diff',
        'show',
        'branch_list',
        'branch_create',
        'fetch',
        'add',
        'init',
        'config_list',
    ]),
};
const CONFIRM_ACTIONS = {
    google_calendar: new Set(['create_event', 'update_event', 'delete_event', 'quick_add']),
    google_drive: new Set(['create_pdf', 'upload', 'upload_convert', 'create_folder', 'create_doc', 'download_file', 'delete_file']),
    n8n: new Set(['create_workflow']),
    filesystem: new Set(['write', 'write_pdf']),
    task_runner: new Set(['run']),
    git: new Set([
        'checkout',
        'switch',
        'pull',
        'push',
        'commit',
        'stash',
        'restore',
        'reset',
        'merge',
        'rebase',
        'tag',
    ]),
};
function enforceToolPolicy(tool, args) {
    if (tool.permission !== 'write')
        return;
    if (tool.name === 'task_runner') {
        // task_runner is safe to preview without confirm; handler enforces confirm for execution.
        return;
    }
    const action = args?.action ? String(args.action) : '';
    const confirm = args?.confirm === true;
    if (action) {
        if (ALLOW_ACTIONS[tool.name]?.has(action))
            return;
        if (CONFIRM_ACTIONS[tool.name]?.has(action)) {
            if (!confirm)
                throw new Error(`Action ${action} on ${tool.name} requires confirm=true.`);
            return;
        }
        if (!confirm)
            throw new Error(`Action ${action} on ${tool.name} requires confirm=true.`);
        return;
    }
    if (!confirm) {
        throw new Error(`Tool ${tool.name} requires confirm=true for write actions.`);
    }
}
function enforceSensitiveAccess(toolName, args) {
    const action = args?.action ? String(args.action) : '';
    const maybeBlock = (reason) => {
        throw new Error(`Refusing to access secrets. ${reason} If you lost a key, I can help you rotate it safely.`);
    };
    if (toolName === 'code_search') {
        const query = String(args?.query ?? '');
        if (isSensitiveQuery(query)) {
            maybeBlock('Secret-search queries are not allowed.');
        }
    }
    if (toolName === 'cli') {
        const commands = Array.isArray(args?.commands)
            ? args.commands.map(String)
            : [args?.command, ...(args?.args ?? []).map(String)].filter(Boolean).map(String);
        if (commands.some((cmd) => isSensitiveQuery(cmd) || isSensitivePath(cmd))) {
            maybeBlock('CLI commands that search for secrets or sensitive files are blocked.');
        }
    }
    if (toolName === 'file_snippet' || toolName === 'file_diff' || toolName === 'filesystem' || toolName === 'workspace') {
        const pathArg = args?.path ?? args?.pathA ?? '';
        if (pathArg && isSensitivePath(String(pathArg))) {
            maybeBlock('Reading sensitive files (e.g., .env, private keys) is blocked.');
        }
    }
    if (toolName === 'google_drive' && action === 'search') {
        const query = String(args?.query ?? '');
        if (isSensitiveQuery(query)) {
            maybeBlock('Drive searches for secrets are blocked.');
        }
    }
    if (toolName === 'gmail' && action === 'search_messages') {
        const query = String(args?.query ?? '');
        if (isSensitiveQuery(query)) {
            maybeBlock('Gmail searches for secrets are blocked.');
        }
    }
    if (toolName === 'workspace' && action === 'search') {
        const query = String(args?.query ?? '');
        if (isSensitiveQuery(query)) {
            maybeBlock('Workspace searches for secrets are blocked.');
        }
    }
}
