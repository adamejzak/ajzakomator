// Real-app SSH checks: node scripts/verify-ssh-ui.mjs [part ...]   (npm run build first)
// Parts are added task by task; with no argument every part runs. Screenshots: D:\Projekty\_shots\ssh-*.png
// Only the local test server (scripts/ssh-test-server.mjs on 127.0.0.1) is used; scratch dirs are deleted afterwards.
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { childPids, connected, connectWithPassword, killTree, launchApp, sleep, scratchRoot, sshState, startTestServer, testHost, writeState } from './ssh-ui-lib.mjs';

if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
const PARTS = {
  /** Task 8: a prepared SSH cell shows "Połącz", the host key card, the password prompt, then the session. */
  async cell() {
    const server = await startTestServer();
    const root = scratchRoot('cell');
    try {
      const host = testHost(server.port);
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
      const app = await launchApp(root);
      try {
        // D5: a restored SSH cell never connects by itself.
        await app.until(`document.querySelector('.ssh-card button')?.textContent === 'Połącz'`, 'connect card');
        await app.screenshot('ssh-cell-idle.png');
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key card');
        const shown = await app.evaluate(`document.querySelector('.ssh-fingerprint').textContent`);
        if (!shown.includes(server.fingerprint)) throw new Error(`fingerprint mismatch: ${shown} vs ${server.fingerprint}`);
        await app.screenshot('ssh-hostkey-new.png');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        const chip = await app.evaluate(`document.querySelector('.cell-head .ssh-host')?.textContent`);
        if (chip !== host.label) throw new Error(`header chip shows "${chip}", expected the host label`);
        await app.screenshot('ssh-cell-connected.png');
        // R11: after "Rozłącz" a bar sits at the bottom of the cell and the last output stays readable.
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', 'Rozłącz');
        await app.until(`document.querySelector('.ssh-bar button')?.textContent === 'Połącz ponownie' && !document.querySelector('.ssh-card')`, 'disconnected bar');
        await app.screenshot('ssh-cell-closed.png');
        // R13: "Połącz ponownie" keeps the screen; the host key is known and the password saved, so no prompt comes up.
        await app.click('.ssh-bar button', 'Połącz ponownie');
        await connected(app, 1);
        await app.screenshot('ssh-cell-reconnected.png');
        // D5 after a Pty Host crash: the cell ends in the error bar and never connects by itself; "Połącz ponownie" works.
        const hosts = childPids(app.pid, 'node.mojom.NodeService');
        if (hosts.length !== 1) throw new Error(`expected one Pty Host process, found ${hosts.length}`);
        killTree(hosts[0]);
        await app.until(`document.querySelector('.ssh-bar.error')?.textContent.includes('Proces terminali został uruchomiony ponownie')`, 'crash bar');
        await sleep(3000);
        const after = await app.evaluate(`[!!document.querySelector('.ssh-bar.error'), !!document.querySelector('.ssh-card'), document.querySelector('.status-text.ssh')?.textContent ?? '']`);
        if (!after[0] || after[1] || !after[2].includes('Proces terminali')) throw new Error(`unexpected state after the crash: ${JSON.stringify(after)}`);
        await app.screenshot('ssh-cell-after-crash.png');
        await app.click('.ssh-bar button', 'Połącz ponownie');
        await connected(app, 1);
      } finally { await app.close(); }
      for (const file of ['state.json', 'ssh/vault.json', 'ssh/known_hosts.json']) {
        const path = join(root, 'data', file);
        if (existsSync(path) && readFileSync(path, 'utf8').includes(server.password)) throw new Error(`${file} contains the test password`);
      }
      if (!existsSync(join(root, 'data', 'ssh', 'known_hosts.json'))) throw new Error('host key was not saved');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
};

const wanted = process.argv.slice(2).length ? process.argv.slice(2) : Object.keys(PARTS);
for (const name of wanted) {
  if (!PARTS[name]) throw new Error(`unknown part ${name}`);
  process.stdout.write(`-- ${name}\n`);
  await PARTS[name]();
  process.stdout.write(`OK ${name}\n`);
}
