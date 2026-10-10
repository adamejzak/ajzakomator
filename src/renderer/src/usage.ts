import { useEffect, useState } from 'react';
import type { UsageState } from '../../shared/usage';

/** Live limits of the signed-in Claude and Codex accounts. */
export function useUsage(): UsageState {
  const [state, setState] = useState<UsageState>({ providers: [] });
  useEffect(() => {
    let alive = true;
    const unsubscribe = window.mc.on('usage:state', (next) => { if (alive) setState(next); });
    void window.mc.getUsage().then((initial) => { if (alive) setState((current) => (current.providers.length ? current : initial)); }).catch(() => undefined);
    return () => { alive = false; unsubscribe(); };
  }, []);
  return state;
}
