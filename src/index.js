#!/usr/bin/env node
import { Command } from 'commander';
import { extractCommand } from './extract.js';
import { compressCommand } from './compress.js';

const program = new Command();

program.name('scene-optimizer').version('1.0.0').description('Extract and compress textures from GLB files');

program
  .command('extract')
  .description('Extract textures from GLB files into models/ and textures/ folders')
  .argument('<input>', 'GLB file, glob pattern, or folder containing GLBs')
  .option('-o, --outdir <dir>', 'Output directory', './output')
  .action(async (input, options) => {
    try {
      await extractCommand(input, options);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command('compress')
  .description('Compress and resize textures by type')
  .argument('<textures-folder>', 'Folder containing textures (from extract step)')
  .option('-o, --outdir <dir>', 'Output directory (default: overwrite in place)')
  .option('-b, --basecolor-size <n>', 'Max height for baseColor textures', '1024')
  .option('-n, --normal-size <n>', 'Max height for normal maps', '1024')
  .option('-r, --orm-size <n>', 'Max height for roughness/metallic/ORM textures', '512')
  .option('-e, --emissive-size <n>', 'Max height for emissive textures', '512')
  .option('--other-size <n>', 'Max height for other textures', '512')
  .option('-q, --quality <n>', 'Compression quality 1-100', '85')
  .option('-d, --depth <n>', 'Bit depth: 8 or 16', '8')
  .option('-f, --format <fmt>', 'Output format: png, jpeg, webp', 'png')
  .action(async (texturesFolder, options) => {
    try {
      await compressCommand(texturesFolder, options);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });

program.parse();
