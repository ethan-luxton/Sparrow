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
import { addMessage, clearChat, getDbHandle } from './lib/db.js';
import { OpenAIClient } from './lib/openaiClient.js';
import { verifyAllChains, verifyChain } from './memory-ledger/verifier.js';
import { MemoryRetriever } from './memory-ledger/retriever.js';
import { migrateMessagesToLedger } from './memory-ledger/migrate.js';
import { startDashboard } from './dashboard/server.js';

const program = new Command();
program.name('pt').description('Local-only AI agent');

function logAction(action: string, details?: Record<string, unknown>) {
  logger.info(`${action}${details ? ' ' + JSON.stringify(details) : ''}`);
}

program
  .command('init')
  .description('Interactive setup for PixelTrail AI')
  .action(async () => {
    logAction('cli.init.start');
    const cfg = loadConfig();
    requireSecret();
    const answers = await prompts([
      {
        type: 'select',
        name: 'provider',
        message: 'AI provider',
        choices: [
          { title: 'OpenAI', value: 'openai' },
          { title: 'Anthropic', value: 'anthropic' },
        ],
        initial: cfg.aiProvider === 'anthropic' ? 1 : 0,
      },
      {
        type: (prev, values) => (values.provider === 'openai' && !cfg.openai?.apiKeyEnc ? 'password' : null),
        name: 'openai',
        message: 'OpenAI API key',
      },
      {
        type: (prev, values) => (values.provider === 'anthropic' && !cfg.anthropic?.apiKeyEnc ? 'password' : null),
        name: 'anthropic',
        message: 'Anthropic API key',
      },
      {
        type: (prev, values) => (values.provider === 'anthropic' ? 'text' : null),
        name: 'anthropicModel',
        message: 'Anthropic model',
        initial: cfg.anthropic?.model ?? 'claude-3-7-sonnet-latest',
      },
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
    if (answers.provider) updated.aiProvider = answers.provider;
    if (answers.openai) updated = setSecret(updated, 'openai.apiKey', answers.openai);
    if (answers.anthropic) updated = setSecret(updated, 'anthropic.apiKey', answers.anthropic);
    if (answers.anthropicModel) {
      updated.anthropic = { ...(updated.anthropic ?? {}), model: String(answers.anthropicModel).trim() };
    }
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
    console.log('Config saved to ~/.pixeltrail/config.json');
  });

program
  .command('run')
  .description('Start Telegram bot (long polling)')
  .option('--debug-io', 'Log detailed input/output and tool usage')
  .action((options) => {
    logAction('cli.run.start');
    if (options?.debugIo) {
      process.env.PIXELTRAIL_DEBUG_IO = '1';
      logger.info('cli.run.debug_io enabled');
    }
    startTelegramBot({ debugIO: Boolean(options?.debugIo) });
  });

program
  .command('ai-provider')
  .description('Select the AI provider (openai or anthropic)')
  .option('-p, --provider <name>', 'Provider name: openai|anthropic')
  .action(async (options) => {
    logAction('cli.ai_provider.start');
    let cfg = loadConfig();
    requireSecret();
    const provider =
      options.provider ||
      (
        await prompts({
          type: 'select',
          name: 'provider',
          message: 'Select AI provider',
          choices: [
            { title: 'OpenAI', value: 'openai' },
            { title: 'Anthropic', value: 'anthropic' },
          ],
          initial: cfg.aiProvider === 'anthropic' ? 1 : 0,
        })
      ).provider;
    if (!provider) return;
    if (provider === 'openai' && !cfg.openai?.apiKeyEnc && !process.env.OPENAI_API_KEY) {
      const { openai } = await prompts({ type: 'password', name: 'openai', message: 'OpenAI API key' });
      if (openai) cfg = setSecret(cfg, 'openai.apiKey', openai);
    }
    if (provider === 'anthropic' && !cfg.anthropic?.apiKeyEnc && !process.env.ANTHROPIC_API_KEY) {
      const { anthropic } = await prompts({ type: 'password', name: 'anthropic', message: 'Anthropic API key' });
      if (anthropic) cfg = setSecret(cfg, 'anthropic.apiKey', anthropic);
    }
    if (provider === 'anthropic') {
      const { model } = await prompts({
        type: 'text',
        name: 'model',
        message: 'Anthropic model (optional)',
        initial: cfg.anthropic?.model ?? 'claude-3-7-sonnet-latest',
      });
      if (model) cfg = { ...cfg, anthropic: { ...(cfg.anthropic ?? {}), model: String(model).trim() } };
    }
    cfg.aiProvider = provider;
    saveConfig(cfg);
    logAction('cli.ai_provider.saved', { provider });
    console.log(`AI provider set to ${provider}.`);
  });

program
  .command('chat [message]')
  .description('Chat with PixelTrail AI via the CLI (interactive if no message).')
  .option('-i, --chat-id <id>', 'Chat id to use (default: -1)')
  .action(async (message, options) => {
    const chatId = Number.isFinite(Number(options.chatId)) ? Number(options.chatId) : -1;
    const mode = message ? 'once' : 'repl';
    logAction('cli.chat.start', { mode, chatId });

    const cfg = loadConfig();
    const openai = new OpenAIClient(cfg);
    const tools = buildToolRegistry(cfg);

    const send = async (text: string) => {
      try {
        addMessage(chatId, 'user', text);
        const result = await openai.chat(chatId, text, tools);
        console.log(result.reply);
        return result.reply;
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
    console.log('PixelTrail AI CLI chat. Type /exit to quit, /reset to clear history.');
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
      if (pathKey === 'openai.apiKey' || pathKey === 'anthropic.apiKey' || pathKey === 'telegram.botToken') {
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
      pathKey === 'anthropic.apiKey' ||
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
    const registry = buildToolRegistry(loadConfig());
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

program
  .command('dashboard')
  .description('Start local PixelTrail AI monitoring dashboard')
  .option('--host <host>', 'Host to bind (use 0.0.0.0 for LAN)', '0.0.0.0')
  .option('--port <port>', 'Port to listen on', '5527')
  .action((options) => {
    const port = Number(options.port);
    if (!Number.isFinite(port) || port <= 0) {
      throw new Error('Invalid port.');
    }
    startDashboard({ host: options.host, port });
  });

const memoryCmd = program.command('memory').description('Ledger memory utilities');
memoryCmd
  .command('verify')
  .option('-c, --chain <id>', 'Specific chain id to verify')
  .action((options) => {
    const db = getDbHandle();
    if (options.chain) {
      const result = verifyChain(db, options.chain);
      console.log(JSON.stringify(result, null, 2));
      return;
    }
    const result = verifyAllChains(db);
    console.log(JSON.stringify(result, null, 2));
  });
memoryCmd
  .command('inspect')
  .requiredOption('-b, --block <id>', 'Block id')
  .action((options) => {
    const db = getDbHandle();
    const retriever = new MemoryRetriever(db);
    const block = retriever.getBlockById(options.block);
    if (!block) {
      console.log('Block not found.');
      return;
    }
    console.log(JSON.stringify(block, null, 2));
  });
memoryCmd
  .command('export')
  .requiredOption('-c, --chain <id>', 'Chain id')
  .action((options) => {
    const db = getDbHandle();
    const retriever = new MemoryRetriever(db);
    const blocks = retriever.getRecentBlocks(options.chain, 10_000);
    console.log(JSON.stringify({ chainId: options.chain, blocks }, null, 2));
  });
memoryCmd
  .command('replay')
  .requiredOption('-c, --chain <id>', 'Chain id')
  .option('-l, --limit <n>', 'Limit messages', '200')
  .action((options) => {
    const db = getDbHandle();
    const retriever = new MemoryRetriever(db);
    const blocks = retriever.getRecentBlocks(options.chain, Number(options.limit));
    blocks.forEach((b) => {
      console.log(`[${b.height} ${b.role}] ${b.content}`);
    });
  });
memoryCmd
  .command('migrate')
  .description('Migrate legacy messages to ledger blocks')
  .action(() => {
    const db = getDbHandle();
    const result = migrateMessagesToLedger(db);
    console.log(JSON.stringify(result, null, 2));
  });

program.parseAsync(process.argv).catch((err) => {
  logger.error(`cli.unhandled ${err.message}`);
  console.error(err);
  process.exit(1);
});
