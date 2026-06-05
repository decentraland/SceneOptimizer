import fs from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { glob } from 'glob';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { formatBytes } from './utils.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = path.resolve(__dirname, '..');

// Default flags — every one is here for a Decentraland-runtime reason.
// See meshoptimizer+atlas/README.md for the full rationale; do not change
// these defaults without verifying the corresponding DCL behaviour.
//   -tr   keep external texture URIs (don't embed sibling PNGs)
//   -kn   keep named nodes/meshes — required for "_collider" convention
//   -vpf  float positions instead of int+nodeScale (preserves named-node
//         topology so collider lookup stays intact)
//   -kv   keep source vertex attributes even if unused (UVs on runtime-
//         textured image-plane meshes would otherwise be stripped)
//   -vtf  store UVs as float (avoids glTFast quantized-int UV bugs)
const DEFAULT_FLAGS = ['-tr', '-kn', '-vpf', '-kv', '-vtf'];

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const defaultProgress = (e) => console.log(e.message);

function resolveGltfpackBin() {
  return path.join(PROJECT_ROOT, 'node_modules', '.bin', process.platform === 'win32' ? 'gltfpack.cmd' : 'gltfpack');
}

async function ensureGltfpack(bin) {
  try {
    await fs.access(bin);
  } catch {
    throw new Error(
      `gltfpack binary not found at ${bin}. Run \`npm install\` in the project root to install it.`
    );
  }
}

function runGltfpack(bin, inFile, outFile, extraFlags) {
  return new Promise((resolve) => {
    const args = ['-i', inFile, '-o', outFile, ...DEFAULT_FLAGS, ...extraFlags];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b) => { stdout += b.toString(); });
    child.stderr.on('data', (b) => { stderr += b.toString(); });
    child.on('error', (err) => resolve({ ok: false, code: -1, stdout, stderr: err.message }));
    child.on('close', (code) => resolve({ ok: code === 0, code, stdout, stderr }));
  });
}

async function countTriangles(io, glbPath) {
  try {
    const doc = await io.read(glbPath);
    let tris = 0;
    for (const mesh of doc.getRoot().listMeshes()) {
      for (const prim of mesh.listPrimitives()) {
        const indices = prim.getIndices();
        const positions = prim.getAttribute('POSITION');
        const count = indices ? indices.getCount() : (positions ? positions.getCount() : 0);
        const mode = prim.getMode();
        if (mode === 4) tris += count / 3;                       // TRIANGLES
        else if (mode === 5 || mode === 6) tris += Math.max(0, count - 2); // STRIP / FAN
      }
    }
    return Math.round(tris);
  } catch {
    return null;
  }
}

async function copyAuxFiles(srcDir, dstDir, predicate) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!predicate(entry.name)) continue;
    await fs.copyFile(path.join(srcDir, entry.name), path.join(dstDir, entry.name));
    count++;
  }
  return count;
}

function isTextureFile(name) {
  return TEXTURE_EXTS.has(path.extname(name).toLowerCase());
}

function isManifestFile(name) {
  return name === 'manifest.json';
}

