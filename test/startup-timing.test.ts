import { describe, expect, it } from 'vitest';
import { createStartupLog, createStartupTimer, isRendererMark, startupLogText, STARTUP_LOG_LINES } from '../src/main/startupTiming';

describe('startup timing', () => {
  it('records each mark once, in order, rounded to milliseconds', () => {
    let t = 10.4;
    const timer = createStartupTimer(() => t);
    timer.mark('modules-loaded');
    t = 120.6;
    timer.mark('app-ready');
    t = 500;
    timer.mark('modules-loaded');
    expect(timer.line()).toBe('modules-loaded=10 app-ready=121');
    expect(timer.has('app-ready')).toBe(true);
    expect(timer.has('first-output')).toBe(false);
  });

  it('accepts only the fixed renderer marks', () => {
    expect(isRendererMark('renderer-boot')).toBe(true);
    expect(isRendererMark('first-output')).toBe(true);
    expect(isRendererMark('app-ready')).toBe(false);
    expect(isRendererMark(42)).toBe(false);
  });

  it('keeps the last launches only', () => {
    const older = Array.from({ length: STARTUP_LOG_LINES + 5 }, (_, i) => `line ${i}`);
    const lines = startupLogText(older, 'now').trim().split('\n');
    expect(lines).toHaveLength(STARTUP_LOG_LINES);
    expect(lines.at(-1)).toBe('now');
    expect(lines[0]).toBe(`line ${older.length - STARTUP_LOG_LINES + 1}`);
  });

  it('rewrites the line of this launch on every flush and never throws', async () => {
    const files = new Map<string, string>([['log', 'old launch\n']]);
    const fs = {
      readFile: async (file: string) => { const text = files.get(file); if (text === undefined) throw new Error('missing'); return text; },
      writeFile: async (file: string, text: string) => { files.set(file, text); },
    };
    let t = 1;
    const timer = createStartupTimer(() => t);
    const log = createStartupLog('log', 'H', timer, fs as never);
    timer.mark('a');
    await log.flush();
    t = 2;
    timer.mark('b');
    await log.flush();
    expect(files.get('log')).toBe('old launch\nH a=1 b=2\n');
    const failing = createStartupLog('x', 'H', timer, { readFile: fs.readFile, writeFile: async () => { throw new Error('locked'); } } as never);
    await expect(failing.flush()).resolves.toBeUndefined();
  });
});
