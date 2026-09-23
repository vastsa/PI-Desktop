import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Enumerate explicitly so PowerShell/CMD do not need to expand a shell glob.
const root = fileURLToPath(new URL('../', import.meta.url));
const files = readdirSync(new URL('./', import.meta.url))
  .filter(name => name.endsWith('.test.mjs'))
  .sort()
  .map(name => `test/${name}`);
const result = spawnSync(process.execPath, ['--test', ...files], {
  cwd: root, stdio: 'inherit', shell: false,
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
