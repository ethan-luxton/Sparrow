import { loadConfig, getSecret } from '../config/config.js';
import { logger } from '../lib/logger.js';
import OpenAI from 'openai';
import { getSearchModel } from '../lib/llm.js';
function extractFirstText(response) {
    if (!response?.output)
        return '';
    for (const item of response.output) {
        if (item.type === 'output_text' && typeof item.output_text === 'string')
            return item.output_text;
        if (item.type === 'message' && Array.isArray(item.content)) {
            const textPart = item.content.find((c) => c.type === 'output_text' || c.type === 'text');
            if (textPart?.text)
                return textPart.text;
            if (textPart?.output_text)
                return textPart.output_text;
        }
    }
    return '';
}
function extractSources(response) {
    const sources = [];
    const add = (src) => {
        if (!src)
            return;
        if (src.url || src.title)
            sources.push({ title: src.title, url: src.url });
    };
    const output = response?.output ?? [];
    for (const item of output) {
        if (Array.isArray(item?.sources))
            item.sources.forEach(add);
        const actionSources = item?.action?.sources;
        if (Array.isArray(actionSources))
            actionSources.forEach(add);
        if (Array.isArray(item?.results))
            item.results.forEach(add);
        if (Array.isArray(item?.search_results))
            item.search_results.forEach(add);
    }
    return sources;
}
function extractResults(response) {
    const results = [];
    const add = (r) => {
        if (!r)
            return;
        const title = r.title ?? r.name ?? r.heading;
        const url = r.url ?? r.link;
        const snippet = r.snippet ?? r.text ?? r.content ?? r.description ?? r.summary;
        if (title || url || snippet)
            results.push({ title, url, snippet });
    };
    const output = response?.output ?? [];
    for (const item of output) {
        if (Array.isArray(item?.results))
            item.results.forEach(add);
        if (Array.isArray(item?.search_results))
            item.search_results.forEach(add);
        if (Array.isArray(item?.action?.results))
            item.action.results.forEach(add);
        if (item?.type === 'web_search_call' && Array.isArray(item?.results))
            item.results.forEach(add);
    }
    return results;
}
/**
 * Implements OpenAI web_search per https://platform.openai.com/docs/guides/tools-web-search.
 * The model can choose to search; we return a concise summary plus sources.
 */
export function webSearchTool() {
    return {
        name: 'web_search',
        description: 'Use OpenAI web_search to fetch live info and return a short summary with sources.',
        permission: 'read',
        schema: {
            type: 'object',
            properties: {
                query: { type: 'string' },
                maxResults: { type: 'integer', minimum: 1, maximum: 10 },
                userLocation: { type: 'string' },
            },
            required: ['query'],
            additionalProperties: false,
        },
        handler: async (args) => {
            const cfg = loadConfig();
            let apiKey = '';
            try {
                apiKey = getSecret(cfg, 'openai.apiKey');
            }
            catch (err) {
                return `Web search requires an OpenAI API key: ${err.message}`;
            }
            const baseURL = cfg.openai?.baseUrl ?? process.env.OPENAI_BASE_URL;
            const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
            const model = getSearchModel(cfg);
            const max = Math.min(Math.max(args.maxResults ?? 5, 1), 10);
            const locationNote = args.userLocation ? `User location: ${args.userLocation}.` : '';
            const debugIO = process.env.SPARROW_DEBUG_IO === '1';
            try {
                const response = await client.responses.create({
                    model,
                    input: `${args.query}${locationNote ? `\n${locationNote}` : ''}\n\nSummarize results in 3-5 sentences and list 3-5 sources with title + URL.`,
                    tools: [{ type: 'web_search' }],
                    tool_choice: { type: 'web_search' },
                    max_output_tokens: 400,
                    text: { format: { type: 'text' } },
                    include: ['web_search_call.action.sources', 'web_search_call.results'],
                });
                const text = response.output_text ?? extractFirstText(response);
                const sources = extractSources(response);
                const results = extractResults(response);
                if (debugIO) {
                    const outputTypes = response?.output?.map((o) => o?.type).filter(Boolean) ?? [];
                    logger.info(`web_search.raw model=${model} outputTypes=${JSON.stringify(outputTypes)} sources=${sources.length} results=${results.length}`);
                }
                const srcList = sources
                    .slice(0, 5)
                    .map((s) => `- ${s.title ?? s.url ?? 'source'}: ${s.url ?? ''}`)
                    .join('\n');
                if (text && text.trim()) {
                    return sources.length ? `${text}\n\nSources:\n${srcList}` : text;
                }
                if (results.length || sources.length) {
                    const resultLines = results
                        .slice(0, 6)
                        .map((r, i) => `Result ${i + 1}: ${r.title ?? '(no title)'}\nURL: ${r.url ?? '(no url)'}\nSnippet: ${r.snippet ?? '(no snippet)'}`)
                        .join('\n\n');
                    const summaryResp = await client.responses.create({
                        model,
                        input: `Summarize the following web search results in 3-5 sentences. ` +
                            `Only use the information provided. Query: ${args.query}\n\n${resultLines}`,
                        max_output_tokens: 250,
                        text: { format: { type: 'text' } },
                    });
                    const summaryText = summaryResp.output_text ?? extractFirstText(summaryResp);
                    if (summaryText && summaryText.trim()) {
                        return sources.length ? `${summaryText}\n\nSources:\n${srcList}` : summaryText;
                    }
                }
                return 'Web search returned no summary. Try a more specific query.';
            }
            catch (err) {
                // Log richer context for debugging while keeping the reply concise
                const e = err;
                const status = e?.status ?? e?.statusCode ?? 'unknown';
                const code = e?.code ?? e?.type ?? 'unknown';
                const message = e?.message ?? 'unknown error';
                logger.error(`web_search failed status=${status} code=${code} model=${model} max=${max} loc=${args.userLocation ?? 'n/a'} msg=${message}`);
                return `Web search failed (status ${status}, code ${code}): ${message}`;
            }
        },
    };
}
