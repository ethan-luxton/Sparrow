import { buildToolRegistry } from '../tools/index.js';
import { loadConfig } from '../config/config.js';

export async function runWorkspaceExample() {
  const cfg = loadConfig();
  const tools = buildToolRegistry(cfg);

  await tools.run('workspace', { action: 'ensure_workspace' }, 0);
  await tools.run('workspace', { action: 'ensure_project', project: 'sparrow-telegram' }, 0);
  await tools.run('git', { action: 'init', project: 'sparrow-telegram' }, 0);
  await tools.run(
    'workspace',
    {
      action: 'write_file',
      project: 'sparrow-telegram',
      path: 'README.md',
      content: '# sparrow-telegram\n\nInitial scaffold.',
    },
    0
  );
  await tools.run('git', { action: 'status', project: 'sparrow-telegram' }, 0);
  await tools.run('git', { action: 'add', project: 'sparrow-telegram', paths: ['README.md'] }, 0);
  // commit requires confirm=true and user approval
}
