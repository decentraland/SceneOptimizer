import fs from 'node:fs/promises';
import path from 'node:path';
import sharp from 'sharp';
import { classifyByFilename, formatBytes } from './utils.js';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const defaultProgress = (e) => console.log(e.message);

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

  // Denoise settings: median filter radius + optional sharpen
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
  } catch {
    // No manifest — will use filename-based classification
  }

  const allFiles = await fs.readdir(inputDir);
  const imageFiles = allFiles.filter((f) => IMAGE_EXTENSIONS.has(path.extname(f).toLowerCase()));

  if (imageFiles.length === 0) throw new Error(`No image files found in: ${inputDir}`);

  onProgress({
    type: 'start',
    fileCount: imageFiles.length,
    settings: { quality, depth, format, sizes: sizeMap },
    message: `Found ${imageFiles.length} texture(s) | quality=${quality}, depth=${depth}, format=${format}${denoise !== 'off' ? ', denoise=' + denoise : ''}`,
  });

  let totalBefore = 0;
  let totalAfter = 0;

  for (const file of imageFiles) {
    const inputPath = path.join(inputDir, file);
    const category = manifest?.[file] || classifyByFilename(file);
    const maxHeight = sizeMap[category] || sizeMap.other;

    const inputStats = await fs.stat(inputPath);
    totalBefore += inputStats.size;

    const metadata = await sharp(inputPath).metadata();

    let pipeline = sharp(inputPath);

    if (metadata.height > maxHeight) {
      pipeline = pipeline.resize(null, maxHeight, { withoutEnlargement: true });
    }

    const dn = denoiseSettings[denoise];
    if (dn) {
      pipeline = pipeline.median(dn.median);
      if (dn.sharpen) {
        pipeline = pipeline.sharpen(dn.sharpen);
      }
    }

    if (format === 'jpeg' && metadata.channels === 4) {
      onProgress({ type: 'warning', file, message: `  Warning: ${file} has alpha channel — flattening to white for JPEG` });
      pipeline = pipeline.flatten({ background: { r: 255, g: 255, b: 255 } });
    }

    const outputExt = format === 'jpeg' ? '.jpg' : `.${format}`;
    const baseName = path.basename(file, path.extname(file));
    const outputFilename = baseName + outputExt;

    switch (format) {
      case 'png':
        pipeline = pipeline.png({
          quality,
          ...(depth === 8 ? { bitdepth: 8 } : {}),
        });
        break;
      case 'jpeg':
        pipeline = pipeline.jpeg({ quality });
        break;
      case 'webp':
        pipeline = pipeline.webp({ quality });
        break;
    }

    const outputPath = path.join(outputDir, outputFilename);
    if (inPlace && outputPath === inputPath) {
      const tmpPath = outputPath + '.tmp';
      await pipeline.toFile(tmpPath);
      await fs.rename(tmpPath, outputPath);
    } else {
      await pipeline.toFile(outputPath);
    }

    const outputStats = await fs.stat(outputPath);
    totalAfter += outputStats.size;

    const ratio = ((1 - outputStats.size / inputStats.size) * 100).toFixed(1);
    const resized = metadata.height > maxHeight;

    onProgress({
      type: 'file-done',
      file,
      category,
      beforeSize: inputStats.size,
      afterSize: outputStats.size,
      reduction: ratio,
      resized,
      message: `  ${file} [${category}]: ${formatBytes(inputStats.size)} → ${formatBytes(outputStats.size)} (${ratio}% reduction)${resized ? ` → resized to height ${maxHeight}` : ''}`,
    });
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
