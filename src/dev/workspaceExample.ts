import { buildToolRegistry } from '../tools/index.js';
import { loadConfig } from '../config/config.js';

export async function runWorkspaceExample() {
  const cfg = loadConfig();
  const tools = buildToolRegistry(cfg);

  await tools.run('workspace', { action: 'ensure_workspace' }, 0);
  await tools.run('workspace', { action: 'ensure_project', project: 'pixeltrail-telegram' }, 0);
  await tools.run('git', { action: 'init', project: 'pixeltrail-telegram' }, 0);
  await tools.run(
    'workspace',
    {
      action: 'write_file',
      project: 'pixeltrail-telegram',
      path: 'README.md',
      content: '# pixeltrail-telegram\n\nInitial scaffold.',
    },
    0
  );
  await tools.run('git', { action: 'status', project: 'pixeltrail-telegram' }, 0);
  await tools.run('git', { action: 'add', project: 'pixeltrail-telegram', paths: ['README.md'] }, 0);
  // commit requires confirm=true and user approval
}
