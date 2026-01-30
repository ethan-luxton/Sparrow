import { ToolRegistry } from './registry.js';
import { systemInfoTool } from './system.js';
import { filesystemTool } from './filesystem.js';
import { googleDriveTool } from './drive.js';
import { gmailTool } from './gmail.js';
import { notesTool } from './notes.js';
import { webSearchTool } from './webSearch.js';
import { calendarTool } from './calendar.js';
import { n8nTool } from './n8n.js';
import { weatherTool } from './weather.js';

export function buildToolRegistry() {
  const registry = new ToolRegistry();
  registry.register(systemInfoTool());
  registry.register(filesystemTool());
  registry.register(googleDriveTool());
  registry.register(gmailTool());
  registry.register(notesTool());
  registry.register(webSearchTool());
  registry.register(calendarTool());
  registry.register(n8nTool());
  registry.register(weatherTool());
  return registry;
}

export type { ToolRegistry };
