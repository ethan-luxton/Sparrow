import TelegramBot from 'node-telegram-bot-api';
import os from 'node:os';
import https from 'node:https';
import { loadConfig, getSecret, redacted } from './config/config.js';
import { ChatQueue } from './lib/queues.js';
import { addMessage, clearChat, listNotes, addNote } from './lib/db.js';
import { OpenAIClient } from './lib/openaiClient.js';
import { buildToolRegistry } from './tools/index.js';
import { logger } from './lib/logger.js';
import { startHeartbeat } from './heartbeat.js';
import { AgentRuntime } from './agent/runtime.js';
import { AgentLLM } from './agent/llm.js';
import fs from 'fs-extra';
import path from 'node:path';
import { baseDir } from './config/paths.js';
import { redactSensitiveText } from './lib/redaction.js';

const queue = new ChatQueue();
const pendingMedia = new Map<number, { audioPath: string; transcript: string }>();

function boolFromEnv(value?: string): boolean | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return undefined;
}

function numberFromEnv(value?: string): number | undefined {
  if (!value) return undefined;
  const num = Number(value);
  return Number.isFinite(num) ? num : undefined;
}

function buildTelegramOptions() {
  const pollingIntervalMs = numberFromEnv(
    process.env.SPARROW_TELEGRAM_POLLING_INTERVAL_MS ?? process.env.TELEGRAM_POLLING_INTERVAL_MS
  );
  const pollingTimeoutSec = numberFromEnv(
    process.env.SPARROW_TELEGRAM_POLLING_TIMEOUT_SEC ?? process.env.TELEGRAM_POLLING_TIMEOUT_SEC
  );
  const proxyUrl = process.env.SPARROW_TELEGRAM_PROXY_URL ?? process.env.TELEGRAM_PROXY_URL;
  const ipv4Only =
    boolFromEnv(process.env.SPARROW_TELEGRAM_IPV4_ONLY ?? process.env.TELEGRAM_IPV4_ONLY) ??
    (process.platform === 'linux');

  const options: any = { polling: true };
  if (pollingIntervalMs || pollingTimeoutSec) {
    options.polling = {
      autoStart: true,
      ...(pollingIntervalMs ? { interval: pollingIntervalMs } : {}),
      ...(pollingTimeoutSec ? { params: { timeout: pollingTimeoutSec } } : {}),
    };
  }

  if (proxyUrl || ipv4Only) {
    options.request = {
      ...(proxyUrl ? { proxy: proxyUrl } : {}),
      ...(ipv4Only ? { agent: new https.Agent({ keepAlive: true, family: 4 }) } : {}),
    };
  }

  return { options, diagnostics: { pollingIntervalMs, pollingTimeoutSec, proxy: Boolean(proxyUrl), ipv4Only } };
}

function chunkAndSend(bot: TelegramBot, chatId: number, text: string) {
  const max = 3500;
  const parts = [] as string[];
  for (let i = 0; i < text.length; i += max) {
    parts.push(text.slice(i, i + max));
  }
  return (async () => {
    for (const part of parts) {
      await bot.sendChatAction(chatId, 'typing');
      await bot.sendMessage(chatId, part);
    }
  })();
}

function summarizeLog(text: string, maxLen = 200) {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen) + '…';
}

function isYes(text: string) {
  const t = text.trim().toLowerCase();
  return ['yes', 'y', 'sure', 'ok', 'okay', 'yep', 'please', 'do it'].includes(t);
}

function isNo(text: string) {
  const t = text.trim().toLowerCase();
  return ['no', 'n', 'nope', 'nah', 'dont', "don't"].includes(t);
}

async function downloadTelegramFile(bot: TelegramBot, fileId: string, targetPath: string) {
  const link = await bot.getFileLink(fileId);
  await fs.ensureDir(path.dirname(targetPath));
  const res = await fetch(link);
  if (!res.ok) throw new Error(`Failed to download file: ${res.status}`);
  const buffer = Buffer.from(await res.arrayBuffer());
  await fs.writeFile(targetPath, buffer);
  return targetPath;
}

