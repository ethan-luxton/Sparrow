import fs from 'fs-extra';
import { configPath, baseDir, dbPath, logsDir, sandboxDir } from './paths.js';
import { decryptText, encryptText, generateSalt } from '../lib/crypto.js';

export type SecretField =
  | 'openai.apiKey'
  | 'telegram.botToken'
  | 'google.clientSecret'
  | 'google.token'
  | 'n8n.apiKey'
  | 'n8n.basicUser'
  | 'n8n.basicPass';

export interface SparrowConfig {
  encryption: {
    salt: string;
    iterations?: number;
  };
  assistant?: {
    name?: string;
    age?: string;
    hobbies?: string;
    description?: string;
  };
  user?: {
    name?: string;
    role?: string;
    preferences?: string;
    timezone?: string;
  };
  openai?: {
    apiKeyEnc?: string;
    model?: string;
    searchModel?: string;
    baseUrl?: string;
  };
  telegram?: {
    botTokenEnc?: string;
  };
  google?: {
    clientId?: string;
    clientSecretEnc?: string;
    tokenEnc?: string;
    scopes?: string[];
    redirectUri?: string;
  };
  n8n?: {
    baseUrl?: string;
    apiKeyEnc?: string;
    basicUserEnc?: string;
    basicPassEnc?: string;
  };
  paths?: {
    dataDir?: string;
    dbPath?: string;
    allowlist?: string[];
    logsDir?: string;
  };
  bot?: {
    maxHistory?: number;
    checkinIntervalHours?: number;
    checkinMessage?: string;
    heartbeatIntervalHours?: number;
    heartbeatMaxTokens?: number;
  };
}

const defaultConfig: SparrowConfig = {
  encryption: {
    salt: generateSalt(),
  },
  assistant: {
    name: 'Sparrow',
  },
  user: {},
  openai: {
    model: 'gpt-5-mini',
    searchModel: 'gpt-5-mini',
  },
  google: {
    scopes: [
      'https://www.googleapis.com/auth/drive.file',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.modify',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/calendar.readonly',
      'https://www.googleapis.com/auth/calendar.events',
    ],
    redirectUri: 'urn:ietf:wg:oauth:2.0:oob',
  },
  paths: {
    dataDir: baseDir,
    dbPath,
    allowlist: [sandboxDir],
    logsDir,
  },
  bot: {
    maxHistory: 12,
    checkinIntervalHours: 24,
    checkinMessage: 'How are things going? Share any updates or tasks I should remember.',
    heartbeatIntervalHours: 3,
    heartbeatMaxTokens: 180,
  },
};

function ensureDirs() {
  fs.ensureDirSync(baseDir);
  fs.ensureDirSync(logsDir);
  fs.ensureDirSync(sandboxDir);
}

export function loadConfig(): SparrowConfig {
  ensureDirs();
  if (!fs.existsSync(configPath)) {
    fs.writeJSONSync(configPath, defaultConfig, { spaces: 2 });
    return { ...defaultConfig };
  }
  const existing = fs.readJSONSync(configPath) as SparrowConfig;

  // Normalize legacy model names: force everything to gpt-5-mini
  const normalizeModel = (model?: string) => {
    if (!model) return undefined;
    if (model.includes('gpt-4')) return 'gpt-5-mini';
    return model;
  };
  if (existing.openai) {
    existing.openai.model = normalizeModel(existing.openai.model);
    existing.openai.searchModel = normalizeModel(existing.openai.searchModel);
  }
  if (process.env.OPENAI_BASE_URL) {
    existing.openai = { ...(existing.openai ?? {}), baseUrl: process.env.OPENAI_BASE_URL };
  }
  // inject env overrides for clientId if provided
  if (process.env.GOOGLE_CLIENT_ID) {
    existing.google = { ...(existing.google ?? {}), clientId: process.env.GOOGLE_CLIENT_ID };
  }
  if (process.env.N8N_BASE_URL) {
    existing.n8n = { ...(existing.n8n ?? {}), baseUrl: process.env.N8N_BASE_URL };
  }
  // merge defaults without overriding existing
  return {
    ...defaultConfig,
    ...existing,
    encryption: { ...defaultConfig.encryption, ...(existing.encryption ?? {}) },
    assistant: { ...defaultConfig.assistant, ...(existing.assistant ?? {}) },
    user: { ...defaultConfig.user, ...(existing.user ?? {}) },
    openai: { ...defaultConfig.openai, ...(existing.openai ?? {}) },
    telegram: { ...(existing.telegram ?? {}) },
    google: { ...defaultConfig.google, ...(existing.google ?? {}) },
    paths: { ...defaultConfig.paths, ...(existing.paths ?? {}) },
    bot: { ...defaultConfig.bot, ...(existing.bot ?? {}) },
  };
}

