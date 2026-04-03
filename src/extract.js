import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { listTextureSlots } from '@gltf-transform/functions';
import {
  classifyTextureSlot,
  mimeToExtension,
  sanitizeFilename,
  formatBytes,
  resolveGlobs,
} from './utils.js';

const defaultProgress = (e) => console.log(e.message);

/**
 * Patch a GLB file's JSON chunk to add URI references to images.
 * gltf-transform strips URIs when writing GLB, so we inject them manually.
 */
async function patchGlbImageURIs(glbPath, imageURIs) {
  if (imageURIs.size === 0) return;

  const buf = Buffer.from(await fs.readFile(glbPath));

  // GLB header: magic(4) + version(4) + totalLength(4) = 12 bytes
  // Chunk 0 header: chunkLength(4) + chunkType(4) = 8 bytes
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonStr = buf.slice(20, 20 + jsonChunkLength).toString('utf8').trimEnd();
  const json = JSON.parse(jsonStr);

  // Add URI to each image entry, remove bufferView if present
  if (json.images) {
    for (const [idx, filename] of imageURIs) {
      if (json.images[idx]) {
        json.images[idx].uri = filename;
        delete json.images[idx].bufferView;
      }
    }
  }

  // Re-encode the JSON chunk, padded to 4-byte alignment with spaces (per GLB spec)
  let newJsonStr = JSON.stringify(json);
  while (newJsonStr.length % 4 !== 0) newJsonStr += ' ';
  const newJsonBuf = Buffer.from(newJsonStr, 'utf8');

  // Rebuild the GLB: header(12) + json chunk header(8) + json data + binary chunk (if any)
  const binaryChunkStart = 20 + jsonChunkLength;
  const binaryChunk = binaryChunkStart < buf.length ? buf.slice(binaryChunkStart) : Buffer.alloc(0);

  const totalLength = 12 + 8 + newJsonBuf.length + binaryChunk.length;
  const out = Buffer.alloc(totalLength);

  // GLB header
  out.writeUInt32LE(0x46546C67, 0); // magic: glTF
  out.writeUInt32LE(2, 4);           // version: 2
  out.writeUInt32LE(totalLength, 8);

  // JSON chunk header
  out.writeUInt32LE(newJsonBuf.length, 12);
  out.writeUInt32LE(0x4E4F534A, 16); // type: JSON

  // JSON data
  newJsonBuf.copy(out, 20);

  // Binary chunk (if any)
  if (binaryChunk.length > 0) {
    binaryChunk.copy(out, 20 + newJsonBuf.length);
  }

  await fs.writeFile(glbPath, out);
}

function buildTextureNameMap(document, globalUsedNames) {
  const root = document.getRoot();
  const textures = root.listTextures();
  const nameMap = new Map();
  const usedNames = globalUsedNames;

  // Build a lookup: texture → slot category (from material assignments)
  const textureCategories = new Map();
  for (const material of root.listMaterials()) {
    const slots = [
      ['baseColorTexture', material.getBaseColorTexture()],
      ['normalTexture', material.getNormalTexture()],
      ['metallicRoughnessTexture', material.getMetallicRoughnessTexture()],
      ['occlusionTexture', material.getOcclusionTexture()],
      ['emissiveTexture', material.getEmissiveTexture()],
    ];
    for (const [slotName, texture] of slots) {
      if (texture && !textureCategories.has(texture)) {
        textureCategories.set(texture, classifyTextureSlot(slotName));
      }
    }
  }

  // Use the texture's ORIGINAL name from the GLB, with category suffix
  for (const texture of textures) {
    if (nameMap.has(texture)) continue;

    const originalName = texture.getName() || '';
    const category = textureCategories.get(texture)
      || (listTextureSlots(texture).length > 0 ? classifyTextureSlot(listTextureSlots(texture)[0]) : 'other');
    const ext = mimeToExtension(texture.getMimeType());

    // Use original texture name if available, otherwise fall back to "texture"
    let baseName;
    if (originalName) {
      // Use original name as-is (sanitized), don't append category if name already implies it
      baseName = sanitizeFilename(originalName);
    } else {
      baseName = `texture_${category}`;
    }

    let finalName = baseName + ext;

    let counter = 2;
    while (usedNames.has(finalName)) {
      finalName = `${baseName}_${counter}${ext}`;
      counter++;
    }

    usedNames.add(finalName);
    nameMap.set(texture, { filename: finalName, category });
  }

  return nameMap;
}