async function handleAudioMessage(
  bot: TelegramBot,
  tools: ReturnType<typeof buildToolRegistry>,
  openai: OpenAIClient,
  chatId: number,
  fileId: string,
  fileName: string
) {
  const tmpDir = path.join(baseDir, 'tmp');
  const audioPath = path.join(tmpDir, fileName);
  await downloadTelegramFile(bot, fileId, audioPath);

  const transcription = (await tools.run('whisper_transcribe', { action: 'transcribe', path: audioPath }, chatId)) as {
    text?: string;
  };
  const transcriptText = typeof transcription === 'string' ? transcription : transcription?.text ?? '';
  if (!transcriptText.trim()) {
    await bot.sendMessage(chatId, 'I could not transcribe that audio.');
    return;
  }

  pendingMedia.set(chatId, { audioPath, transcript: transcriptText });
  const reply = await openai.chat(chatId, transcriptText, tools);
  await chunkAndSend(bot, chatId, reply);
  await bot.sendMessage(chatId, 'Do you want me to save the audio and transcript to your workspace? Reply yes or no.');
}

export function startTelegramBot(opts?: { debugIO?: boolean }) {
  const cfg = loadConfig();
  const botToken = getSecret(cfg, 'telegram.botToken');
  const { options, diagnostics } = buildTelegramOptions();
  const bot = new TelegramBot(botToken, options);
  const tools = buildToolRegistry(cfg);
  const openai = new OpenAIClient(cfg);
  const llm = new AgentLLM(cfg);
  const runtime = new AgentRuntime({
    tools,
    llm,
    notify: async (chatId, text) => {
      logger.info(`telegram.out chatId=${chatId} chars=${text.length} text=${summarizeLog(text)}`);
      await chunkAndSend(bot, chatId, text);
    },
    options: {
      tickMaxToolCalls: cfg.agent?.tickMaxToolCalls,
      tickMaxTokens: cfg.agent?.tickMaxTokens,
    },
  });
  startHeartbeat(bot, cfg, { queue });
  if (opts?.debugIO) {
    process.env.SPARROW_DEBUG_IO = '1';
  }
  logger.info(`Telegram options: ${JSON.stringify(diagnostics)}`);

  bot.onText(/^\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, 'Sparrow ready. Send a message or /help for options.');
  });

  bot.onText(/^\/help/, (msg) => {
    bot.sendMessage(
      msg.chat.id,
      ['/start', '/help', '/config', '/status', '/reset', '/note <title>: <content>', '/notes'].join('\n') +
        '\nMessages are processed sequentially per chat.'
    );
  });

  bot.onText(/^\/config/, (msg) => {
    const cfgSafe = redacted(cfg);
    bot.sendMessage(msg.chat.id, 'Config (redacted):\n' + JSON.stringify(cfgSafe, null, 2));
  });

  bot.onText(/^\/status/, (msg) => {
    const status = {
      pid: process.pid,
      uptimeSeconds: process.uptime(),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      load: os.loadavg(),
    };
    bot.sendMessage(msg.chat.id, 'Status:\n' + JSON.stringify(status, null, 2));
  });

  bot.onText(/^\/reset/, (msg) => {
    clearChat(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Conversation reset for this chat.');
  });

  bot.onText(/^\/pause/, (msg) => {
    runtime.pause(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Paused.');
  });

  bot.onText(/^\/resume/, (msg) => {
    runtime.resume(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Resumed.');
  });

  bot.onText(/^\/cancel/, (msg) => {
    runtime.cancel(msg.chat.id);
    bot.sendMessage(msg.chat.id, 'Canceled current run.');
  });

  bot.onText(/^\/note (.+)/s, (msg, match) => {
    const body = match?.[1] ?? '';
    const [title, ...rest] = body.split(':');
    const content = rest.join(':').trim();
    if (!title || !content) {
      bot.sendMessage(msg.chat.id, 'Use /note Title: content');
      return;
    }
    addNote(msg.chat.id, title.trim(), content);
    bot.sendMessage(msg.chat.id, 'Saved locally.');
  });

  bot.onText(/^\/notes$/, (msg) => {
    const notes = listNotes(msg.chat.id, 10);
    if (notes.length === 0) return bot.sendMessage(msg.chat.id, 'No notes yet.');
    const text = notes.map((n) => `#${n.id} ${n.title} — ${n.createdAt}\n${n.content}`).join('\n\n');
    bot.sendMessage(msg.chat.id, text);
  });

  bot.on('message', (msg) => {
    if (msg.text && msg.text.startsWith('/')) return; // commands handled separately
    const chatId = msg.chat.id;
    queue.enqueue(chatId, async () => {
      try {
        if (msg.voice || msg.audio || (msg.document && msg.document.mime_type?.startsWith('audio/'))) {
          const fileId = msg.voice?.file_id ?? msg.audio?.file_id ?? msg.document?.file_id;
          const fileName =
            msg.document?.file_name ??
            (msg.voice
              ? `voice_${msg.voice.file_unique_id}.ogg`
              : `audio_${msg.audio?.file_unique_id ?? Date.now()}.bin`);
          if (!fileId) throw new Error('Audio file id not found.');
          logger.info(`telegram.in chatId=${chatId} audio=${fileName}`);
          await bot.sendChatAction(chatId, 'typing');
          await handleAudioMessage(bot, tools, openai, chatId, fileId, fileName);
          return;
        }

        if (msg.text) {
          const pending = pendingMedia.get(chatId);
          if (pending && (isYes(msg.text) || isNo(msg.text))) {
            if (isYes(msg.text)) {
              const transcriptPath = path.join('transcripts', `${path.parse(pending.audioPath).name}.txt`);
              const audioSavePath = path.join('audio', path.basename(pending.audioPath));
              const audioBuf = await fs.readFile(pending.audioPath);
              await tools.run('filesystem', {
                action: 'write',
                path: transcriptPath,
                content: pending.transcript,
                confirm: true,
              }, chatId);
              await tools.run('filesystem', {
                action: 'write_binary',
                path: audioSavePath,
                content: audioBuf.toString('base64'),
                encoding: 'base64',
                confirm: true,
              }, chatId);
              await bot.sendMessage(chatId, 'Saved the transcript and audio under ~/.sparrow.');
            } else {
              await bot.sendMessage(chatId, 'Got it, I will not save them.');
            }
            pendingMedia.delete(chatId);
            return;
          }

          logger.info(`telegram.in chatId=${chatId} text=${summarizeLog(redactSensitiveText(msg.text))}`);
          addMessage(chatId, 'user', msg.text);
          await bot.sendChatAction(chatId, 'typing');
          const reply = await openai.chat(chatId, msg.text, tools);
          logger.info(`telegram.out chatId=${chatId} chars=${reply.length} text=${summarizeLog(reply)}`);
          await chunkAndSend(bot, chatId, reply);
          return;
        }
      } catch (err) {
        const text = `Error: ${(err as Error).message}`;
        logger.error(text);
        await bot.sendMessage(chatId, text);
      }
    }).catch((err) => logger.error(`Queue error: ${err.message}`));
  });

  bot.on('polling_error', (err: any) => {
    logger.error(
      `Polling error: ${err?.message ?? String(err)}${err?.code ? ` code=${err.code}` : ''}${
        err?.response?.body ? ` response=${JSON.stringify(err.response.body)}` : ''
      }`
    );
  });
  bot.on('webhook_error', (err: any) => {
    logger.error(`Webhook error: ${err?.message ?? String(err)}`);
  });
  logger.info('Telegram bot started.');

  // Heartbeat handles autonomous check-ins
  const tickMs = cfg.agent?.tickMs ?? 1500;
  setInterval(() => {
    runtime
      .tickAll()
      .catch((err) => logger.error(`runtime.tick error: ${(err as Error).message}`));
  }, Math.max(500, tickMs));
}
