#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import prompts from 'prompts';
import fs from 'fs-extra';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { loadConfig, saveConfig, setSecret, getSecret, redacted, requireSecret } from './config/config.js';
import { startTelegramBot } from './telegram.js';
import { runGoogleAuth } from './google/auth.js';
import { buildToolRegistry } from './tools/index.js';
import { logsDir } from './config/paths.js';
import { logger } from './lib/logger.js';
import { addMessage, clearChat } from './lib/db.js';
import { OpenAIClient } from './lib/openaiClient.js';

const program = new Command();
program.name('sparrow').description('Local-only AI agent');

function logAction(action: string, details?: Record<string, unknown>) {
  logger.info(`${action}${details ? ' ' + JSON.stringify(details) : ''}`);
}

program
  .command('init')
  .description('Interactive setup for Sparrow')
  .action(async () => {
    logAction('cli.init.start');
    const cfg = loadConfig();
    requireSecret();
    const answers = await prompts([
      { type: cfg.openai?.apiKeyEnc ? null : 'password', name: 'openai', message: 'OpenAI API key' },
      { type: cfg.telegram?.botTokenEnc ? null : 'password', name: 'telegram', message: 'Telegram bot token' },
      { type: 'text', name: 'userName', message: 'Your name (optional)', initial: cfg.user?.name ?? '' },
      { type: 'text', name: 'userRole', message: 'Your role / job (optional)', initial: cfg.user?.role ?? '' },
      { type: 'text', name: 'userPreferences', message: 'Your preferences (tone, brevity, format)', initial: cfg.user?.preferences ?? '' },
      { type: 'text', name: 'userTimezone', message: 'Your timezone (optional)', initial: cfg.user?.timezone ?? 'America/Los_Angeles' },
      {
        type: 'text',
        name: 'assistantDescription',
        message: 'Assistant personality/description (optional)',
        initial: cfg.assistant?.description ?? '',
      },
    ]);

    let updated = { ...cfg };
    if (answers.openai) updated = setSecret(updated, 'openai.apiKey', answers.openai);
    if (answers.telegram) updated = setSecret(updated, 'telegram.botToken', answers.telegram);
    updated.user = {
      ...(updated.user ?? {}),
      ...(answers.userName ? { name: String(answers.userName).trim() } : {}),
      ...(answers.userRole ? { role: String(answers.userRole).trim() } : {}),
      ...(answers.userPreferences ? { preferences: String(answers.userPreferences).trim() } : {}),
      ...(answers.userTimezone ? { timezone: String(answers.userTimezone).trim() } : {}),
    };
    updated.assistant = {
      ...(updated.assistant ?? {}),
      ...(answers.assistantDescription ? { description: String(answers.assistantDescription).trim() } : {}),
    };
    saveConfig(updated);
    logAction('cli.init.saved');
    console.log('Config saved to ~/.sparrow/config.json');
  });

program
  .command('run')
  .description('Start Telegram bot (long polling)')
  .action(() => {
    logAction('cli.run.start');
    startTelegramBot();
  });

program
  .command('chat [message]')
  .description('Chat with Sparrow via the CLI (interactive if no message).')
  .option('-i, --chat-id <id>', 'Chat id to use (default: -1)')
  .action(async (message, options) => {
    const chatId = Number.isFinite(Number(options.chatId)) ? Number(options.chatId) : -1;
    const mode = message ? 'once' : 'repl';
    logAction('cli.chat.start', { mode, chatId });

    const cfg = loadConfig();
    const openai = new OpenAIClient(cfg);
    const tools = buildToolRegistry();

    const send = async (text: string) => {
      try {
        addMessage(chatId, 'user', text);
        const reply = await openai.chat(chatId, text, tools);
        console.log(reply);
        return reply;
      } catch (err) {
        const msg = (err as Error).message;
        logger.error(`cli.chat.error chatId=${chatId} err=${msg}`);
        console.error(`Error: ${msg}`);
        return '';
      }
    };

    if (message) {
      await send(String(message));
      return;
    }

    const rl = readline.createInterface({ input, output });
    console.log('Sparrow CLI chat. Type /exit to quit, /reset to clear history.');
    while (true) {
      const line = (await rl.question('> ')).trim();
      if (!line) continue;
      if (line === '/exit' || line === '/quit') break;
      if (line === '/reset') {
        clearChat(chatId);
        console.log('Conversation reset.');
        continue;
      }
      await send(line);
    }
    rl.close();
  });

program
  .command('profile')
  .description('Manage user profile')
  .command('set')
  .description('Set user profile (name, role, preferences, timezone)')
  .action(async () => {
    logAction('cli.profile.set.start');
    const cfg = loadConfig();
    const answers = await prompts([
      { type: 'text', name: 'userName', message: 'Your name (optional)', initial: cfg.user?.name ?? '' },
      { type: 'text', name: 'userRole', message: 'Your role / job (optional)', initial: cfg.user?.role ?? '' },
      { type: 'text', name: 'userPreferences', message: 'Your preferences (tone, brevity, format)', initial: cfg.user?.preferences ?? '' },
      { type: 'text', name: 'userTimezone', message: 'Your timezone (optional)', initial: cfg.user?.timezone ?? 'America/Los_Angeles' },
    ]);

    const updated = { ...cfg };
    updated.user = {
      ...(updated.user ?? {}),
      ...(answers.userName ? { name: String(answers.userName).trim() } : {}),
      ...(answers.userRole ? { role: String(answers.userRole).trim() } : {}),
      ...(answers.userPreferences ? { preferences: String(answers.userPreferences).trim() } : {}),
      ...(answers.userTimezone ? { timezone: String(answers.userTimezone).trim() } : {}),
    };
    saveConfig(updated);
    logAction('cli.profile.set.saved');
    console.log('User profile saved.');
  });

