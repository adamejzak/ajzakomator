import { describe, expect, it } from 'vitest';
import { BULK_COALESCE_MS, coalesceDelay, ECHO_COALESCE_MS, FlowGate, HIGH_WATER, LOW_WATER, TailBuffer } from '../src/ptyhost/flow';

describe('TailBuffer', () => {
  it('matches the naive (tail + data).slice(-limit) for random chunks', () => {
    for (const limit of [1, 7, 100, 1000]) {
      const buf = new TailBuffer(limit);
      let naive = '';
      let seed = limit;
      for (let i = 0; i < 300; i++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        const chunk = String.fromCharCode(97 + (i % 26)).repeat(seed % 40);
        buf.push(chunk);
        naive = (naive + chunk).slice(-limit);
        if (i % 17 === 0) expect(buf.toString()).toBe(naive);
      }
      expect(buf.toString()).toBe(naive);
    }
  });

  it('keeps a chunk larger than the limit cut to the newest characters', () => {
    const buf = new TailBuffer(4);
    buf.push('abcdefgh');
    expect(buf.toString()).toBe('efgh');
    buf.push('ij');
    expect(buf.toString()).toBe('ghij');
  });

  it('does not grow without bound', () => {
    const buf = new TailBuffer(1000);
    for (let i = 0; i < 10_000; i++) buf.push('x'.repeat(100));
    expect((buf as unknown as { chunks: string[] }).chunks.length).toBeLessThan(25);
  });

  it('ignores empty pushes', () => {
    const buf = new TailBuffer(5);
    buf.push('');
    expect(buf.toString()).toBe('');
  });
});

describe('FlowGate', () => {
  it('pauses at the high watermark and resumes at the low one', () => {
    const g = new FlowGate();
    expect(g.sent(HIGH_WATER - 1)).toBe(false);
    expect(g.sent(1)).toBe(true);
    expect(g.paused).toBe(true);
    expect(g.sent(500)).toBe(false); // already paused
    expect(g.acked(HIGH_WATER - LOW_WATER - 1)).toBe(false);
    expect(g.acked(600)).toBe(true);
    expect(g.paused).toBe(false);
  });

  it('never lets pending go negative and ignores acks while running', () => {
    const g = new FlowGate();
    expect(g.acked(10_000)).toBe(false);
    expect(g.sent(10)).toBe(false);
  });

  it('reset reports a pause that has to be lifted', () => {
    const g = new FlowGate();
    g.sent(HIGH_WATER);
    expect(g.reset()).toBe(true);
    expect(g.paused).toBe(false);
    expect(g.reset()).toBe(false);
    expect(g.sent(HIGH_WATER - 1)).toBe(false);
  });
});

describe('coalesceDelay', () => {
  it('is short right after the user typed and longer for bulk output', () => {
    expect(coalesceDelay(1000, 900)).toBe(ECHO_COALESCE_MS);
    expect(coalesceDelay(1000, 100)).toBe(BULK_COALESCE_MS);
    expect(coalesceDelay(1000, -Infinity)).toBe(BULK_COALESCE_MS);
  });
});
