import type OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { createCodingClient, getCodingModel } from './llm.js';
import type { PixelTrailConfig } from '../config/config.js';

export class CodingClient {
  private client: OpenAI;
  private model: string;

  constructor(cfg: PixelTrailConfig) {
    this.client = createCodingClient(cfg);
    this.model = getCodingModel(cfg);
  }

  async generatePatch(input: { instructions: string; context: string; maxTokens?: number }) {
    const messages: ChatCompletionMessageParam[] = [
      {
        role: 'system',
        content:
          'You generate unified diffs for code edits. Only modify files inside the workspace project. Be diff-first and avoid extra commentary.',
      },
      { role: 'user', content: `Instructions:\n${input.instructions}` },
      { role: 'user', content: `Context:\n${input.context}` },
    ];
    const completion = await this.client.chat.completions.create({
      model: this.model,
      messages,
      max_tokens: input.maxTokens ?? 600,
      temperature: 0.1,
    });
    return completion.choices[0]?.message?.content?.trim() ?? '';
  }
}
