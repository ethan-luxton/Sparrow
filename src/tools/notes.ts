import { ToolDefinition } from './registry.js';
import { addNote, listNotes } from '../lib/db.js';

export function notesTool(): ToolDefinition {
  return {
    name: 'notes',
    description: 'Store or retrieve short notes for this chat, kept locally in SQLite.',
    permission: 'write',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['add', 'list'] },
        title: { type: 'string' },
        content: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: 50 },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args: { action: 'add' | 'list'; title?: string; content?: string; limit?: number }, chatId) => {
      if (args.action === 'add') {
        if (!args.title || !args.content) throw new Error('title and content required');
        addNote(chatId, args.title, args.content);
        return 'Note stored locally.';
      }
      const notes = listNotes(chatId, args.limit ?? 10);
      if (notes.length === 0) return 'No notes yet.';
      return notes.map((n) => `#${n.id} ${n.title} — ${n.createdAt}\n${n.content}`).join('\n\n');
    },
  };
}
