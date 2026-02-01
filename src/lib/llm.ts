import OpenAI from 'openai';
import { SparrowConfig, getSecret } from '../config/config.js';

export function getChatModel(cfg: SparrowConfig): string {
  return cfg.openai?.model ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini';
}

export function supportsTools(cfg: SparrowConfig): boolean {
  return true;
}

export function supportsWebSearch(cfg: SparrowConfig): boolean {
  return true;
}

export function createChatClient(cfg: SparrowConfig): OpenAI {
  const apiKey = getSecret(cfg, 'openai.apiKey');
  const baseURL = cfg.openai?.baseUrl ?? process.env.OPENAI_BASE_URL;
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}
