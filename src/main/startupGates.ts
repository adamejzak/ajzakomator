// Startup gates (0.9.4): the window opens before the startup steps finish, so what must still come first waits on a gate.
// No Electron imports, so it is tested in Node.
import type { CliKind } from '../shared/types';

export interface StartupGate { promise: Promise<void>; open(): void; isOpen(): boolean }

export function createStartupGate(): StartupGate {
  let open!: () => void;
  let opened = false;
  const promise = new Promise<void>((resolve) => { open = resolve; });
  return { promise, open: () => { opened = true; open(); }, isOpen: () => opened };
}

export interface SpawnGates {
  /** Hook server and MCP server listening, files of removed cells and old startup prompts pruned. */
  cellServices: StartupGate;
  /** The recovery of an interrupted account switch finished (the live ~/.claude login is consistent again). */
  accountsRecovered: StartupGate;
}

/**
 * What a cell spawn waits for: Claude cells use the live Claude login, so they wait for the account recovery; every agent
 * waits for the hook and MCP servers. A plain shell waits for nothing, unless it gets a startup prompt (the prompt file
 * must not be pruned before the shell reads it).
 */
export function spawnWaitsFor(gates: SpawnGates, req: { cli: CliKind; startupPrompt?: string }): Promise<void>[] {
  const waits: Promise<void>[] = [];
  if (req.cli !== 'shell' || !!req.startupPrompt?.trim()) waits.push(gates.cellServices.promise);
  if (req.cli === 'claude') waits.push(gates.accountsRecovered.promise);
  return waits;
}
