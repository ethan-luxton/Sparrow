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
const queue = new ChatQueue();
function boolFromEnv(value) {
    if (!value)
        return undefined;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized))
        return true;
    if (['0', 'false', 'no', 'off'].includes(normalized))
        return false;
    return undefined;
}
function numberFromEnv(value) {
    if (!value)
        return undefined;
    const num = Number(value);
    return Number.isFinite(num) ? num : undefined;
}
function buildTelegramOptions() {
    const pollingIntervalMs = numberFromEnv(process.env.SPARROW_TELEGRAM_POLLING_INTERVAL_MS ?? process.env.TELEGRAM_POLLING_INTERVAL_MS);
    const pollingTimeoutSec = numberFromEnv(process.env.SPARROW_TELEGRAM_POLLING_TIMEOUT_SEC ?? process.env.TELEGRAM_POLLING_TIMEOUT_SEC);
    const proxyUrl = process.env.SPARROW_TELEGRAM_PROXY_URL ?? process.env.TELEGRAM_PROXY_URL;
    const ipv4Only = boolFromEnv(process.env.SPARROW_TELEGRAM_IPV4_ONLY ?? process.env.TELEGRAM_IPV4_ONLY) ??
        (process.platform === 'linux');
    const options = { polling: true };
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
function chunkAndSend(bot, chatId, text) {
    const max = 3500;
    const parts = [];
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
export function startTelegramBot(opts) {
    const cfg = loadConfig();
    const botToken = getSecret(cfg, 'telegram.botToken');
    const { options, diagnostics } = buildTelegramOptions();
    const bot = new TelegramBot(botToken, options);
    const openai = new OpenAIClient(cfg);
    const tools = buildToolRegistry(cfg);
    startHeartbeat(bot, cfg, { queue });
    if (opts?.debugIO) {
        process.env.SPARROW_DEBUG_IO = '1';
    }
    logger.info(`Telegram options: ${JSON.stringify(diagnostics)}`);
    bot.onText(/^\/start/, (msg) => {
        bot.sendMessage(msg.chat.id, 'Sparrow ready. Send a message or /help for options.');
    });
    bot.onText(/^\/help/, (msg) => {
        bot.sendMessage(msg.chat.id, ['/start', '/help', '/config', '/status', '/reset', '/note <title>: <content>', '/notes'].join('\n') +
            '\nMessages are processed sequentially per chat.');
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
        if (notes.length === 0)
            return bot.sendMessage(msg.chat.id, 'No notes yet.');
        const text = notes.map((n) => `#${n.id} ${n.title} — ${n.createdAt}\n${n.content}`).join('\n\n');
        bot.sendMessage(msg.chat.id, text);
    });
    bot.on('message', (msg) => {
        if (!msg.text || msg.text.startsWith('/'))
            return; // commands handled separately
        const chatId = msg.chat.id;
        queue.enqueue(chatId, async () => {
            try {
                logger.info(`telegram.in chatId=${chatId} text=${msg.text}`);
                addMessage(chatId, 'user', msg.text);
                await bot.sendChatAction(chatId, 'typing');
                const reply = await openai.chat(chatId, msg.text, tools);
                logger.info(`telegram.out chatId=${chatId} chars=${reply.length}`);
                await chunkAndSend(bot, chatId, reply);
            }
            catch (err) {
                const text = `Error: ${err.message}`;
                logger.error(text);
                await bot.sendMessage(chatId, text);
            }
        }).catch((err) => logger.error(`Queue error: ${err.message}`));
    });
    bot.on('polling_error', (err) => {
        logger.error(`Polling error: ${err?.message ?? String(err)}${err?.code ? ` code=${err.code}` : ''}${err?.response?.body ? ` response=${JSON.stringify(err.response.body)}` : ''}`);
    });
    bot.on('webhook_error', (err) => {
        logger.error(`Webhook error: ${err?.message ?? String(err)}`);
    });
    logger.info('Telegram bot started.');
    // Heartbeat handles autonomous check-ins
}
