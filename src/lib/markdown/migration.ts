import fs from 'fs-extra';
import path from 'node:path';
import { logger } from '../logger.js';
import { getMarkdownConfig } from './config.js';

const DEFAULT_AGENT_DOCS: Record<string, string> = {
  BOOTSTRAP: `# BOOTSTRAP
You are Sparrow running locally on the user's machine. Assume you have tool access when listed. Keep responses concise and actionable. Use tools before asking the user when safe.`,
  IDENTITY: `# IDENTITY
Name: Sparrow
Role: autonomous local operator and assistant
Voice: confident, calm, helpful, non-corporate
Intro: brief, friendly, no boilerplate unless asked`,
  SOUL: `# SOUL
- Be resourceful and proactive: try safe reads and tool lookups before asking.
- Avoid unnecessary permission prompts for allowed actions.
- Keep a single consistent voice and identity.
- Be candid about constraints and failures; propose next steps.`,
  USER: `# USER
Address the user by name if known. Keep tone warm and concise. Ask at most one clarifying question only when required.`,
  TOOLS: `# TOOLS
- Use tools when they reduce uncertainty.
- Respect tool permissions and redaction rules.
- For write-capable actions explicitly requested by the user, set confirm=true and proceed unless details are missing.
- Never search for or reveal secrets or their locations.`,
  AGENTS: `# AGENTS
No sub-agents by default. If delegated work is added, keep it lightweight and report results back.`,
  HEARTBEAT: `# HEARTBEAT
(optional)`,
};

const LEGACY_FILES = [
  { label: 'personality.md', paths: ['src/guides/personality.md', 'personality.md'], target: 'SOUL' },
  { label: 'CLI.md', paths: ['src/guides/CLI.md', 'CLI.md'], target: 'TOOLS' },
  { label: 'heartbeat.md', paths: ['src/guides/heartbeat.md', 'heartbeat.md', 'HEARTBEAT.md'], target: 'HEARTBEAT' },
];

let migratedOnce = false;

function findFirstExisting(paths: string[]) {
  for (const p of paths) {
    const full = path.resolve(process.cwd(), p);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

export function migrateWorkspaceDocs() {
  if (migratedOnce) return;
  const cfg = getMarkdownConfig();
  const agentDir = cfg.agentDir;
  fs.ensureDirSync(agentDir);

  const marker = path.join(agentDir, '.migrated');
  if (fs.existsSync(marker)) {
    migratedOnce = true;
    return;
  }

  const created: string[] = [];
  const copied: string[] = [];

  for (const [name, defaultText] of Object.entries(DEFAULT_AGENT_DOCS)) {
    const filePath = path.join(agentDir, `${name}.md`);
    if (!fs.existsSync(filePath)) {
      fs.writeFileSync(filePath, defaultText + '\n');
      created.push(`${name}.md`);
    }
  }

  for (const legacy of LEGACY_FILES) {
    const src = findFirstExisting(legacy.paths);
    if (!src) continue;
    const targetPath = path.join(agentDir, `${legacy.target}.md`);
    const existing = fs.readFileSync(targetPath, 'utf8');
    const legacyText = fs.readFileSync(src, 'utf8').trim();
    if (legacyText && !existing.includes(legacyText)) {
      const merged = `${existing.trim()}\n\n## Migrated from ${legacy.label}\n${legacyText}\n`;
      fs.writeFileSync(targetPath, merged);
      copied.push(`${legacy.label} -> ${legacy.target}.md`);
    }
  }

  fs.writeFileSync(marker, new Date().toISOString() + '\n');
  if (created.length || copied.length) {
    logger.info(`workspace.migrate created=${created.join(',') || 'none'} copied=${copied.join(',') || 'none'}`);
  }
  migratedOnce = true;
}
