import { createTerminalLinkOpener } from '../../shared/terminalLinks';
import { askChoice, getUi, toast } from './store';
import { tr } from './i18n';
export const confirmTerminalLink = createTerminalLinkOpener({
  isBusy: () => { const ui = getUi(); return !!(ui.dialog || ui.modal || ui.palette); },
  invalid: () => toast(tr('Nieobsługiwany adres linku.'), 'error'),
  confirm: async (address) => (await askChoice(tr('Otworzyć link w przeglądarce?'), `${address}\n\n${tr('Link pochodzi z terminala. Sprawdź adres przed otwarciem.')}`,
    [{ label: tr('Otwórz link'), value: 'open', primary: true }])) === 'open',
  open: (address) => window.mc.openExternal(address),
});
