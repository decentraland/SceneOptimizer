#!/usr/bin/env node
import { Command } from 'commander';
import { extractCommand } from './extract.js';
import { compressCommand } from './compress.js';
import { dedupScan, dedupApply } from './dedup.js';

const program = new Command();

program
  .name('scene-optimizer')
  .version('1.0.0')
  .description('Extract and compress textures from GLB files');

program
  .command('extract')
  .description('Extract textures from GLB files')
  .argument('<input>', 'GLB file, glob pattern, or folder containing GLBs')
  .option('-o, --outdir <dir>', 'Output directory', './output')
  .option('-s, --separate-folders', 'Put models and textures in separate subfolders', false)
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
  .option('--denoise <level>', 'Denoise: off, light, medium, strong', 'off')
  .action(async (texturesFolder, options) => {
    try {
      await compressCommand(texturesFolder, options);
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });

program
  .command('dedup')
  .description('Find and merge duplicate textures across GLBs')
  .argument('<folder>', 'Folder containing GLBs and textures (output from extract)')
  .option('-s, --separate-folders', 'Models and textures are in separate subfolders', false)
  .option('--apply', 'Apply changes (rewrite GLBs + delete duplicates). Without this flag, only scans.', false)
  .action(async (folder, options) => {
    try {
      const result = await dedupScan(folder, { separateFolders: options.separateFolders });
      if (result.totalGroups === 0) {
        console.log('No duplicates found.');
        return;
      }
      if (!options.apply) {
        console.log('\nRun with --apply to rewrite GLBs and delete duplicates.');
        return;
      }
      const groupIds = result.groups.map(g => g.id);
      await dedupApply(folder, groupIds, result, { separateFolders: options.separateFolders });
    } catch (e) {
      console.error(e.message);
      process.exit(1);
    }
  });

program.parse();
