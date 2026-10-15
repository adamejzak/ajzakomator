// Export the supplied artwork without cropping its background, edges or transparency.
// The original stays intact in resources/branding/logo.png.
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
  if (width !== height) throw new Error('Brand logo must be square to preserve its proportions');
  const icon = source.resize({ width: 1024, height: 1024, quality: 'best' });
  if (icon.isEmpty() || icon.getSize().width !== 1024) throw new Error('Icon rendering failed');
  writeFileSync(resolve(__dirname, '../resources/icon.png'), icon.toPNG());
  writeFileSync(resolve(__dirname, '../resources/icon-64.png'), source.resize({ width: 64, height: 64, quality: 'best' }).toPNG());
  // Explicit multi-resolution Windows icon for Explorer, shortcuts and the taskbar.
  const sizes = [16, 24, 32, 48, 64, 128, 256];
  const frames = sizes.map((size) => source.resize({ width: size, height: size, quality: 'best' }).toPNG());
  const directory = Buffer.alloc(6 + sizes.length * 16);
  directory.writeUInt16LE(1, 2);
  directory.writeUInt16LE(sizes.length, 4);
  let offset = directory.length;
  sizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    directory[entry] = size === 256 ? 0 : size;
    directory[entry + 1] = size === 256 ? 0 : size;
    directory.writeUInt16LE(1, entry + 4);
    directory.writeUInt16LE(32, entry + 6);
    directory.writeUInt32LE(frames[index].length, entry + 8);
    directory.writeUInt32LE(offset, entry + 12);
    offset += frames[index].length;
  });
  writeFileSync(resolve(__dirname, '../resources/icon.ico'), Buffer.concat([directory, ...frames]));
  console.log(`Exported icon.png (1024px), icon-64.png and icon.ico (${sizes.join(', ')}px); source ${width}×${height}, transparency preserved`);
  app.quit();
}).catch(error => { console.error(error); app.exit(1); });
