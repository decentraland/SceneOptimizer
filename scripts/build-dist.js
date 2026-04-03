/**
 * Build script for SceneOptimizer distribution ZIPs.
 *
 * Produces self-contained ZIPs for macOS (arm64 + x64) and Windows (x64),
 * each with an embedded Node.js runtime so artists don't need Node installed.
 *
 * Usage: node scripts/build-dist.js [--target macos-arm64|macos-x64|win-x64]
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import https from 'node:https';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const CACHE = path.join(__dirname, '.cache');

const NODE_VERSION = '22.15.0';

const TARGETS = [
  {
    name: 'macos-arm64',
    platform: 'darwin',
    arch: 'arm64',
    nodeArchive: `node-v${NODE_VERSION}-darwin-arm64.tar.gz`,
    nodeBinary: 'node',
    launcher: 'start.command',
  },
  {
    name: 'macos-x64',
    platform: 'darwin',
    arch: 'x64',
    nodeArchive: `node-v${NODE_VERSION}-darwin-x64.tar.gz`,
    nodeBinary: 'node',
    launcher: 'start.command',
  },
  {
    name: 'win-x64',
    platform: 'win32',
    arch: 'x64',
    nodeArchive: `node-v${NODE_VERSION}-win-x64.zip`,
    nodeBinary: 'node.exe',
    launcher: 'start.bat',
  },
];

// Parse --target flag
const targetArg = process.argv.find((a, i) => process.argv[i - 1] === '--target');
const selectedTargets = targetArg ? TARGETS.filter((t) => t.name === targetArg) : TARGETS;

if (targetArg && selectedTargets.length === 0) {
  console.error(`Unknown target: ${targetArg}`);
  console.error(`Available: ${TARGETS.map((t) => t.name).join(', ')}`);
  process.exit(1);
}

// === Helpers ===

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = createWriteStream(dest);
    proto
      .get(url, (res) => {
        // Follow redirects
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          file.close();
          fs.unlink(dest).catch(() => {});
          return download(res.headers.location, dest).then(resolve).catch(reject);
        }
        if (res.statusCode !== 200) {
          file.close();
          return reject(new Error(`HTTP ${res.statusCode} for ${url}`));
        }
        const total = parseInt(res.headers['content-length'] || '0', 10);
        let downloaded = 0;
        res.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0) {
            const pct = ((downloaded / total) * 100).toFixed(0);
            process.stdout.write(`\r  Downloading... ${pct}%`);
          }
        });
        res.pipe(file);
        file.on('finish', () => {
          file.close();
          console.log('');
          resolve();
        });
      })
      .on('error', (err) => {
        file.close();
        reject(err);
      });
  });
}

async function downloadNodeBinary(target) {
  const cacheFile = path.join(CACHE, target.nodeArchive);
  try {
    await fs.access(cacheFile);
    console.log(`  Using cached ${target.nodeArchive}`);
    return cacheFile;
  } catch {}

  const url = `https://nodejs.org/dist/v${NODE_VERSION}/${target.nodeArchive}`;
  console.log(`  Downloading ${url}`);
  await download(url, cacheFile);
  return cacheFile;
}

async function extractNodeBinary(archivePath, target, nodeDir) {
  await fs.mkdir(nodeDir, { recursive: true });

  if (target.platform === 'win32') {
    // ZIP — extract node.exe
    const folderName = `node-v${NODE_VERSION}-win-x64`;
    execSync(`unzip -o -j "${archivePath}" "${folderName}/node.exe" -d "${nodeDir}"`, {
      stdio: 'pipe',
    });
  } else {
    // tar.gz — extract bin/node
    const folderName = `node-v${NODE_VERSION}-${target.platform}-${target.arch}`;
    execSync(
      `tar -xzf "${archivePath}" --strip-components=2 -C "${nodeDir}" "${folderName}/bin/node"`,
      { stdio: 'pipe' },
    );
    execSync(`chmod +x "${path.join(nodeDir, 'node')}"`, { stdio: 'pipe' });
  }
}

function writeMacLauncher(filePath) {
  return fs.writeFile(
    filePath,
    `#!/bin/bash
DIR="$(cd "$(dirname "$0")" && pwd)"
export PORT=3000
echo ""
echo "  ✦ SceneOptimizer starting..."
echo "  Drop .glb files into the watch/ folder"
echo ""
"$DIR/node/node" "$DIR/app/src/server.js"
`,
    { mode: 0o755 },
  );
}

function writeWinLauncher(filePath) {
  return fs.writeFile(
    filePath,
    `@echo off
cd /d "%~dp0"
set PORT=3000
echo.
echo   SceneOptimizer starting...
echo   Drop .glb files into the watch\\ folder
echo.
node\\node.exe app\\src\\server.js
pause
`,
  );
}

async function copyDir(src, dest) {
  await fs.mkdir(dest, { recursive: true });
  const entries = await fs.readdir(src, { withFileTypes: true });
  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDir(srcPath, destPath);
    } else {
      await fs.copyFile(srcPath, destPath);
    }
  }
}

async function pruneNodeModules(appDir, target) {
  const nmDir = path.join(appDir, 'node_modules');

  // Remove @img/sharp-* packages that don't match this target
  const imgDir = path.join(nmDir, '@img');
  try {
    const imgEntries = await fs.readdir(imgDir);
    const targetSuffix = `${target.platform}-${target.arch}`;
    for (const entry of imgEntries) {
      // Keep matching platform, remove others
      if (entry.startsWith('sharp-') && !entry.includes(targetSuffix)) {
        await fs.rm(path.join(imgDir, entry), { recursive: true, force: true });
      }
    }
  } catch {}

  // Remove unnecessary files to save space
  const prunePatterns = ['*.md', '*.markdown', 'LICENSE*', 'CHANGELOG*', '*.d.ts', '*.map'];
  try {
    for (const pattern of prunePatterns) {
      try {
        execSync(`find "${nmDir}" -name "${pattern}" -type f -delete 2>/dev/null`, {
          stdio: 'pipe',
        });
      } catch {}
    }
  } catch {}
}

// === Main ===

console.log(`\n  SceneOptimizer Build Script`);
console.log(`  Node.js v${NODE_VERSION} | ${selectedTargets.length} target(s)\n`);

await fs.mkdir(CACHE, { recursive: true });
await fs.rm(DIST, { recursive: true, force: true });
await fs.mkdir(DIST, { recursive: true });

for (const target of selectedTargets) {
  console.log(`\n━━━ Building ${target.name} ━━━\n`);

  const stageDir = path.join(DIST, `_stage_${target.name}`, 'SceneOptimizer');
  await fs.mkdir(stageDir, { recursive: true });

  // 1. Download & extract Node.js binary
  console.log('  [1/5] Node.js binary');
  const archive = await downloadNodeBinary(target);
  const nodeDir = path.join(stageDir, 'node');
  await extractNodeBinary(archive, target, nodeDir);

  // 2. Copy app source
  console.log('  [2/5] Copying app source');
  const appDir = path.join(stageDir, 'app');
  await copyDir(path.join(ROOT, 'src'), path.join(appDir, 'src'));
  await fs.copyFile(path.join(ROOT, 'package.json'), path.join(appDir, 'package.json'));
  await fs.copyFile(path.join(ROOT, 'package-lock.json'), path.join(appDir, 'package-lock.json'));

  // 3. Install platform-specific dependencies
  console.log(`  [3/5] Installing deps (${target.platform}/${target.arch})`);
  execSync(
    `npm install --omit=dev --os=${target.platform} --cpu=${target.arch}`,
    { cwd: appDir, stdio: 'pipe', env: { ...process.env, npm_config_os: target.platform, npm_config_cpu: target.arch } },
  );

  // 4. Prune node_modules
  console.log('  [4/5] Pruning node_modules');
  await pruneNodeModules(appDir, target);

  // Create empty watch folder
  await fs.mkdir(path.join(stageDir, 'watch'), { recursive: true });

  // Write launcher
  if (target.platform === 'win32') {
    await writeWinLauncher(path.join(stageDir, 'start.bat'));
  } else {
    await writeMacLauncher(path.join(stageDir, 'start.command'));
  }

  // 5. Create ZIP
  console.log('  [5/5] Creating ZIP');
  const zipName = `SceneOptimizer-${target.name}.zip`;
  const zipPath = path.join(DIST, zipName);
  const stageParent = path.join(DIST, `_stage_${target.name}`);
  execSync(`cd "${stageParent}" && zip -r -y "${zipPath}" SceneOptimizer/`, { stdio: 'pipe' });

  // Get ZIP size
  const zipStat = await fs.stat(zipPath);
  const sizeMB = (zipStat.size / 1024 / 1024).toFixed(1);
  console.log(`  ✓ ${zipName} (${sizeMB} MB)`);

  // Clean up staging
  await fs.rm(stageParent, { recursive: true, force: true });
}

console.log(`\n  ✦ Build complete! ZIPs in: ${DIST}\n`);
