import { ToolDefinition } from './registry.js';
import { loadConfig, getSecret } from '../config/config.js';

interface N8nArgs {
  action: 'list_workflows' | 'get_workflow' | 'list_executions' | 'create_workflow' | 'workflow_schema';
  workflowId?: string | number;
  limit?: number;
  offset?: number;
  name?: string;
  nodes?: unknown;
  connections?: unknown;
  settings?: Record<string, unknown>;
  confirm?: boolean;
}

async function request(path: string, method: string, headers: Record<string, string>, baseUrl: string, body?: any) {
  const url = `${baseUrl.replace(/\/$/, '')}${path}`;
  const res = await fetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`n8n ${method} ${path} failed: ${res.status} ${text}`);
  }
  return res.json();
}

export function n8nTool(): ToolDefinition {
  return {
    name: 'n8n',
    description: 'Access to local n8n: list/get workflows, list executions, and create workflows (requires confirm=true).',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_workflows', 'get_workflow', 'list_executions', 'create_workflow', 'workflow_schema'],
        },
        workflowId: { anyOf: [{ type: 'string' }, { type: 'number' }] },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
        offset: { type: 'integer', minimum: 0 },
        name: { type: 'string' },
        nodes: { type: 'array', items: { type: 'object' } },
        connections: { type: 'object' },
        settings: { type: 'object' },
        confirm: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args: N8nArgs) => {
      const cfg = loadConfig();
      const baseUrl = cfg.n8n?.baseUrl || process.env.N8N_BASE_URL;
      if (!baseUrl) return 'n8n baseUrl not configured (set n8n.baseUrl or N8N_BASE_URL).';

      // Prefer API key; fall back to basic auth if provided
      let apiKey: string | undefined;
      try {
        apiKey = getSecret(cfg as any, 'n8n.apiKey' as any);
      } catch {
        apiKey = process.env.N8N_API_KEY;
      }

      let basicUser: string | undefined;
      let basicPass: string | undefined;
      try {
        basicUser = getSecret(cfg as any, 'n8n.basicUser' as any);
        basicPass = getSecret(cfg as any, 'n8n.basicPass' as any);
      } catch {
        basicUser = process.env.N8N_BASIC_USER;
        basicPass = process.env.N8N_BASIC_PASS;
      }

      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };
      if (apiKey) {
        headers['X-N8N-API-KEY'] = apiKey;
      } else if (basicUser && basicPass) {
        const token = Buffer.from(`${basicUser}:${basicPass}`, 'utf8').toString('base64');
        headers['Authorization'] = `Basic ${token}`;
      } else {
        return 'n8n credentials not configured (set n8n.apiKey or n8n.basicUser/basicPass or env equivalents).';
      }

      switch (args.action) {
        case 'list_workflows': {
          return await request('/api/v1/workflows', 'GET', headers, baseUrl, undefined);
        }
        case 'get_workflow': {
          if (!args.workflowId) return 'workflowId required';
          return await request(`/api/v1/workflows/${args.workflowId}`, 'GET', headers, baseUrl, undefined);
        }
        case 'list_executions': {
          const q = new URLSearchParams();
          if (args.limit) q.set('limit', String(args.limit));
          if (args.offset) q.set('offset', String(args.offset));
          const query = q.toString() ? `?${q.toString()}` : '';
          return await request(`/api/v1/executions${query}`, 'GET', headers, baseUrl, undefined);
        }
        case 'create_workflow': {
          if (!args.name) return 'name required';
          if (args.confirm !== true) return 'Set confirm=true to create a workflow.';
          if (args.nodes && !Array.isArray(args.nodes)) return 'nodes must be an array of node objects.';
          const body = {
            name: args.name,
            nodes: args.nodes ?? [],
            connections: args.connections ?? {},
            settings: args.settings ?? {},
          };
          return await request('/api/v1/workflows', 'POST', headers, baseUrl, body);
        }
        case 'workflow_schema': {
          return {
            name: 'Example Workflow',
            nodes: [
              {
                id: 'Webhook',
                name: 'Webhook',
                type: 'n8n-nodes-base.webhook',
                typeVersion: 1,
                position: [240, 300],
                parameters: {
                  httpMethod: 'POST',
                  path: 'example-endpoint',
                  responseMode: 'lastNode',
                },
              },
              {
                id: 'Set',
                name: 'Set',
                type: 'n8n-nodes-base.set',
                typeVersion: 1,
                position: [540, 300],
                parameters: {
                  values: { string: [{ name: 'message', value: 'Hello from n8n' }] },
                },
              },
              {
                id: 'Respond',
                name: 'Respond to Webhook',
                type: 'n8n-nodes-base.respondToWebhook',
                typeVersion: 1,
                position: [820, 300],
                parameters: {
                  respondWith: 'firstIncomingItem',
                },
              },
            ],
            connections: {
              Webhook: {
                main: [[{ node: 'Set', type: 'main', index: 0 }]],
              },
              Set: {
                main: [[{ node: 'Respond to Webhook', type: 'main', index: 0 }]],
              },
            },
            settings: {
              timezone: 'UTC',
            },
          };
        }
        default:
          return 'Unsupported action';
      }
    },
  };
}
