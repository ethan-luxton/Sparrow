const SECRET_VALUE_PATTERNS: RegExp[] = [
  /sk-[a-z0-9]{16,}/gi, // OpenAI-style
  /\b(?:ghp|gho|ghu|ghs|ghr)_[0-9A-Za-z]{36,}\b/g, // GitHub tokens
  /\bgithub_pat_[0-9A-Za-z_]{22,}\b/g,
  /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/g, // Slack tokens
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key
  /\bASIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z\-_]{35}\b/g, // Google API key
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /\bBearer\s+[A-Za-z0-9\-_\.=]+\b/gi,
];

const SECRET_ASSIGNMENT_RE = /(\b(?:API_KEY|OPENAI_API_KEY|OPENAI_KEY|SECRET|TOKEN|PASSWORD)\b\s*[=:]\s*)([^\s'"]+)/gi;

const SENSITIVE_PATH_RE =
  /(^|[\/\\])(\.env(\.|$)|\.ssh[\/\\]|id_rsa|id_ed25519|credentials\.json|token\.json|\.npmrc|\.netrc|\.git-credentials|\.aws[\/\\]credentials|\.p12$|\.pfx$|\.pem$|\.key$|\.kdbx$)/i;

const SENSITIVE_QUERY_RE =
  /\b(api[_ -]?key|openai[_ -]?key|openai api key|sk-[a-z0-9]{8,}|secret|password|private key|token)\b/i;

export function isSensitiveQuery(text: string): boolean {
  return SENSITIVE_QUERY_RE.test(text);
}

export function isSensitivePath(path: string): boolean {
  return SENSITIVE_PATH_RE.test(path);
}

export function redactSensitiveText(text: string): string {
  let out = text;
  out = out.replace(SECRET_ASSIGNMENT_RE, '$1***');
  for (const re of SECRET_VALUE_PATTERNS) {
    out = out.replace(re, '[REDACTED]');
  }
  out = out.replace(/[^ \n\t]*\.env[^ \n\t]*/gi, '[REDACTED_ENV_PATH]');
  out = out.replace(
    /[^ \n\t]*(?:\.ssh[\/\\][^ \n\t]*|id_rsa|id_ed25519|credentials\.json|token\.json|\.npmrc|\.netrc|\.git-credentials)[^ \n\t]*/gi,
    '[REDACTED_PATH]'
  );
  return out;
}

export function redactSensitiveObject(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((v) => redactSensitiveObject(v));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = redactSensitiveObject(v);
    }
    return out;
  }
  return value;
}

export function hasSensitiveIndicators(value: unknown): boolean {
  if (typeof value === 'string') {
    return isSensitiveQuery(value) || isSensitivePath(value);
  }
  if (Array.isArray(value)) return value.some((v) => hasSensitiveIndicators(v));
  if (value && typeof value === 'object') {
    return Object.values(value as Record<string, unknown>).some((v) => hasSensitiveIndicators(v));
  }
  return false;
}
