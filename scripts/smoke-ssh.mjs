// scripts/smoke-ssh.mjs
// npm run test:ssh-electron: runs scripts/smoke-ssh-run.cjs with Electron's own Node (BoringSSL), from the repository.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import electron from 'electron';

const result = spawnSync(electron, [resolve('scripts/smoke-ssh-run.cjs')], {
  cwd: process.cwd(),
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
  windowsHide: true,
  timeout: 180000,
});
process.exit(result.status ?? 1);
