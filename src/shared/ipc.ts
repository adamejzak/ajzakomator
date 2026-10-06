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
}

export type MainToHost =
  | { t: 'spawn'; req: SpawnRequest }
  | { t: 'kill'; id: string }
  | { t: 'killAll' };

export type HostToMain =
  | { t: 'spawned'; id: string; pid: number }
  | { t: 'spawnError'; id: string; message: string }
  | { t: 'exit'; id: string; code: number }
  | { t: 'killedAll' };

export type RendererToHost =
  | { t: 'write'; id: string; data: string }
  | { t: 'resize'; id: string; cols: number; rows: number };

export type HostToRenderer =
  | { t: 'data'; id: string; data: string }
  | { t: 'replay'; id: string; data: string }
  | { t: 'exit'; id: string; code: number };