export async function meshoptCommand(inputFolder, options = {}, onProgress = defaultProgress) {
  const inputDir = path.resolve(inputFolder);
  const separateFolders = options.separateFolders === true;

  const inputModelsDir = separateFolders ? path.join(inputDir, 'models') : inputDir;
  const inputTexturesDir = separateFolders ? path.join(inputDir, 'textures') : inputDir;

  const outputDir = options.outdir
    ? path.resolve(options.outdir)
    : path.join(inputDir, 'meshopt');
  const outputModelsDir = separateFolders ? path.join(outputDir, 'models') : outputDir;
  const outputTexturesDir = separateFolders ? path.join(outputDir, 'textures') : outputDir;

  const extraFlags = (options.extraFlags || '').trim().split(/\s+/).filter(Boolean);
  const writeReport = options.report !== false;

  const stat = await fs.stat(inputModelsDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Input models folder not found: ${inputModelsDir}`);
  }

  // If the output dir lives inside the input dir (e.g. a previous meshopt run
  // wrote to "<input>/meshopt-via-ui/"), exclude that subtree from the scan so
  // re-runs don't double-process the previous output.
  const ignorePatterns = [
    '**/node_modules/**',
    '**/.git/**',
    '**/meshopt/**',
    '**/atlas/**',
    '**/canonicalized/**',
    '**/*.aligned.tmp',
    '**/*.backup.glb',
  ];
  const relOutput = path.relative(inputModelsDir, outputModelsDir);
  if (relOutput && !relOutput.startsWith('..') && !path.isAbsolute(relOutput)) {
    const head = relOutput.split(path.sep)[0];
    if (head) ignorePatterns.push(`${head}/**`);
  }

  const glbFiles = await glob('**/*.glb', {
    cwd: inputModelsDir,
    nodir: true,
    posix: true,
    ignore: ignorePatterns,
  });

  if (glbFiles.length === 0) {
    throw new Error(`No .glb files found in: ${inputModelsDir}`);
  }

  const bin = resolveGltfpackBin();
  await ensureGltfpack(bin);

  await fs.mkdir(outputModelsDir, { recursive: true });
  if (separateFolders) await fs.mkdir(outputTexturesDir, { recursive: true });

  // Mirror sibling textures + manifest BEFORE processing GLBs. gltfpack's -tr
  // flag preserves URI references, so the optimized GLBs need to find their
  // textures at the same relative paths in the output folder. This also lets
  // us read post-meshopt geometry with @gltf-transform/core for triangle
  // counting (gltf-transform fails on unresolved external URIs).
  let copiedTextures = 0;
  if (separateFolders) {
    if (await fs.stat(inputTexturesDir).catch(() => null)) {
      copiedTextures += await copyAuxFiles(inputTexturesDir, outputTexturesDir, isTextureFile);
      copiedTextures += await copyAuxFiles(inputTexturesDir, outputTexturesDir, isManifestFile);
    }
  } else {
    copiedTextures += await copyAuxFiles(inputDir, outputDir, isTextureFile);
    copiedTextures += await copyAuxFiles(inputDir, outputDir, isManifestFile);
  }

  onProgress({
    type: 'start',
    fileCount: glbFiles.length,
    flags: [...DEFAULT_FLAGS, ...extraFlags],
    inputDir,
    outputDir,
    copiedTextures,
    message: `Found ${glbFiles.length} GLB file(s) | flags: ${[...DEFAULT_FLAGS, ...extraFlags].join(' ')} | mirrored ${copiedTextures} texture/manifest files`,
  });

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const results = [];
  let totalBefore = 0;
  let totalAfter = 0;
  let okCount = 0;
  let failCount = 0;

  for (const rel of glbFiles) {
    const inFile = path.join(inputModelsDir, rel);
    const outFile = path.join(outputModelsDir, rel);
    await fs.mkdir(path.dirname(outFile), { recursive: true });

    onProgress({ type: 'file-start', file: rel, message: `Processing: ${rel}` });

    const beforeStat = await fs.stat(inFile);
    const beforeTris = await countTriangles(io, inFile);

    const result = await runGltfpack(bin, inFile, outFile, extraFlags);
    if (!result.ok) {
      failCount++;
      const errLine = (result.stderr || result.stdout || '').trim().split('\n').pop() || `exit ${result.code}`;
      onProgress({
        type: 'file-error',
        file: rel,
        error: result.stderr || result.stdout,
        message: `  FAILED: ${rel} — ${errLine}`,
      });
      continue;
    }

    const afterStat = await fs.stat(outFile);
    const afterTris = await countTriangles(io, outFile);
    const delta = beforeStat.size - afterStat.size;
    const pct = beforeStat.size > 0 ? (delta / beforeStat.size) * 100 : 0;

    totalBefore += beforeStat.size;
    totalAfter += afterStat.size;
    okCount++;

    results.push({
      file: rel,
      before: beforeStat.size,
      after: afterStat.size,
      delta,
      pct,
      beforeTris,
      afterTris,
    });

    const triLabel =
      beforeTris != null && afterTris != null
        ? ` | tris: ${beforeTris} → ${afterTris}`
        : '';

    onProgress({
      type: 'file-done',
      file: rel,
      beforeSize: beforeStat.size,
      afterSize: afterStat.size,
      reduction: pct.toFixed(1),
      beforeTris,
      afterTris,
      message: `  ${rel}: ${formatBytes(beforeStat.size)} → ${formatBytes(afterStat.size)} (${pct.toFixed(1)}%)${triLabel}`,
    });
  }

  // TSV report.
  if (writeReport && results.length > 0) {
    const header = ['before', 'after', 'delta', 'pct', 'before_tris', 'after_tris', 'file'].join('\t');
    const lines = results
      .slice()
      .sort((a, b) => b.delta - a.delta)
      .map((r) =>
        [
          r.before,
          r.after,
          r.delta,
          r.pct.toFixed(1),
          r.beforeTris ?? '',
          r.afterTris ?? '',
          r.file,
        ].join('\t')
      );
    const reportPath = path.join(outputDir, 'meshopt-report.tsv');
    await fs.writeFile(reportPath, [header, ...lines].join('\n') + '\n');
    onProgress({
      type: 'report',
      reportPath,
      message: `Report written to: ${reportPath}`,
    });
  }

  const reduction = totalBefore > 0 ? ((1 - totalAfter / totalBefore) * 100) : 0;

  // Top-20 savings summary line.
  const top = results
    .slice()
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 20);
  if (top.length > 0) {
    onProgress({ type: 'top-savings-header', message: '\nTop savings:' });
    for (const r of top) {
      onProgress({
        type: 'top-savings',
        file: r.file,
        message: `  ${r.file}: ${formatBytes(r.before)} → ${formatBytes(r.after)} (${r.pct.toFixed(1)}%)`,
      });
    }
  }

  onProgress({
    type: 'summary',
    okCount,
    failCount,
    copiedTextures,
    totalBefore,
    totalAfter,
    reduction: reduction.toFixed(1),
    outputDir,
    message: `\nMeshopt: ${okCount} ok, ${failCount} failed | ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (${reduction.toFixed(1)}% reduction)\nOutput: ${outputDir}\nDone!`,
  });

  return { okCount, failCount, totalBefore, totalAfter, reduction, outputDir, results };
}
