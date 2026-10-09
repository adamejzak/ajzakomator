// Load node-pty with the packaged Electron runtime to catch ABI/architecture mismatches.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

const mac = process.platform === 'darwin';
const bundle = resolve('release', mac ? `mac${process.arch === 'arm64' ? '-arm64' : ''}/ajzakomator.app/Contents` : 'win-unpacked');
const executable = resolve(bundle, mac ? 'MacOS/ajzakomator' : 'ajzakomator.exe');
const modulePath = resolve(bundle, mac ? 'Resources/app/node_modules/node-pty' : 'resources/app/node_modules/node-pty');
if (!existsSync(executable) || !existsSync(modulePath)) throw new Error('Packaged Electron or node-pty is missing');

const script = `
  const pty = require(${JSON.stringify(modulePath)});
  const windows = process.platform === 'win32';
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const terminal = pty.spawn(windows ? 'cmd.exe' : '/bin/bash',
    windows ? ['/d', '/c', 'echo ajzakomator-pty-ok'] : ['-c', 'printf "ajzakomator-pty-%s\\n" ok'],
    { name: 'xterm-256color', cols: 80, rows: 24, cwd: process.cwd(), env,
      ...(windows ? { useConpty: true, useConptyDll: true } : {}) });
  let output = '';
  const timeout = setTimeout(() => { terminal.kill(); process.exit(1); }, 15000);
  terminal.onData((data) => { output += data; });
  terminal.onExit(({ exitCode }) => {
    clearTimeout(timeout);
    if (exitCode !== 0 || !output.includes('ajzakomator-pty-ok')) {
      process.stderr.write(output);
      process.exit(1);
    }
    process.stdout.write('Packaged terminal OK (' + process.platform + '/' + process.arch + ')\\n', () => process.exit(0));
  });
`;
execFileSync(executable, ['-e', script], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit', windowsHide: true, timeout: 20000,
});
