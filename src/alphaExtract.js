import fs from 'node:fs/promises';
import path from 'node:path';
import { glob } from 'glob';
import sharp from 'sharp';

const defaultProgress = (e) => console.log(e.message || JSON.stringify(e));

const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'bmp', 'tif', 'tiff', 'webp'];

/**
 * Extract the alpha channel of every image in `inputDir` and write each
 * result as a single-channel grayscale PNG to `outputDir` with an `_alpha`
 * suffix. Mirrors `extract_alpha.py` from the alpha-transform tool, but
 * runs in Node/Sharp so it can live inside SceneOptimizer.
 *
 * White = opaque, black = transparent. Output dimensions match the input
 * exactly (no resize, no compositing).
 */
export async function alphaExtractCommand(inputDir, outputDir, options, onProgress = defaultProgress) {
  const inDir = path.resolve(inputDir);
  const outDir = path.resolve(outputDir);
  const log = (message, type = 'info') => onProgress({ type, message });

  // Collect images of every supported extension (case-insensitive),
  // excluding anything already named `*_alpha.*` so re-runs are idempotent.
  const pattern = `*.{${IMAGE_EXTS.join(',')}}`;
  const files = (await glob(pattern, { cwd: inDir, absolute: true, nocase: true }))
    .filter((f) => !/_alpha\.[^.]+$/i.test(path.basename(f)))
    .sort((a, b) => path.basename(a).localeCompare(path.basename(b)));

  if (files.length === 0) throw new Error(`No images found in ${inDir}`);

  await fs.mkdir(outDir, { recursive: true });
  log(`Found ${files.length} image(s) to process`, 'info');

  const results = [];
  let written = 0;
  let failed = 0;

  for (const [i, file] of files.entries()) {
    const baseName = path.basename(file);
    const parsed = path.parse(baseName);
    const outName = `${parsed.name}_alpha.png`;
    const outPath = path.join(outDir, outName);

    try {
      const img = sharp(file).ensureAlpha();
      await img
        .extractChannel('alpha')
        .png({ compressionLevel: 0, force: true })
        .toFile(outPath);

      written++;
      results.push({ input: baseName, output: outName });
      onProgress({
        type: 'progress',
        current: i + 1,
        total: files.length,
        file: baseName,
        message: `Extracted ${baseName} -> ${outName}`,
      });
    } catch (err) {
      failed++;
      log(`Failed on ${baseName}: ${err.message}`, 'error');
    }
  }

  const summary = {
    type: 'summary',
    total: files.length,
    written,
    failed,
    outputDir: outDir,
    results,
    message: `Alpha extraction complete: ${written} written, ${failed} failed`,
  };
  onProgress(summary);
  return summary;
}
