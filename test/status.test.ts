import { describe, expect, it } from 'vitest';
import { aggregate, StatusTracker } from '../src/shared/status';

describe('StatusTracker heuristic', () => {
  it('startup output without a submitted prompt stays idle', () => {
    const t = new StatusTracker(1000);
    t.output(0);
    expect(t.tick(5000)).toBe('idle');
  });

  it('submit → output → silence goes working → waiting', () => {
    const t = new StatusTracker(1000);
    t.input(0, true);
    t.output(100); // echo, ignored
    expect(t.tick(100)).toBe('idle');
    t.output(600);
    expect(t.tick(700)).toBe('working');
    t.output(1200);
    expect(t.tick(2100)).toBe('working');
    expect(t.tick(2300)).toBe('waiting');
  });

  it('typing clears waiting and acknowledge resets it', () => {
    const t = new StatusTracker(10);
    t.input(0, true);
    t.output(500);
    t.tick(1000);
    expect(t.status).toBe('waiting');
    t.acknowledge();
    expect(t.status).toBe('idle');
  });
});

describe('StatusTracker recovery', () => {
  it('sustained output after a false "waiting" brings the cell back to working', () => {
    const t = new StatusTracker(1500);
    t.input(0, true);
    t.output(500);
    expect(t.tick(600)).toBe('working');
    // a pause longer than quietMs mid-turn (or a notification) flips it to waiting…
    expect(t.tick(2100)).toBe('waiting');
    // …but the agent keeps redrawing its "Working (1m 02s)" timer every second
    for (let ms = 3000; ms <= 7000; ms += 1000) t.output(ms);
    expect(t.tick(7100)).toBe('working');
  });

  it('a short burst (startup banner, redraw) does not count as working', () => {
    const t = new StatusTracker(1500);
    t.output(0);
    t.output(400);
    t.output(900);
    expect(t.tick(1000)).toBe('idle');
  });

  it('typing echo never counts as activity', () => {
    const t = new StatusTracker(1500);
    for (let ms = 0; ms <= 6000; ms += 200) {
      t.input(ms, false);
      t.output(ms + 50);
    }
    expect(t.tick(6100)).toBe('idle');
  });
});

describe('StatusTracker precise signals', () => {
  it('hooks drive the status and disable the heuristic', () => {
    const t = new StatusTracker(10);
    t.hook('prompt');
    expect(t.tick(100000)).toBe('working');
    t.output(200000);
    t.hook('stop');
    expect(t.status).toBe('waiting');
    t.hook('prompt');
    t.hook('notify');
    expect(t.status).toBe('waiting');
  });

  it('osc9 marks waiting', () => {
    const t = new StatusTracker();
    t.input(0, true);
    t.output(1000);
    t.osc9();
    expect(t.status).toBe('waiting');
  });

  it('osc9 does not override hook-driven status', () => {
    const t = new StatusTracker();
    t.hook('prompt');
    t.osc9();
    expect(t.status).toBe('working');
  });

  it('exited is sticky until reset', () => {
    const t = new StatusTracker();
    t.exited();
    t.hook('prompt');
    t.input(1, true);
    expect(t.status).toBe('exited');
    t.reset();
    expect(t.status).toBe('idle');
  });
});

describe('aggregate', () => {
  it('counts non-idle statuses', () => {
    expect(aggregate(['working', 'idle', 'waiting', 'working', 'exited'])).toEqual({ working: 2, waiting: 1, exited: 1 });
  });
});
