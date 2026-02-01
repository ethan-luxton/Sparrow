import fs from 'fs-extra';
import path from 'node:path';
import type { ToolDefinition } from '../../tools/registry.js';
import { getMarkdownConfig, type MarkdownConfig } from './config.js';

export type AgentDocName = 'BOOTSTRAP' | 'IDENTITY' | 'SOUL' | 'USER' | 'TOOLS' | 'AGENTS' | 'HEARTBEAT';

const AGENT_ORDER: AgentDocName[] = ['BOOTSTRAP', 'IDENTITY', 'SOUL', 'USER', 'TOOLS', 'AGENTS', 'HEARTBEAT'];

export interface InjectionInput {
  userText: string;
  tools: ToolDefinition[];
  recentTools?: string[];
  config?: MarkdownConfig;
}

export interface InjectionResult {
  text: string;
  includedTools: string[];
  missingFiles: string[];
}

function truncate(text: string, maxChars: number) {
  if (text.length <= maxChars) return { text, truncated: false };
  return { text: text.slice(0, Math.max(0, maxChars - 12)).trimEnd() + '\n(truncated)', truncated: true };
}

function loadFileOrMissing(filePath: string, label: string, maxChars: number) {
  if (!fs.existsSync(filePath)) {
    return { text: `[missing: ${label}]`, missing: true };
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const trimmed = raw.trim();
  if (!trimmed) return { text: `[missing: ${label}]`, missing: true };
  const { text } = truncate(trimmed, maxChars);
  return { text, missing: false };
}

function normalizeTokens(input: string) {
  return input
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((t) => t.length >= 4);
}

function isToolRelevant(userText: string, tool: ToolDefinition) {
  const text = userText.toLowerCase();
  const name = tool.name.replace(/_/g, ' ');
  if (text.includes(name)) return true;
  const tokens = new Set([...normalizeTokens(tool.name), ...normalizeTokens(tool.description)]);
  for (const token of tokens) {
    if (text.includes(token)) return true;
  }
  return false;
}

function resolveToolDocPath(toolsDir: string, toolName: string) {
  return path.join(toolsDir, `${toolName}.md`);
}

function buildToolRegistry(tools: ToolDefinition[]) {
  if (!tools.length) return '(no tools available)';
  return tools
    .slice()
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `- ${t.name}: ${t.description}`)
    .join('\n');
}

export function injectMarkdown(input: InjectionInput): InjectionResult {
  const cfg = input.config ?? getMarkdownConfig();
  const missing: string[] = [];
  const includedTools: string[] = [];
  const sections: string[] = [];
  let remaining = cfg.totalMaxChars;

  for (const doc of AGENT_ORDER) {
    if (remaining <= 0) break;
    const filePath = path.join(cfg.agentDir, `${doc}.md`);
    const loaded = loadFileOrMissing(filePath, `${doc}.md`, Math.min(cfg.perFileMaxChars, remaining));
    if (loaded.missing) missing.push(`${doc}.md`);
    const header = `--- ${doc}.md ---`;
    const body = `${header}\n${loaded.text}`.trimEnd();
    const { text } = truncate(body, remaining);
    sections.push(text);
    remaining -= text.length;
  }

  const registryHeader = '--- TOOL_REGISTRY ---';
  if (remaining > registryHeader.length + 10) {
    const registryText = `${registryHeader}\n${buildToolRegistry(input.tools)}`;
    const { text } = truncate(registryText, remaining);
    sections.push(text);
    remaining -= text.length;
  }

  const recent = (input.recentTools ?? []).slice(0, cfg.recentToolLimit);
  const relevant = input.tools.filter((t) => isToolRelevant(input.userText, t)).map((t) => t.name);
  const toolNames = Array.from(new Set([...recent, ...relevant])).sort();

  for (const toolName of toolNames) {
    if (remaining <= 0) break;
    const tool = input.tools.find((t) => t.name === toolName);
    if (!tool) continue;
    const toolPath = resolveToolDocPath(cfg.toolsDir, tool.name);
    const loaded = loadFileOrMissing(toolPath, `tools/mds/${tool.name}.md`, Math.min(cfg.toolDocsMaxChars, remaining));
    if (loaded.missing) missing.push(`tools/mds/${tool.name}.md`);
    const header = `--- TOOL: ${tool.name} ---`;
    const body = `${header}\n${loaded.text}`.trimEnd();
    const { text } = truncate(body, remaining);
    sections.push(text);
    remaining -= text.length;
    includedTools.push(tool.name);
  }

  return { text: sections.join('\n\n').trim(), includedTools, missingFiles: missing };
}

export function resolveToolMdPath(toolName: string, cfg: MarkdownConfig = getMarkdownConfig()) {
  return resolveToolDocPath(cfg.toolsDir, toolName);
}
