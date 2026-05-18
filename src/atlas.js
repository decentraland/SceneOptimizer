import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import sharp from 'sharp';

const defaultProgress = (e) => console.log(e.message || JSON.stringify(e));

/**
 * Pack PNGs from `inputDir` into a fixed-size atlas, written to `outputDir`.
 * If the input set contains `<base>_alpha.png` siblings of `<base>.png`,
 * a paired alpha atlas with matching coordinates is produced.
 *
 * Port of build_atlas.py — same output JSON shape, same packing strategy
 * (sort by area desc, row-pack within target width).
 *
 * Options:
 *   - size:   atlas width & height in px (default 1024)
 *   - margin: per-cell padding in px (default 1)
 */
export async function atlasCommand(inputDir, outputDir, options, onProgress = defaultProgress) {
  const inDir = path.resolve(inputDir);
  const outDir = path.resolve(outputDir);
  const size = parseInt(options.size, 10) || 1024;
  const margin = Math.max(0, parseInt(options.margin, 10) || 0);

  const log = (message, type = 'info') => onProgress({ type, message });

  // 1. Scan PNGs (deterministic order: filename asc).
  const pngs = (await glob('*.png', { cwd: inDir, absolute: true, nocase: true }))
    .filter((f) => !path.basename(f).match(/^atlas(_alpha)?_\d+\.png$/i))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  if (pngs.length === 0) {
    throw new Error(`No PNG files found in ${inDir}`);
  }

  // 2. Partition into base / alpha-with-base / orphan-alpha (matches Python rules).
  const allNames = new Set(pngs.map((p) => path.basename(p)));
  const alphaPairs = []; // { base: <abs>, alpha: <abs> }
  const orphanAlphaFiles = []; // <abs>
  const baseFiles = []; // <abs> (excludes alpha-with-base)

  for (const f of pngs) {
    const name = path.basename(f);
    if (name.endsWith('_alpha.png')) {
      const baseName = name.replace(/_alpha\.png$/, '.png');
      if (allNames.has(baseName)) {
        alphaPairs.push({ base: path.join(path.dirname(f), baseName), alpha: f });
      } else {
        log(`Alpha file ${name} has no base version, treating as normal image`, 'info');
        orphanAlphaFiles.push(f);
      }
    } else {
      baseFiles.push(f);
    }
  }

  const mainFiles = [...baseFiles, ...orphanAlphaFiles]
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  log(`Found ${mainFiles.length} image(s) for main atlas, ${alphaPairs.length} alpha pair(s)`, 'info');

  // 3. Get dimensions via sharp.
  const items = [];
  for (const f of mainFiles) {
    const m = await sharp(f).metadata();
    if (!m.width || !m.height) {
      log(`Skipping ${path.basename(f)}: could not read dimensions`, 'warning');
      continue;
    }
    items.push({
      file: f,
      name: path.basename(f),
      w: m.width,
      h: m.height,
      cellW: m.width + 2 * margin,
      cellH: m.height + 2 * margin,
    });
  }

  if (items.length === 0) throw new Error('No usable images after reading dimensions');

  // 4. Pack rows: sort by area desc (tiebreak by filename asc for determinism).
  const sorted = [...items].sort((a, b) => {
    const areaDelta = b.cellW * b.cellH - a.cellW * a.cellH;
    if (areaDelta !== 0) return areaDelta;
    return a.name.localeCompare(b.name);
  });

  const rows = [];
  const skipped = [];
  let currentRow = null;
  for (const it of sorted) {
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

  // 5. Drop rows that overflow vertically.
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

  // 6. Build composite() list + metadata.
  const composites = [];
  const meta = {
    atlas: {
      width: size,
      height: size,
      margin,
      layout_type: 'compact_dynamic',
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
        total: items.length,
        file: it.name,
        message: `Placed ${it.name} at (${imageX}, ${imageY})`,
      });
    }
    y += row.height;
  }

  meta.atlas.total_images = meta.images.length;
  meta.atlas.space_efficiency = (imageSpace / (size * size)) * 100;

  // 7. Write main atlas + metadata.
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

  // 8. Optional alpha atlas — only pair entries whose base actually landed in the main atlas.
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
    atlasPath,
    metadataPath,
    alphaAtlasPath,
    alphaMetadataPath,
    message: `Atlas built: ${meta.images.length} image(s), ${meta.atlas.space_efficiency.toFixed(1)}% efficiency`,
  };
  onProgress(summary);
  return summary;
}
