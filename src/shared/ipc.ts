// Messages between main ⇄ pty host (control) and renderer ⇄ pty host (data, via MessagePort).
import type { ShellKind } from './types';

export interface SpawnRequest {
  id: string;
  cwd: string;
  cols: number;
  rows: number;
  env: Record<string, string>;
  shell: ShellKind;
  /** Typed into the shell once it printed its first output (agent launch command). */
  command?: string;
  /** Also forward the output to the main process (only the install window, which parses an end marker). */
  tap?: boolean;
}

export type MainToHost =
  | { t: 'spawn'; req: SpawnRequest }
  | { t: 'kill'; id: string; ack?: boolean }
  | { t: 'killAll' };

export type HostToMain =
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'spawnError'; id: string; message: string }
  | { t: 'exit'; id: string; code: number }
  /** Output of a terminal spawned with `tap`. */
  | { t: 'tap'; id: string; data: string }
  | { t: 'killed'; id: string }
  | { t: 'killedAll' };

export type RendererToHost =
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number }
  /** The renderer finished parsing `chars` characters of output (flow control). */
  | { t: 'ack'; id: string; chars: number };

export type HostToRenderer =
  | { t: 'data'; id: string; data: string }
  | { t: 'replay'; id: string; data: string }
  | { t: 'exit'; id: string; code: number };
