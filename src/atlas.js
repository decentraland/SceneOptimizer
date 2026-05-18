import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import sharp from 'sharp';

const defaultProgress = (e) => console.log(e.message || JSON.stringify(e));

/**
 * Partition a folder of PNGs into the set of files that will go into the
 * main atlas vs. paired `<base>.png` + `<base>_alpha.png` siblings.
 * Orphan `*_alpha.png` files (no matching base) are treated as normal
 * main images. Shared by `scanInputs` (used by the UI) and `atlasCommand`
 * so both see the exact same partition.
 *
 * Returns absolute paths so the caller can read pixels directly.
 */
async function partitionPngs(inDir) {
  const pngs = (await glob('*.png', { cwd: inDir, absolute: true, nocase: true }))
    .filter((f) => !path.basename(f).match(/^atlas(_alpha|_auto_alpha)?_\d+\.png$/i))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  const allNames = new Set(pngs.map((p) => path.basename(p)));
  const alphaPairs = []; // { base: <abs>, alpha: <abs> }
  const orphanAlphaFiles = [];
  const baseFiles = [];

  for (const f of pngs) {
    const name = path.basename(f);
    if (name.endsWith('_alpha.png')) {
      const baseName = name.replace(/_alpha\.png$/, '.png');
      if (allNames.has(baseName)) {
        alphaPairs.push({ base: path.join(path.dirname(f), baseName), alpha: f });
      } else {
        orphanAlphaFiles.push(f);
      }
    } else {
      baseFiles.push(f);
    }
  }

  const mainFiles = [...baseFiles, ...orphanAlphaFiles].sort((a, b) =>
    path.basename(a).localeCompare(path.basename(b)),
  );

  return { mainFiles, alphaPairs };
}

/**
 * Public scan used by `GET /api/atlas/scan`. Returns dimensions for each
 * main file so the UI can show area and offer manual reordering.
 */
export async function scanInputs(inputDir) {
  const inDir = path.resolve(inputDir);
  const { mainFiles, alphaPairs } = await partitionPngs(inDir);

  const detailed = [];
  for (const f of mainFiles) {
    try {
      const m = await sharp(f).metadata();
      if (m.width && m.height) {
        detailed.push({ path: f, name: path.basename(f), width: m.width, height: m.height });
      }
    } catch {
      // unreadable, skip
    }
  }

  const pairedBaseNames = new Set(alphaPairs.map((p) => path.basename(p.base)));
  return {
    inputDir: inDir,
    mainFiles: detailed.map((d) => ({ ...d, hasAlphaPair: pairedBaseNames.has(d.name) })),
    alphaPairs: alphaPairs.map((p) => ({
      base: path.basename(p.base),
      alpha: path.basename(p.alpha),
    })),
  };
}

/**
 * Pack PNGs from `inputDir` into a fixed-size atlas, written to `outputDir`.
 *
 * Options:
 *   - size:   atlas width & height in px (default 1024)
 *   - margin: per-cell padding in px (default 1)
 *   - order:  optional array of filenames (basenames) defining the exact
 *             packing order. When provided, items are packed in that order
 *             with no sort. Files in the folder but not in `order` are
 *             excluded from the atlas. Files in `order` but not on disk
 *             are ignored with a warning.
 */
