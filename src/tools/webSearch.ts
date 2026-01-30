import OpenAI from 'openai';
import { ToolDefinition } from './registry.js';
import { loadConfig, getSecret } from '../config/config.js';
import { logger } from '../lib/logger.js';

interface SearchArgs {
  query: string;
  maxResults?: number;
  userLocation?: string;
}

function extractFirstText(response: any): string {
  if (!response?.output) return '';
  for (const item of response.output) {
    if (item.type === 'output_text' && typeof item.output_text === 'string') return item.output_text;
    if (item.type === 'message' && Array.isArray(item.content)) {
      const textPart = item.content.find((c: any) => c.type === 'output_text' || c.type === 'text');
      if (textPart?.text) return textPart.text;
      if (textPart?.output_text) return textPart.output_text;
    }
  }
  return '';
}

type SourceLike = { title?: string; url?: string };

function extractSources(response: any): SourceLike[] {
  const sources: SourceLike[] = [];
  const add = (src?: any) => {
    if (!src) return;
    if (src.url || src.title) sources.push({ title: src.title, url: src.url });
  };
  const output = response?.output ?? [];
  for (const item of output) {
    if (Array.isArray(item?.sources)) item.sources.forEach(add);
    const actionSources = item?.action?.sources;
    if (Array.isArray(actionSources)) actionSources.forEach(add);
    if (Array.isArray(item?.results)) item.results.forEach(add);
  }
  return sources;
}

/**
 * Implements OpenAI web_search per https://platform.openai.com/docs/guides/tools-web-search.
 * The model can choose to search; we return a concise summary plus sources.
 */
export function webSearchTool(): ToolDefinition {
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
    handler: async (args: SearchArgs) => {
      const cfg = loadConfig();
      const apiKey = getSecret(cfg, 'openai.apiKey');
      const client = new OpenAI({ apiKey });

      const model = cfg.openai?.searchModel ?? 'gpt-5-mini';
      const max = Math.min(Math.max(args.maxResults ?? 5, 1), 10);
      const locationNote = args.userLocation ? `User location: ${args.userLocation}.` : '';

      try {
        const response = await client.responses.create({
          model,
          input: [
            {
              role: 'system',
              content:
                'For user queries, you must perform a web_search at least once unless the query is strictly about yourself ' +
                'or is simple arithmetic. Prefer fresh, authoritative sources. Keep response concise.',
            },
            { role: 'user', content: args.query },
            {
              role: 'system',
              content:
                `After searching, summarize in 3-5 sentences, then list 3-5 sources with title + URL. ` +
                `Prefer authoritative, recent sources. Respect max results ${max}. ${locationNote}`,
            },
          ],
          tools: [{ type: 'web_search' }],
          max_output_tokens: 400,
          text: { format: { type: 'text' } },
          include: ['web_search_call.action.sources', 'web_search_call.results'],
        } as any);

        const text = (response as any).output_text ?? extractFirstText(response);
        const sources = extractSources(response);

        if (sources.length) {
          const srcList = sources
            .slice(0, 5)
            .map((s) => `- ${s.title ?? s.url ?? 'source'}: ${s.url ?? ''}`)
            .join('\n');
          return `${text || 'No summary returned.'}\n\nSources:\n${srcList}`;
        }

        return text || 'No results returned from web search.';
      } catch (err) {
        // Log richer context for debugging while keeping the reply concise
        const e = err as any;
        const status = e?.status ?? e?.statusCode ?? 'unknown';
        const code = e?.code ?? e?.type ?? 'unknown';
        const message = e?.message ?? 'unknown error';
        logger.error(`web_search failed status=${status} code=${code} model=${model} max=${max} loc=${args.userLocation ?? 'n/a'} msg=${message}`);
        return `Web search failed (status ${status}, code ${code}): ${message}`;
      }
    },
  };
}
