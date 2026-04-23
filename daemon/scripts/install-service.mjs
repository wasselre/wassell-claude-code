// Install the presentations daemon as a Windows service using node-windows.
// Opt-in, manual run. Requires `node-windows` installed locally first:
//
//   npm install node-windows
//
// Then from the daemon/ folder:
//
//   node scripts/install-service.mjs
//
// What it does:
//   1. Registers a Windows service named `WassellPresentationsDaemon` that
//      runs `node scripts/run-with-tsx.mjs` (which boots src/index.ts via tsx).
//   2. The service uses the daemon/.env for config — don't delete it.
//   3. Output (stdout+stderr) is captured by node-windows into its own
//      daemonized log files alongside the script; our logger.ts continues
//      writing to daemon/logs/ as well.
//
// To uninstall:
//
//   node scripts/uninstall-service.mjs
//
// Limitations:
//   - Windows-only. On macOS/Linux use launchd / systemd respectively; scripts
//     for those aren't in the v1 box.
//   - node-windows hardcodes the NT user that runs the service (default
//     LocalSystem). If you need the service to run as your own account (to
//     reach your Chrome profile for Paseetah), edit the svc.user property
//     below. LocalSystem won't see your user profile, so for the Presentations
//     pipeline you almost certainly need a user-scoped service.

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));
const daemonRoot = resolve(here, '..');

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error(
    'node-windows is not installed. Run `npm install node-windows` in this daemon folder, then re-run this script.',
  );
  process.exit(1);
}

const svc = new Service({
  name: 'WassellPresentationsDaemon',
  description:
    'Wassell CRM — Presentations daemon. Polls Supabase for queued deck jobs, runs Claude Code for each, writes Drive URLs back.',
  script: resolve(here, 'run-with-tsx.mjs'),
  // Make sure the service sees the daemon folder as its cwd so .env loads
  // and TEMPLATES_DIR/LOG_DIR defaults resolve correctly.
  workingDirectory: daemonRoot,
  // Inherit the user's current PATH so `claude` is findable. Without this,
  // node-windows strips PATH and spawn fails.
  env: [
    { name: 'PATH', value: process.env.PATH ?? '' },
  ],
  // Restart on crash with a back-off. node-windows defaults to 1s grace which
  // can thrash; 15s lets Supabase / Claude recover cleanly.
  wait: 2,
  grow: 0.5,
  maxRestarts: 10,
});

svc.on('install', () => {
  console.log(
    `✓ Service '${svc.name}' installed. Starting it now... (check Services.msc if you want to watch)`,
  );
  svc.start();
});
svc.on('start', () => {
  console.log(`✓ Service '${svc.name}' started.`);
  console.log('Tail daemon/logs/daemon-<date>.log to watch activity.');
  console.log(
    'To uninstall:   node scripts/uninstall-service.mjs',
  );
});
svc.on('alreadyinstalled', () => {
  console.warn(`Service '${svc.name}' is already installed. Nothing to do.`);
});
svc.on('error', (err) => {
  console.error(`Service error: ${err?.message ?? err}`);
  process.exit(2);
});

console.log(`Installing Windows service '${svc.name}' pointing at ${svc.script}...`);
void pathToFileURL(svc.script);
svc.install();