export async function atlasCommand(inputDir, outputDir, options, onProgress = defaultProgress) {
  const inDir = path.resolve(inputDir);
  const outDir = path.resolve(outputDir);
  const size = parseInt(options.size, 10) || 1024;
  const margin = Math.max(0, parseInt(options.margin, 10) || 0);
  const customOrder = Array.isArray(options.order) && options.order.length ? options.order : null;

  const log = (message, type = 'info') => onProgress({ type, message });

  const { mainFiles, alphaPairs } = await partitionPngs(inDir);
  if (mainFiles.length === 0) throw new Error(`No PNG files found in ${inDir}`);

  log(`Found ${mainFiles.length} image(s), ${alphaPairs.length} alpha pair(s)`, 'info');

  // Read dimensions for every main file.
  const fileByName = new Map();
  for (const f of mainFiles) {
    const name = path.basename(f);
    try {
      const m = await sharp(f).metadata();
      if (m.width && m.height) {
        fileByName.set(name, {
          file: f,
          name,
          w: m.width,
          h: m.height,
          cellW: m.width + 2 * margin,
          cellH: m.height + 2 * margin,
        });
      } else {
        log(`Skipping ${name}: could not read dimensions`, 'warning');
      }
    } catch {
      log(`Skipping ${name}: could not read metadata`, 'warning');
    }
  }

  if (fileByName.size === 0) throw new Error('No usable images after reading dimensions');

  // Choose packing order: custom (manual reorder) or auto (area desc, name asc).
  let ordered;
  if (customOrder) {
    ordered = [];
    for (const name of customOrder) {
      const it = fileByName.get(name);
      if (it) ordered.push(it);
      else log(`Custom order references missing file ${name}, ignored`, 'warning');
    }
    if (ordered.length === 0) {
      throw new Error('Custom order did not match any input files');
    }
    log(`Packing ${ordered.length} image(s) in manual order`, 'info');
  } else {
    ordered = [...fileByName.values()].sort((a, b) => {
      const areaDelta = b.cellW * b.cellH - a.cellW * a.cellH;
      return areaDelta !== 0 ? areaDelta : a.name.localeCompare(b.name);
    });
  }

  // Row-pack: greedily fill rows of width <= size.
  const rows = [];
  const skipped = [];
  let currentRow = null;
  for (const it of ordered) {
    if (it.cellW > size || it.cellH > size) {
      skipped.push({ name: it.name, reason: 'too large for atlas' });
      log(`Skipping ${it.name}: ${it.cellW}x${it.cellH} exceeds atlas ${size}x${size}`, 'warning');
      continue;
    }
    if (!currentRow || currentRow.width + it.cellW > size) {
      currentRow = { images: [it], width: it.cellW, height: it.cellH };
      rows.push(currentRow);
    } else {
      currentRow.images.push(it);
      currentRow.width += it.cellW;
      currentRow.height = Math.max(currentRow.height, it.cellH);
    }
  }

  // Drop rows that overflow vertically.
  const fittedRows = [];
  let totalH = 0;
  for (const row of rows) {
    if (totalH + row.height > size) {
      for (const it of row.images) {
        skipped.push({ name: it.name, reason: 'atlas height overflow' });
        log(`Skipping ${it.name}: atlas height would exceed ${size}px`, 'warning');
      }
      continue;
    }
    fittedRows.push(row);
    totalH += row.height;
  }

  // Build composite list + metadata.
  const composites = [];
  const meta = {
    atlas: {
      width: size,
      height: size,
      margin,
      layout_type: customOrder ? 'manual' : 'compact_dynamic',
      rows: fittedRows.length,
      total_images: 0,
      space_efficiency: 0,
    },
    images: [],
  };

  let imageSpace = 0;
  let y = 0;
  for (const [r, row] of fittedRows.entries()) {
    let x = 0;
    for (const [c, it] of row.images.entries()) {
      const imageX = x + margin;
      const imageY = y + margin;
      composites.push({ input: it.file, left: imageX, top: imageY });
      meta.images.push({
        name: it.name,
        cell: { x, y, width: it.cellW, height: it.cellH },
        image: { x: imageX, y: imageY, width: it.w, height: it.h },
        original: { width: it.w, height: it.h },
        layout_position: { row: r, col: c },
      });
      imageSpace += it.w * it.h;
      x += it.cellW;
      onProgress({
        type: 'progress',
        current: meta.images.length,
        total: ordered.length,
        file: it.name,
        message: `Placed ${it.name} at (${imageX}, ${imageY})`,
      });
    }
    y += row.height;
  }

  meta.atlas.total_images = meta.images.length;
  meta.atlas.space_efficiency = (imageSpace / (size * size)) * 100;

  // Write main atlas + metadata.
  await fs.mkdir(outDir, { recursive: true });
  const atlasPath = path.join(outDir, `atlas_${size}.png`);
  await sharp({
    create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
  })
    .composite(composites)
    .png({ compressionLevel: 0, force: true })
    .toFile(atlasPath);

  const metadataPath = path.join(outDir, 'atlas_metadata.json');
  await fs.writeFile(metadataPath, JSON.stringify(meta, null, 2));

  log(`Wrote ${path.basename(atlasPath)}`, 'success');
  log(`Wrote ${path.basename(metadataPath)}`, 'success');

  // Auto-generated alpha atlas — always emitted.
  const autoAlphaPath = path.join(outDir, `atlas_auto_alpha_${size}.png`);
  await sharp(atlasPath)
    .extractChannel('alpha')
    .png({ compressionLevel: 0, force: true })
    .toFile(autoAlphaPath);
  log(`Wrote ${path.basename(autoAlphaPath)}`, 'success');

  // Paired alpha atlas — only for placed bases.
  let alphaAtlasPath = null;
  let alphaMetadataPath = null;
  const placedBases = new Set(meta.images.map((i) => i.name));
  const usablePairs = alphaPairs.filter((p) => placedBases.has(path.basename(p.base)));

  if (usablePairs.length > 0) {
    const baseByName = new Map(meta.images.map((i) => [i.name, i]));
    const alphaComposites = [];
    const alphaMeta = {
      atlas: {
        width: size,
        height: size,
        margin,
        layout_type: 'alpha_matched',
        total_images: 0,
        description: 'Alpha channel atlas with same positions as main atlas',
      },
      images: [],
    };

    for (const { base, alpha } of usablePairs) {
      const baseName = path.basename(base);
      const alphaName = path.basename(alpha);
      const basePos = baseByName.get(baseName);
      const m = await sharp(alpha).metadata();
      if (!m.width || !m.height) {
        log(`Skipping alpha ${alphaName}: cannot read dimensions`, 'warning');
        continue;
      }
      alphaComposites.push({ input: alpha, left: basePos.image.x, top: basePos.image.y });
      alphaMeta.images.push({
        name: alphaName,
        base_file: baseName,
        cell: basePos.cell,
        image: { x: basePos.image.x, y: basePos.image.y, width: m.width, height: m.height },
        original: { width: m.width, height: m.height },
        layout_position: basePos.layout_position,
      });
    }

    alphaMeta.atlas.total_images = alphaMeta.images.length;

    alphaAtlasPath = path.join(outDir, `atlas_alpha_${size}.png`);
    await sharp({
      create: { width: size, height: size, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } },
    })
      .composite(alphaComposites)
      .png({ compressionLevel: 0, force: true })
      .toFile(alphaAtlasPath);

    alphaMetadataPath = path.join(outDir, 'atlas_alpha_metadata.json');
    await fs.writeFile(alphaMetadataPath, JSON.stringify(alphaMeta, null, 2));

    log(`Wrote ${path.basename(alphaAtlasPath)}`, 'success');
    log(`Wrote ${path.basename(alphaMetadataPath)}`, 'success');
  } else if (alphaPairs.length > 0) {
    log('Alpha pairs found but no usable base placements; alpha atlas skipped', 'warning');
  } else {
    log('No alpha files found, skipping alpha atlas', 'info');
  }

  const summary = {
    type: 'summary',
    totalImages: meta.images.length,
    skipped,
    atlasSize: size,
    efficiency: meta.atlas.space_efficiency,
    layoutType: meta.atlas.layout_type,
    atlasPath,
    metadataPath,
    autoAlphaPath,
    alphaAtlasPath,
    alphaMetadataPath,
    message: `Atlas built: ${meta.images.length} image(s), ${meta.atlas.space_efficiency.toFixed(1)}% efficiency`,
  };
  onProgress(summary);
  return summary;
}
