// Owns one xterm.js instance per cell for the app's lifetime. Hidden cells keep their terminal in
// an off-screen "parking" element so output keeps flowing; visible cells get a WebGL renderer.
import { FitAddon } from '@xterm/addon-fit';
import { Unicode11Addon } from '@xterm/addon-unicode11';
import { WebglAddon } from '@xterm/addon-webgl';
import { Terminal, type ITheme } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import type { HostToRenderer, RendererToHost } from '../../../shared/ipc';
import { StatusTracker, type CellStatus, type HookEvent } from '../../../shared/status';
import { encodeWin32Key } from '../../../shared/win32input';
import { tr } from '../i18n';
import { confirmTerminalLink } from '../terminalLinks';

// Campbell (Windows Terminal / PowerShell default) on a Cursor-like background.
export const THEME: ITheme = {
  background: '#0d0d0d', foreground: '#cccccc', cursor: '#cccccc', cursorAccent: '#0d0d0d',
  selectionBackground: '#264f78', selectionInactiveBackground: '#264f7880',
  black: '#0c0c0c', red: '#c50f1f', green: '#13a10e', yellow: '#c19c00', blue: '#0037da',
  magenta: '#881798', cyan: '#3a96dd', white: '#cccccc',
  brightBlack: '#767676', brightRed: '#e74856', brightGreen: '#16c60c', brightYellow: '#f9f1a5',
  brightBlue: '#3b78ff', brightMagenta: '#b4009e', brightCyan: '#61d6d6', brightWhite: '#f2f2f2',
};

const FONT = '"Cascadia Mono", "Cascadia Code", Consolas, Menlo, "SFMono-Regular", "Courier New", monospace';
const PENDING_LIMIT = 512 * 1024;

interface Entry {
  id: string;
  term: Terminal;
  fit: FitAddon;
  webgl: WebglAddon | null;
  host: HTMLDivElement;
  tracker: StatusTracker;
  win32: boolean;
  agent: boolean;
  attachedTo: HTMLElement | null;
  resizeObs: ResizeObserver | null;
  /** >0 while replayed history is being parsed: terminal query replies must not reach the pty. */
  replaying: number;
  lastSize: { cols: number; rows: number };
}

type StatusListener = (cellId: string, status: CellStatus, prev: CellStatus) => void;

export interface EnsureOptions {
  fontSize: number;
  agent: boolean;
  onFontSize?: (size: number) => void;
}

class TerminalManager {
  private entries = new Map<string, Entry>();
  private port: MessagePort | null = null;
  private pending = new Map<string, Array<{ data: string; replay: boolean }>>();
  private exited = new Set<string>();
  private disposed = new Set<string>();
  private statusListeners = new Set<StatusListener>();
  private exitListeners = new Set<(cellId: string) => void>();
  private parking: HTMLDivElement;
  private buildNumber = 0;

  constructor() {
    this.parking = document.createElement('div');
    this.parking.style.cssText = 'position:fixed;left:-20000px;top:0;width:1200px;height:800px;overflow:hidden;visibility:hidden;';
    document.body.appendChild(this.parking);
    window.addEventListener('message', (e) => {
      if (e.data === 'mc:pty-port' && e.ports[0]) this.setPort(e.ports[0]);
    });
    setInterval(() => this.tickStatuses(), 400);
  }

  setWindowsBuild(n: number): void {
    this.buildNumber = n;
  }

  private setPort(port: MessagePort): void {
    this.port?.close();
    this.port = port;
    port.onmessage = (e) => this.onHostMessage(e.data as HostToRenderer);
    port.start();
    // Tell the host about the sizes we already know (e.g. after a host restart).
    for (const e of this.entries.values()) this.post({ t: 'resize', id: e.id, cols: e.term.cols, rows: e.term.rows });
  }

  private post(m: RendererToHost): void {
    this.port?.postMessage(m);
  }

