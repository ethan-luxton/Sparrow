import path from 'node:path';

export interface MarkdownConfig {
  agentDir: string;
  toolsDir: string;
  perFileMaxChars: number;
  totalMaxChars: number;
  toolDocsMaxChars: number;
  recentToolLimit: number;
}

function numberFromEnv(value: string | undefined, fallback: number) {
  if (!value) return fallback;
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

export function getMarkdownConfig(): MarkdownConfig {
  return {
    agentDir: process.env.SPARROW_AGENT_MDS_DIR ?? path.resolve(process.cwd(), 'src', 'agent', 'mds'),
    toolsDir: process.env.SPARROW_TOOL_MDS_DIR ?? path.resolve(process.cwd(), 'src', 'tools', 'mds'),
    perFileMaxChars: numberFromEnv(process.env.SPARROW_MD_PER_FILE_MAX_CHARS, 4000),
    totalMaxChars: numberFromEnv(process.env.SPARROW_MD_TOTAL_MAX_CHARS, 14000),
    toolDocsMaxChars: numberFromEnv(process.env.SPARROW_MD_TOOL_MAX_CHARS, 3000),
    recentToolLimit: numberFromEnv(process.env.SPARROW_MD_RECENT_TOOL_LIMIT, 4),
  };
}
