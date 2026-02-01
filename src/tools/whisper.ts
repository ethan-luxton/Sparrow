import fs from 'fs-extra';
import { ToolDefinition } from './registry.js';
import { resolveWithinRoots } from '../lib/safePath.js';
import { loadConfig, getSecret } from '../config/config.js';
import OpenAI from 'openai';

interface WhisperArgs {
  action: 'transcribe';
  path: string;
  language?: string;
  prompt?: string;
}

export function whisperTool(): ToolDefinition {
  return {
    name: 'whisper_transcribe',
    description: 'Transcribe an audio file with OpenAI Whisper. Input is a local file path.',
    permission: 'read',
    schema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['transcribe'] },
        path: { type: 'string' },
        language: { type: 'string' },
        prompt: { type: 'string' },
      },
      required: ['action', 'path'],
      additionalProperties: false,
    },
    handler: async (args: WhisperArgs) => {
      if (args.action !== 'transcribe') throw new Error('Unsupported action');
      const target = resolveWithinRoots(args.path, process.cwd());
      if (!fs.existsSync(target)) throw new Error(`File not found: ${target}`);
      const cfg = loadConfig();
      const apiKey = getSecret(cfg, 'openai.apiKey');
      const baseURL = cfg.openai?.baseUrl ?? process.env.OPENAI_BASE_URL;
      const client = new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
      const file = fs.createReadStream(target);
      const resp = await client.audio.transcriptions.create({
        file,
        model: 'whisper-1',
        ...(args.language ? { language: args.language } : {}),
        ...(args.prompt ? { prompt: args.prompt } : {}),
      } as any);
      const text = (resp as any).text ?? '';
      return { text };
    },
  };
}
