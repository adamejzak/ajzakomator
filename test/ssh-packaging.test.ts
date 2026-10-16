// test/ssh-packaging.test.ts
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));
const EXCLUDED = [
  '!**/node_modules/cpu-features/**',
  '!**/node_modules/nan/**',
  '!**/node_modules/ssh2/lib/protocol/crypto/build/**',
  '!**/node_modules/ssh2/lib/protocol/crypto/src/**',
  '!**/node_modules/ssh2/lib/protocol/crypto/binding.gyp',
  '!**/node_modules/ssh2/install.js',
  '!**/node_modules/ssh2/test/**',
  '!**/node_modules/ssh2/examples/**',
  // util/ only holds the Pageant helper (pagent.exe, unused: agent auth is a non-goal); its presence makes
  // electron-builder unpack the whole ssh2 package out of the asar.
  '!**/node_modules/ssh2/util/**',
];

describe('ssh2 packaging', () => {
  it('ships ssh2 as an exactly pinned production dependency and its types as a dev dependency', () => {
    expect(pkg.dependencies.ssh2).toBe('1.17.0');
    expect(pkg.devDependencies['@types/ssh2']).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.dependencies['@types/ssh2']).toBeUndefined();
  });

  it('keeps the optional native parts of ssh2 out of both file lists', () => {
    for (const list of [pkg.build.files, pkg.build.win.files]) for (const rule of EXCLUDED) expect(list, rule).toContain(rule);
  });

  it('has the Electron runtime smoke test script', () => {
    expect(pkg.scripts['test:ssh-electron']).toBe('node scripts/smoke-ssh.mjs');
  });
});
