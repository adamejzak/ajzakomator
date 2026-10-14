// Export the supplied brand artwork as a square icon, trimming its outer black margin.
// The original artwork stays intact in resources/branding/logo.png.
const { writeFileSync } = require('node:fs');
const { resolve } = require('node:path');
const electron = require('electron');

if (typeof electron === 'string') {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const child = spawnSync(electron, [__filename], { env, windowsHide: true, stdio: 'inherit' });
  if (child.error) throw child.error;
  process.exit(child.status ?? 1);
}

const { app, nativeImage } = electron;
app.disableHardwareAcceleration();
app.whenReady().then(async () => {
  const source = nativeImage.createFromPath(resolve(__dirname, '../resources/branding/logo.png'));
  if (source.isEmpty()) throw new Error('Brand logo could not be loaded');
  const { width, height } = source.getSize();
  const pixels = source.toBitmap();
  let x0 = width, y0 = height, x1 = 0, y1 = 0;
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const offset = (y * width + x) * 4;
    if (pixels[offset + 3] > 128 && Math.max(pixels[offset], pixels[offset + 1], pixels[offset + 2]) > 100) {
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (x0 >= x1 || y0 >= y1) throw new Error('Brand artwork bounds are empty');
  const size = Math.min(width, height, Math.ceil(Math.max(x1 - x0 + 1, y1 - y0 + 1) * 1.2));
  const x = Math.max(0, Math.min(width - size, Math.round((x0 + x1 - size) / 2)));
  const y = Math.max(0, Math.min(height - size, Math.round((y0 + y1 - size) / 2)));
  const icon = source.crop({ x, y, width: size, height: size }).resize({ width: 1024, height: 1024, quality: 'best' });
  if (icon.isEmpty() || icon.getSize().width !== 1024) throw new Error('Icon rendering failed');
  writeFileSync(resolve(__dirname, '../resources/icon.png'), icon.toPNG());
  console.log('Exported resources/icon.png (1024×1024) from resources/branding/logo.png');
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
