// Real-app SSH checks: node scripts/verify-ssh-ui.mjs [part ...]   (npm run build first)
// With no argument every part runs. Screenshots: D:\Projekty\_shots\ssh-*.png
// SSH_CHECK_LANGUAGE=en runs a part with the English UI (the `cell` part uses the TEXT table; screenshots get an -en suffix).
// Only the local test server (scripts/ssh-test-server.mjs on 127.0.0.1) is used; scratch dirs are deleted afterwards.
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import ssh2 from 'ssh2';
import { join } from 'node:path';
import { childPids, connected, connectWithPassword, killTree, LANGUAGE, launchApp, sleep, scratchRoot, sshState, startTestServer, testHost, writeKnownHost, writeState } from './ssh-ui-lib.mjs';

if (!existsSync('out/main/index.js')) throw new Error('Build first: npm run build');
/** Expression: the xterm buffer text of every cell of the active tab, in cell order (what the terminal really shows, not a screenshot). */
const CELL_BUFFERS = `(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId);
  return t.cells.map((c) => { const b = window.__mc.terminals.entries.get(c.id)?.term.buffer.active; if (!b) return ''; let text = ''; for (let i = 0; i < b.length; i++) text += (b.getLine(i)?.translateToString(true) ?? '') + '\\n'; return text; }); })()`;
