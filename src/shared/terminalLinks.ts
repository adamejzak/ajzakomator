export function createTerminalLinkOpener(deps: { isBusy: () => boolean; invalid: () => void; confirm: (address: string) => Promise<boolean>; open: (address: string) => void }) {
  let pending = false;
  return async (address: string): Promise<void> => {
    if (pending || deps.isBusy()) return;
    let url: URL;
    try { url = new URL(address); if (!['http:', 'https:'].includes(url.protocol)) throw new Error(); }
    catch { deps.invalid(); return; }
    pending = true;
    try { if (await deps.confirm(url.href)) deps.open(url.href); }
    finally { pending = false; }
  };
}