export function saveConfig(cfg: SparrowConfig) {
  ensureDirs();
  fs.writeJSONSync(configPath, cfg, { spaces: 2 });
}

export function requireSecret(): string {
  const secret = process.env.SPARROW_SECRET;
  if (!secret) throw new Error('SPARROW_SECRET environment variable is required to encrypt/decrypt secrets.');
  return secret;
}

function resolveCtx(cfg: SparrowConfig) {
  return { salt: cfg.encryption.salt, iterations: cfg.encryption.iterations };
}

function envFallback(field: SecretField): string | undefined {
  switch (field) {
    case 'openai.apiKey':
      return process.env.OPENAI_API_KEY;
    case 'telegram.botToken':
      return process.env.TELEGRAM_BOT_TOKEN;
    case 'google.clientSecret':
      return process.env.GOOGLE_CLIENT_SECRET;
    case 'google.token':
      return process.env.GOOGLE_TOKEN;
    case 'n8n.apiKey':
      return process.env.N8N_API_KEY;
    case 'n8n.basicUser':
      return process.env.N8N_BASIC_USER;
    case 'n8n.basicPass':
      return process.env.N8N_BASIC_PASS;
    // n8n uses baseUrl in plain config; api key can come from env
    default:
      return undefined;
  }
}

export function setSecret(cfg: SparrowConfig, field: SecretField, value: string): SparrowConfig {
  const secret = requireSecret();
  const ctx = resolveCtx(cfg);
  const enc = encryptText(value, secret, ctx);
  const clone: SparrowConfig = { ...cfg };
  const [group, key] = field.split('.') as [keyof SparrowConfig, string];
  clone[group] = { ...(clone[group] as Record<string, unknown>), [`${key}Enc`]: enc } as any;
  return clone;
}

export function getSecret(cfg: SparrowConfig, field: SecretField): string {
  const env = envFallback(field);
  if (env) return env;
  // allow .env OPENAI_SEARCH_MODEL override for search model
  if (field === 'openai.apiKey' && process.env.OPENAI_SEARCH_MODEL && !cfg.openai?.searchModel) {
    cfg.openai = { ...(cfg.openai ?? {}), searchModel: process.env.OPENAI_SEARCH_MODEL };
  }
  const secret = requireSecret();
  const ctx = resolveCtx(cfg);
  const [group, key] = field.split('.') as [keyof SparrowConfig, string];
  const groupObj = cfg[group] as Record<string, unknown> | undefined;
  const enc = groupObj?.[`${key}Enc`];
  if (!enc || typeof enc !== 'string') throw new Error(`Secret ${field} not configured`);
  return decryptText(enc, secret, ctx);
}

export function redacted(cfg: SparrowConfig) {
  const clone = JSON.parse(JSON.stringify(cfg)) as SparrowConfig;
  if (clone.openai?.apiKeyEnc) clone.openai.apiKeyEnc = '***';
  if (clone.telegram?.botTokenEnc) clone.telegram.botTokenEnc = '***';
  if (clone.google?.clientSecretEnc) clone.google.clientSecretEnc = '***';
  if (clone.google?.tokenEnc) clone.google.tokenEnc = '***';
  return clone;
}
