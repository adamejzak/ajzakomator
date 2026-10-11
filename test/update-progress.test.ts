import { describe, expect, it } from 'vitest';
import { closeAction, UpdateProgressModel, type UpdateSnapshot } from '../src/shared/updateProgress';

const snap = (over: Partial<UpdateSnapshot>): UpdateSnapshot => ({ elapsedMs: 0, closed: false, installed: false, ready: false, ...over });
const MB = 1024 * 1024;

describe('update window progress', () => {
  it('walks through the stages and only reaches 100 when the new app is ready', () => {
    const model = new UpdateProgressModel(300 * MB);
    expect(model.update(snap({ elapsedMs: 0 }))).toMatchObject({ stage: 'preparing', percent: 0 });
    expect(model.update(snap({ elapsedMs: 3000 })).stage).toBe('closing');
    expect(model.update(snap({ elapsedMs: 5000, closed: true })).stage).toBe('installing');
    expect(model.update(snap({ elapsedMs: 30000, closed: true, installed: true })).stage).toBe('launching');
    expect(model.update(snap({ elapsedMs: 40000, closed: true, installed: true })).percent).toBeLessThan(100);
    expect(model.update(snap({ elapsedMs: 41000, closed: true, installed: true, ready: true }))).toEqual({ stage: 'done', percent: 100 });
  });

  it('never moves backwards, even when the install directory is emptied and refilled', () => {
    const model = new UpdateProgressModel(300 * MB);
    const samples = [300, 250, 80, 5, 20, 120, 220, 295].map((mb, index) => model.update(snap({ elapsedMs: 4000 + index * 1500, closed: true, dirBytes: mb * MB })).percent);
    for (let i = 1; i < samples.length; i++) expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1]);
    expect(samples.at(-1)!).toBeGreaterThan(samples[0]);
  });

  it('follows the regrowing directory and stays below the launch range until the installer is done', () => {
    const model = new UpdateProgressModel(300 * MB);
    model.update(snap({ elapsedMs: 4000, closed: true, dirBytes: 2 * MB }));
    const half = model.update(snap({ elapsedMs: 5000, closed: true, dirBytes: 150 * MB })).percent;
    const full = model.update(snap({ elapsedMs: 6000, closed: true, dirBytes: 300 * MB })).percent;
    expect(full).toBeGreaterThan(half);
    expect(full).toBeLessThan(90);
  });

  it('still advances by time when the directory size gives no signal', () => {
    const model = new UpdateProgressModel(0);
    const early = model.update(snap({ elapsedMs: 4000, closed: true })).percent;
    const late = model.update(snap({ elapsedMs: 40000, closed: true })).percent;
    expect(late).toBeGreaterThan(early + 20);
    expect(late).toBeLessThan(90);
  });

  it('completes right after the installer in quit mode, where no new app starts', () => {
    const model = new UpdateProgressModel(300 * MB, 'quit');
    expect(model.update(snap({ elapsedMs: 20000, closed: true, installed: true }))).toEqual({ stage: 'done', percent: 100 });
  });
});

describe('update window honesty', () => {
  it('says it waits for the old app when it has not exited for a while, and not before', () => {
    const model = new UpdateProgressModel(300 * MB);
    expect(model.update(snap({ elapsedMs: 3000 })).note).toBeUndefined();
    expect(model.update(snap({ elapsedMs: 9000 }))).toMatchObject({ stage: 'closing', note: 'waitingClose' });
  });

  it('says it waits for the installer and stops estimating past the unconfirmed ceiling when no file was touched', () => {
    const model = new UpdateProgressModel(300 * MB);
    model.update(snap({ elapsedMs: 5000, closed: true, dirBytes: 300 * MB }));
    expect(model.update(snap({ elapsedMs: 30000, closed: true, dirBytes: 300 * MB }))).toMatchObject({ stage: 'installing', note: 'waitingInstaller' });
    const much = model.update(snap({ elapsedMs: 200000, closed: true, dirBytes: 300 * MB }));
    expect(much.percent).toBeLessThanOrEqual(61);
    expect(much.note).toBe('waitingInstaller');
  });

  it('adds the slow-install note only after files are really being replaced for over a minute', () => {
    const model = new UpdateProgressModel(300 * MB);
    model.update(snap({ elapsedMs: 5000, closed: true, dirBytes: 2 * MB }));
    expect(model.update(snap({ elapsedMs: 30000, closed: true, dirBytes: 100 * MB })).note).toBeUndefined();
    expect(model.update(snap({ elapsedMs: 70000, closed: true, dirBytes: 150 * MB }))).toMatchObject({ stage: 'installing', note: 'installingLong' });
  });
});

describe('closing the update window', () => {
  it('only hides while work is in flight, so the installer is never interrupted', () => {
    for (const stage of ['preparing', 'closing', 'installing', 'launching'] as const) expect(closeAction(stage)).toBe('hide');
  });

  it('exits once the update is done or has given up', () => {
    expect(closeAction('done')).toBe('exit');
    expect(closeAction('error')).toBe('exit');
  });
});
