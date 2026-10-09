// node-pty 1.1.0 ships macOS spawn-helper without its execute permission.
// https://github.com/microsoft/node-pty/issues/850
const { chmodSync, existsSync, statSync } = require('node:fs');
const { dirname, join } = require('node:path');

function fixPermissions(moduleRoot) {
  for (const directory of ['build/Release', 'build/Debug', 'prebuilds/darwin-arm64', 'prebuilds/darwin-x64']) {
    const helper = join(moduleRoot, directory, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, statSync(helper).mode | 0o111);
  }
}

// Run before signing so the distributed application also has executable helpers.
module.exports = ({ electronPlatformName, appOutDir, packager }) => {
  if (electronPlatformName !== 'darwin') return;
  fixPermissions(join(appOutDir, `${packager.appInfo.productFilename}.app`, 'Contents', 'Resources', 'app', 'node_modules', 'node-pty'));
};

if (require.main === module && process.platform === 'darwin') {
  fixPermissions(dirname(require.resolve('node-pty/package.json')));
}
