// Pty Host entry (Electron utilityProcess). Control messages come from main via parentPort;
// terminal data flows directly to/from the renderer over a transferred MessagePort.
import type { MessagePortMain } from 'electron';
import type { HostToMain, HostToRenderer, MainToHost, RendererToHost } from '../shared/ipc';
import { PtyManager } from './manager';

const parentPort = process.parentPort;
let rendererPort: MessagePortMain | null = null;

const toMain = (m: HostToMain) => parentPort.postMessage(m);
const toRenderer = (m: HostToRenderer) => rendererPort?.postMessage(m);

const manager = new PtyManager({
  data: (id, data) => toRenderer({ t: 'data', id, data }),
  exit: (id, code) => {
    toRenderer({ t: 'exit', id, code });
    toMain({ t: 'exit', id, code });
  },
});

function attachRenderer(port: MessagePortMain): void {
  rendererPort?.close();
  rendererPort = port;
  port.on('message', (e) => {
    const m = e.data as RendererToHost;
    if (m.t === 'write') manager.write(m.id, m.data);
    else if (m.t === 'resize') manager.resize(m.id, m.cols, m.rows);
  });
  port.start();
  for (const h of manager.histories()) toRenderer({ t: 'replay', id: h.id, data: h.data });
}

parentPort.on('message', async (e) => {
  const m = e.data as MainToHost | { t: 'port' };
  switch (m.t) {
    case 'port':
      attachRenderer(e.ports[0]);
      break;
    case 'spawn':
      try {
        toMain({ t: 'spawned', id: m.req.id, pid: manager.spawn(m.req) });
      } catch (err) {
        toMain({ t: 'spawnError', id: m.req.id, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    case 'kill':
      manager.kill(m.id);
      break;
    case 'killAll':
      await manager.killAll();
      toMain({ t: 'killedAll' });
      break;
  }
});