  private onHostMessage(m: HostToRenderer): void {
    if (m.t === 'exit') {
      this.exited.add(m.id);
      const e = this.entries.get(m.id);
      if (e) {
        e.term.write(`\r\n\x1b[90m[${tr('Terminal')} · ${tr('zakończony')}]\x1b[0m\r\n`);
        this.setStatus(e, () => e.tracker.exited());
      }
      this.exitListeners.forEach((l) => l(m.id));
      return;
    }
    const e = this.entries.get(m.id);
    if (!e) {
      if (this.disposed.has(m.id)) return; // in-flight output of a closed cell
      const q = this.pending.get(m.id) ?? [];
      if (m.t === 'replay') q.length = 0;
      q.push({ data: m.data, replay: m.t === 'replay' });
      // Bound memory for busy cells that are never shown: keep roughly the newest PENDING_LIMIT.
      let size = q.reduce((n, x) => n + x.data.length, 0);
      while (size > PENDING_LIMIT && q.length > 1) size -= q.shift()!.data.length;
      this.pending.set(m.id, q);
      return;
    }
    if (m.t === 'replay') {
      e.term.reset();
      this.writeReplay(e, m.data);
    } else {
      e.term.write(m.data);
      e.tracker.output(performance.now());
    }
  }

  private writeReplay(e: Entry, data: string): void {
    e.replaying++;
    e.term.write(data, () => e.replaying--);
  }

  has(cellId: string): boolean {
    return this.entries.has(cellId);
  }

