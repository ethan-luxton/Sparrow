import { google } from 'googleapis';
import fs from 'fs-extra';
import path from 'node:path';
import { ToolDefinition } from './registry.js';
import { buildOAuthClient } from '../google/client.js';
import { loadConfig } from '../config/config.js';
import { logger } from '../lib/logger.js';
import { extractDocxTextFromBuffer, extractPdfTextFromBuffer } from '../lib/fileText.js';

function assertAllowed(target: string, allowlist: string[]) {
  const resolved = path.resolve(target);
  for (const allowed of allowlist) {
    const base = path.resolve(allowed);
    if (resolved === base || resolved.startsWith(base + path.sep)) return resolved;
  }
  throw new Error(`Path ${resolved} is not in allowlist.`);
}

export function gmailTool(): ToolDefinition {
  return {
    name: 'gmail',
    description:
      'Search/read Gmail, list threads, inspect/save attachments, and safely compose/send email (send requires confirm=true).',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'search_messages',
            'read_message',
            'list_threads',
            'attachment_metadata',
            'save_attachment',
            'attachment_text',
            'compose_message',
            'send_raw',
          ],
        },
        query: { type: 'string' },
        messageId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        threadId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        attachmentId: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        savePath: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        fileName: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        mimeType: { anyOf: [{ type: 'string' }, { type: 'null' }] },
        to: { type: 'array', items: { type: 'string' } },
        cc: { type: 'array', items: { type: 'string' } },
        bcc: { type: 'array', items: { type: 'string' } },
        subject: { type: 'string' },
        body: { type: 'string' },
        raw: { type: 'string' },
        confirm: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    handler: async (args) => {
      const cfg = loadConfig();
      const auth = buildOAuthClient(cfg);
      const gmail = google.gmail({ version: 'v1', auth });

      // Guardrails for required IDs to avoid repeated empty calls
      const requireFields = (fields: Array<keyof typeof args>) => {
        const missing = fields.filter((f) => !args[f]);
        if (missing.length) {
          return `Missing required fields for ${args.action}: ${missing.join(', ')}. Use search/list actions first to fetch IDs.`;
        }
        return null;
      };

      switch (args.action) {
        case 'search_messages': {
          const res = await gmail.users.messages.list({ userId: 'me', q: args.query ?? '', maxResults: 10 });
          return res.data.messages ?? [];
        }
        case 'read_message': {
          const missing = requireFields(['messageId']);
          if (missing) return missing;
          const res = await gmail.users.messages.get({ userId: 'me', id: args.messageId, format: 'full' });
          return res.data;
        }
        case 'list_threads': {
          const res = await gmail.users.threads.list({ userId: 'me', q: args.query ?? '', maxResults: 10 });
          return res.data.threads ?? [];
        }
        case 'attachment_metadata': {
          const missing = requireFields(['messageId', 'attachmentId']);
          if (missing) return missing;
          const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: args.messageId, id: args.attachmentId });
          return { size: res.data.size, dataPresent: !!res.data.data };
        }
        case 'save_attachment': {
          const missing = requireFields(['messageId', 'attachmentId', 'savePath']);
          if (missing) return missing;
          const allowlist = cfg.paths?.allowlist ?? [];
          const target = assertAllowed(args.savePath, allowlist);
          const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: args.messageId, id: args.attachmentId });
          const data = res.data.data;
          if (!data) throw new Error('No attachment data found');
          const buffer = decodeAttachmentData(data);
          await fs.outputFile(target, buffer);
          return { saved: target, bytes: buffer.length };
        }
        case 'attachment_text': {
          const missing = requireFields(['messageId', 'attachmentId']);
          if (missing) return missing;
          const res = await gmail.users.messages.attachments.get({ userId: 'me', messageId: args.messageId, id: args.attachmentId });
          const data = res.data.data;
          if (!data) throw new Error('No attachment data found');
          const buffer = decodeAttachmentData(data);
          const type = detectType(args.mimeType, args.fileName);
          if (type === 'pdf') return await extractPdfTextFromBuffer(buffer);
          if (type === 'docx') return await extractDocxTextFromBuffer(buffer);
          return 'Unsupported attachment type. Only PDF and DOCX are supported for text extraction.';
        }
        case 'compose_message': {
          const missing = requireFields(['to', 'subject', 'body']);
          if (missing) return missing;
          const to = (args.to as string[]) ?? [];
          if (to.length === 0) return 'At least one recipient is required.';

          const headers = [
            `To: ${to.join(', ')}`,
            args.cc?.length ? `Cc: ${(args.cc as string[]).join(', ')}` : null,
            args.bcc?.length ? `Bcc: ${(args.bcc as string[]).join(', ')}` : null,
            `Subject: ${args.subject}`,
            'Content-Type: text/plain; charset=UTF-8',
          ]
            .filter(Boolean)
            .join('\r\n');

          const raw = Buffer.from(`${headers}\r\n\r\n${args.body}`, 'utf8')
            .toString('base64')
            .replace(/\+/g, '-')
            .replace(/\//g, '_')
            .replace(/=+$/, '');

          if (args.confirm === true) {
            const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw } });
            logger.info('Gmail message sent', { id: res.data.id });
            return { sent: true, id: res.data.id, threadId: res.data.threadId };
          }
          return {
            sent: false,
            note: 'Not sent. Set confirm=true to send.',
            preview: { to, cc: args.cc, bcc: args.bcc, subject: args.subject, body: args.body },
            raw,
          };
        }
        case 'send_raw': {
          const missing = requireFields(['raw']);
          if (missing) return missing;
          if (args.confirm !== true) return 'Set confirm=true to send raw message.';
          const res = await gmail.users.messages.send({ userId: 'me', requestBody: { raw: args.raw as string } });
          logger.info('Gmail raw message sent', { id: res.data.id });
          return { sent: true, id: res.data.id, threadId: res.data.threadId };
        }
        default:
          throw new Error('Unsupported action');
      }
    },
  };
}

function decodeAttachmentData(data: string) {
  const normalized = data.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

function detectType(mimeType?: string | null, fileName?: string | null) {
  const mt = (mimeType ?? '').toLowerCase();
  const fn = (fileName ?? '').toLowerCase();
  if (mt.includes('pdf') || fn.endsWith('.pdf')) return 'pdf';
  if (mt.includes('word') || mt.includes('officedocument.wordprocessingml') || fn.endsWith('.docx')) return 'docx';
  return 'unknown';
}
