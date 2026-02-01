import fs from 'fs-extra';
import path from 'node:path';
import { getLastMessageTimestamp, getLastCheckin, setLastCheckin, listChats, getMessages, getUserProfile, setUserProfile } from './lib/db.js';
import { logger } from './lib/logger.js';
import { createChatClient, getChatModel } from './lib/llm.js';
const HEARTBEAT_PATHS = [path.resolve(process.cwd(), 'HEARTBEAT.md'), path.resolve(process.cwd(), 'heartbeat.md')];
const DEFAULT_HEARTBEAT_PROMPT = 'Read HEARTBEAT.md if it exists (workspace context). Follow it strictly. ' +
    'Do not infer or repeat old tasks from prior chats. If nothing needs attention, reply HEARTBEAT_OK.';
function loadHeartbeatGuide() {
    try {
        for (const p of HEARTBEAT_PATHS) {
            if (fs.existsSync(p))
                return { path: p, content: fs.readFileSync(p, 'utf8') };
        }
    }
    catch (err) {
        logger.warn(`Failed to read heartbeat.md: ${err.message}`);
    }
    return null;
}
function isGuideEffectivelyEmpty(content) {
    const stripped = content
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line && !line.startsWith('#'))
        .join('');
    return stripped.length === 0;
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
function parseTime(input) {
    const match = input.trim().match(/^(\d{1,2}):(\d{2})$/);
    if (!match)
        return null;
    const hour = Number(match[1]);
    const minute = Number(match[2]);
    if (Number.isNaN(hour) || Number.isNaN(minute))
        return null;
    if (hour < 0 || hour > 23 || minute < 0 || minute > 59)
        return null;
    return { hour, minute };
}
function isWithinActiveHours(cfg) {
    const window = cfg.bot?.heartbeatActiveHours;
    if (!window?.start || !window?.end)
        return true;
    const start = parseTime(window.start);
    const end = parseTime(window.end);
    if (!start || !end)
        return true;
    const tz = cfg.user?.timezone;
    let hour = new Date().getHours();
    let minute = new Date().getMinutes();
    if (tz) {
        try {
            const parts = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: tz }).formatToParts(new Date());
            const h = parts.find((p) => p.type === 'hour')?.value;
            const m = parts.find((p) => p.type === 'minute')?.value;
            if (h)
                hour = Number(h);
            if (m)
                minute = Number(m);
        }
        catch (err) {
            logger.warn(`Heartbeat timezone error: ${err.message}`);
        }
    }
    const now = hour * 60 + minute;
    const startMin = start.hour * 60 + start.minute;
    const endMin = end.hour * 60 + end.minute;
    if (startMin <= endMin)
        return now >= startMin && now <= endMin;
    return now >= startMin || now <= endMin;
}
async function runHeartbeatForChat(chatId, bot, client, cfg, guide, intervalMs, maxTokens, queue) {
    if (queue?.isBusy(chatId)) {
        logger.info(`heartbeat.skip.busy chatId=${chatId}`);
        return;
    }
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
    if (!isWithinActiveHours(cfg)) {
        return;
    }
    if (guide && isGuideEffectivelyEmpty(guide.content)) {
        logger.info(`heartbeat.skip.empty_guide chatId=${chatId} path=${guide.path}`);
        return;
    }
    const profile = getUserProfile(chatId) ?? 'Unknown.';
    const recent = formatRecentMessages(chatId, 12);
    const prompt = cfg.bot?.heartbeatPrompt ?? DEFAULT_HEARTBEAT_PROMPT;
    const ackMax = cfg.bot?.heartbeatAckMaxChars ?? 300;
    try {
        const completion = await client.chat.completions.create({
            model: getChatModel(cfg),
            messages: [
                {
                    role: 'system',
                    content: 'You are Sparrow heartbeat. Be proactive but avoid noise. If nothing needs attention, reply HEARTBEAT_OK.',
                },
                { role: 'system', content: `Heartbeat prompt:\n${prompt}` },
                ...(guide ? [{ role: 'system', content: `HEARTBEAT.md:\n${guide.content}` }] : []),
                { role: 'system', content: `User profile:\n${profile}` },
                { role: 'system', content: `Recent messages:\n${recent || '(none)'}` },
            ],
            temperature: 0.2,
            max_tokens: maxTokens,
        });
        let content = (completion.choices[0]?.message?.content ?? '').trim();
        if (!content) {
            setLastCheckin(chatId, new Date().toISOString());
            return;
        }
        // Optional profile update line: PROFILE_UPDATE: ...
        const lines = content.split('\n');
        const profileLineIdx = lines.findIndex((l) => l.startsWith('PROFILE_UPDATE:'));
        if (profileLineIdx >= 0) {
            const profileLine = lines[profileLineIdx].replace(/^PROFILE_UPDATE:\s*/i, '').trim();
            if (profileLine)
                setUserProfile(chatId, profileLine);
            lines.splice(profileLineIdx, 1);
            content = lines.join('\n').trim();
        }
        const hasOk = content.includes('HEARTBEAT_OK');
        const cleaned = content.replace(/HEARTBEAT_OK/g, '').trim();
        if (hasOk && cleaned.length <= ackMax) {
            setLastCheckin(chatId, new Date().toISOString());
            return;
        }
        if (!cleaned) {
            setLastCheckin(chatId, new Date().toISOString());
            return;
        }
        await bot.sendMessage(chatId, cleaned);
        setLastCheckin(chatId, new Date().toISOString());
    }
    catch (err) {
        logger.error(`Heartbeat failed for chat ${chatId}: ${err.message}`);
    }
}
export function startHeartbeat(bot, cfg, opts) {
    const client = createChatClient(cfg);
    const guide = loadHeartbeatGuide();
    const intervalMs = (cfg.bot?.heartbeatIntervalHours ?? cfg.bot?.checkinIntervalHours ?? 24) * 60 * 60 * 1000;
    const maxTokens = cfg.bot?.heartbeatMaxTokens ?? 180;
    const tick = async () => {
        const chats = listChats();
        for (const chatId of chats) {
            await runHeartbeatForChat(chatId, bot, client, cfg, guide, intervalMs, maxTokens, opts?.queue);
        }
    };
    // Run periodically; align with previous check-in cadence.
    setInterval(tick, Math.max(15 * 60 * 1000, intervalMs / 4));
}
