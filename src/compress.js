import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import sharp from 'sharp';
import oxipng from '@wasm-codecs/oxipng';
import { classifyByFilename, formatBytes } from './utils.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const CONCURRENCY = Math.max(2, os.cpus().length);

const defaultProgress = (e) => console.log(e.message);

async function runPool(items, concurrency, fn) {
  const results = [];
  let index = 0;
  async function next() {
    while (index < items.length) {
      const i = index++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => next()));
  return results;
}

export async function compressCommand(texturesFolder, options, onProgress = defaultProgress) {
  const inputDir = path.resolve(texturesFolder);
  const outputDir = options.outdir ? path.resolve(options.outdir) : inputDir;
  const inPlace = outputDir === inputDir;

  const sizeMap = {
    baseColor: parseInt(options.basecolorSize),
    normal: parseInt(options.normalSize),
    orm: parseInt(options.ormSize),
    emissive: parseInt(options.emissiveSize),
    other: parseInt(options.otherSize),
  };
  const quality = parseInt(options.quality);
  const depth = parseInt(options.depth);
  const format = options.format;
  const denoise = options.denoise || 'off';

  if (quality < 1 || quality > 100) throw new Error('Quality must be between 1 and 100');
  if (depth !== 8 && depth !== 16) throw new Error('Bit depth must be 8 or 16');
  if (!['png', 'jpeg', 'webp'].includes(format)) throw new Error('Format must be png, jpeg, or webp');

  const denoiseSettings = {
    off: null,
    light: { median: 3, sharpen: { sigma: 0.5 } },
    medium: { median: 3, sharpen: { sigma: 0.8 } },
    strong: { median: 5, sharpen: { sigma: 1.0 } },
  };

  if (outputDir !== inputDir) {
    await fs.mkdir(outputDir, { recursive: true });
  }

  let manifest = null;
  try {
    const manifestPath = path.join(inputDir, 'manifest.json');
    manifest = JSON.parse(await fs.readFile(manifestPath, 'utf-8'));
  } catch {}

  const allFiles = await fs.readdir(inputDir);
  const imageFiles = allFiles.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));

  if (imageFiles.length === 0) throw new Error(`No image files found in: ${inputDir}`);

  onProgress({
    type: 'start',
    fileCount: imageFiles.length,
    settings: { quality, depth, format, sizes: sizeMap },
    message: `Found ${imageFiles.length} texture(s) | ${format === 'png' ? `oxipng lossless, depth=${depth}` : `quality=${quality}`}, format=${format}${denoise !== 'off' ? ', denoise=' + denoise : ''}, concurrency=${CONCURRENCY}`,
  });

  let totalBefore = 0;
  let totalAfter = 0;

  const results = await runPool(imageFiles, CONCURRENCY, async (file) => {
    const inputPath = path.join(inputDir, file);
    const category = manifest?.[file] || classifyByFilename(file);
    const maxHeight = sizeMap[category] || sizeMap.other;

    const inputStats = await fs.stat(inputPath);

    const metadata = await sharp(inputPath).metadata();
    const needsResize = metadata.height > maxHeight;
    const dn = denoiseSettings[denoise];
    const needsDenoise = !!dn;
    const isPng = format === 'png';
    const inputIsPng = ['.png'].includes(path.extname(file).toLowerCase());
    // Sharp metadata.depth is a string: 'uchar' (8-bit), 'ushort' (16-bit), etc.
    // Treat anything other than 8-bit unsigned char as 16-bit for our purposes.
    const inputBitdepth = metadata.depth === 'uchar' ? 8 : 16;
    const needsBitDepthChange = isPng && inputIsPng && inputBitdepth !== depth;
    const needsTransform = needsResize || needsDenoise || needsBitDepthChange;

    const outputExt = format === 'jpeg' ? '.jpg' : `.${format}`;
    const baseName = path.basename(file, path.extname(file));
    const outputFilename = baseName + outputExt;
    const outputPath = path.join(outputDir, outputFilename);

    if (isPng && inputIsPng) {
      // PNG path: Sharp only for transforms, oxipng always does final encoding
      let pngBuffer;

      if (needsTransform) {
        // Sharp handles resize/denoise/bit-depth change → outputs PNG buffer → oxipng optimizes.
        // Always pass an explicit bitdepth so the user's selection is honored
        // (without this, Sharp falls back to the input's bit depth).
        let pipeline = sharp(inputPath);
        if (needsResize) pipeline = pipeline.resize(null, maxHeight, { withoutEnlargement: true });
        if (needsDenoise) {
          pipeline = pipeline.median(dn.median);
          if (dn.sharpen) pipeline = pipeline.sharpen(dn.sharpen);
        }
        pipeline = pipeline.png({ bitdepth: depth });
        pngBuffer = await pipeline.toBuffer();
      } else {
        pngBuffer = await fs.readFile(inputPath);
      }

      // oxipng lossless optimization — always.
      //
      // CAUTION: oxipng performs lossless "color type reduction" — e.g. an
      // RGBA PNG whose RGB channels are all equal gets repacked as 2-channel
      // grayscale+alpha. The pixel content is mathematically identical but
      // some runtimes (Babylon.js / glTFast under DCL) fail to load grayscale
      // PNGs as a glTF baseColor/normal/ORM texture, causing the entire GLB
      // to render invisibly. We detect channel reduction and re-expand to
      // RGB/RGBA via Sharp so the runtime always gets a 3- or 4-channel PNG.
      try {
        const optimized = await oxipng(pngBuffer, { level: 2 });
        if (optimized.length < pngBuffer.length) {
          const optimizedMeta = await sharp(optimized).metadata();
          if (optimizedMeta.channels && optimizedMeta.channels < 3) {
            // oxipng reduced to grayscale or grayscale+alpha — re-expand.
            const hasAlpha = optimizedMeta.channels === 2;
            let pipe = sharp(optimized).toColorspace('srgb');
            pipe = hasAlpha ? pipe.ensureAlpha() : pipe.removeAlpha();
            pipe = pipe.png({ bitdepth: depth });
            const reExpanded = await pipe.toBuffer();
            // Re-run oxipng on the expanded buffer so we still get a small file.
            try {
              const reOptimized = await oxipng(reExpanded, { level: 2 });
              const reOptMeta = await sharp(reOptimized).metadata();
              if (reOptimized.length < reExpanded.length && reOptMeta.channels >= 3) {
                pngBuffer = reOptimized;
              } else {
                pngBuffer = reExpanded;
              }
            } catch {
              pngBuffer = reExpanded;
            }
          } else {
            pngBuffer = optimized;
          }
        }
      } catch {}

      if (inPlace && outputPath === inputPath) {
        const tmpPath = outputPath + '.tmp';
        await fs.writeFile(tmpPath, pngBuffer);
        await fs.rename(tmpPath, outputPath);
      } else {
        await fs.writeFile(outputPath, pngBuffer);
      }
    } else {
      // JPEG/WebP path: Sharp does everything (quality slider applies here)
      let pipeline = sharp(inputPath);

      if (needsResize) pipeline = pipeline.resize(null, maxHeight, { withoutEnlargement: true });
      if (needsDenoise) {
        pipeline = pipeline.median(dn.median);
        if (dn.sharpen) pipeline = pipeline.sharpen(dn.sharpen);
      }

      if (format === 'jpeg' && metadata.channels === 4) {
        onProgress({ type: 'warning', file, message: `  Warning: ${file} has alpha channel — flattening to white for JPEG` });
        pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
      }

      if (format === 'jpeg') pipeline = pipeline.jpeg({ quality });
      else if (format === 'webp') pipeline = pipeline.webp({ quality });

      if (inPlace && outputPath === inputPath) {
        const tmpPath = outputPath + '.tmp';
        await pipeline.toFile(tmpPath);
        await fs.rename(tmpPath, outputPath);
      } else {
        await pipeline.toFile(outputPath);
      }
    }

    const outputStats = await fs.stat(outputPath);
    const ratio = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);

    onProgress({
      type: 'file-done',
      file,
      category,
      beforeSize: inputStats.size,
      afterSize: outputStats.size,
      reduction: ratio,
      resized: needsResize,
      message: `  ${file} [${category}]: ${formatBytes(inputStats.size)} → ${formatBytes(outputStats.size)} (${ratio}%)${needsResize ? ` → resized to ${maxHeight}` : ''}${isPng && !needsTransform ? ' (oxipng only)' : ''}`,
    });

    return { before: inputStats.size, after: outputStats.size };
  });

  for (const r of results) {
    totalBefore += r.before;
    totalAfter += r.after;
  }

  const reduction = ((1 - totalAfter / totalBefore) * 100).toFixed(1);

  onProgress({
    type: 'summary',
    totalBefore,
    totalAfter,
    reduction,
    message: `\nTotal: ${formatBytes(totalBefore)} → ${formatBytes(totalAfter)} (${reduction}% reduction)\nDone!`,
  });

  return { totalBefore, totalAfter, reduction };
}
