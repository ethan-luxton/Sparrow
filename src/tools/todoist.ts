import { ToolDefinition } from './registry.js';
import { getSecret, loadConfig } from '../config/config.js';

interface TodoistArgs {
  action:
    | 'list_tasks'
    | 'filter_tasks'
    | 'get_task'
    | 'create_task'
    | 'update_task'
    | 'delete_task';
  confirm?: boolean;
  taskId?: string | number;
  content?: string;
  description?: string;
  projectId?: string | number;
  sectionId?: string | number;
  parentId?: string | number;
  labels?: string[];
  priority?: number;
  dueString?: string;
  dueDate?: string;
  dueDatetime?: string;
  dueLang?: string;
  filter?: string;
  lang?: string;
  limit?: number;
  cursor?: string;
  label?: string;
  ids?: Array<string | number>;
}

type TodoistQuery = Record<string, string>;

function getBaseUrl() {
  const cfg = loadConfig();
  return cfg.todoist?.baseUrl ?? process.env.TODOIST_BASE_URL ?? 'https://api.todoist.com/api/v1';
}

function buildUrl(baseUrl: string, endpoint: string, query?: TodoistQuery) {
  const normalized = baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
  const url = new URL(normalized + endpoint.replace(/^\//, ''));
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, value);
    }
  }
  return url;
}

async function todoistRequest(method: string, endpoint: string, body?: unknown, query?: TodoistQuery) {
  const cfg = loadConfig();
  const token = getSecret(cfg, 'todoist.token');
  const url = buildUrl(getBaseUrl(), endpoint, query);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    Accept: 'application/json',
  };
  const options: RequestInit = { method, headers };
  if (body) {
    headers['Content-Type'] = 'application/json';
    options.body = JSON.stringify(body);
  }
  const res = await fetch(url, options);
  if (res.status === 204) return { ok: true };
  const text = await res.text();
  let payload: unknown = text;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    // keep as text
  }
  if (!res.ok) {
    const msg = typeof payload === 'string' ? payload : JSON.stringify(payload);
    throw new Error(`Todoist API error ${res.status}: ${msg}`);
  }
  return payload;
}

function buildTaskPayload(args: TodoistArgs) {
  const payload: Record<string, unknown> = {};
  if (args.content) payload.content = args.content;
  if (args.description) payload.description = args.description;
  if (args.projectId !== undefined) payload.project_id = args.projectId;
  if (args.sectionId !== undefined) payload.section_id = args.sectionId;
  if (args.parentId !== undefined) payload.parent_id = args.parentId;
  if (Array.isArray(args.labels)) payload.labels = args.labels;
  if (typeof args.priority === 'number') payload.priority = args.priority;
  if (args.dueString) payload.due_string = args.dueString;
  if (args.dueDate) payload.due_date = args.dueDate;
  if (args.dueDatetime) payload.due_datetime = args.dueDatetime;
  if (args.dueLang) payload.due_lang = args.dueLang;
  return payload;
}

function ensureTaskId(taskId?: string | number) {
  if (taskId === undefined || taskId === null || String(taskId).trim() === '') {
    throw new Error('taskId is required.');
  }
  return String(taskId);
}

export function todoistTool(): ToolDefinition {
  return {
    name: 'todoist',
    description:
      'Interact with Todoist tasks: list/filter/get tasks, create/update/delete tasks. Write actions require confirm=true.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list_tasks', 'filter_tasks', 'get_task', 'create_task', 'update_task', 'delete_task'],
        },
        confirm: { type: 'boolean' },
        taskId: { type: ['string', 'number'] },
        content: { type: 'string' },
        description: { type: 'string' },
        projectId: { type: ['string', 'number'] },
        sectionId: { type: ['string', 'number'] },
        parentId: { type: ['string', 'number'] },
        labels: { type: 'array', items: { type: 'string' } },
        priority: { type: 'number' },
        dueString: { type: 'string' },
        dueDate: { type: 'string' },
        dueDatetime: { type: 'string' },
        dueLang: { type: 'string' },
        filter: { type: 'string' },
        lang: { type: 'string' },
        limit: { type: 'number' },
        cursor: { type: 'string' },
        label: { type: 'string' },
        ids: { type: 'array', items: { type: ['string', 'number'] } },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args: TodoistArgs) => {
      switch (args.action) {
        case 'list_tasks': {
          const query: TodoistQuery = {};
          if (args.projectId !== undefined) query.project_id = String(args.projectId);
          if (args.sectionId !== undefined) query.section_id = String(args.sectionId);
          if (args.parentId !== undefined) query.parent_id = String(args.parentId);
          if (args.label) query.label = args.label;
          if (args.ids && args.ids.length) query.ids = args.ids.map((id) => String(id)).join(',');
          if (args.cursor) query.cursor = args.cursor;
          if (args.limit !== undefined) query.limit = String(args.limit);
          return await todoistRequest('GET', 'tasks', undefined, query);
        }
        case 'filter_tasks': {
          if (!args.filter) throw new Error('filter is required.');
          const query: TodoistQuery = { query: args.filter };
          if (args.lang) query.lang = args.lang;
          if (args.cursor) query.cursor = args.cursor;
          if (args.limit !== undefined) query.limit = String(args.limit);
          return await todoistRequest('GET', 'tasks/filter', undefined, query);
        }
        case 'get_task': {
          const taskId = ensureTaskId(args.taskId);
          return await todoistRequest('GET', `tasks/${taskId}`);
        }
        case 'create_task': {
          if (!args.content) throw new Error('content is required to create a task.');
          const payload = buildTaskPayload(args);
          return await todoistRequest('POST', 'tasks', payload);
        }
        case 'update_task': {
          const taskId = ensureTaskId(args.taskId);
          const payload = buildTaskPayload(args);
          if (!Object.keys(payload).length) throw new Error('Provide at least one field to update.');
          return await todoistRequest('POST', `tasks/${taskId}`, payload);
        }
        case 'delete_task': {
          const taskId = ensureTaskId(args.taskId);
          return await todoistRequest('DELETE', `tasks/${taskId}`);
        }
        default:
          throw new Error('Unsupported action');
      }
    },
  };
}
