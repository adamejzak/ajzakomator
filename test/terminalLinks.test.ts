import { describe, expect, it, vi } from 'vitest';
import { createTerminalLinkOpener } from '../src/shared/terminalLinks';
describe('terminal link confirmation', () => {
  it('opens only after explicit confirmation and never opens on cancel', async () => {
    const open = vi.fn(); const confirm = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const activate = createTerminalLinkOpener({ isBusy: () => false, invalid: vi.fn(), confirm, open });
    await activate('http://localhost:3023/demo'); expect(open).not.toHaveBeenCalled();
    await activate('https://example.com/demo'); expect(open).toHaveBeenCalledWith('https://example.com/demo');
  });
  it('rejects non-web addresses and does not stack overlapping dialogs', async () => {
    let resolve: (value: boolean) => void = () => {};
    const confirm = vi.fn(() => new Promise<boolean>((r) => { resolve = r; })); const invalid = vi.fn();
    const activate = createTerminalLinkOpener({ isBusy: () => false, invalid, confirm, open: vi.fn() });
    await activate('javascript:alert(1)'); expect(confirm).not.toHaveBeenCalled(); expect(invalid).toHaveBeenCalledOnce();
    const first = activate('https://example.com/'); await activate('https://example.org/'); expect(confirm).toHaveBeenCalledTimes(1);
    resolve(false); await first;
  });
});
