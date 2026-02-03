import path from 'node:path';
import fs from 'fs-extra';

const root = process.cwd();
const srcAssets = path.join(root, 'src', 'dashboard', 'assets');
const distAssets = path.join(root, 'dist', 'dashboard', 'assets');

if (!fs.existsSync(srcAssets)) {
  console.warn('dashboard assets not found:', srcAssets);
  process.exit(0);
}

fs.ensureDirSync(distAssets);
fs.copySync(srcAssets, distAssets, { overwrite: true });
console.log('dashboard assets copied to dist.');
