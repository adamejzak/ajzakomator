// Pty Host entry (Electron utilityProcess). Control messages come from main via parentPort;
// terminal data flows directly to/from the renderer over a transferred MessagePort.
import type { MessagePortMain } from 'electron';
import type { HostToMain, HostToRenderer, MainToHost, RendererToHost } from '../shared/ipc';
import { PtyManager } from './manager';
import { HostRouter } from './router';

const parentPort = process.parentPort;
let rendererPort: MessagePortMain | null = null;

const toMain = (m: HostToMain) => parentPort.postMessage(m);
const toRenderer = (m: HostToRenderer): boolean => {
  if (!rendererPort) return false;
  rendererPort.postMessage(m);
  return true;
};

/** Terminals whose output main also wants to read (the install window). */
const tapped = new Set<string>();

const manager = new PtyManager({
  data: (id, data) => {
    if (tapped.has(id)) toMain({ t: 'tap', id, data });
    return toRenderer({ t: 'data', id, data });
  },
  exit: (id, code) => {
    tapped.delete(id);
    toRenderer({ t: 'exit', id, code });
    toMain({ t: 'exit', id, code });
  },
});
/** Sends renderer messages and kills to the backend that owns the terminal. */
const router = new HostRouter([manager]);

function attachRenderer(port: MessagePortMain): void {
  rendererPort?.close();
  rendererPort = port;
  port.on('message', (e) => {
    const m = e.data as RendererToHost;
    if (m.t === 'write') {
      router.write(m.id, m.data);
      if (tapped.has(m.id) && m.data.includes('\x03')) toMain({ t: 'interrupt', id: m.id });
    } else if (m.t === 'resize') router.resize(m.id, m.cols, m.rows);
    else if (m.t === 'ack') router.ack(m.id, m.chars);
  });
  port.on('close', () => {
    // Only the current port counts: replacing it closes the old one after the new one is in place.
    if (rendererPort !== port) return;
    rendererPort = null;
    router.setFlowControl(false);
  });
  port.start();
  router.setFlowControl(true);
  for (const h of router.histories()) toRenderer({ t: 'replay', id: h.id, data: h.data });
}

parentPort.on('message', async (e) => {
  const m = e.data as MainToHost | { t: 'port' };
  switch (m.t) {
    case 'port':
      attachRenderer(e.ports[0]);
      break;
    case 'spawn':
      try {
        if (m.req.tap) tapped.add(m.req.id);
        const early = router.takeEarlySize(m.req.id);
        toMain({ t: 'spawned', id: m.req.id, pid: manager.spawn(early ? { ...m.req, ...early } : m.req) });
      } catch (err) {
        tapped.delete(m.req.id);
        toMain({ t: 'spawnError', id: m.req.id, message: err instanceof Error ? err.message : String(err) });
      }
      break;
    case 'kill':
      tapped.delete(m.id);
      await router.kill(m.id);
      if (m.ack) toMain({ t: 'killed', id: m.id });
      break;
    case 'killAll':
      tapped.clear();
      await router.killAll();
      toMain({ t: 'killedAll' });
      break;
  }
});
