import TelegramBot from 'node-telegram-bot-api';
import os from 'node:os';
import { loadConfig, getSecret, redacted } from './config/config.js';
import { ChatQueue } from './lib/queues.js';
import { addMessage, clearChat, listNotes, addNote } from './lib/db.js';
import { OpenAIClient } from './lib/openaiClient.js';
import { buildToolRegistry } from './tools/index.js';
import { logger } from './lib/logger.js';
import { startHeartbeat } from './heartbeat.js';
const queue = new ChatQueue();
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
export function startTelegramBot() {
    const cfg = loadConfig();
    const botToken = getSecret(cfg, 'telegram.botToken');
    const bot = new TelegramBot(botToken, { polling: true });
    const openai = new OpenAIClient(cfg);
    const tools = buildToolRegistry();
    startHeartbeat(bot, cfg);
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
                addMessage(chatId, 'user', msg.text);
                await bot.sendChatAction(chatId, 'typing');
                const reply = await openai.chat(chatId, msg.text, tools);
                await chunkAndSend(bot, chatId, reply);
            }
            catch (err) {
                const text = `Error: ${err.message}`;
                logger.error(text);
                await bot.sendMessage(chatId, text);
            }
        }).catch((err) => logger.error(`Queue error: ${err.message}`));
    });
    bot.on('polling_error', (err) => logger.error(`Polling error: ${err.message}`));
    logger.info('Telegram bot started.');
    // Heartbeat handles autonomous check-ins
}
