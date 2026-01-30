import { loadConfig, getSecret } from '../config/config.js';
async function requestNews(path, params, apiKey) {
    const url = new URL(`https://newsapi.org/v2/${path}`);
    Object.entries(params).forEach(([k, v]) => {
        if (v !== '')
            url.searchParams.set(k, v);
    });
    const res = await fetch(url.toString(), {
        headers: { 'X-Api-Key': apiKey },
    });
    if (!res.ok) {
        const text = await res.text();
        throw new Error(`NewsAPI ${path} failed: ${res.status} ${text}`);
    }
    return res.json();
}
export function newsTool() {
    return {
        name: 'news',
        description: 'Query NewsAPI.org for headlines, articles, or sources.',
        permission: 'read',
        schema: {
            type: 'object',
            properties: {
                action: { type: 'string', enum: ['top_headlines', 'everything', 'sources'] },
                query: { type: 'string' },
                country: { type: 'string' },
                category: { type: 'string' },
                sources: { type: 'string' },
                language: { type: 'string' },
                from: { type: 'string' },
                to: { type: 'string' },
                sortBy: { type: 'string', enum: ['relevancy', 'popularity', 'publishedAt'] },
                pageSize: { type: 'integer', minimum: 1, maximum: 100 },
                page: { type: 'integer', minimum: 1, maximum: 100 },
            },
            required: ['action'],
            additionalProperties: false,
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const apiKey = getSecret(cfg, 'news.apiKey');
            switch (args.action) {
                case 'top_headlines': {
                    const params = {
                        q: args.query ?? '',
                        country: args.country ?? '',
                        category: args.category ?? '',
                        sources: args.sources ?? '',
                        pageSize: String(args.pageSize ?? 10),
                        page: String(args.page ?? 1),
                    };
                    return requestNews('top-headlines', params, apiKey);
                }
                case 'everything': {
                    const params = {
                        q: args.query ?? '',
                        sources: args.sources ?? '',
                        language: args.language ?? '',
                        from: args.from ?? '',
                        to: args.to ?? '',
                        sortBy: args.sortBy ?? '',
                        pageSize: String(args.pageSize ?? 10),
                        page: String(args.page ?? 1),
                    };
                    return requestNews('everything', params, apiKey);
                }
                case 'sources': {
                    const params = {
                        language: args.language ?? '',
                        country: args.country ?? '',
                        category: args.category ?? '',
                    };
                    return requestNews('sources', params, apiKey);
                }
                default:
                    throw new Error('Unsupported action');
            }
        },
    };
}
