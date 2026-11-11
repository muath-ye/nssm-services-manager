/*
 * Builds the single-file Windows exe:
 *   1. runs `neu build` with the resources embedded in the exe
 *   2. copies the result to dist/NSSMServicesManager-<version>.exe
 *   3. stamps that copy with the app icon, publisher and version info
 *
 * Run `npm run setup` once first so bin/ and resources/js/neutralino.js exist.
 *
 * Notes:
 *  - The stamping runs AFTER `neu build`, which would otherwise overwrite it.
 *  - Do not set rcedit's 'requested-execution-level': it rewrites the manifest and leaves this binary with none,
 *    so Windows refuses to start it ("side-by-side configuration is incorrect"). The binary's own manifest already
 *    says asInvoker, so the exe opens without a UAC prompt.
 */
const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const rcedit = require('rcedit');

const root = path.resolve(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const configPath = path.join(root, 'neutralino.config.json');
const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const binaryName = config.cli.binaryName;

const PUBLISHER = 'muathye.com';

async function main() {
  if (!fs.existsSync(path.join(root, 'bin', 'neutralino-win_x64.exe'))) {
    throw new Error('bin/neutralino-win_x64.exe is missing. Run "npm run setup" first.');
  }

  // Keep the app version in sync with package.json (CI sets package.json from the git tag).
  config.version = pkg.version;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  execSync('npx --no-install neu build --release --embed-resources', { cwd: root, stdio: 'inherit' });

  const built = path.join(root, 'dist', binaryName, `${binaryName}-win_x64.exe`);
  if (!fs.existsSync(built)) {
    throw new Error(`Expected build output not found: ${built}`);
  }
  const output = path.join(root, 'dist', `NSSMServicesManager-${pkg.version}.exe`);
  fs.copyFileSync(built, output);
  const sizeBefore = fs.statSync(output).size;

  await rcedit(output, {
    icon: path.join(root, 'build', 'icon.ico'),
    'file-version': pkg.version,
    'product-version': pkg.version,
    'version-string': {
      CompanyName: PUBLISHER,
      LegalCopyright: `Copyright (c) ${PUBLISHER}`,
      ProductName: 'NSSM Services Manager',
      FileDescription: pkg.description,
      InternalName: binaryName,
      OriginalFilename: `${binaryName}.exe`,
    },
  });

  // Guards against shipping an exe that will not start or has lost its embedded UI.
  const text = fs.readFileSync(output).toString('latin1');
  if (!text.includes('<assembly')) {
    throw new Error('The exe lost its manifest after stamping; Windows would refuse to start it.');
  }
  if (fs.statSync(output).size < sizeBefore - 2000) {
    throw new Error('The exe shrank after stamping; the embedded UI may have been lost.');
  }

  const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
  console.log(`\nBuilt ${path.relative(root, output)} (${mb} MB), publisher "${PUBLISHER}"`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
