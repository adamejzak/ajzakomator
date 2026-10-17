import { describe, expect, it } from 'vitest';
import { decideShortcut, type DispatchContext } from '../src/shared/shortcutDispatch';
import {
  backspaceDisables, checkAssignment, eventToCombo, keyFromCode, matchCombo, matchShortcut, parseCombo, RepeatGuard, reservedReason,
  resolveShortcuts, setOverride, shortcutDef, SHORTCUT_DEFS, type Combo, type ShortcutScope,
} from '../src/shared/shortcuts';
import { messages } from '../src/shared/messages';
import type { AppPlatform } from '../src/shared/platform';

const combo = (text: string): Combo => parseCombo(text)!;
const press = (code: string, mods = '', key?: string) => ({
  code, key, ctrlKey: mods.includes('c'), altKey: mods.includes('a'), shiftKey: mods.includes('s'), metaKey: mods.includes('m'),
});
const reserved = (text: string, scope: ShortcutScope = 'global', platform: AppPlatform = 'win32') => reservedReason(combo(text), platform, scope);

describe('terminal clipboard and control keys stay with the terminal', () => {
  it('knows Ctrl+Shift+V as a read-only terminal key', () => {
    const def = shortcutDef('terminal.pasteShift')!;
    expect(def.rebindable).toBe(false);
    expect(def.scope).toBe('terminal-passthrough');
    expect(Object.hasOwn(messages, def.label)).toBe(true);
  });

  it('refuses Ctrl+V and Ctrl+Shift+V (Cmd on a Mac) for app-wide actions', () => {
    for (const scope of ['global', 'cell'] as const) {
      expect(reserved('Ctrl+Shift+V', scope), scope).not.toBeNull();
      expect(reserved('Ctrl+V', scope), scope).not.toBeNull();
      expect(reserved('Meta+Shift+V', scope, 'darwin'), scope).not.toBeNull();
      expect(reserved('Ctrl+Shift+V', scope, 'darwin'), scope).not.toBeNull();
    }
    const resolved = resolveShortcuts({}, 'win32');
    expect(checkAssignment('tab.close', combo('Ctrl+Shift+V'), resolved, 'win32')).toMatchObject({ ok: false });
    expect(checkAssignment('tab.close', combo('Ctrl+Shift+V'), resolveShortcuts({}, 'darwin'), 'darwin')).toMatchObject({ ok: false });
    expect(resolveShortcuts({ 'tab.close': 'Ctrl+Shift+V' }, 'win32').problems['tab.close'].kind).toBe('reserved');
    // the file tree is not the terminal
    expect(reserved('Ctrl+Shift+V', 'files-tree')).toBeNull();
  });

  it('never lets an action take the macOS app menu keys Cmd+Q, Cmd+H or Option+Cmd+H', () => {
    for (const scope of ['global', 'cell', 'modal', 'editor', 'files-tree'] as const) {
      for (const text of ['Meta+Q', 'Meta+H', 'Meta+Alt+H']) expect(reserved(text, scope, 'darwin'), `${scope} ${text}`).not.toBeNull();
    }
  });

  it('refuses the Shift variants of Ctrl with arrows, Home, End and Enter', () => {
    for (const key of ['Left', 'Right', 'Up', 'Down', 'Home', 'End', 'Enter', 'PageUp', 'Backspace', 'Delete']) {
      expect(reserved(`Ctrl+${key}`), key).not.toBeNull();
      expect(reserved(`Ctrl+Shift+${key}`), `Shift ${key}`).not.toBeNull();
    }
    expect(reserved('Ctrl+Shift+Y')).toBeNull();
    expect(reserved('Ctrl+Alt+Shift+Left')).toBeNull();
    // dialogs keep Ctrl+Enter (their own default) and the tree is unaffected
    expect(reserved('Ctrl+Shift+Enter', 'modal')).toBeNull();
  });

  it('refuses Ctrl+2 to Ctrl+8 (control codes), with or without Shift', () => {
    for (const digit of ['2', '3', '4', '5', '6', '7', '8']) {
      expect(reserved(`Ctrl+${digit}`), digit).not.toBeNull();
      expect(reserved(`Ctrl+Shift+${digit}`), `Shift ${digit}`).not.toBeNull();
    }
    expect(reserved('Ctrl+1')).toBeNull();
    expect(reserved('Ctrl+9')).toBeNull();
    expect(reserved('Ctrl+Shift+9')).toBeNull();
    expect(reserved('Ctrl+2', 'files-tree')).toBeNull();
  });
});

