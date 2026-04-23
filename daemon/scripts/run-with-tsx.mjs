// Tiny launcher used by the Windows service. node-windows requires a .js/.mjs
// entry point (it won't shell out to `npm start`), so this file boots tsx
// programmatically and hands it src/index.ts — the same thing `npm start`
// does, just without needing a shell.
//
// Keep this file dependency-free so installing the service doesn't require
// the daemon's deps beyond `node-windows` + `tsx` + the actual daemon deps.

import { spawn } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const daemonRoot = resolve(here, '..');
const indexTs = resolve(daemonRoot, 'src', 'index.ts');
const tsxBin = resolve(
  daemonRoot,
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'tsx.cmd' : 'tsx',
);

const child = spawn(tsxBin, [indexTs], {
  cwd: daemonRoot,
  stdio: 'inherit',
  // node-windows captures stdout/stderr to its own log files; our logger.ts
  // also writes to daemon/logs/ so we have two independent trails.
  shell: process.platform === 'win32',
});

child.on('exit', (code) => {
  // Propagate the exit code so node-windows' restart policy kicks in on
  // unexpected failures.
  process.exit(code ?? 0);
});
