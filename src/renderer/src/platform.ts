import { shortcutLabel } from '../../shared/platform';

export const keyLabel = (value: string) => shortcutLabel(window.mc.platform, value);

export const hasPrimaryModifier = (event: { metaKey: boolean; ctrlKey: boolean }) =>
  window.mc.platform === 'darwin' ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