describe('numpad keys that act as navigation keys', () => {
  it('maps NumLock-off numpad keys by their key value', () => {
    expect(keyFromCode('NumpadDecimal', 'Delete')).toBe('Delete');
    expect(keyFromCode('NumpadDecimal', '.')).toBeNull();
    expect(keyFromCode('Numpad4', 'ArrowLeft')).toBe('Left');
    expect(keyFromCode('Numpad8', 'ArrowUp')).toBe('Up');
    expect(keyFromCode('Numpad7', 'Home')).toBe('Home');
    expect(keyFromCode('Numpad4', '4')).toBeNull();
    expect(keyFromCode('NumpadEnter', 'Enter')).toBe('Enter');
    expect(keyFromCode('NumpadEnter')).toBe('Enter');
    expect(keyFromCode('Delete', 'Delete')).toBe('Delete');
  });

  it('triggers Delete in the file tree and records as Delete', () => {
    const resolved = resolveShortcuts({}, 'win32');
    expect(matchShortcut(press('NumpadDecimal', '', 'Delete'), resolved, 'tree.delete')).toBe(true);
    expect(matchShortcut(press('NumpadDecimal', '', '.'), resolved, 'tree.delete')).toBe(false);
    expect(matchShortcut(press('Delete', '', 'Delete'), resolved, 'tree.delete')).toBe(true);
    expect(eventToCombo(press('NumpadDecimal', '', 'Delete'))).toEqual(combo('Delete'));
    expect(matchCombo(press('Numpad4', 'ca', 'ArrowLeft'), combo('Ctrl+Alt+Left'))).toBe(true);
  });
});

