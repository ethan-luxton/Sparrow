import OpenAI from 'openai';
import { PixelTrailConfig, getSecret } from '../config/config.js';

export function getChatModel(cfg: PixelTrailConfig): string {
  return cfg.openai?.model ?? process.env.OPENAI_MODEL ?? 'gpt-5-mini';
}

export function getCodingModel(cfg: PixelTrailConfig): string {
  return cfg.openai?.codeModel ?? process.env.OPENAI_CODE_MODEL ?? 'gpt-5.1-codex-mini';
}

export function supportsTools(cfg: PixelTrailConfig): boolean {
  return true;
}

export function supportsWebSearch(cfg: PixelTrailConfig): boolean {
  return true;
}

export function createChatClient(cfg: PixelTrailConfig): OpenAI {
  const apiKey = getSecret(cfg, 'openai.apiKey');
  const baseURL = cfg.openai?.baseUrl ?? process.env.OPENAI_BASE_URL;
  return new OpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
}

export function createCodingClient(cfg: PixelTrailConfig): OpenAI {
  return createChatClient(cfg);
}