  ensure(cellId: string, opts: EnsureOptions): Entry {
    const existing = this.entries.get(cellId);
    if (existing) {
      existing.agent = opts.agent;
      return existing;
    }
    this.disposed.delete(cellId);
    const host = document.createElement('div');
    host.className = 'term-host';
    this.parking.appendChild(host);

    const term = new Terminal({
      theme: THEME,
      linkHandler: { activate: (event, address) => { event.preventDefault(); void confirmTerminalLink(address); } },
      fontFamily: FONT,
      fontSize: opts.fontSize,
      lineHeight: 1.1,
      cursorBlink: true,
      scrollback: 10000,
      allowProposedApi: true,
      ...(window.mc.platform === 'win32' ? { windowsPty: { backend: 'conpty' as const, buildNumber: this.buildNumber || 26100 } } : {}),
      rightClickSelectsWord: false,
      drawBoldTextInBrightColors: false,
      minimumContrastRatio: 1,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.loadAddon(new Unicode11Addon());
    term.unicode.activeVersion = '11';
    term.open(host);

    const entry: Entry = {
      id: cellId, term, fit, webgl: null, host, tracker: new StatusTracker(), win32: false, agent: opts.agent,
      attachedTo: null, resizeObs: null, replaying: 0, lastSize: { cols: term.cols, rows: term.rows },
    };
    this.entries.set(cellId, entry);

    // ConPTY asks its host terminal for win32-input-mode with CSI ? 9001 h.
    const setW32 = (on: boolean) => (params: (number | number[])[]) => {
      if (window.mc.platform === 'win32' && params.includes(9001)) entry.win32 = on;
      return false; // let xterm process the remaining modes
    };
    term.parser.registerCsiHandler({ prefix: '?', final: 'h' }, setW32(true));
    term.parser.registerCsiHandler({ prefix: '?', final: 'l' }, setW32(false));
    // Codex (tui.notifications) and others signal "needs attention" with OSC 9.
    term.parser.registerOscHandler(9, (payload) => {
      // 9;4;... = progress, 9;9;... = cwd reporting (oh-my-posh etc.) - not notifications.
      if (/^(4|9);/.test(payload)) return true;
      if (entry.agent) this.setStatus(entry, () => entry.tracker.osc9());
      return true;
    });
    term.onBell(() => {
      if (entry.agent) this.setStatus(entry, () => entry.tracker.osc9());
    });

    term.attachCustomKeyEventHandler((ev) => this.handleKey(entry, ev));
    term.onData((d) => {
      if (entry.replaying > 0) return;
      entry.tracker.input(performance.now(), d.includes('\r'));
      this.post({ t: 'write', id: cellId, data: d });
    });
    term.onBinary((d) => entry.replaying === 0 && this.post({ t: 'write', id: cellId, data: d }));

    host.addEventListener('wheel', (ev) => {
      if (!ev.ctrlKey && !(window.mc.platform === 'darwin' && ev.metaKey)) return;
      ev.preventDefault();
      ev.stopPropagation();
      const size = Math.max(8, Math.min(32, (term.options.fontSize ?? 13) + (ev.deltaY < 0 ? 1 : -1)));
      term.options.fontSize = size;
      this.refit(entry);
      opts.onFontSize?.(size);
    }, { passive: false, capture: true });

    host.addEventListener('contextmenu', (ev) => {
      ev.preventDefault();
      if (term.hasSelection()) {
        window.mc.clipboardWrite(term.getSelection());
        term.clearSelection();
      } else {
        this.pasteFromClipboard(entry);
      }
    });

    const queued = this.pending.get(cellId);
    if (queued) {
      this.pending.delete(cellId);
      for (const q of queued) {
        if (q.replay) this.writeReplay(entry, q.data);
        else term.write(q.data);
      }
    }
    return entry;
  }

  private handleKey(entry: Entry, ev: KeyboardEvent): boolean {
    const { term } = entry;
    const ctrl = ev.ctrlKey && !ev.altKey && !ev.metaKey && !ev.getModifierState('AltGraph');
    const command = window.mc.platform === 'darwin' && ev.metaKey && !ev.ctrlKey && !ev.altKey;

    if (ev.type === 'keydown' && (ctrl || command)) {
      // Copy: Ctrl+C with a selection, Ctrl+Shift+C always.
      if (ev.code === 'KeyC' && (term.hasSelection() || ev.shiftKey || command)) {
        if (term.hasSelection()) window.mc.clipboardWrite(term.getSelection());
        term.clearSelection();
        ev.preventDefault();
        return false;
      }
      // Paste text; without text in the clipboard (e.g. an image) forward the key so the app
      // (Claude image paste) can handle it.
      if (ev.code === 'KeyV') {
        ev.preventDefault();
        const key = { type: 'keydown', code: ev.code, key: ev.key, ctrlKey: true, altKey: false, shiftKey: ev.shiftKey };
        void window.mc.clipboardRead().then((text) => {
          if (text) entry.term.paste(text);
          else if (entry.win32) this.post({ t: 'write', id: entry.id, data: encodeWin32Key(key)! + encodeWin32Key({ ...key, type: 'keyup' })! });
          else this.post({ t: 'write', id: entry.id, data: '\x16' });
        });
        return false;
      }
    }
    if (entry.win32) {
      if (ev.type !== 'keydown' && ev.type !== 'keyup') return false;
      if (ev.isComposing || ev.keyCode === 229) return true; // IME
      const seq = encodeWin32Key(ev);
      if (!seq) return true;
      ev.preventDefault();
      if (ev.type === 'keydown') entry.tracker.input(performance.now(), ev.code === 'Enter' || ev.code === 'NumpadEnter');
      this.post({ t: 'write', id: entry.id, data: seq });
      return false;
    }
    return true;
  }

  private pasteFromClipboard(entry: Entry): void {
    void window.mc.clipboardRead().then((text) => text && entry.term.paste(text));
  }

  /** Pastes text as one bracketed-paste block; `submit` presses Enter afterwards. */
  paste(cellId: string, text: string, submit: boolean): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.term.paste(text);
    if (submit) {
      // Separate write so TUIs see Enter after the paste block, not inside it.
      setTimeout(() => {
        e.tracker.input(performance.now(), true);
        this.post({ t: 'write', id: cellId, data: e.win32 ? '\x1b[13;28;13;1;0;1_\x1b[13;28;13;0;0;1_' : '\r' });
      }, 60);
    }
    e.term.focus();
  }

  attach(cellId: string, el: HTMLElement): void {
    const e = this.entries.get(cellId);
    if (!e || e.attachedTo === el) return;
    el.appendChild(e.host);
    e.attachedTo = el;
    if (!e.webgl) {
      try {
        const webgl = new WebglAddon();
        webgl.onContextLoss(() => {
          webgl.dispose();
          if (e.webgl === webgl) e.webgl = null;
        });
        e.term.loadAddon(webgl);
        e.webgl = webgl;
      } catch {
        e.webgl = null; // DOM renderer fallback
      }
    }
    e.resizeObs?.disconnect();
    let t: number | undefined;
    e.resizeObs = new ResizeObserver(() => {
      clearTimeout(t);
      t = window.setTimeout(() => this.refit(e), 25);
    });
    e.resizeObs.observe(el);
    this.refit(e);
  }

  detach(cellId: string, el: HTMLElement): void {
    const e = this.entries.get(cellId);
    if (!e || e.attachedTo !== el) return;
    e.resizeObs?.disconnect();
    e.resizeObs = null;
    e.webgl?.dispose();
    e.webgl = null;
    this.parking.appendChild(e.host);
    e.attachedTo = null;
  }

  private refit(e: Entry): void {
    if (!e.attachedTo || !e.attachedTo.isConnected) return;
    const { clientWidth, clientHeight } = e.attachedTo;
    if (clientWidth < 20 || clientHeight < 20) return;
    try {
      e.fit.fit();
    } catch {
      return;
    }
    if (e.term.cols !== e.lastSize.cols || e.term.rows !== e.lastSize.rows) {
      e.lastSize = { cols: e.term.cols, rows: e.term.rows };
      this.post({ t: 'resize', id: e.id, cols: e.term.cols, rows: e.term.rows });
    }
  }

  /** Re-sends the current size (e.g. right after a spawn that raced with a resize). */
  syncSize(cellId: string): void {
    const e = this.entries.get(cellId);
    if (e) this.post({ t: 'resize', id: cellId, cols: e.term.cols, rows: e.term.rows });
  }

  size(cellId: string): { cols: number; rows: number } {
    const e = this.entries.get(cellId);
    return e ? { cols: e.term.cols, rows: e.term.rows } : { cols: 120, rows: 30 };
  }

  focus(cellId: string): void {
    this.entries.get(cellId)?.term.focus();
  }

  isFocused(cellId: string): boolean {
    const e = this.entries.get(cellId);
    return !!e && document.activeElement === e.term.textarea;
  }

  setFontSize(cellId: string, size: number): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.term.options.fontSize = size;
    this.refit(e);
  }

