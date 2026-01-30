import path from 'node:path';
import os from 'node:os';
export const homeDir = os.homedir();
export const baseDir = path.join(homeDir, '.sparrow');
export const configPath = path.join(baseDir, 'config.json');
export const dbPath = path.join(baseDir, 'sparrow.db');
export const logsDir = path.join(baseDir, 'logs');
export const sandboxDir = path.join(baseDir, 'sandbox');
