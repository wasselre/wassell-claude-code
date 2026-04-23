// Remove the `WassellPresentationsDaemon` Windows service. Requires
// node-windows. See install-service.mjs for context.

import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

let Service;
try {
  ({ Service } = require('node-windows'));
} catch {
  console.error(
    'node-windows is not installed in this daemon folder. If the service is installed, run `npm install node-windows` here first, then re-run this script.',
  );
  process.exit(1);
}

const svc = new Service({
  name: 'WassellPresentationsDaemon',
  script: resolve(here, 'run-with-tsx.mjs'),
});

svc.on('uninstall', () => {
  console.log(`✓ Service '${svc.name}' uninstalled.`);
});
svc.on('alreadyuninstalled', () => {
  console.warn(`Service '${svc.name}' was not installed. Nothing to do.`);
});
svc.on('error', (err) => {
  console.error(`Service error: ${err?.message ?? err}`);
  process.exit(2);
});

console.log(`Uninstalling Windows service '${svc.name}'...`);
svc.uninstall();
