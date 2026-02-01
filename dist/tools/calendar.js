import { google } from 'googleapis';
import fs from 'fs-extra';
import path from 'node:path';
import { buildOAuthClient } from '../google/client.js';
import { loadConfig } from '../config/config.js';
import { baseDir } from '../config/paths.js';
export function calendarTool() {
    return {
        name: 'google_calendar',
        description: 'List calendars/events, create/update/delete events, or quick_add. start/end/timeMin/timeMax should be RFC3339; for all-day use YYYY-MM-DD. Attachments use Drive fileId. create/update/delete/quick_add require confirm=true. Use recurrence as RRULE strings (e.g., "RRULE:FREQ=WEEKLY;BYDAY=TU,TH,SA;COUNT=36").',
        permission: 'write',
        schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: ['list_calendars', 'list_events', 'create_event', 'delete_event', 'update_event', 'quick_add'],
                },
                calendarId: { type: 'string' },
                eventId: { type: 'string' },
                maxResults: { type: 'integer', minimum: 1, maximum: 50 },
                timeMin: { type: 'string' },
                timeMax: { type: 'string' },
                summary: { type: 'string' },
                description: { type: 'string' },
                start: { type: 'string' },
                end: { type: 'string' },
                timezone: { type: 'string' },
                timeZone: { type: 'string' },
                recurrence: { anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] },
                text: { type: 'string' },
                attachments: {
                    type: 'array',
                    items: {
                        type: 'object',
                        properties: {
                            fileId: { type: 'string' },
                            fileUrl: { type: 'string' },
                            title: { type: 'string' },
                            mimeType: { type: 'string' },
                            localPath: { type: 'string' },
                        },
                        additionalProperties: false,
                    },
                },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const auth = buildOAuthClient(cfg);
            const calendar = google.calendar({ version: 'v3', auth });
            const defaultTz = 'America/Los_Angeles';
            const tz = args.timezone ?? args.timeZone ?? defaultTz;
            const dateOnlyRe = /^\d{4}-\d{2}-\d{2}$/;
            const dateTimeRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+\-]\d{2}:\d{2})?$/;
            const dateTimeWithOffsetRe = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+\-]\d{2}:\d{2})$/;
            const buildEventTime = (value) => {
                if (!value)
                    return null;
                if (dateOnlyRe.test(value))
                    return { date: value };
                if (dateTimeRe.test(value))
                    return { dateTime: value, timeZone: tz };
                return null;
            };
            const drive = google.drive({ version: 'v3', auth });
            const assertWithinBase = (target) => {
                const baseResolved = path.resolve(baseDir);
                const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseResolved, target);
                const rel = path.relative(baseResolved, resolved);
                if (rel.startsWith('..') || path.isAbsolute(rel)) {
                    throw new Error(`Path ${resolved} is outside of ${baseResolved}.`);
                }
                if (fs.existsSync(resolved)) {
                    const realBase = fs.realpathSync(baseResolved);
                    const realTarget = fs.realpathSync(resolved);
                    const relReal = path.relative(realBase, realTarget);
                    if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
                        throw new Error(`Resolved path ${realTarget} is outside of ${realBase}.`);
                    }
                }
                return resolved;
            };
            const detectMime = (filePath) => {
                const ext = path.extname(filePath).toLowerCase();
                if (ext === '.pdf')
                    return 'application/pdf';
                if (ext === '.docx')
                    return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
                return 'application/octet-stream';
            };
            const resolveAttachments = async () => {
                if (!args.attachments?.length)
                    return undefined;
                const result = [];
                for (const att of args.attachments) {
                    if (att.fileUrl) {
                        result.push({ fileUrl: att.fileUrl, title: att.title, mimeType: att.mimeType });
                        continue;
                    }
                    if (att.fileId) {
                        const meta = await drive.files.get({
                            fileId: att.fileId,
                            fields: 'id, name, mimeType, webViewLink',
                        });
                        const fileUrl = meta.data.webViewLink;
                        if (!fileUrl)
                            throw new Error('Drive file does not expose webViewLink for attachment.');
                        result.push({
                            fileUrl,
                            title: att.title ?? meta.data.name ?? undefined,
                            mimeType: meta.data.mimeType ?? undefined,
                        });
                        continue;
                    }
                    if (att.localPath) {
                        const resolved = assertWithinBase(att.localPath);
                        const name = att.title ?? path.basename(resolved);
                        const mimeType = detectMime(resolved);
                        const media = { mimeType, body: fs.createReadStream(resolved) };
                        const res = await drive.files.create({
                            requestBody: { name },
                            media,
                            fields: 'id, name, mimeType, webViewLink',
                        });
                        const fileUrl = res.data.webViewLink;
                        if (!fileUrl)
                            throw new Error('Drive upload did not return webViewLink for attachment.');
                        result.push({
                            fileUrl,
                            title: name,
                            mimeType: res.data.mimeType ?? mimeType,
                        });
                    }
                }
                return result.length ? result : undefined;
            };
            switch (args.action) {
                case 'list_calendars': {
                    const res = await calendar.calendarList.list({ maxResults: args.maxResults ?? 20 });
                    return res.data.items?.map((c) => ({ id: c.id, summary: c.summary, primary: c.primary })) ?? [];
                }
                case 'list_events': {
                    const calId = args.calendarId ?? 'primary';
                    if (args.timeMin && !dateTimeWithOffsetRe.test(args.timeMin)) {
                        return 'timeMin must be RFC3339 with timezone offset, e.g. 2011-06-03T10:00:00-07:00 or 2011-06-03T10:00:00Z.';
                    }
                    if (args.timeMax && !dateTimeWithOffsetRe.test(args.timeMax)) {
                        return 'timeMax must be RFC3339 with timezone offset, e.g. 2011-06-03T10:00:00-07:00 or 2011-06-03T10:00:00Z.';
                    }
                    const res = await calendar.events.list({
                        calendarId: calId,
                        maxResults: args.maxResults ?? 20,
                        timeMin: args.timeMin,
                        timeMax: args.timeMax,
                        timeZone: tz,
                        singleEvents: true,
                        orderBy: 'startTime',
                    });
                    return (res.data.items?.map((e) => ({
                        id: e.id,
                        summary: e.summary,
                        start: e.start,
                        end: e.end,
                        status: e.status,
                    })) ?? []);
                }
                case 'create_event': {
                    if (args.confirm !== true)
                        return 'Set confirm=true to create an event.';
                    const calId = args.calendarId ?? 'primary';
                    if (!args.summary || !args.start || !args.end) {
                        return 'summary, start, and end are required.';
                    }
                    const start = buildEventTime(args.start);
                    const end = buildEventTime(args.end);
                    if (!start || !end) {
                        return 'start/end must be RFC3339 date-time or YYYY-MM-DD (all-day).';
                    }
                    const recurrence = typeof args.recurrence === 'string'
                        ? [args.recurrence]
                        : Array.isArray(args.recurrence) && args.recurrence.length
                            ? args.recurrence
                            : undefined;
                    const attachments = await resolveAttachments();
                    const res = await calendar.events.insert({
                        calendarId: calId,
                        supportsAttachments: Boolean(attachments?.length),
                        requestBody: {
                            summary: args.summary,
                            description: args.description,
                            start,
                            end,
                            ...(recurrence ? { recurrence } : {}),
                            attachments,
                        },
                    });
                    return { created: true, id: res.data.id, htmlLink: res.data.htmlLink };
                }
                case 'delete_event': {
                    if (args.confirm !== true)
                        return 'Set confirm=true to delete an event.';
                    const calId = args.calendarId ?? 'primary';
                    if (!args.eventId)
                        return 'eventId required';
                    await calendar.events.delete({ calendarId: calId, eventId: args.eventId });
                    return { deleted: true, id: args.eventId };
                }
                case 'update_event': {
                    if (args.confirm !== true)
                        return 'Set confirm=true to update an event.';
                    const calId = args.calendarId ?? 'primary';
                    if (!args.eventId)
                        return 'eventId required';
                    const requestBody = {};
                    if (args.summary)
                        requestBody.summary = args.summary;
                    if (args.description)
                        requestBody.description = args.description;
                    if (args.recurrence) {
                        requestBody.recurrence =
                            typeof args.recurrence === 'string'
                                ? [args.recurrence]
                                : Array.isArray(args.recurrence) && args.recurrence.length
                                    ? args.recurrence
                                    : undefined;
                    }
                    if (args.start) {
                        const start = buildEventTime(args.start);
                        if (!start)
                            return 'start must be RFC3339 date-time or YYYY-MM-DD (all-day).';
                        requestBody.start = start;
                    }
                    if (args.end) {
                        const end = buildEventTime(args.end);
                        if (!end)
                            return 'end must be RFC3339 date-time or YYYY-MM-DD (all-day).';
                        requestBody.end = end;
                    }
                    const attachments = await resolveAttachments();
                    if (attachments?.length)
                        requestBody.attachments = attachments;
                    if (Object.keys(requestBody).length === 0)
                        return 'No fields provided to update.';
                    const res = await calendar.events.patch({
                        calendarId: calId,
                        eventId: args.eventId,
                        supportsAttachments: Boolean(attachments?.length),
                        requestBody,
                    });
                    return { updated: true, id: res.data.id, htmlLink: res.data.htmlLink };
                }
                case 'quick_add': {
                    if (args.confirm !== true)
                        return 'Set confirm=true to quick add an event.';
                    const calId = args.calendarId ?? 'primary';
                    if (!args.text)
                        return 'text required for quick_add.';
                    const res = await calendar.events.quickAdd({ calendarId: calId, text: args.text });
                    return { created: true, id: res.data.id, htmlLink: res.data.htmlLink };
                }
                default:
                    return 'Unsupported action';
            }
        },
    };
}