  /** Called right before (re)spawning the pty for a cell. */
  prepareSpawn(cellId: string): void {
    const e = this.entries.get(cellId);
    this.exited.delete(cellId);
    if (!e) return;
    e.win32 = false;
    e.term.reset();
    this.setStatus(e, () => e.tracker.reset());
  }

  dispose(cellId: string): void {
    const e = this.entries.get(cellId);
    if (!e) return;
    e.resizeObs?.disconnect();
    e.term.dispose();
    e.host.remove();
    this.entries.delete(cellId);
    this.pending.delete(cellId);
    this.disposed.add(cellId);
  }

  // ── statuses ──────────────────────────────────────────────────────────────

  status(cellId: string): CellStatus {
    return this.entries.get(cellId)?.tracker.status ?? 'idle';
  }

  hook(cellId: string, event: HookEvent): void {
    const e = this.entries.get(cellId);
    if (e) this.setStatus(e, () => e.tracker.hook(event));
  }

  acknowledge(cellId: string): void {
    const e = this.entries.get(cellId);
    if (e) this.setStatus(e, () => e.tracker.acknowledge());
  }

  onStatus(l: StatusListener): () => void {
    this.statusListeners.add(l);
    return () => this.statusListeners.delete(l);
  }

  onExit(l: (cellId: string) => void): () => void {
    this.exitListeners.add(l);
    return () => this.exitListeners.delete(l);
  }

  private setStatus(e: Entry, change: () => void): void {
    const prev = e.tracker.status;
    change();
    if (e.tracker.status !== prev) this.statusListeners.forEach((l) => l(e.id, e.tracker.status, prev));
  }

  private tickStatuses(): void {
    const now = performance.now();
    for (const e of this.entries.values()) this.setStatus(e, () => e.tracker.tick(now));
  }
}

export const terminals = new TerminalManager();
