import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type ReactNode } from 'react';
import { tr } from '../i18n';

/** Catches a failed chunk load (or a crash while rendering the screen) so the rest of the app stays usable, and offers a retry. */
class Boundary extends Component<{ onRetry(): void; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div className="empty" role="alert">
        <div className="welcome">
          <div className="sub">{tr('Nie udało się wczytać tego widoku.')}</div>
          <button className="btn" onClick={() => { this.setState({ failed: false }); this.props.onRetry(); }}>{tr('Spróbuj ponownie')}</button>
        </div>
      </div>
    );
  }
}

/** A screen loaded on demand. `load` must be a stable function (a module constant): a retry imports the chunk again. */
export function LazyScreen({ load }: { load: () => Promise<{ default: ComponentType }> }) {
  const [attempt, setAttempt] = useState(0);
  const Screen = useMemo(() => lazy(load), [load, attempt]); // eslint-disable-line react-hooks/exhaustive-deps
  return <Boundary onRetry={() => setAttempt((n) => n + 1)}><Suspense fallback={null}><Screen /></Suspense></Boundary>;
}
