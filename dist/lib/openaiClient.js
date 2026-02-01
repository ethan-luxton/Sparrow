import { SYSTEM_PROMPT } from './prompt.js';
import { addMessage, getDbHandle, getUserProfile } from './db.js';
import { logger } from './logger.js';
import { createChatClient, getChatModel, supportsTools } from './llm.js';
import { choose_next_step } from '../agent/decision.js';
import { filterToolsByTier, getToolRiskTier } from '../agent/toolPolicy.js';
import { deriveFactsFromMessage } from '../memory/derive.js';
import { addMemoryItem, appendLedgerEvent, recordAssistantMessage, recordUserMessage, getRecentEvents, searchMemory, sealPendingBlocks, } from '../memory/ledger.js';
import { getWorkingState, mergeWorkingState, saveWorkingState } from '../memory/workingState.js';
import { injectMarkdown } from './markdown/injector.js';
import { migrateWorkspaceDocs } from './markdown/migration.js';
function summarize(text, maxLen) {
    if (text.length <= maxLen)
        return text;
    return text.slice(0, maxLen) + '…';
}
function formatWorkingState(state) {
    const lines = [];
    if (state.objective)
        lines.push(`Objective: ${state.objective}`);
    if (state.constraints.length) {
        lines.push('Constraints:');
        for (const item of state.constraints)
            lines.push(`- ${item}`);
    }
    if (state.hypotheses.length) {
        lines.push('Hypotheses:');
        for (const item of state.hypotheses)
            lines.push(`- ${item}`);
    }
    if (state.lastObservations.length) {
        lines.push('Last observations:');
        for (const item of state.lastObservations)
            lines.push(`- ${item}`);
    }
    if (state.nextActions.length) {
        lines.push('Next actions:');
        for (const item of state.nextActions)
            lines.push(`- ${item}`);
    }
    return lines.join('\n');
}
function formatRetrievedMemories(memories) {
    return memories
        .map((m) => `- (${m.kind}, score=${m.score.toFixed(2)}) ${m.text} [${m.citation.blockId}:${m.citation.eventId}]`)
        .join('\n');
}
async function withTimeout(promise, ms) {
    if (!Number.isFinite(ms) || ms <= 0)
        return promise;
    let timeout;
    const timer = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`Model request timed out after ${ms}ms`)), ms);
    });
    try {
        return await Promise.race([promise, timer]);
    }
    finally {
        if (timeout)
            clearTimeout(timeout);
    }
}
export class OpenAIClient {
    client;
    cfg;
    constructor(cfg) {
        this.client = createChatClient(cfg);
        this.cfg = cfg;
    }
    async chat(chatId, userText, tools) {
        migrateWorkspaceDocs();
        const db = getDbHandle();
        const profile = getUserProfile(chatId);
        const assistant = this.cfg.assistant;
        const user = this.cfg.user;
        const model = getChatModel(this.cfg);
        const debugIO = process.env.SPARROW_DEBUG_IO === '1';
        const working = getWorkingState(chatId, db);
        const userEventId = recordUserMessage(chatId, userText);
        const derivedFacts = deriveFactsFromMessage(userText);
        for (const fact of derivedFacts) {
            const factEventId = appendLedgerEvent(db, {
                chatId,
                type: 'derived_fact',
                payload: { text: fact.text, sourceEventId: userEventId },
            });
            addMemoryItem(db, { chatId, kind: fact.kind, text: fact.text, eventId: factEventId });
        }
        const decision = choose_next_step(working, userText);
        const observations = [];
        for (const action of decision.actions) {
            if (action.tier !== 0)
                continue;
            const tool = tools.get(action.tool);
            if (!tool || getToolRiskTier(tool.name, tool.permission) > decision.maxToolTier)
                continue;
            try {
                const result = await tools.run(action.tool, action.args, chatId);
                const summary = summarize(typeof result === 'string' ? result : JSON.stringify(result), 800);
                observations.push(`${action.summary}: ${summary}`);
            }
            catch (err) {
                observations.push(`${action.summary}: error ${err.message}`);
            }
        }
        const constraintBase = [
            'CLI tool is read-only; no writes, sudo, kills, or installs',
            'Ask at most one question only if needed',
            'Tier2 writes are not allowed; output patch/diff only',
        ];
        if (assistant?.name)
            constraintBase.push(`Assistant name: ${assistant.name}`);
        if (assistant?.description)
            constraintBase.push(`Assistant description: ${assistant.description}`);
        if (user?.name)
            constraintBase.push(`User name: ${user.name}`);
        if (user?.role)
            constraintBase.push(`User role: ${user.role}`);
        if (user?.preferences)
            constraintBase.push(`User preferences: ${user.preferences}`);
        if (user?.timezone)
            constraintBase.push(`User timezone: ${user.timezone}`);
        if (profile)
            constraintBase.push(`Working style: ${profile}`);
        const mergedConstraints = Array.from(new Set([...(working.constraints ?? []), ...constraintBase]));
        const updatedState = mergeWorkingState(working, {
            objective: working.objective || userText,
            constraints: mergedConstraints,
            lastObservations: [...(working.lastObservations ?? []), ...observations],
            nextActions: decision.plan,
        }, { maxObservations: 6, maxNextActions: 6 });
        saveWorkingState(chatId, updatedState, db);
        const retrieved = searchMemory(db, chatId, userText, 6);
        const recentToolNames = getRecentToolNames(chatId);
        const injection = injectMarkdown({
            userText,
            tools: tools.list(),
            recentTools: recentToolNames,
        });
        const baseMsgs = [
            { role: 'system', content: SYSTEM_PROMPT },
            ...(injection.text
                ? [
                    {
                        role: 'system',
                        content: `Workspace docs:\n${injection.text}`,
                    },
                ]
                : []),
            {
                role: 'system',
                content: `Working state:\n${formatWorkingState(updatedState)}`,
            },
            ...(retrieved.length
                ? [
                    {
                        role: 'system',
                        content: `Retrieved memories (cite as [block_id:event_id]):\n${formatRetrievedMemories(retrieved)}`,
                    },
                ]
                : []),
            { role: 'user', content: userText },
        ];
        const allowTools = supportsTools(this.cfg);
        const allowedTools = allowTools ? filterToolsByTier(tools.list(), decision.maxToolTier) : [];
        const allowedToolNames = new Set(allowedTools.map((t) => t.name));
        const toolDefs = allowTools
            ? allowedTools.map((t) => ({
                type: 'function',
                function: { name: t.name, description: t.description, parameters: t.schema },
            }))
            : [];
        const openaiMsgs = [...baseMsgs];
        logger.info(`chat.in chatId=${chatId} model=${model} tools=${toolDefs.length} playbook=${decision.playbookId} text=${summarize(userText, debugIO ? 4000 : 400)}`);
        if (toolDefs.length) {
            // Let the model know explicitly which tools exist and when to use them.
            openaiMsgs.push({
                role: 'system',
                content: `Available tools: ${toolDefs
                    .map((t) => t.function?.name ?? '')
                    .filter(Boolean)
                    .join(', ')}. Use them when they help. If a tool has an action field, choose the most appropriate action yourself; only ask the user if required inputs are missing. Minimize tool calls and avoid redundant steps.

CLI tool notes:
- Use action=run with a commands array for multi-step tasks.
- Allowed operators: pipe (|), &&, and one fallback (cmd1 || cmd2). Avoid ;, >, < (except /dev/null).
- Redirects are only allowed to /dev/null (e.g., 2>/dev/null).
- Prefer separate commands (e.g., "cd ~/projects", "ls -1", "git -C ~/projects/sparrow status").
- You can use action=start to create a session and reuse sessionId across calls to preserve cwd.
- For tools that support confirm=true on write actions (calendar/drive/n8n/filesystem/task_runner), set confirm=true when the user explicitly asks you to perform the write.
- Never search for or reveal secrets (API keys/tokens/passwords/private keys) or their locations.
`,
            });
        }
        const accumulated = [...openaiMsgs];
        let toolIterations = 0;
        const maxToolIterations = 12;
        const seenToolCalls = new Set();
        while (true) {
            const request = {
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
            if (!msg)
                throw new Error('No completion message');
            if (debugIO) {
                logger.info(`chat.raw chatId=${chatId} finish=${completion.choices[0].finish_reason ?? 'n/a'} content=${summarize(msg.content ?? '', 2000)}`);
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
                    if (call.type !== 'function')
                        continue;
                    const toolName = call.function?.name ?? '';
                    if (toolName && !allowedToolNames.has(toolName)) {
                        const blocked = `Tool ${toolName} not allowed under current risk tier.`;
                        accumulated.push({ role: 'tool', tool_call_id: call.id, content: blocked });
                        addMessage(chatId, 'tool', blocked);
                        continue;
                    }
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
                    }
                    catch (err) {
                        const text = `Tool ${call.function.name} failed: ${err.message}`;
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
            recordAssistantMessage(chatId, content);
            const episodicSummary = summarize(`User: ${userText}\nAssistant: ${content}\nObservations: ${observations.join(' | ')}`, 900);
            const summaryEventId = appendLedgerEvent(db, {
                chatId,
                type: 'observation',
                payload: { text: episodicSummary, sourceEventId: userEventId },
            });
            addMemoryItem(db, { chatId, kind: 'summary', text: episodicSummary, eventId: summaryEventId });
            sealPendingBlocks(db, { force: true });
            logger.info(`chat.out chatId=${chatId} chars=${content.length} text=${summarize(content, debugIO ? 4000 : 400)}`);
            return content;
        }
    }
}
function getRecentToolNames(chatId, limit = 12) {
    const events = getRecentEvents(getDbHandle(), chatId, limit);
    const names = [];
    for (const ev of events) {
        if (ev.type !== 'tool_call')
            continue;
        try {
            const payload = JSON.parse(ev.payload);
            const name = payload?.tool;
            if (typeof name === 'string')
                names.push(name);
        }
        catch {
            // ignore
        }
    }
    return names;
}