describe('older Ctrl keys on a Mac keep working on the defaults', () => {
  const mac = resolveShortcuts({}, 'darwin');
  const win = resolveShortcuts({}, 'win32');

  it('accepts Ctrl as well as Cmd in the file tree, dialogs and the Git commit box', () => {
    for (const [id, code] of [['tree.copy', 'KeyC'], ['tree.cut', 'KeyX'], ['tree.paste', 'KeyV'], ['tree.undo', 'KeyZ'], ['tree.selectAll', 'KeyA'], ['modal.save', 'Enter'], ['git.commit', 'Enter']] as const) {
      expect(matchShortcut(press(code, 'm'), mac, id), `${id} Cmd`).toBe(true);
      expect(matchShortcut(press(code, 'c'), mac, id), `${id} Ctrl`).toBe(true);
      expect(matchShortcut(press(code, 'cm'), mac, id), `${id} both`).toBe(false);
      expect(matchShortcut(press(code, 'cs'), mac, id), `${id} Ctrl+Shift`).toBe(false);
    }
  });

  it('keeps the aliases out of the combo that is shown and out of conflicts', () => {
    expect(mac.combos['tree.copy']).toEqual(combo('Meta+C'));
    expect(mac.aliases['tree.copy']).toEqual([combo('Ctrl+C')]);
    expect(win.aliases).toEqual({});
    expect(resolveShortcuts({}, 'darwin').problems).toEqual({});
  });

  it('drops an alias once the user rebinds or disables the action', () => {
    const rebound = resolveShortcuts({ 'tree.copy': 'Meta+Shift+Y' }, 'darwin');
    expect(matchShortcut(press('KeyC', 'c'), rebound, 'tree.copy')).toBe(false);
    expect(matchShortcut(press('KeyY', 'ms'), rebound, 'tree.copy')).toBe(true);
    const off = resolveShortcuts({ 'tree.copy': null }, 'darwin');
    expect(matchShortcut(press('KeyC', 'c'), off, 'tree.copy')).toBe(false);
    expect(off.aliases['tree.copy']).toBeUndefined();
  });

  it('adds nothing on Windows and Linux (Ctrl is already the default)', () => {
    for (const platform of ['win32', 'linux'] as const) {
      const resolved = resolveShortcuts({}, platform);
      expect(resolved.aliases).toEqual({});
      expect(matchShortcut(press('KeyC', 'c'), resolved, 'tree.copy')).toBe(true);
      expect(matchShortcut(press('KeyC', 'm'), resolved, 'tree.copy')).toBe(false);
    }
  });

  it('registers the Git commit shortcut as a default Ctrl+Enter that can be rebound', () => {
    const def = shortcutDef('git.commit')!;
    expect(def).toMatchObject({ scope: 'git-panel', default: 'Mod+Enter', rebindable: true, group: 'panels' });
    expect(Object.hasOwn(messages, def.label)).toBe(true);
    expect(matchShortcut(press('Enter', 'c'), win, 'git.commit')).toBe(true);
    const rebound = resolveShortcuts({ 'git.commit': 'Ctrl+Shift+Enter' }, 'win32');
    expect(rebound.problems).toEqual({});
    expect(matchShortcut(press('Enter', 'c'), rebound, 'git.commit')).toBe(false);
    expect(matchShortcut(press('Enter', 'cs'), rebound, 'git.commit')).toBe(true);
    // same keys as the dialog Save never collide: different focus areas
    expect(SHORTCUT_DEFS.filter((d) => d.default === 'Mod+Enter').map((d) => d.id).sort()).toEqual(['git.commit', 'modal.save']);
    expect(checkAssignment('git.commit', combo('Ctrl+Enter'), win, 'win32')).toEqual({ ok: true, same: true });
    // and it is not dispatched app-wide
    const ctx: DispatchContext = { resolution: win, languageChosen: true, recording: false, overlayOpen: false, paletteOpen: false, settingsActive: false, hasProject: true, hasTab: true, target: 'input' };
    expect(decideShortcut(press('Enter', 'c'), ctx)).toBeNull();
  });
});

describe('recording Backspace', () => {
  it('disables on Backspace everywhere but in the file tree, where it is a key that can be assigned', () => {
    expect(backspaceDisables(shortcutDef('grid.new')!)).toBe(true);
    expect(backspaceDisables(shortcutDef('editor.save')!)).toBe(true);
    expect(backspaceDisables(shortcutDef('tree.delete')!)).toBe(false);
    const resolved = resolveShortcuts({}, 'win32');
    expect(checkAssignment('tree.delete', combo('Backspace'), resolved, 'win32')).toEqual({ ok: true, same: false });
    expect(checkAssignment('grid.new', combo('Backspace'), resolved, 'win32')).toMatchObject({ ok: false, kind: 'reserved' });
    const next = resolveShortcuts(setOverride({}, 'tree.delete', combo('Backspace'), 'win32'), 'win32');
    expect(next.combos['tree.delete']).toEqual(combo('Backspace'));
    expect(matchShortcut(press('Backspace', '', 'Backspace'), next, 'tree.delete')).toBe(true);
  });
});

describe('auto-repeat after a recording', () => {
  it('swallows repeats of the key that finished it until it is released or pressed again', () => {
    const guard = new RepeatGuard();
    expect(guard.swallow({ repeat: true })).toBe(false); // not armed: ordinary repeats pass
    guard.arm();
    expect(guard.swallow({ repeat: true })).toBe(true);
    expect(guard.swallow({ repeat: true })).toBe(true);
    guard.release({ code: 'ShiftLeft' }); // letting go of a modifier does not end the key repeat
    expect(guard.swallow({ repeat: true })).toBe(true);
    guard.release({ code: 'KeyJ' });
    expect(guard.swallow({ repeat: true })).toBe(false);
  });

  it('a fresh key press ends the guard and is handled normally', () => {
    const guard = new RepeatGuard();
    guard.arm();
    expect(guard.swallow({ repeat: false })).toBe(false);
    expect(guard.swallow({ repeat: true })).toBe(false);
  });
});
