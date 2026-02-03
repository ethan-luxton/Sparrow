import fs from 'node:fs';
import path from 'node:path';

const target = path.resolve(process.cwd(), 'dist', 'cli.js');
const shebang = '#!/usr/bin/env node';

if (!fs.existsSync(target)) {
  console.warn('ensure-cli-bin: dist/cli.js not found. Run the build first.');
  process.exit(0);
}

let content = fs.readFileSync(target, 'utf8');
if (!content.startsWith(shebang)) {
  content = `${shebang}\n${content}`;
  fs.writeFileSync(target, content, 'utf8');
}

try {
  const stat = fs.statSync(target);
  const desiredMode = stat.mode | 0o111;
  if ((stat.mode & 0o111) !== 0o111) {
    fs.chmodSync(target, desiredMode);
  }
  console.log('ensure-cli-bin: ready');
} catch (err) {
  console.warn(`ensure-cli-bin: unable to set executable bit (${err.message}).`);
}
