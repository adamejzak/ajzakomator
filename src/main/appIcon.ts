import { app, nativeImage, type NativeImage } from 'electron';
import { join } from 'path';

/** Windows takes the multi-size .ico (taskbar, title bar); other systems the 1024 px PNG. */
const iconPath = (): string => join(app.getAppPath(), 'resources', process.platform === 'win32' ? 'icon.ico' : 'icon.png');

/** The window icon: set explicitly so a dev run (or an unpacked build) never falls back to the Electron logo. */
export const windowIcon = (): string => iconPath();

/** The macOS dock icon (it ignores the window icon); a no-op elsewhere. */
export function applyDockIcon(): void {
  if (process.platform !== 'darwin' || !app.dock) return;
  const image: NativeImage = nativeImage.createFromPath(join(app.getAppPath(), 'resources', 'icon.png'));
  if (!image.isEmpty()) app.dock.setIcon(image);
}
