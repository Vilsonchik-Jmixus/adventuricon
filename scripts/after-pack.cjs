const { execFileSync } = require('node:child_process');
const path = require('node:path');
module.exports = async context => {
  const pkg = require('../package.json');
  if (context.electronPlatformName === 'darwin') {
    const app = path.join(context.appOutDir, pkg.build.productName + '.app');
    // Local ad-hoc signature so Apple Silicon can run the packaged app.
    execFileSync('codesign', ['--force', '--deep', '--sign', '-', app]);
    execFileSync('codesign', ['--verify', '--deep', '--strict', app]);
    return;
  }
  if (context.electronPlatformName !== 'win32') return;
  const rcedit = path.join(path.dirname(require.resolve('rcedit')), '..', 'bin', 'rcedit-x64.exe');
  execFileSync(rcedit, [path.join(context.appOutDir, pkg.build.productName + '.exe'), '--set-icon', path.resolve(__dirname, '../ui/assets/icon.ico'), '--set-file-version', pkg.version, '--set-product-version', pkg.version, '--set-version-string', 'ProductName', pkg.build.productName, '--set-version-string', 'FileDescription', pkg.description, '--set-version-string', 'CompanyName', pkg.author, '--set-version-string', 'LegalCopyright', `Copyright 2026 ${pkg.author}`], { windowsHide: true });
};
