// Startup / idle profile of the built app (run `npm run build` first): 6 shell cells in isolated data, then 8 s of idle CPU profile.
// Prints boot time, first paint, renderer heap and DOM size, the CPU the renderer used while idle and the memory of the process tree.
// Usage: npm run perf [-- label]
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electron from 'electron';

const repo = process.cwd();
const label = process.argv[2] ?? 'run';
const root = mkdtempSync(join(tmpdir(), 'unimux-perf-'));
const data = join(root, 'data');
mkdirSync(data);
const areas = Array.from({ length: 6 }, (_, i) => ({ col: i % 3, row: Math.floor(i / 3), colSpan: 1, rowSpan: 1 }));
writeFileSync(join(data, 'state.json'), JSON.stringify({
  version: 1, activeProjectId: 'p', projects: [{ id: 'p', name: 'Perf', path: root, color: '#3b82f6', archive: [], activeTabId: 't', tabs: [{
    id: 't', name: 'Grid', layout: { cols: 3, rows: 2, areas },
    cells: Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, name: `Shell ${i + 1}`, profileId: 'shell' })),
  }] }],
  profiles: [{ id: 'shell', name: 'Terminal', cli: 'shell', args: '', color: '#888888' }],
  snippets: [], presets: [], settings: { language: 'pl', fontSize: 13, shell: 'cmd', lastProfileId: 'shell' },
  sidebarCollapsed: false, snippetsOpen: true, sidebarWidth: 228, snippetsWidth: 210,
}));
const port = await new Promise((res, rej) => { const s = createServer(); s.on('error', rej); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const env = { ...process.env, MC_DATA_DIR: data, MC_OFFSCREEN: '1', MC_DEBUG_PORT: String(port) };
delete env.ELECTRON_RUN_AS_NODE; delete env.ELECTRON_RENDERER_URL;
const t0 = Date.now();
const child = spawn(electron, ['.'], { cwd: repo, env, windowsHide: true, stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let socket, id = 0; const pending = new Map();
const cdp = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, { res, rej }); socket.send(JSON.stringify({ id: i, method, params })); });
const evaluate = async (expression) => (await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result.value;
try {
  let target;
  for (let i = 0; i < 200 && !target; i++) { try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find((t) => t.type === 'page'); } catch {} if (!target) await sleep(100); }
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => socket.addEventListener('open', r, { once: true }));
  socket.addEventListener('message', (e) => { const m = JSON.parse(e.data); const p = pending.get(m.id); if (p) { pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } });
  await cdp('Runtime.enable');
  let bootMs = null;
  for (let i = 0; i < 300; i++) { if (await evaluate('Boolean(document.querySelector(".cell .xterm"))')) { bootMs = Date.now() - t0; break; } await sleep(100); }
  await sleep(4000); // let the shells settle
  const nav = await evaluate(`JSON.stringify((() => { const n = performance.getEntriesByType('navigation')[0]; const p = Object.fromEntries(performance.getEntriesByType('paint').map(e => [e.name, Math.round(e.startTime)])); return { dcl: Math.round(n.domContentLoadedEventEnd), load: Math.round(n.loadEventEnd), ...p }; })())`);
  const mem = await evaluate(`JSON.stringify({ heapMB: Math.round(performance.memory.usedJSHeapSize / 1048576), dom: document.getElementsByTagName('*').length, terms: document.querySelectorAll('.xterm').length })`);
  await cdp('Profiler.enable');
  await cdp('Profiler.start');
  await sleep(8000);
  const { profile } = await cdp('Profiler.stop');
  const self = new Map(); const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  profile.samples.forEach((sid, i) => { const n = byId.get(sid); const k = `${n.callFrame.functionName || '(anon)'} ${n.callFrame.url.split('/').slice(-2).join('/')}:${n.callFrame.lineNumber}`; self.set(k, (self.get(k) ?? 0) + (profile.timeDeltas[i] ?? 0)); });
  const total = profile.endTime - profile.startTime;
  const idle = [...self.entries()].filter(([k]) => k.startsWith('(idle)') || k.startsWith('(program)')).reduce((a, [, v]) => a + v, 0);
  const top = [...self.entries()].filter(([k]) => !k.startsWith('(idle)') && !k.startsWith('(program)') && !k.startsWith('(garbage')).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => `${(v / 1000).toFixed(1)}ms ${k}`);
  // memory of the whole process tree (working set)
  const ps = execFileSync('powershell', ['-NoProfile', '-Command', `$p = Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -like '*node_modules*electron*' -or $_.ExecutablePath -like '*node_modules\\\\electron*' }; $m = ($p | Measure-Object WorkingSetSize -Sum).Sum / 1MB; "{0:N0} MB in {1} processes" -f $m, $p.Count`], { encoding: 'utf8' }).trim();
  console.log(JSON.stringify({ label, bootToTerminalsMs: bootMs, nav: JSON.parse(nav), renderer: JSON.parse(mem), idleCpuActiveMsOf8000: Math.round((total - idle) / 1000), processTree: ps }, null, 1));
  console.log('top idle self-time:\n' + top.join('\n'));
} finally { child.kill(); }