export async function extractCommand(input, options, onProgress = defaultProgress) {
  const outdir = path.resolve(options.outdir);
  const modelsDir = path.join(outdir, 'models');
  const texturesDir = path.join(outdir, 'textures');

  await fs.mkdir(modelsDir, { recursive: true });
  await fs.mkdir(texturesDir, { recursive: true });

  // Accept an array of paths (from server) or a glob string (from CLI)
  const glbFiles = Array.isArray(input) ? input : await resolveGlobs(input);
  if (glbFiles.length === 0) {
    throw new Error(`No .glb files found matching: ${input}`);
  }

  onProgress({ type: 'start', fileCount: glbFiles.length, message: `Found ${glbFiles.length} GLB file(s)\n` });

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const manifest = {};
  const globalUsedNames = new Set();
  // Dedup key (sourceName:width:height) → filename: deduplicates shared textures across GLBs
  const dedupIndex = new Map();

  for (const glbPath of glbFiles) {
    const baseName = path.basename(glbPath, '.glb');
    onProgress({ type: 'file-start', file: `${baseName}.glb`, message: `Processing: ${baseName}.glb` });

    const document = await io.read(glbPath);
    const root = document.getRoot();
    const textures = root.listTextures();

    if (textures.length === 0) {
      onProgress({ type: 'file-skip', file: `${baseName}.glb`, message: '  No textures found, copying as-is\n' });
      const data = await fs.readFile(glbPath);
      await fs.writeFile(path.join(modelsDir, `${baseName}.glb`), data);
      continue;
    }

    const nameMap = buildTextureNameMap(document, globalUsedNames);

    let extractedCount = 0;
    let totalTextureBytes = 0;
    // Maps texture object → actual filename used (may differ from nameMap if deduped)
    const dedupedNames = new Map();

    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData) continue;

      const { filename, category } = nameMap.get(texture);

      // Build dedup key from: original texture name + dimensions
      // Textures with the same source name and size across GLBs are the same asset
      const sourceName = texture.getName() || '';
      let dedupKey = '';
      if (sourceName) {
        try {
          const meta = await sharp(Buffer.from(imageData)).metadata();
          dedupKey = `${sourceName}:${meta.width}:${meta.height}`;
        } catch {
          dedupKey = '';
        }
      }

      // Also compute pixel hash as fallback for unnamed textures or different names w/ same pixels
      const rawPixels = await sharp(Buffer.from(imageData)).raw().toBuffer();
      const pixelHash = crypto.createHash('sha256').update(rawPixels).digest('hex');

      // Check both dedup strategies
      const existingByName = dedupKey ? dedupIndex.get(`name:${dedupKey}`) : null;
      const existingByHash = dedupIndex.get(`hash:${pixelHash}`);
      const existing = existingByName || existingByHash;

      if (existing) {
        dedupedNames.set(texture, existing);

        onProgress({
          type: 'texture-reused',
          file: `${baseName}.glb`,
          filename: existing,
          originalName: filename,
          category,
          message: `  Reused: ${filename} → ${existing} (deduplicated)`,
        });
      } else {
        // New unique texture — write to disk
        const texturePath = path.join(texturesDir, filename);
        await fs.writeFile(texturePath, imageData);
        if (dedupKey) dedupIndex.set(`name:${dedupKey}`, filename);
        dedupIndex.set(`hash:${pixelHash}`, filename);
        dedupedNames.set(texture, filename);

        manifest[filename] = category;
        totalTextureBytes += imageData.byteLength;
        extractedCount++;

        onProgress({
          type: 'texture-extracted',
          file: `${baseName}.glb`,
          filename,
          size: imageData.byteLength,
          category,
          message: `  Extracted: ${filename} (${formatBytes(imageData.byteLength)}) [${category}]`,
        });
      }
    }

    // Build a map of image index → URI for patching the GLB after write
    const imageURIs = new Map();
    const imageList = root.listTextures();
    for (let i = 0; i < imageList.length; i++) {
      const resolvedName = dedupedNames.get(imageList[i]);
      if (!resolvedName) continue;
      imageURIs.set(i, '../textures/' + resolvedName);
      imageList[i].setImage(null);
    }

    const outputGlbPath = path.join(modelsDir, `${baseName}.glb`);
    await io.write(outputGlbPath, document);

    // Patch the GLB JSON chunk to add URI references to external textures
    // (gltf-transform strips URIs when writing GLB format)
    await patchGlbImageURIs(outputGlbPath, imageURIs);

    const originalSize = (await fs.stat(glbPath)).size;
    const strippedSize = (await fs.stat(outputGlbPath)).size;

    onProgress({
      type: 'file-done',
      file: `${baseName}.glb`,
      originalSize,
      strippedSize,
      textureCount: extractedCount,
      textureBytes: totalTextureBytes,
      message: `  Original: ${formatBytes(originalSize)} → Stripped: ${formatBytes(strippedSize)} | ${extractedCount} textures (${formatBytes(totalTextureBytes)})`,
    });
  }

  const manifestPath = path.join(texturesDir, 'manifest.json');
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  onProgress({ type: 'done', manifestPath, message: `Manifest written to: ${manifestPath}\nDone!` });

  return manifest;
}
