import { Component, type CSSProperties, type ReactNode } from 'react';
import { tr } from '../i18n';
import { reportError } from '../errorReport';

interface Props {
  /** Which part failed, for the log ("cell", "sidebar", ...). */
  name: string;
  /** What is drawn instead; `retry` draws the children again. */
  fallback: (retry: () => void) => ReactNode;
  children: ReactNode;
}

/**
 * A render error in one part of the window (a cell, the sidebar, the status bar) stays in that part: React would otherwise
 * unmount the whole root and leave a blank window. Terminals keep running in the Pty Host meanwhile.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError(): { failed: boolean } { return { failed: true }; }
  componentDidCatch(error: unknown): void {
    reportError('boundary', error instanceof Error ? Object.assign(new Error(`${this.props.name}: ${error.message}`), { stack: error.stack }) : `${this.props.name}: ${String(error)}`);
  }
  retry = (): void => { this.setState({ failed: false }); };
  render(): ReactNode {
    return this.state.failed ? this.props.fallback(this.retry) : this.props.children;
  }
}

/** A cell that failed to draw: its box stays in the grid with a retry (the terminal keeps running behind it). */
export function CellFallback({ style, retry }: { style: CSSProperties; retry: () => void }) {
  return (
    <div className="cell cell-failed" style={style} role="alert">
      <div className="cell-failed-body">
        <div>{tr('Nie udało się narysować tej komórki.')}</div>
        <button className="btn" onClick={retry}>{tr('Spróbuj ponownie')}</button>
      </div>
    </div>
  );
}

/** A panel (sidebar, status bar, snippets) that failed to draw. */
export function PanelFallback({ retry, className }: { retry: () => void; className?: string }) {
  return (
    <div className={`panel-failed ${className ?? ''}`} role="alert">
      <span>{tr('Nie udało się narysować tej części okna.')}</span>
      <button className="btn" onClick={retry}>{tr('Spróbuj ponownie')}</button>
    </div>
  );
}

/** Everything failed to draw (or the start did): the window can be loaded again, the terminals survive a reload. */
export function WindowFallback({ message, retry }: { message?: string; retry?: () => void }) {
  return (
    <div className="app window-failed" role="alert">
      <div className="welcome">
        <div className="sub">{message ?? tr('Nie udało się narysować okna aplikacji.')}</div>
        <div className="row">
          {retry && <button className="btn" onClick={retry}>{tr('Spróbuj ponownie')}</button>}
          <button className="btn white" onClick={() => window.location.reload()}>{tr('Wczytaj okno ponownie')}</button>
        </div>
      </div>
    </div>
  );
}