const configCmd = program.command('config').description('Manage configuration');
configCmd
  .command('list')
  .description('Show redacted config')
  .action(() => {
    logAction('cli.config.list');
    console.log(JSON.stringify(redacted(loadConfig()), null, 2));
  });
configCmd
  .command('get <path>')
  .description('Get a config value (supports openai.apiKey, telegram.botToken)')
  .action((pathKey) => {
    logAction('cli.config.get', { path: pathKey });
    const cfg = loadConfig();
    try {
      if (pathKey === 'openai.apiKey' || pathKey === 'telegram.botToken') {
        console.log(getSecret(cfg, pathKey as any));
        return;
      }
      const value = pathKey.split('.').reduce((acc: any, k: string) => acc?.[k], cfg as any);
      console.log(JSON.stringify(value, null, 2));
    } catch (err) {
      logger.error(`cli.config.get failed path=${pathKey} err=${(err as Error).message}`);
      console.error((err as Error).message);
    }
  });
configCmd
  .command('set <path> [value]')
  .description('Set a config value; secrets are encrypted automatically')
  .action(async (pathKey, value) => {
    logAction('cli.config.set.start', { path: pathKey, hasValue: Boolean(value) });
    let cfg = loadConfig();
    if (!value) {
      const res = await prompts({ type: 'text', name: 'v', message: 'Value' });
      value = res.v;
    }
    if (!value) throw new Error('Value required');
    if (
      pathKey === 'openai.apiKey' ||
      pathKey === 'telegram.botToken' ||
      pathKey === 'google.clientSecret' ||
      pathKey === 'google.token' ||
      pathKey === 'n8n.apiKey'
    ) {
      cfg = setSecret(cfg, pathKey as any, value);
    } else if (pathKey === 'google.clientId') {
      cfg = { ...cfg, google: { ...cfg.google, clientId: value } };
    } else {
      const segments = pathKey.split('.');
      let target: any = cfg;
      for (let i = 0; i < segments.length - 1; i++) {
        target[segments[i]] = target[segments[i]] ?? {};
        target = target[segments[i]];
      }
      target[segments.at(-1)!] = value;
    }
    saveConfig(cfg);
    logAction('cli.config.set.saved', { path: pathKey });
    console.log('Saved.');
  });

program
  .command('google-auth')
  .description('Run Google OAuth installed-app flow (prompts for client ID/secret if not set)')
  .action(async () => {
    logAction('cli.google_auth.start');
    let cfg = loadConfig();
    // Ensure creds exist; prompt if missing and not provided via env
    if (!cfg.google?.clientId && !process.env.GOOGLE_CLIENT_ID) {
      const { clientId } = await prompts({ type: 'text', name: 'clientId', message: 'Google OAuth Client ID' });
      if (!clientId) {
        logger.warn('cli.google_auth.missing_client_id');
        console.error('Client ID is required.');
        return;
      }
      cfg = { ...cfg, google: { ...(cfg.google ?? {}), clientId } };
      saveConfig(cfg);
    }
    if (!cfg.google?.clientSecretEnc && !process.env.GOOGLE_CLIENT_SECRET) {
      const { clientSecret } = await prompts({ type: 'password', name: 'clientSecret', message: 'Google OAuth Client Secret' });
      if (!clientSecret) {
        logger.warn('cli.google_auth.missing_client_secret');
        console.error('Client secret is required.');
        return;
      }
      cfg = setSecret(cfg, 'google.clientSecret', clientSecret);
      saveConfig(cfg);
    }
    await runGoogleAuth(cfg);
    logAction('cli.google_auth.done');
  });

// legacy grouped helpers (optional)
const googleCmd = program.command('google').description('Google OAuth helpers');
googleCmd
  .command('set-creds')
  .description('Set Google OAuth client ID/secret (secret stored encrypted unless provided via env)')
  .action(async () => {
    logAction('cli.google.set_creds.start');
    let cfg = loadConfig();
    const answers = await prompts([
      { type: 'text', name: 'clientId', message: 'Google OAuth Client ID', initial: cfg.google?.clientId },
      { type: 'password', name: 'clientSecret', message: 'Google OAuth Client Secret' },
    ]);
    if (!answers.clientId || !answers.clientSecret) {
      logger.warn('cli.google.set_creds.missing');
      console.error('Client ID and secret are required.');
      return;
    }
    cfg = { ...cfg, google: { ...(cfg.google ?? {}), clientId: answers.clientId } };
    cfg = setSecret(cfg, 'google.clientSecret', answers.clientSecret);
    saveConfig(cfg);
    logAction('cli.google.set_creds.saved');
    console.log('Google client ID/secret saved.');
  });

program
  .command('tools list')
  .description('List available tools and permissions')
  .action(() => {
    const registry = buildToolRegistry();
    logAction('cli.tools.list', { count: registry.list().length });
    registry.list().forEach((t) => {
      console.log(`${t.name} [${t.permission}] - ${t.description}`);
    });
  });

program
  .command('logs tail')
  .description('Tail latest log file')
  .action(() => {
    const files = fs
      .readdirSync(logsDir)
      .filter((f: string) => f.endsWith('.log'))
      .map((f: string) => path.join(logsDir, f))
      .sort();
    if (files.length === 0) {
      logAction('cli.logs.tail.empty');
      return console.log('No logs yet.');
    }
    const latest = files[files.length - 1];
    logAction('cli.logs.tail', { file: path.basename(latest) });
    const content = fs.readFileSync(latest, 'utf8');
    const lines = content.trim().split('\n');
    console.log(lines.slice(-100).join('\n'));
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(`cli.unhandled ${err.message}`);
  console.error(err);
  process.exit(1);
});
