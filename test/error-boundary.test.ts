// The renderer's ErrorBoundary with no DOM: a render error shows the fallback (with a retry) and is reported to main.
import { readFileSync } from 'node:fs';
import { beforeAll, describe, expect, it, vi } from 'vitest';

let mod: any;
let react: any;
let server: any;
const reportError = vi.fn();
beforeAll(async () => {
  (globalThis as any).window = { mc: { reportError } };
  const modulePath = '../src/renderer/src/components/ErrorBoundary';
  mod = await import(/* @vite-ignore */ modulePath);
  react = await import('react');
  server = await import('react-dom/server');
});

describe('ErrorBoundary', () => {
  it('draws the children until one throws, then the fallback', () => {
    const { ErrorBoundary } = mod;
    const ok = server.renderToStaticMarkup(react.createElement(ErrorBoundary, { name: 'cell', fallback: () => 'fallback' }, react.createElement('b', null, 'cell')));
    expect(ok).toBe('<b>cell</b>');
    expect(ErrorBoundary.getDerivedStateFromError(new Error('x'))).toEqual({ failed: true });
  });

  it('renders the fallback with a retry that draws the children again, and reports the error', () => {
    const { ErrorBoundary } = mod;
    const retries: Array<() => void> = [];
    const boundary = new ErrorBoundary({ name: 'cell', fallback: (retry: () => void) => { retries.push(retry); return 'fallback'; }, children: 'child' });
    boundary.setState = (next: object) => { boundary.state = { ...boundary.state, ...next }; };
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error('boom'));
    boundary.componentDidCatch(new Error('boom'));
    expect(boundary.render()).toBe('fallback');
    expect(reportError).toHaveBeenCalledWith('boundary', 'Error: cell: boom', expect.any(String));
    retries[0]();
    expect(boundary.render()).toBe('child');
  });

  it('keeps a failed cell in its grid box with a retry button', () => {
    const { CellFallback } = mod;
    const html = server.renderToStaticMarkup(react.createElement(CellFallback, { style: { left: '50%', top: 0, width: '50%', height: '100%' }, retry: () => {} }));
    expect(html).toContain('class="cell cell-failed"');
    expect(html).toContain('left:50%');
    expect(html).toContain('<button');
  });

  it('fallback cards read the language reactively (the hoisted status bar, palette and modal boundaries in App.tsx never re-render)', () => {
    const source = readFileSync('src/renderer/src/components/ErrorBoundary.tsx', 'utf8');
    expect(source).toMatch(/function PanelFallback[^\n]*\n\s+const \{ tr \} = useI18n\(\);/);
    expect(source).toMatch(/function CellFallback[^\n]*\n\s+const \{ tr \} = useI18n\(\);/);
    const app = readFileSync('src/renderer/src/App.tsx', 'utf8');
    expect(app).toMatch(/^const statusBar = <ErrorBoundary name="statusbar" fallback=\{\(retry\) => <PanelFallback /m);
  });
});
