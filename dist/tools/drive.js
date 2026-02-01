import { google } from 'googleapis';
import fs from 'fs-extra';
import path from 'node:path';
import { buildOAuthClient } from '../google/client.js';
import { loadConfig } from '../config/config.js';
import { baseDir } from '../config/paths.js';
import { extractDocxTextFromBuffer, extractPdfTextFromBuffer, createPdfBufferFromText } from '../lib/fileText.js';
function assertWithinBase(target, base) {
    const baseResolved = path.resolve(base);
    const resolved = path.isAbsolute(target) ? path.resolve(target) : path.resolve(baseResolved, target);
    const rel = path.relative(baseResolved, resolved);
    if (rel.startsWith('..') || path.isAbsolute(rel)) {
        throw new Error(`Path ${resolved} is outside of ${baseResolved}.`);
    }
    // If the path exists, ensure realpath doesn't escape via symlinks.
    if (fs.existsSync(resolved)) {
        const realBase = fs.realpathSync(baseResolved);
        const realTarget = fs.realpathSync(resolved);
        const relReal = path.relative(realBase, realTarget);
        if (relReal.startsWith('..') || path.isAbsolute(relReal)) {
            throw new Error(`Resolved path ${realTarget} is outside of ${realBase}.`);
        }
    }
    return resolved;
}
export function googleDriveTool() {
    return {
        name: 'google_drive',
        description: 'Interact with Google Drive: list, search, metadata, export docs, extract text, upload, create docs/folders. Write actions (upload/create/delete/download) require confirm=true.',
        permission: 'write',
        schema: {
            type: 'object',
            properties: {
                action: {
                    type: 'string',
                    enum: [
                        'list',
                        'search',
                        'metadata',
                        'export_doc',
                        'export_pdf',
                        'export_docx',
                        'create_pdf',
                        'upload',
                        'upload_convert',
                        'create_folder',
                        'create_doc',
                        'download_file',
                        'extract_text',
                        'delete_file',
                    ],
                },
                query: { type: 'string' },
                fileId: { type: 'string' },
                localPath: { type: 'string' },
                name: { type: 'string' },
                parentId: { type: 'string' },
                content: { type: 'string' },
                confirm: { type: 'boolean' },
            },
            required: ['action'],
            additionalProperties: false,
        },
        handler: async (args) => {
            const cfg = loadConfig();
            const auth = buildOAuthClient(cfg);
            const drive = google.drive({ version: 'v3', auth });
            switch (args.action) {
                case 'list': {
                    const res = await drive.files.list({ pageSize: 20, fields: 'files(id, name, mimeType, modifiedTime, size)' });
                    return res.data.files;
                }
                case 'search': {
                    const q = args.query ?? '';
                    const res = await drive.files.list({ q, pageSize: 20, fields: 'files(id, name, mimeType, modifiedTime, size)' });
                    return res.data.files;
                }
                case 'metadata': {
                    if (!args.fileId)
                        throw new Error('fileId required');
                    const res = await drive.files.get({ fileId: args.fileId, fields: 'id, name, mimeType, size, owners, createdTime, modifiedTime' });
                    return res.data;
                }
                case 'export_doc': {
                    if (!args.fileId)
                        throw new Error('fileId required');
                    const res = await drive.files.export({ fileId: args.fileId, mimeType: 'text/plain' }, { responseType: 'text' });
                    return res.data;
                }
                case 'export_pdf': {
                    if (!args.fileId)
                        throw new Error('fileId required');
                    const res = await drive.files.export({ fileId: args.fileId, mimeType: 'application/pdf' }, { responseType: 'arraybuffer' });
                    return Buffer.from(res.data).toString('base64');
                }
                case 'export_docx': {
                    if (!args.fileId)
                        throw new Error('fileId required');
                    const res = await drive.files.export({ fileId: args.fileId, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' }, { responseType: 'arraybuffer' });
                    return Buffer.from(res.data).toString('base64');
                }
                case 'create_pdf': {
                    if (!args.name)
                        throw new Error('name required');
                    if (typeof args.content !== 'string')
                        throw new Error('content required');
                    const buffer = await createPdfBufferFromText(args.content);
                    const media = { mimeType: 'application/pdf', body: buffer };
                    const res = await drive.files.create({
                        requestBody: {
                            name: args.name,
                            parents: args.parentId ? [args.parentId] : undefined,
                        },
                        media,
                        fields: 'id, name, mimeType',
                    });
                    return res.data;
                }
                case 'upload': {
                    if (!args.localPath)
                        throw new Error('localPath required');
                    const resolved = assertWithinBase(args.localPath, baseDir);
                    const fileName = path.basename(resolved);
                    const fileMetadata = { name: fileName, parents: args.parentId ? [args.parentId] : undefined };
                    const media = { body: fs.createReadStream(resolved) };
                    const res = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id, name' });
                    return res.data;
                }
                case 'download_file': {
                    if (!args.fileId)
                        throw new Error('fileId required');
                    if (!args.localPath)
                        throw new Error('localPath required');
                    const resolved = assertWithinBase(args.localPath, baseDir);
                    const res = await drive.files.get({ fileId: args.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
                    const buffer = Buffer.from(res.data);
                    await fs.outputFile(resolved, buffer);
                    return { saved: resolved, bytes: buffer.length };
                }
                case 'extract_text': {
                    if (!args.fileId)
                        throw new Error('fileId required');
                    const meta = await drive.files.get({ fileId: args.fileId, fields: 'mimeType, name' });
                    const mimeType = meta.data.mimeType ?? '';
                    if (mimeType === 'application/vnd.google-apps.document') {
                        const res = await drive.files.export({ fileId: args.fileId, mimeType: 'text/plain' }, { responseType: 'text' });
                        return res.data;
                    }
                    if (mimeType === 'application/pdf') {
                        const res = await drive.files.get({ fileId: args.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
                        const buffer = Buffer.from(res.data);
                        return await extractPdfTextFromBuffer(buffer);
                    }
                    if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
                        const res = await drive.files.get({ fileId: args.fileId, alt: 'media' }, { responseType: 'arraybuffer' });
                        const buffer = Buffer.from(res.data);
                        return await extractDocxTextFromBuffer(buffer);
                    }
                    return `Unsupported mimeType for extract_text: ${mimeType}`;
                }
                case 'upload_convert': {
                    if (!args.localPath)
                        throw new Error('localPath required');
                    const resolved = assertWithinBase(args.localPath, baseDir);
                    const fileName = path.basename(resolved);
                    const fileMetadata = {
                        name: args.name ?? fileName,
                        parents: args.parentId ? [args.parentId] : undefined,
                        mimeType: 'application/vnd.google-apps.document',
                    };
                    const media = {
                        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
                        body: fs.createReadStream(resolved),
                    };
                    const res = await drive.files.create({ requestBody: fileMetadata, media, fields: 'id, name, mimeType' });
                    return res.data;
                }
                case 'create_doc': {
                    if (!args.name)
                        throw new Error('name required');
                    const res = await drive.files.create({
                        requestBody: {
                            name: args.name,
                            mimeType: 'application/vnd.google-apps.document',
                            parents: args.parentId ? [args.parentId] : undefined,
                        },
                        fields: 'id, name, mimeType',
                    });
                    return res.data;
                }
                case 'create_folder': {
                    if (!args.name)
                        throw new Error('name required');
                    const res = await drive.files.create({
                        requestBody: {
                            name: args.name,
                            mimeType: 'application/vnd.google-apps.folder',
                            parents: args.parentId ? [args.parentId] : undefined,
                        },
                        fields: 'id, name',
                    });
                    return res.data;
                }
                case 'delete_file': {
                    if (args.confirm !== true)
                        throw new Error('Set confirm=true to delete a file.');
                    if (!args.fileId)
                        throw new Error('fileId required');
                    await drive.files.delete({ fileId: args.fileId });
                    return { deleted: true, id: args.fileId };
                }
                default:
                    throw new Error('Unsupported action');
            }
        },
    };
}
