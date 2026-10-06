import { mkdtempSync, readFileSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { describe, expect, it } from 'vitest';
import { createSaver, loadState, writeStateNow } from '../src/main/store';
import { addProject, defaultState } from '../src/shared/state';

const tmp = () => mkdtempSync(join(tmpdir(), 'mc-store-'));

describe('store', () => {
  it('roundtrips state and makes a .bak on load', () => {
    const dir = tmp();
    const s = addProject(defaultState(), { name: 'p', path: 'D:\\p' });
    writeStateNow(dir, s);
    expect(loadState(dir).projects[0].name).toBe('p');
    expect(JSON.parse(readFileSync(join(dir, 'state.json.bak'), 'utf8')).projects[0].name).toBe('p');
  });

  it('falls back to .bak when state.json is corrupted', () => {
    const dir = tmp();
    writeStateNow(dir, addProject(defaultState(), { name: 'good', path: 'X' }));
    loadState(dir); // creates .bak
    writeFileSync(join(dir, 'state.json'), '{ broken');
    expect(loadState(dir).projects[0].name).toBe('good');
  });

  it('returns defaults when nothing usable exists', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'state.json'), '{"version": 99}');
    expect(loadState(dir).projects).toEqual([]);
  });

  it('debounced saver writes on flush', () => {
    const dir = tmp();
    const saver = createSaver(dir, 10000);
    saver.save(addProject(defaultState(), { name: 'later', path: 'Y' }));
    saver.flush();
    expect(loadState(dir).projects[0].name).toBe('later');
  });
});
