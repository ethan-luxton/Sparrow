import fs from 'fs-extra';
import path from 'node:path';
import OpenAI from 'openai';
import { getSecret } from './config/config.js';
import { getLastMessageTimestamp, getLastCheckin, setLastCheckin, listChats, getMessages, getUserProfile, setUserProfile } from './lib/db.js';
import { logger } from './lib/logger.js';
const HEARTBEAT_PATH = path.resolve(process.cwd(), 'heartbeat.md');
function loadHeartbeatGuide() {
    try {
        if (fs.existsSync(HEARTBEAT_PATH))
            return fs.readFileSync(HEARTBEAT_PATH, 'utf8');
    }
    catch (err) {
        logger.warn(`Failed to read heartbeat.md: ${err.message}`);
    }
    return 'Provide brief, helpful check-ins only when useful. Skip otherwise.';
}
function formatRecentMessages(chatId, limit) {
    const messages = getMessages(chatId, limit)
        .filter((m) => m.role === 'user' || m.role === 'assistant')
        .map((m) => {
        const snippet = m.content.replace(/\s+/g, ' ').slice(0, 240);
        return `${m.role}: ${snippet}`;
    });
    return messages.join('\n');
}
function extractJson(text) {
    const match = text.match(/\{[\s\S]*\}/);
    if (!match)
        return null;
    try {
        return JSON.parse(match[0]);
    }
    catch {
        return null;
    }
}
async function runHeartbeatForChat(chatId, bot, client, cfg, guide, intervalMs, maxTokens) {
    const lastMsgIso = getLastMessageTimestamp(chatId);
    if (!lastMsgIso)
        return;
    const lastMsgMs = Date.parse(lastMsgIso);
    if (Date.now() - lastMsgMs < intervalMs)
        return;
    const lastCheckinIso = getLastCheckin(chatId);
    const lastCheckMs = lastCheckinIso ? Date.parse(lastCheckinIso) : 0;
    if (Date.now() - lastCheckMs < intervalMs)
        return;
    const profile = getUserProfile(chatId) ?? 'Unknown.';
    const recent = formatRecentMessages(chatId, 12);
    try {
        const completion = await client.chat.completions.create({
            model: cfg.openai?.model ?? 'gpt-5-mini',
            messages: [
                {
                    role: 'system',
                    content: 'You are Sparrow heartbeat. Decide whether to send one proactive message. ' +
                        'If sending, keep it under ~80 tokens. If not useful, skip.',
                },
                { role: 'system', content: `Heartbeat guide:\n${guide}` },
                { role: 'system', content: `User profile:\n${profile}` },
                { role: 'system', content: `Recent messages:\n${recent || '(none)'}` },
                {
                    role: 'system',
                    content: 'Return JSON only: {"action":"skip"|"message","text":"...","profile_update":"..."}. ' +
                        'Set profile_update to "" if no update. Never include extra keys.',
                },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
        });
        const content = completion.choices[0]?.message?.content ?? '';
        const data = extractJson(content);
        if (!data || (data.action !== 'skip' && data.action !== 'message')) {
            logger.warn(`Heartbeat returned non-JSON or invalid action for chat ${chatId}.`);
            setLastCheckin(chatId, new Date().toISOString());
            return;
        }
        if (typeof data.profile_update === 'string' && data.profile_update.trim()) {
            setUserProfile(chatId, data.profile_update.trim());
        }
        if (data.action === 'message' && typeof data.text === 'string' && data.text.trim()) {
            await bot.sendMessage(chatId, data.text.trim());
        }
        setLastCheckin(chatId, new Date().toISOString());
    }
    catch (err) {
        logger.error(`Heartbeat failed for chat ${chatId}: ${err.message}`);
    }
}
export function startHeartbeat(bot, cfg) {
    const apiKey = getSecret(cfg, 'openai.apiKey');
    const client = new OpenAI({ apiKey });
    const guide = loadHeartbeatGuide();
    const intervalMs = (cfg.bot?.heartbeatIntervalHours ?? cfg.bot?.checkinIntervalHours ?? 24) * 60 * 60 * 1000;
    const maxTokens = cfg.bot?.heartbeatMaxTokens ?? 180;
    const tick = async () => {
        const chats = listChats();
        for (const chatId of chats) {
            await runHeartbeatForChat(chatId, bot, client, cfg, guide, intervalMs, maxTokens);
        }
    };
    // Run periodically; align with previous check-in cadence.
    setInterval(tick, Math.max(15 * 60 * 1000, intervalMs / 4));
}