const hasLine = (index, line) => `${CELL_BUFFERS}[${index}].split('\\n').some((l) => l.trim() === ${JSON.stringify(line)})`;
/** UI texts the checks click on or wait for, per language of SSH_CHECK_LANGUAGE (only the `cell` part is language-aware). */
const TEXT = {
  pl: { connect: 'Połącz', trust: 'Zaufaj i zapisz', disconnect: 'Rozłącz', reconnect: 'Połącz ponownie', crashed: 'Proces terminali został uruchomiony ponownie', crashedShort: 'Proces terminali' },
  en: { connect: 'Connect', trust: 'Trust and save', disconnect: 'Disconnect', reconnect: 'Reconnect', crashed: 'The terminal process was restarted', crashedShort: 'The terminal process' },
}[LANGUAGE];
if (!TEXT) throw new Error(`SSH_CHECK_LANGUAGE=${LANGUAGE} has no TEXT entry`);
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
        await app.until(`document.querySelector('.ssh-card button')?.textContent === ${JSON.stringify(TEXT.connect)}`, 'connect card');
        await app.screenshot('ssh-cell-idle.png');
        await app.click('.ssh-card button', TEXT.connect);
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key card');
        const shown = await app.evaluate(`document.querySelector('.ssh-fingerprint').textContent`);
        if (!shown.includes(server.fingerprint)) throw new Error(`fingerprint mismatch: ${shown} vs ${server.fingerprint}`);
        await app.screenshot('ssh-hostkey-new.png');
        await app.click('.ssh-card button', TEXT.trust);
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        const chip = await app.evaluate(`document.querySelector('.cell-head .ssh-host')?.textContent`);
        if (chip !== host.label) throw new Error(`header chip shows "${chip}", expected the host label`);
        await app.screenshot('ssh-cell-connected.png');
        // R11: after "Rozłącz" a bar sits at the bottom of the cell and the last output stays readable.
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', TEXT.disconnect);
        await app.until(`document.querySelector('.ssh-bar button')?.textContent === ${JSON.stringify(TEXT.reconnect)} && !document.querySelector('.ssh-card')`, 'disconnected bar');
        await app.screenshot('ssh-cell-closed.png');
        // R13: "Połącz ponownie" keeps the screen; the host key is known and the password saved, so no prompt comes up.
        await app.click('.ssh-bar button', TEXT.reconnect);
        await connected(app, 1);
        await app.screenshot('ssh-cell-reconnected.png');
        // D5 after a Pty Host crash: the cell ends in the error bar and never connects by itself; "Połącz ponownie" works.
        const hosts = childPids(app.pid, 'node.mojom.NodeService');
        if (hosts.length !== 1) throw new Error(`expected one Pty Host process, found ${hosts.length}`);
        killTree(hosts[0]);
        await app.until(`document.querySelector('.ssh-bar.error')?.textContent.includes(${JSON.stringify(TEXT.crashed)})`, 'crash bar');
        await sleep(3000);
        const after = await app.evaluate(`[!!document.querySelector('.ssh-bar.error'), !!document.querySelector('.ssh-card'), document.querySelector('.status-text.ssh')?.textContent ?? '']`);
        if (!after[0] || after[1] || !after[2].includes(TEXT.crashedShort)) throw new Error(`unexpected state after the crash: ${JSON.stringify(after)}`);
        await app.screenshot('ssh-cell-after-crash.png');
        await app.click('.ssh-bar button', TEXT.reconnect);
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
        // Every open editor stays mounted (hidden when not active): selectors are scoped to the visible one.
        const A = '.ssh-editor-screen.active';
        const fieldValues = () => app.evaluate(`[...document.querySelectorAll('${A} [data-field]')].map((e) => e.value).join('|')`);
        await palette('SSH: nowy host');
        await app.until(`!!document.querySelector('${A} [data-field=address]')`, 'host editor');
        await app.until(`document.querySelector('.workspace-tabs .ssh-tab.active .label')?.textContent === 'Nowy host'`, 'active editor tab');
        await app.setValue(`${A} [data-field=label]`, 'local test');
        await app.setValue(`${A} [data-field=address]`, '127.0.0.1');
        // A half-filled host editor survives switching to another editor tab and to Settings.
        await palette('SSH: nowy klucz');
        await app.until(`!!document.querySelector('${A} .ssh-segmented')`, 'new key tab in front');
        await app.click('.workspace-tabs .ssh-tab', 'Nowy host');
        await app.until(`!!document.querySelector('${A} [data-field=address]')`, 'host editor again');
        if (await fieldValues() !== 'local test|127.0.0.1|22|') throw new Error(`host editor lost its input: ${await fieldValues()}`);
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(`!document.querySelector('${A}')`, 'settings in front');
        await app.click('.workspace-tabs .ssh-tab', 'Nowy host');
        await app.until(`!!document.querySelector('${A} [data-field=address]')`, 'host editor after settings');
        if (await fieldValues() !== 'local test|127.0.0.1|22|') throw new Error(`host editor lost its input after Settings: ${await fieldValues()}`);
        await app.setValue(`${A} [data-field=port]`, String(server.port));
        await app.setValue(`${A} [data-field=username]`, 'alice');
        await app.screenshot('ssh-host-editor.png');
        await app.click(`${A} .ssh-editor button`, 'Zapisz i połącz');
        await app.until(`!!document.querySelector('.cell .ssh-fingerprint')`, 'host key prompt in the new cell');
        // The same tab now edits the saved host.
        await app.until(`document.querySelector('.workspace-tabs .ssh-tab .label')?.textContent === 'local test'`, 'retargeted editor tab');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password);
        await connected(app, 1);
        // The "new key" tab opened above is still there: generate in it.
        await app.click('.workspace-tabs .ssh-tab', 'Nowy klucz');
        await app.until(`!!document.querySelector('${A} .ssh-segmented')`, 'new key editor');
        await app.setValue(`${A} [data-field=newKeyLabel]`, 'check key');
        await app.screenshot('ssh-newkey-editor.png');
        await app.click(`${A} .ssh-editor button.primary`, 'Wygeneruj klucz');
        await app.until(`!!document.querySelector('${A} .ssh-public')`, 'key editor with public key', 60000);
        const pub = await app.evaluate(`document.querySelector('${A} .ssh-public').textContent`);
        if (!/^ssh-ed25519 \S+ unimux@/.test(pub)) throw new Error(`unexpected public key: ${pub}`);
        await app.click(`${A} .ssh-editor button`, 'Kopiuj klucz publiczny');
        await app.screenshot('ssh-key-editor.png');
        // Drag and drop of a private key file onto the drop zone.
        await palette('SSH: nowy klucz');
        await app.until(`document.querySelectorAll('.workspace-tabs .ssh-tab').length === 3`, 'second new key tab');
        await app.click(`${A} .ssh-segmented button`, 'Importuj z pliku');
        await app.until(`!!document.querySelector('${A} .ssh-drop')`, 'drop zone');
        const box = await app.evaluate(`(() => { const r = document.querySelector('${A} .ssh-drop').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; })()`);
        const data = { items: [], files: [keyFile], dragOperationsMask: 1 };
        for (const type of ['dragEnter', 'dragOver', 'drop']) await app.cdp('Input.dispatchDragEvent', { type, x: box.x, y: box.y, data });
        await app.until(`document.querySelector('${A} .ssh-facts dd')?.textContent === 'ssh-ed25519'`, 'dropped key draft');
        await app.screenshot('ssh-newkey-dropped.png');
        // The uncommitted draft survives a switch to the grid and back.
        // Grid tabs select on mousedown.
        await app.evaluate(`document.querySelector('.workspace-tabs .grid-tab').dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))`);
        await app.until(`!document.querySelector('${A}')`, 'grid in front');
        await app.click('.workspace-tabs .ssh-tab', 'Nowy klucz');
        await app.until(`document.querySelector('${A} .ssh-public')?.textContent.includes('dropped@check')`, 'draft kept after the grid');
        await app.click(`${A} .ssh-editor button.primary`, 'Zapisz');
        await app.until(`document.querySelector('${A} .ssh-public')?.textContent.includes('dropped@check') && !document.querySelector('${A} .ssh-segmented')`, 'dropped key stored');
        // Pasted private key text.
        await palette('SSH: nowy klucz');
        await app.click(`${A} .ssh-segmented button`, 'Wklej klucz');
        await app.until(`!!document.querySelector('${A} .ssh-editor textarea')`, 'paste form');
        await app.setValue(`${A} .ssh-editor textarea`, pasted.private);
        await app.click(`${A} .ssh-editor button.primary`, 'Dalej');
        await app.until(`document.querySelector('${A} .ssh-facts dd')?.textContent === 'ecdsa-sha2-nistp256'`, 'pasted key draft');
        await app.click(`${A} .ssh-editor button.primary`, 'Zapisz');
        await app.until(`document.querySelector('${A} .ssh-public')?.textContent.includes('pasted@check') && !document.querySelector('${A} .ssh-segmented')`, 'pasted key stored');
        const keys = await app.evaluate(`window.mc.ssh.vaultInfo().then((v) => v.keys.map((k) => k.label))`);
        if (keys.length !== 3) throw new Error(`expected 3 keys in the vault, found ${JSON.stringify(keys)}`);
      } finally { await app.close(); }
      const vault = readFileSync(join(root, 'data', 'ssh', 'vault.json'), 'utf8');
      if (vault.includes('PRIVATE KEY') || vault.includes(server.password)) throw new Error('vault.json contains plain secrets');
      const state = readFileSync(join(root, 'data', 'state.json'), 'utf8');
      if (!state.includes('"local test"') || state.includes('PRIVATE KEY') || state.includes(server.password)) throw new Error('state.json: host missing or a secret leaked');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 9 fix: with no project at all, the palette still opens the SSH editors and a host can be saved. */
  async editorsNoProject() {
    const root = scratchRoot('editors-noproject');
    try {
      writeState(root, { version: 1, settings: { language: 'pl' }, sshHosts: [], projects: [], activeProjectId: null });
      const app = await launchApp(root);
      try {
        const A = '.ssh-editor-screen.active';
        for (const title of ['SSH: nowy klucz', 'SSH: nowy host']) {
          await app.click('button[aria-label="Szukaj wszędzie"]');
          await app.until(`!!document.querySelector('.palette input')`, 'palette');
          await app.setValue('.palette input', title);
          await app.until(`document.querySelector('.palette-item.sel .ptitle')?.textContent === ${JSON.stringify(title)}`, `palette entry ${title}`);
          await app.press('Enter');
        }
        await app.until(`!!document.querySelector('${A} [data-field=address]')`, 'host editor without a project');
        await app.setValue(`${A} [data-field=address]`, 'example.invalid');
        await app.setValue(`${A} [data-field=username]`, 'bob');
        await app.click(`${A} .ssh-editor button.primary`, 'Zapisz');
        await app.until(`document.querySelector('.workspace-tabs .ssh-tab.active .label')?.textContent === 'example.invalid'`, 'host saved without a project');
        await app.screenshot('ssh-editor-no-project.png');
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      if (!readFileSync(join(root, 'data', 'state.json'), 'utf8').includes('"example.invalid"')) throw new Error('host not stored');
    } finally { rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 10: the SSH tile opens, hosts are grouped and searchable, folding and multi-select work, a group opens as a 3-cell grid. */
  async panel() {
    const server = await startTestServer();
    const root = scratchRoot('ssh-panel');
    try {
      const hosts = [testHost(server.port, { label: 'web-1', group: 'lab' }), testHost(server.port, { label: 'web-2', group: 'lab' }), testHost(server.port, { label: 'web-3', group: 'lab' }), testHost(server.port, { label: 'pi' })];
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts }));
      const app = await launchApp(root);
      try {
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-hosts')`, 'host list');
        const heads = await app.evaluate(`[...document.querySelectorAll('.ssh-group-head .grow')].map((e) => e.textContent)`);
        if (JSON.stringify(heads) !== JSON.stringify(['lab', 'Bez grupy'])) throw new Error(`groups: ${heads}`);
        const sections = await app.evaluate(`[...document.querySelectorAll('.terminal-heading')].map((e) => e.textContent)`);
        if (JSON.stringify(sections) !== JSON.stringify(['Hosty', 'Klucze', 'Lokalne powłoki'])) throw new Error(`sections: ${sections}`);
        await app.screenshot('ssh-panel.png');
        // Search narrows the list.
        await app.setValue('.ssh-search', 'pi');
        await app.until(`document.querySelectorAll('.ssh-host-row').length === 1`, 'search narrows the list');
        await app.setValue('.ssh-search', '');
        await app.until(`document.querySelectorAll('.ssh-host-row').length === 4`, 'all hosts back');
        // Folding a group hides its hosts and is remembered.
        await app.click('.ssh-group-head', 'lab');
        await app.until(`document.querySelectorAll('.ssh-host-row').length === 1 && !!document.querySelector('.ssh-group-head .chev-right')`, 'folded group');
        await app.screenshot('ssh-panel-folded.png');
        if (await app.evaluate(`localStorage.getItem('mc-ssh-groups-v1')`) !== '["lab"]') throw new Error('fold state not stored');
        await app.click('.ssh-group-head', 'lab');
        await app.until(`document.querySelectorAll('.ssh-host-row').length === 4`, 'expanded group');
        // Ctrl+click selects; the grid button counts the selection.
        await app.evaluate(`(() => { for (const row of [...document.querySelectorAll('.ssh-host-row')].filter((r) => /web-1|pi/.test(r.textContent))) row.querySelector('.terminal-source-main').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); return true; })()`);
        await app.until(`document.querySelectorAll('.ssh-host-row.selected').length === 2 && document.querySelector('.ssh-open-grid')?.textContent === 'Otwórz jako siatkę (2)'`, 'two hosts selected');
        await app.screenshot('ssh-panel-selected.png');
        await app.evaluate(`(() => { for (const row of document.querySelectorAll('.ssh-host-row.selected')) row.querySelector('.terminal-source-main').dispatchEvent(new MouseEvent('click', { bubbles: true, ctrlKey: true })); return true; })()`);
        await app.until(`!document.querySelector('.ssh-open-grid') && !document.querySelector('.ssh-host-row.selected')`, 'selection cleared');
        // A group opens as a grid named after it.
        await app.evaluate(`(() => { const head = [...document.querySelectorAll('.ssh-group-head')].find((e) => e.textContent.includes('lab')); head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); return true; })()`);
        await app.click('.menu [role=menuitem]', 'Otwórz jako siatkę');
        await app.until(`document.querySelectorAll('.cell .ssh-fingerprint').length === 3`, 'host key prompt in all three cells');
        await app.until(`document.querySelector('.workspace-tabs .grid-tab.active .label')?.textContent === 'lab'`, 'tab named after the group');
        await app.screenshot('ssh-group-grid.png');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 11: a saved preset with three SSH cells opens from the palette and connects; the grid dialog lists hosts. */
  async grid() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-grid');
    try {
      const host = testHost(server.port, { label: 'lab' });
      const state = sshState({ projectPath: join(root, 'project'), hosts: [host] });
      state.presets = [{ id: 'preset-ssh', name: 'SSH lab x3', layout: { cols: 3, rows: 1, areas: [0, 1, 2].map((i) => ({ col: i, row: 0, colSpan: 1, rowSpan: 1 })) },
        cells: [0, 1, 2].map(() => ({ profileId: 'shell', worktree: false, sshHostId: host.id })) }];
      writeState(root, state);
      const app = await launchApp(root);
      try {
        await app.click('button[aria-label="Szukaj wszędzie"]');
        await app.setValue('.palette input', 'SSH lab x3');
        await app.press('Enter');
        await app.until(`document.querySelectorAll('.cell .ssh-fingerprint').length === 3`, 'one shared host key card in three cells');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await app.until(`document.querySelectorAll('.cell .ssh-card').length === 0`, 'all three connected');
        // Every cell's terminal buffer holds the connected notice and the server greeting (nothing lost to the shared prompt or an early write).
        const buffers = CELL_BUFFERS;
        await app.until(`${buffers}.length === 3 && ${buffers}.every((t) => t.includes('połączono') && t.includes('unimux test server') && t.includes('$'))`, 'every cell shows the connected notice and the server greeting');
        await app.screenshot('ssh-grid-preset.png');
        // Typing into each cell reaches its own session and the echo comes back.
        for (let i = 0; i < 3; i++) {
          await app.evaluate(`(() => { const s = window.__mc.useStore.getState().s; const p = s.projects.find((x) => x.id === s.activeProjectId); const t = p.tabs.find((x) => x.id === p.activeTabId); window.__mc.terminals.focus(t.cells[${i}].id); return true; })()`);
          await app.insertText(`echo ok${i}`);
          await app.press('Enter');
          await app.until(`${buffers}[${i}].split('\\n').some((l) => l.trim() === 'ok${i}')`, `cell ${i + 1} echoes its command`);
        }
        await app.screenshot('ssh-grid-preset-echo.png');
        await app.click('button[title^="Nowy grid"]');
        await app.until(`!!document.querySelector('.grid-dialog')`, 'grid dialog');
        await app.click('.cell-table .select');
        await app.screenshot('ssh-grid-dialog.png');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 12: a 3-cell grid opened from the 'lab' group, one command broadcast to all three (read from each terminal buffer), then one disconnected cell is disabled and skipped. */
  async broadcast() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-broadcast');
    try {
      const hosts = ['web-1', 'web-2', 'web-3'].map((label) => testHost(server.port, { label, group: 'lab' }));
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts }));
      writeKnownHost(root, server);
      const app = await launchApp(root);
      try {
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-hosts')`, 'host list');
        await app.evaluate(`(() => { const head = [...document.querySelectorAll('.ssh-group-head')].find((e) => e.textContent.includes('lab')); head.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 50, clientY: 50 })); return true; })()`);
        await app.click('.menu [role=menuitem]', 'Otwórz jako siatkę');
        await connected(app, 3);
        await app.until(`${CELL_BUFFERS}.length === 3 && ${CELL_BUFFERS}.every((t) => t.includes('połączono') && t.includes('$'))`, 'three cells with a prompt');
        await app.click('.terminal-panel button', 'Wyślij do wszystkich (3)');
        await app.until(`!!document.querySelector('.ssh-broadcast textarea')`, 'broadcast dialog');
        await app.until(`document.querySelectorAll('.ssh-targets li').length === 3 && document.querySelectorAll('.ssh-targets li.disabled').length === 0 && [...document.querySelectorAll('.ssh-targets input')].every((i) => i.checked)`, 'three connected cells, all checked');
        if (await app.evaluate(`document.querySelector('.ssh-broadcast .modal-foot .btn.white').disabled`) !== true) throw new Error('send button is enabled for an empty command');
        await app.setValue('.ssh-broadcast textarea', 'echo hi');
        await app.until(`document.querySelector('.ssh-broadcast .modal-foot .btn.white').textContent === 'Wyślij do 3' && !document.querySelector('.ssh-broadcast .modal-foot .btn.white').disabled`, 'send button counts three');
        await app.click('.ssh-broadcast .modal-foot .btn.white');
        await app.until(`[...document.querySelectorAll('.ssh-target-state')].filter((e) => e.textContent === 'wysłano').length === 3`, 'sent to three');
        // The terminals themselves print the output (L23): "hi" on its own line in every cell.
        for (let i = 0; i < 3; i++) await app.until(hasLine(i, 'hi'), `cell ${i + 1} printed hi`);
        if (await app.evaluate(`document.querySelector('.ssh-broadcast textarea').value`) !== '') throw new Error('the text was not cleared after sending');
        await app.screenshot('ssh-broadcast-sent.png');
        // The dialog stays open; Arrow Up in the empty field recalls the command.
        await app.evaluate(`document.querySelector('.ssh-broadcast textarea').focus()`);
        await app.press('ArrowUp');
        await app.until(`document.querySelector('.ssh-broadcast textarea').value === 'echo hi'`, 'history recall');
        // An escape sequence is refused and disables sending.
        await app.setValue('.ssh-broadcast textarea', 'ls \u001b[A');
        await app.until(`!!document.querySelector('.ssh-broadcast [role=alert]') && document.querySelector('.ssh-broadcast .modal-foot .btn.white').disabled`, 'control characters refused');
        await app.press('Escape');
        await app.until(`!document.querySelector('.ssh-broadcast')`, 'dialog closed by Escape');
        // Disconnect the first cell through its host chip menu.
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', 'Rozłącz');
        await app.until(`document.querySelectorAll('.cell .ssh-bar').length === 1`, 'first cell disconnected');
        await app.click('.terminal-panel button', 'Wyślij do wszystkich');
        await app.until(`document.querySelectorAll('.ssh-targets li').length === 3 && document.querySelectorAll('.ssh-targets li.disabled').length === 1`, 'disconnected cell disabled in the dialog');
        const reason = await app.evaluate(`document.querySelector('.ssh-targets li.disabled .ssh-target-state').textContent`);
        if (reason !== 'rozłączono') throw new Error(`disabled row reason: ${reason}`);
        await app.setValue('.ssh-broadcast textarea', 'echo again');
        await app.until(`document.querySelector('.ssh-broadcast .modal-foot .btn.white').textContent === 'Wyślij do 2'`, 'send button counts two');
        await app.screenshot('ssh-broadcast-disabled.png');
        await app.press('Enter', 2); // Ctrl+Enter sends
        await app.until(`[...document.querySelectorAll('.ssh-target-state')].filter((e) => e.textContent === 'wysłano').length === 2`, 'sent to the two connected cells');
        await app.until(`${hasLine(1, 'again')} && ${hasLine(2, 'again')}`, 'cells 2 and 3 printed again');
        if (await app.evaluate(hasLine(0, 'again'))) throw new Error('the disconnected cell received the command');
        await app.press('Escape');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 13: Settings > SSH shows the storage and the known host, and removes it. */
  async settings() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-settings');
    try {
      writeState(root, sshState({ projectPath: join(root, 'project') }));
      writeKnownHost(root, server);
      const app = await launchApp(root);
      try {
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page');
        await app.click('.settings-nav [role=tab]', 'SSH');
        await app.until(`!!document.querySelector('.ssh-known')`, 'known hosts table');
        const storage = await app.evaluate(`document.querySelector('.settings-content').textContent`);
        if (!/Szyfrowanie: (Windows \(DPAPI\)|pęk kluczy macOS)/.test(storage)) throw new Error('storage line missing');
        if (storage.includes('tylko do odczytu:')) throw new Error('a healthy store is shown as read-only');
        if (!storage.includes(join(root, 'data', 'ssh', 'known_hosts.json'))) throw new Error('known hosts file path missing');
        await app.screenshot('ssh-settings.png');
        await app.click('.ssh-known button', 'Usuń');
        await app.until(`document.querySelector('.settings-content').textContent.includes('Brak znanych hostów')`, 'known host removed');
      } finally { await app.close(); }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Task 13 (a)-(c): a vault and a known hosts file of a newer format open read-only; Settings says so, shows both paths, and neither file is touched. */
  async settingsReadOnly() {
    const server = await startTestServer(['--no-auth']);
    const root = scratchRoot('ssh-settings-ro');
    try {
      writeState(root, sshState({ projectPath: join(root, 'project') }));
      writeKnownHost(root, server);
      const vaultFile = join(root, 'data', 'ssh', 'vault.json'), hostsFile = join(root, 'data', 'ssh', 'known_hosts.json');
      writeFileSync(vaultFile, '{"version":99,"keys":[],"passwords":[]}');
      const damaged = readFileSync(hostsFile, 'utf8').replace('"version":1', '"version":99'); // newer format: the entry is listed, nothing can change
      writeFileSync(hostsFile, damaged);
      const app = await launchApp(root);
      try {
        await app.click('button[aria-label="Ustawienia"]');
        await app.until(`!!document.querySelector('.settings-nav [role=tab]')`, 'settings page');
        await app.click('.settings-nav [role=tab]', 'SSH');
        await app.until(`document.querySelectorAll('.settings-content .ssh-banner-warn').length === 2`, 'two read-only notes');
        const text = await app.evaluate(`document.querySelector('.settings-content').textContent`);
        for (const needle of ['Sejf SSH jest tylko do odczytu', vaultFile, 'Lista znanych hostów jest tylko do odczytu', hostsFile, 'Zaufaj i zapisz', 'Zastąp zapisany klucz']) {
          if (!text.includes(needle)) throw new Error(`Settings text misses: ${needle}`);
        }
        if (!(await app.evaluate(`[...document.querySelectorAll('.ssh-known button')].every((b) => b.disabled)`))) throw new Error('remove buttons are enabled on a read-only store');
        await app.screenshot('ssh-settings-readonly.png');
      } finally { await app.close(); }
      if (readFileSync(vaultFile, 'utf8') !== '{"version":99,"keys":[],"passwords":[]}') throw new Error('the vault file was modified');
      if (readFileSync(hostsFile, 'utf8') !== damaged) throw new Error('the known hosts file was modified');
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** Spec 14: after a restart of the app the cell shows "Połącz" (D5); a new host key on the same port gives the red card (incl. the changed host key, L13). */
  async restart() {
    let server = await startTestServer();
    const root = scratchRoot('ssh-restart');
    const passwords = [server.password];
    try {
      const host = testHost(server.port);
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
      let app = await launchApp(root);
      try {
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      app = await launchApp(root);
      try {
        await app.until(`document.querySelector('.ssh-card button')?.textContent === 'Połącz'`, 'not restored after restart');
        await app.screenshot('ssh-after-restart.png');
      } finally { await app.close(); }
      const port = server.port;
      server.stop();
      await sleep(500); // the port is free again
      server = await startTestServer(['--port', String(port)]);
      passwords.push(server.password);
      if (server.port !== port) throw new Error('test server did not come back on the same port');
      app = await launchApp(root);
      try {
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-card.danger')`, 'changed host key card');
        const shown = await app.evaluate(`document.querySelector('.ssh-card.danger').textContent`);
        if (!shown.includes(server.fingerprint)) throw new Error('the red card does not show the new fingerprint');
        await app.until(`document.querySelector('.ssh-card.danger button.danger')?.disabled === true`, 'replace disabled until confirmed');
        await app.screenshot('ssh-hostkey-changed.png');
        await app.click('.ssh-card.danger button', 'Rozłącz');
        await app.until(`!!document.querySelector('.ssh-bar.error')`, 'hostKeyChanged bar');
        await app.screenshot('ssh-hostkey-changed-refused.png');
      } finally { await app.close(); }
      const files = ['state.json', 'ssh/vault.json', 'ssh/known_hosts.json'].map((f) => join(root, 'data', f)).filter(existsSync);
      if (files.length !== 3) throw new Error(`expected state, vault and known hosts files, found ${files.length}`);
      for (const file of files) {
        const text = readFileSync(file, 'utf8');
        for (const secret of [...passwords, 'PRIVATE KEY']) if (text.includes(secret)) throw new Error(`${file} contains a secret`);
      }
    } finally { server.stop(); rmSync(root, { recursive: true, force: true }); }
  },
  /** D8: with MC_SSH_NO_SAFESTORAGE=1 the banner shows, a saved password works for the session, nothing secret is written. */
  async noSafeStorage() {
    const server = await startTestServer();
    const root = scratchRoot('ssh-nosafe');
    try {
      const host = testHost(server.port);
      writeState(root, sshState({ projectPath: join(root, 'project'), hosts: [host], cells: [host.id] }));
      const app = await launchApp(root, { MC_SSH_NO_SAFESTORAGE: '1' });
      try {
        await app.click('.rail-tiles [aria-label="SSH"]');
        await app.until(`!!document.querySelector('.ssh-banner-warn')`, 'unavailable banner');
        await app.screenshot('ssh-no-safestorage.png');
        await app.click('.ssh-card button', 'Połącz');
        await app.until(`!!document.querySelector('.ssh-fingerprint')`, 'host key');
        await app.click('.ssh-card button', 'Zaufaj i zapisz');
        await connectWithPassword(app, server.password, { save: true });
        await connected(app, 1);
        // The password is kept in memory for the session: a reconnect does not ask again.
        await app.click('.cell-head .ssh-host');
        await app.click('.menu .menu-item', 'Rozłącz');
        await app.until(`document.querySelector('.ssh-bar button')?.textContent === 'Połącz ponownie'`, 'disconnected bar');
        await app.click('.ssh-bar button', 'Połącz ponownie');
        await connected(app, 1);
        await sleep(2500); // state.json is written debounced
      } finally { await app.close(); }
      if (existsSync(join(root, 'data', 'ssh', 'vault.json'))) throw new Error('vault.json written although safeStorage was unavailable');
      if (readFileSync(join(root, 'data', 'state.json'), 'utf8').includes(server.password)) throw new Error('state.json contains the password');
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
