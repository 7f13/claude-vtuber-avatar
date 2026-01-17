import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

if (process.platform !== 'darwin') {
  fail('This script is macOS-only.');
}

const rootDir = process.cwd();
const pkgPath = path.join(rootDir, 'package.json');
const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));

const productName = pkg?.build?.productName || pkg?.name || 'ElectronApp';
const appBundleName = `${productName}.app`;

const electronAppSrc = path.join(
  rootDir,
  'node_modules',
  'electron',
  'dist',
  'Electron.app'
);

if (!fs.existsSync(electronAppSrc)) {
  fail(`Electron.app not found at: ${electronAppSrc}`);
}

const arch = process.arch; // arm64 on Apple Silicon
const outDir = path.join(rootDir, 'release', 'portable', `mac-${arch}`);
const appDest = path.join(outDir, appBundleName);
const resourcesDest = path.join(appDest, 'Contents', 'Resources');

console.log(`Output: ${appDest}`);

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

// Copy stock Electron.app as-is (keeps upstream binaries/signatures intact).
// IMPORTANT: use `ditto` on macOS to preserve bundle symlinks correctly.
const ditto = spawnSync('ditto', [electronAppSrc, appDest], { stdio: 'inherit' });
if (ditto.status !== 0) {
  fail(`ditto failed (exit=${ditto.status ?? 'unknown'})`);
}

// Build app.asar from a staging directory that includes:
// - electron/ (main.cjs, index.html, assets...)
// - package.json (with main=electron/main.cjs)
// - node_modules (runtime deps; we exclude obvious dev-only/builder-only ones)
const asarCli = path.join(rootDir, 'node_modules', '@electron', 'asar', 'bin', 'asar.js');
const electronAppDir = path.join(rootDir, 'electron');
const tmpAsar = path.join(outDir, 'app.asar.tmp');
const stageDir = path.join(outDir, '.stage');

if (!fs.existsSync(electronAppDir)) {
  fail(`electron/ directory not found at: ${electronAppDir}`);
}

fs.mkdirSync(resourcesDest, { recursive: true });

// Option: reuse electron-builder's produced app.asar (if it exists and you want byte-for-byte parity)
// This is useful when the builder-made asar runs fine under the dev Electron binary.
const builderDir = path.join(rootDir, 'release', 'mac-arm64');
let builderAsar = '';
if (fs.existsSync(builderDir)) {
  const apps = fs.readdirSync(builderDir).filter((n) => n.endsWith('.app'));
  if (apps.length > 0) {
    builderAsar = path.join(builderDir, apps[0], 'Contents', 'Resources', 'app.asar');
  }
}
const useBuilderAsar = process.env.USE_BUILDER_ASAR === '1' && builderAsar && fs.existsSync(builderAsar);

if (useBuilderAsar) {
  console.log(`Using builder app.asar: ${builderAsar}`);
  fs.copyFileSync(builderAsar, path.join(resourcesDest, 'app.asar'));
} else {
  fs.rmSync(stageDir, { recursive: true, force: true });
  fs.mkdirSync(stageDir, { recursive: true });

  // electron/
  fs.cpSync(electronAppDir, path.join(stageDir, 'electron'), { recursive: true, dereference: true });

  // minimal package.json for Electron app loading
  const appPkg = {
    name: pkg?.name || 'zundamon-avatar',
    version: pkg?.version || '0.0.0',
    main: 'electron/main.cjs',
  };
  fs.writeFileSync(path.join(stageDir, 'package.json'), JSON.stringify(appPkg, null, 2));

  // node_modules (filtered)
  const nodeModulesSrc = path.join(rootDir, 'node_modules');
  const nodeModulesDest = path.join(stageDir, 'node_modules');
  if (fs.existsSync(nodeModulesSrc)) {
    const denyPrefixes = [
      path.join(nodeModulesSrc, 'electron'),
      path.join(nodeModulesSrc, 'electron-builder'),
      path.join(nodeModulesSrc, 'app-builder-lib'),
      path.join(nodeModulesSrc, 'builder-util'),
      path.join(nodeModulesSrc, 'builder-util-runtime'),
      path.join(nodeModulesSrc, 'dmg-builder'),
      path.join(nodeModulesSrc, 'app-builder-bin'),
      path.join(nodeModulesSrc, 'typescript'),
      path.join(nodeModulesSrc, 'tsx'),
      path.join(nodeModulesSrc, '@types'),
    ];

    fs.cpSync(nodeModulesSrc, nodeModulesDest, {
      recursive: true,
      dereference: true,
      filter: (src) => !denyPrefixes.some((p) => src === p || src.startsWith(p + path.sep)),
    });
  }

  const pack = spawnSync(process.execPath, [asarCli, 'pack', stageDir, tmpAsar], {
    stdio: 'inherit',
    cwd: rootDir,
    env: process.env,
  });

  if (pack.status !== 0) {
    fail(`asar pack failed (exit=${pack.status ?? 'unknown'})`);
  }

  fs.copyFileSync(tmpAsar, path.join(resourcesDest, 'app.asar'));
  fs.rmSync(tmpAsar, { force: true });
  fs.rmSync(stageDir, { recursive: true, force: true });
}

// Copy config/ into Resources/config
const configSrc = path.join(rootDir, 'config');
if (fs.existsSync(configSrc)) {
  fs.cpSync(configSrc, path.join(resourcesDest, 'config'), { recursive: true, dereference: false });
}

// Remove default_app.asar to ensure our app.asar is loaded
const defaultAppAsar = path.join(resourcesDest, 'default_app.asar');
if (fs.existsSync(defaultAppAsar)) {
  fs.rmSync(defaultAppAsar);
}

// Optionally replace icon if an .icns exists
const iconSrc = path.join(rootDir, 'electron', 'assets', 'icon.icns');
if (fs.existsSync(iconSrc)) {
  fs.copyFileSync(iconSrc, path.join(resourcesDest, 'electron.icns'));
}

console.log('Done.');
