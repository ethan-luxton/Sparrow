import { ToolRegistry } from './registry.js';
import { systemInfoTool } from './system.js';
import { filesystemTool } from './filesystem.js';
import { googleDriveTool } from './drive.js';
import { gmailTool } from './gmail.js';
import { notesTool } from './notes.js';
import { calendarTool } from './calendar.js';
import { n8nTool } from './n8n.js';
import { weatherTool } from './weather.js';
import type { SparrowConfig } from '../config/config.js';
import { cliTool } from './cli.js';

export function buildToolRegistry(cfg?: SparrowConfig) {
  const registry = new ToolRegistry();
  registry.register(systemInfoTool());
  registry.register(filesystemTool());
  registry.register(googleDriveTool());
  registry.register(gmailTool());
  registry.register(notesTool());
  registry.register(cliTool());
  registry.register(calendarTool());
  registry.register(n8nTool());
  registry.register(weatherTool());
  return registry;
}

export type { ToolRegistry };
