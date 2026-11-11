/*
 * Builds the single-file Windows exe:
 *   1. stamps the Neutralino binary with the app icon and version info (runs as the invoking user)
 *   2. runs `neu build` with the resources embedded in the exe
 *   3. copies the result to dist/NSSMServicesManager-<version>.exe
 *   4. restores the original binary, so `npm run dev` does not demand elevation
 *
 * Run `npm run setup` once first so bin/ and resources/js/neutralino.js exist.
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

const binary = path.join(root, 'bin', 'neutralino-win_x64.exe');
const backup = `${binary}.bak`;

async function main() {
  if (!fs.existsSync(binary)) {
    throw new Error('bin/neutralino-win_x64.exe is missing. Run "npm run setup" first.');
  }

  // Keep the app version in sync with package.json (CI sets package.json from the git tag).
  config.version = pkg.version;
  fs.writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);

  fs.copyFileSync(binary, backup);
  try {
    await rcedit(binary, {
      icon: path.join(root, 'build', 'icon.ico'),
      // Opens without a UAC prompt; the app offers "Restart as administrator" when it is needed.
      'requested-execution-level': 'asInvoker',
      'file-version': pkg.version,
      'product-version': pkg.version,
      'version-string': {
        ProductName: 'NSSM Services Manager',
        FileDescription: pkg.description,
        InternalName: binaryName,
        OriginalFilename: `${binaryName}.exe`,
      },
    });

    execSync('npx --no-install neu build --release --embed-resources', { cwd: root, stdio: 'inherit' });
  } finally {
    fs.copyFileSync(backup, binary);
    fs.unlinkSync(backup);
  }

  const built = path.join(root, 'dist', binaryName, `${binaryName}-win_x64.exe`);
  if (!fs.existsSync(built)) {
    throw new Error(`Expected build output not found: ${built}`);
  }
  const output = path.join(root, 'dist', `NSSMServicesManager-${pkg.version}.exe`);
  fs.copyFileSync(built, output);
  const mb = (fs.statSync(output).size / 1024 / 1024).toFixed(2);
  console.log(`\nBuilt ${path.relative(root, output)} (${mb} MB)`);
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
