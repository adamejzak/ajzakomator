// Real-app SSH checks: node scripts/verify-ssh-ui.mjs [part ...]   (npm run build first)
// Parts are added task by task; with no argument every part runs. Screenshots: D:\Projekty\_shots\ssh-*.png
// Only the local test server (scripts/ssh-test-server.mjs on 127.0.0.1) is used; scratch dirs are deleted afterwards.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import ssh2 from 'ssh2';
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
  /** Task 9: new host from the palette, save and connect; generate a key and copy its public key; import by drop and by paste. */
  async editors() {
    const server = await startTestServer();
    const root = scratchRoot('editors');
    try {
      writeState(root, sshState({ projectPath: join(root, 'project') }));
      // Two throwaway keys for the import paths (never the user's ~/.ssh): one dropped as a file, one pasted.
      const dropped = ssh2.utils.generateKeyPairSync('ed25519', { comment: 'dropped@check' });
      const pasted = ssh2.utils.generateKeyPairSync('ecdsa', { bits: 256, comment: 'pasted@check' });
      const keyFile = join(root, 'id_dropped');
      writeFileSync(keyFile, dropped.private);
      const app = await launchApp(root);
      try {
        const palette = async (title) => {
          await app.click('button[aria-label="Szukaj wszędzie"]'); // the title bar button that opens the palette
          await app.until(`!!document.querySelector('.palette input')`, 'palette');
          await app.setValue('.palette input', title);
          await app.until(`document.querySelector('.palette-item.sel .ptitle')?.textContent === ${JSON.stringify(title)}`, `palette entry ${title}`);
          await app.press('Enter');
        };
        await palette('SSH: nowy host');
        await app.until(`!!document.querySelector('.ssh-editor [data-field=address]')`, 'host editor');
        await app.until(`document.querySelector('.workspace-tabs .ssh-tab.active .label')?.textContent === 'Nowy host'`, 'active editor tab');
        await app.setValue('[data-field=label]', 'local test');
        await app.setValue('[data-field=address]', '127.0.0.1');
        await app.setValue('[data-field=port]', String(server.port));
        await app.setValue('[data-field=username]', 'alice');
        await app.screenshot('ssh-host-editor.png');
        await app.click('.ssh-editor button', 'Zapisz i połącz');
        await app.until(`!!document.querySelector('.cell .ssh-fingerprint')`, 'host key prompt in the new cell');
        // The same tab now edits the saved host.
        await app.until(`document.querySelector('.workspace-tabs .ssh-tab .label')?.textContent === 'local test'`, 'retargeted editor tab');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password);
        await connected(app, 1);
        await palette('SSH: nowy klucz');
        await app.until(`!!document.querySelector('.ssh-segmented')`, 'new key editor');
        await app.setValue('[data-field=newKeyLabel]', 'check key');
        await app.screenshot('ssh-newkey-editor.png');
        await app.click('.ssh-editor button.primary', 'Wygeneruj klucz');
        await app.until(`!!document.querySelector('.ssh-public')`, 'key editor with public key', 60000);
        const pub = await app.evaluate(`document.querySelector('.ssh-public').textContent`);
        if (!/^ssh-ed25519 \S+ unimux@/.test(pub)) throw new Error(`unexpected public key: ${pub}`);
        await app.click('.ssh-editor button', 'Kopiuj klucz publiczny');
        await app.screenshot('ssh-key-editor.png');
        // Drag and drop of a private key file onto the drop zone.
        await palette('SSH: nowy klucz');
        await app.until(`document.querySelectorAll('.workspace-tabs .ssh-tab').length === 3`, 'second new key tab');
        await app.click('.ssh-segmented button', 'Importuj z pliku');
        await app.until(`!!document.querySelector('.ssh-drop')`, 'drop zone');
        const box = await app.evaluate(`(() => { const r = document.querySelector('.ssh-drop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const data = { items: [], files: [keyFile], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await app.cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
        await app.until(`document.querySelector('.ssh-editor .ssh-facts dd')?.textContent === 'ssh-ed25519'`, 'dropped key draft');
        await app.screenshot('ssh-newkey-dropped.png');
        await app.click('.ssh-editor button.primary', 'Zapisz');
        await app.until(`document.querySelector('.ssh-public')?.textContent.includes('dropped@check')`, 'dropped key stored');
        // Pasted private key text.
        await palette('SSH: nowy klucz');
        await app.click('.ssh-segmented button', 'Wklej klucz');
        await app.until(`!!document.querySelector('.ssh-editor textarea')`, 'paste form');
        await app.setValue('.ssh-editor textarea', pasted.private);
        await app.click('.ssh-editor button.primary', 'Dalej');
        await app.until(`document.querySelector('.ssh-editor .ssh-facts dd')?.textContent === 'ecdsa-sha2-nistp256'`, 'pasted key draft');
        await app.click('.ssh-editor button.primary', 'Zapisz');
        await app.until(`document.querySelector('.ssh-public')?.textContent.includes('pasted@check')`, 'pasted key stored');
        const keys = await app.evaluate(`window.mc.ssh.vaultInfo().then((v) => v.keys.map((k) => k.label))`);
        if (keys.length !== 3) throw new Error(`expected 3 keys in the vault, found ${JSON.stringify(keys)}`);
      } finally { await app.close(); }
      const vault = readFileSync(join(root, 'data', 'ssh', 'vault.json'), 'utf8');
      if (vault.includes('PRIVATE KEY') || vault.includes(server.password)) throw new Error('vault.json contains plain secrets');
      const state = readFileSync(join(root, 'data', 'state.json'), 'utf8');
      if (!state.includes('"local test"') || state.includes('PRIVATE KEY') || state.includes(server.password)) throw new Error('state.json: host missing or a secret leaked');
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
