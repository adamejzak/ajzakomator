// Capture the real built Electron renderer. Never uses an installed app's data or AI models.
// Run: npm run build && node scripts/capture-readme.mjs
// Requires Node >=22, installed dependencies, and an Electron desktop environment.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import electron from 'electron';
import { verifyWorkspaceUI } from './verify-workspace-ui.mjs';

const checkout = process.cwd();
if (!existsSync(join(checkout, 'out/main/index.js'))) throw new Error('Build first: npm run build');
const output = resolve(process.argv.slice(2).find(arg => !arg.startsWith('--')) ?? 'docs/screenshots');
mkdirSync(output, { recursive: true });
// Set MC_CAPTURE_ROOT to a generic path if your OS temp path contains a personal name.
const temporaryBase = resolve(process.env.MC_CAPTURE_ROOT ?? tmpdir());
mkdirSync(temporaryBase, { recursive: true });
const root = mkdtempSync(join(temporaryBase, 'ajzakomator-readme-'));
const data = join(root, 'data'), project = join(root, 'atlas');
for (const dir of [data, project, join(project, 'src'), join(project, 'test')]) mkdirSync(dir, { recursive: true });
writeFileSync(join(project, 'package.json'), JSON.stringify({ name: 'atlas-demo', private: true, type: 'module', scripts: { test: 'node --test', check: 'node --check src/catalog.mjs' } }, null, 2));
writeFileSync(join(project, 'README.md'), '# Atlas\n\nA small product catalog used for the ajzakomator screenshot demo.\n\nRun `npm test` to check filtering and price formatting.\n');
writeFileSync(join(project, 'src/catalog.mjs'), `/** A tiny catalog shared by the storefront and API. */
export const products = [
  { id: 'orbit', name: 'Orbit desk lamp', category: 'lighting', price: 79 },
  { id: 'folio', name: 'Folio notebook', category: 'stationery', price: 12 },
  { id: 'arc', name: 'Arc bookend', category: 'workspace', price: 24 },
];

export function findProducts(query, catalog = products) {
  const search = query.trim().toLowerCase();
  return catalog.filter(product =>
    product.name.toLowerCase().includes(search) ||
    product.category.toLowerCase().includes(search)
  );
}

export function formatPrice(amount) {
  return new Intl.NumberFormat('en-US', {
    style: 'currency', currency: 'USD',
  }).format(amount);
}
`);
writeFileSync(join(project, 'test/catalog.test.mjs'), `import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findProducts, formatPrice } from '../src/catalog.mjs';
test('search finds a product by name', () => assert.equal(findProducts('orbit')[0].id, 'orbit'));
test('search is case insensitive', () => assert.equal(findProducts('FOLIO').length, 1));
test('search trims whitespace', () => assert.equal(findProducts(' arc ')[0].id, 'arc'));
test('search matches categories', () => assert.equal(findProducts('workspace').length, 1));
test('empty search returns the catalog', () => assert.equal(findProducts('').length, 3));
test('prices use US dollars', () => assert.equal(formatPrice(79), '$79.00'));
`);
writeFileSync(join(project, 'inspect.mjs'), `import { products, formatPrice } from './src/catalog.mjs';
console.log('ATLAS / PRODUCT CATALOG\\n');
for (const p of products) console.log(p.name.padEnd(24) + formatPrice(p.price).padStart(8));
console.log('\\n3 products · 3 categories · USD');
`);
writeFileSync(join(project, 'review.mjs'), `import { readFileSync } from 'node:fs';
const source = readFileSync('src/catalog.mjs', 'utf8');
console.log('ATLAS / SOURCE CHECK\\n');
console.log('Module:        src/catalog.mjs');
console.log('Exports:       ' + [...source.matchAll(/export (?:const|function) (\\w+)/g)].map(m => m[1]).join(', '));
console.log('Lines:         ' + source.trimEnd().split('\\n').length);
console.log('Dependencies:  JavaScript standard library');
console.log('\\nReady to review beside the terminal.');
`);
const layout = { cols: 2, rows: 2, areas: [0, 1, 2, 3].map(i => ({ col: i % 2, row: Math.floor(i / 2), colSpan: 1, rowSpan: 1 })) };
const cells = ['Tests', 'Catalog', 'Syntax check', 'Source review'].map((name, i) => ({ id: `readme-shell-${i}`, name, profileId: 'shell', color: ['#10b981', '#60a5fa', '#c084fc', '#fbbf24'][i] }));
const demoProject = { id: 'atlas', name: 'Atlas storefront', path: project, color: '#60a5fa', icon: { kind: 'emoji', value: '🌐' }, archive: [], activeTabId: 'development', tabs: [{ id: 'development', name: 'Development', layout, cells }] };
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'atlas', projects: [demoProject,
    { id: 'design', name: 'Design system', path: project, color: '#c084fc', icon: { kind: 'emoji', value: '🎨' }, tabs: [], archive: [], activeTabId: null },
    { id: 'api', name: 'Catalog API', path: project, color: '#10b981', icon: { kind: 'emoji', value: '⚡' }, tabs: [], archive: [], activeTabId: null }],
  profiles: [{ id: 'claude', name: 'Claude Code', cli: 'claude', args: '', color: '#d97757' }, { id: 'codex', name: 'Codex', cli: 'codex', args: '', color: '#10a37f' }, { id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#7a7a7a' }],
  snippets: [
    { id: 'review', name: 'Review changes', icon: '🔎', color: '#60a5fa', text: 'Review the diff. Focus on correctness and missing tests.', autoSend: false },
    { id: 'test', name: 'Add focused tests', icon: '🧪', color: '#10b981', text: 'Add focused tests for the behavior we changed.', autoSend: false },
    { id: 'plan', name: 'Plan the next step', icon: '📋', color: '#c084fc', text: 'Explain the next implementation step before editing.', autoSend: false }],
  presets: [{ id: 'review-team', name: 'Review team', layout, cells: ['Coordinator', 'Frontend', 'Backend', 'Tests'].map((name, i) => ({ name, profileId: i % 2 ? 'codex' : 'claude', role: i ? 'worker' : 'coordinator', worktree: false, prompt: ['Plan and coordinate the review.', 'Review the storefront accessibility.', 'Review catalog validation.', 'Check edge cases and tests.'][i] })) }],
  settings: { language: 'en', fontSize: 14, notifications: false, shell: process.platform === 'win32' ? 'cmd' : 'bash', lastProfileId: 'claude' },
  sidebarCollapsed: false, snippetsOpen: true, sidebarWidth: 230, snippetsWidth: 220,
}));
const port = await new Promise((resolvePort, reject) => {
  const probe = createServer(); probe.on('error', reject);
  probe.listen(0, '127.0.0.1', () => { const p = probe.address().port; probe.close(() => resolvePort(p)); });
});
const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const child = spawn(electron, ['.'], { cwd: checkout, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
let log = '', exited = false, socket, requestId = 0;
child.stdout.on('data', d => { log += d; }); child.stderr.on('data', d => { log += d; });
child.on('error', e => { log += e.message; exited = true; }); child.on('exit', () => { exited = true; });
const pending = new Map(), exceptions = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label) {
  const end = Date.now() + 30000;
  while (Date.now() < end) { const value = await fn(); if (value) return value; if (exited) throw new Error(`App exited: ${log}`); await sleep(100); }
  throw new Error(`Timeout: ${label}\n${log.slice(-3000)}`);
}
function cdp(method, params = {}) {
  const id = ++requestId;
  return new Promise((resolveRequest, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)); }, 10000);
    pending.set(id, { resolve: r => { clearTimeout(timer); resolveRequest(r); }, reject: e => { clearTimeout(timer); reject(e); } });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const result = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
  return result.result.value;
}
async function click(selector, text) {
  await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find(el => ${text ? `el.textContent.trim() === ${JSON.stringify(text)}` : 'true'}); if (!el) throw new Error('Missing control: ' + ${JSON.stringify(text ?? selector)}); el.click(); })()`);
}
async function key(key, code, modifiers = {}) {
  await evaluate(`(document.activeElement ?? window).dispatchEvent(new KeyboardEvent('keydown', ${JSON.stringify({ key, code, bubbles: true, ...modifiers })}))`);
}
async function screenshot(name) {
  await evaluate('document.fonts.ready'); await sleep(600);
  const { data: png } = await cdp('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
  writeFileSync(join(output, `${name}.png`), Buffer.from(png, 'base64'));
  console.log(`Captured ${name}.png`);
}
try {
  const target = await until(async () => { try { return (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'page'); } catch { return null; } }, 'debugger');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => {
    const message = JSON.parse(e.data);
    if (message.method === 'Runtime.exceptionThrown') exceptions.push(message.params.exceptionDetails.text);
    const p = pending.get(message.id); if (p) { pending.delete(message.id); message.error ? p.reject(new Error(message.error.message)) : p.resolve(message.result); }
  });
  await cdp('Runtime.enable');
  await cdp('Page.enable');
  // Electron does not expose Chrome's Browser window-management CDP methods.
  await cdp('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate('!!window.mc && document.querySelectorAll(".cell").length === 4'), 'four terminals');
  // Observe real PTY output and use its existing MessagePort to enter demo commands.
  await cdp('Page.addScriptToEvaluateOnNewDocument', { source: `window.__readmeOutput = {}; window.addEventListener('message', e => { if (e.data === 'mc:pty-port' && e.ports[0]) { window.__readmePort = e.ports[0]; e.ports[0].addEventListener('message', e => { if (e.data.t === 'data' || e.data.t === 'replay') window.__readmeOutput[e.data.id] = (window.__readmeOutput[e.data.id] || '') + e.data.data; }); } });` });
  await cdp('Page.reload');
  await until(() => evaluate('!!window.__readmePort'), 'PTY port');
  await until(async () => (await evaluate('window.mc.aliveCells()')).length === 4, 'running shells');
  const commands = ['node --test --test-reporter=spec', 'node inspect.mjs', 'node --check src/catalog.mjs && node --check test/catalog.test.mjs && echo JavaScript syntax checks passed.', 'node review.mjs'];
  for (let i = 0; i < cells.length; i++) {
    const command = process.platform === 'win32' ? `prompt Atlas$G & cls & ${commands[i]}\r` : `export PS1='Atlas> '; clear; ${commands[i]}\r`;
    await evaluate(`window.__readmePort.postMessage({ t: 'write', id: ${JSON.stringify(cells[i].id)}, data: ${JSON.stringify(command)} })`);
  }
  await until(() => evaluate(`window.__readmeOutput['readme-shell-0']?.includes('pass 6') && window.__readmeOutput['readme-shell-3']?.includes('Ready to review beside the terminal.')`), 'demo output');
  await screenshot('main');
  await click('#files-view');
  await until(() => evaluate('!!document.querySelector(".file-entry[title=src]")'), 'file tree');
  await click('.file-entry[title=src]');
  await until(() => evaluate(`!!document.querySelector(${JSON.stringify('.file-entry[title="src/catalog.mjs"]')})`), 'source file');
  await click('.file-entry[title="src/catalog.mjs"]');
  await until(() => evaluate('!!document.querySelector(".file-editor textarea, .monaco-editor, .cm-editor")'), 'integrated editor');
  await screenshot('editor');
  await evaluate(`(() => { const tab = [...document.querySelectorAll('.workspace-tabs .tab')].find(el => el.textContent.includes('Development')); if (!tab) throw new Error('Missing Development workspace tab'); tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 })); })()`);
  await click('#projects-view');
  await key('G', 'KeyG', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin', shiftKey: true });
  await until(() => evaluate('!!document.querySelector(".cell-table")'), 'grid dialog');
  await click('.presets span.btn', 'Review team');
  await screenshot('grid-dialog');
  await key('Escape', 'Escape');
  await key('k', 'KeyK', { ctrlKey: process.platform !== 'darwin', metaKey: process.platform === 'darwin' });
  await until(() => evaluate('!!document.querySelector(".palette")'), 'command palette');
  await screenshot('palette');
  if (process.argv.includes('--verify')) {
    await key('Escape', 'Escape');
    await until(() => evaluate('!document.querySelector(".palette")'), 'close palette before checks');
    await verifyWorkspaceUI({ cdp, evaluate, click, key, until, project, cells });
  }
  if (exceptions.length) throw new Error(`Renderer exceptions: ${exceptions.join('; ')}`);
  console.log(`Screenshots: ${output}\nIsolated demo data: ${root}`);
} catch (error) {
  console.error(error); process.exitCode = 1;
  if (socket?.readyState === WebSocket.OPEN) console.error(await evaluate('({ port: !!window.__readmePort, outputCells: Object.keys(window.__readmeOutput ?? {}), text: document.body.textContent.slice(0, 1800) })').catch(() => 'Renderer unavailable'));
} finally {
  if (socket?.readyState === WebSocket.OPEN) { await cdp('Browser.close').catch(() => {}); socket.close(); }
  for (let i = 0; i < 50 && !exited; i++) await sleep(100);
  if (!exited) {
    if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGTERM');
  }
}
