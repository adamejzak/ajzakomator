import { Component, lazy, Suspense, useMemo, useState, type ComponentType, type LazyExoticComponent, type ReactNode } from 'react';
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
type Loader = () => Promise<{ default: ComponentType }>;
/** One lazy component per loader: a screen opened again (the Git panel) renders at once instead of showing nothing first. */
const screens = new Map<Loader, LazyExoticComponent<ComponentType>>();
export function LazyScreen({ load }: { load: Loader }) {
  const [attempt, setAttempt] = useState(0);
  const Screen = useMemo(() => {
    // A retry imports the chunk again (a failed lazy component stays failed).
    let screen = attempt === 0 ? screens.get(load) : undefined;
    if (!screen) { screen = lazy(load); screens.set(load, screen); }
    return screen;
  }, [load, attempt]);
  return <Boundary onRetry={() => setAttempt((n) => n + 1)}><Suspense fallback={null}><Screen /></Suspense></Boundary>;
}
