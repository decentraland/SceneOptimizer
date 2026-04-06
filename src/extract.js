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

const categoryPriority = { baseColor: 5, normal: 4, orm: 3, emissive: 2, other: 1 };

function fixGlbAlignment(buf) {
  if (buf.length < 20) return buf;
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546C67) return buf;

  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonEnd = 20 + jsonChunkLength;

  if (jsonEnd % 4 === 0) return buf;

  const padNeeded = 4 - (jsonEnd % 4);
  const jsonData = buf.subarray(20, jsonEnd);
  const padding = Buffer.alloc(padNeeded, 0x20);
  const newJsonLength = jsonChunkLength + padNeeded;

  const binaryChunk = jsonEnd + 8 <= buf.length ? buf.subarray(jsonEnd) : Buffer.alloc(0);
  const totalLength = 12 + 8 + newJsonLength + binaryChunk.length;

  const out = Buffer.alloc(totalLength);
  out.writeUInt32LE(0x46546C67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(newJsonLength, 12);
  out.writeUInt32LE(0x4E4F534A, 16);
  jsonData.copy(out, 20);
  padding.copy(out, 20 + jsonChunkLength);
  if (binaryChunk.length > 0) binaryChunk.copy(out, 20 + newJsonLength);

  return out;
}

async function patchGlbImageURIs(glbPath, imageURIs) {
  if (imageURIs.size === 0) return;

  const buf = await fs.readFile(glbPath);
  if (buf.length < 20) return;

  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonStr = buf.subarray(20, 20 + jsonChunkLength).toString('utf8').trimEnd();

  let json;
  try {
    json = JSON.parse(jsonStr);
  } catch {
    return;
  }

  if (json.images) {
    for (const [idx, filename] of imageURIs) {
      if (json.images[idx]) {
        json.images[idx].uri = filename;
        delete json.images[idx].bufferView;
      }
    }
  }

  let newJsonStr = JSON.stringify(json);
  while (Buffer.byteLength(newJsonStr, 'utf8') % 4 !== 0) newJsonStr += ' ';
  const newJsonBuf = Buffer.from(newJsonStr, 'utf8');

  const binaryChunkStart = 20 + jsonChunkLength;
  const hasBinaryChunk = binaryChunkStart + 8 <= buf.length;
  const binaryChunk = hasBinaryChunk ? buf.subarray(binaryChunkStart) : Buffer.alloc(0);

  const jsonSectionLength = 8 + newJsonBuf.length;
  let padding = Buffer.alloc(0);
  if (hasBinaryChunk && (12 + jsonSectionLength) % 4 !== 0) {
    const padLen = 4 - ((12 + jsonSectionLength) % 4);
    padding = Buffer.alloc(padLen, 0x20);
  }

  const totalLength = 12 + jsonSectionLength + padding.length + binaryChunk.length;
  const out = Buffer.alloc(totalLength);

  out.writeUInt32LE(0x46546C67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(newJsonBuf.length + padding.length, 12);
  out.writeUInt32LE(0x4E4F534A, 16);
  newJsonBuf.copy(out, 20);
  if (padding.length > 0) padding.copy(out, 20 + newJsonBuf.length);
  if (binaryChunk.length > 0) binaryChunk.copy(out, 20 + newJsonBuf.length + padding.length);

  await fs.writeFile(glbPath, out);
}

function buildTextureNameMap(document, globalUsedNames) {
  const root = document.getRoot();
  const textures = root.listTextures();
  const nameMap = new Map();
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
      if (!texture) continue;
      const category = classifyTextureSlot(slotName);
      const existing = textureCategories.get(texture);
      if (!existing || (categoryPriority[category] || 0) > (categoryPriority[existing] || 0)) {
        textureCategories.set(texture, category);
      }
    }
  }

  for (const texture of textures) {
    if (nameMap.has(texture)) continue;

    const originalName = texture.getName() || '';
    const category = textureCategories.get(texture)
      || (listTextureSlots(texture).length > 0 ? classifyTextureSlot(listTextureSlots(texture)[0]) : 'other');
    const ext = mimeToExtension(texture.getMimeType());
    const baseName = originalName ? sanitizeFilename(originalName) : `texture_${category}`;

    let finalName = baseName + ext;
    let counter = 2;
    while (globalUsedNames.has(finalName)) {
      finalName = `${baseName}_${counter}${ext}`;
      counter++;
    }

    globalUsedNames.add(finalName);
    nameMap.set(texture, { filename: finalName, category });
  }

  return nameMap;
}

export async function extractCommand(input, options, onProgress = defaultProgress) {
  const outdir = path.resolve(options.outdir);
  const separateFolders = options.separateFolders === true;

  const modelsDir = separateFolders ? path.join(outdir, 'models') : outdir;
  const texturesDir = separateFolders ? path.join(outdir, 'textures') : outdir;

  await fs.mkdir(modelsDir, { recursive: true });
  if (separateFolders) await fs.mkdir(texturesDir, { recursive: true });

  // Accept an array of paths (from server) or a glob string (from CLI)
  const glbFiles = Array.isArray(input) ? input : await resolveGlobs(input);
  if (glbFiles.length === 0) {
    throw new Error(`No .glb files found matching: ${input}`);
  }

  onProgress({ type: 'start', fileCount: glbFiles.length, message: `Found ${glbFiles.length} GLB file(s)\n` });

  const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);
  const manifest = {};
  const globalUsedNames = new Set();
  const dedupIndex = new Map();

  for (const glbPath of glbFiles) {
    const baseName = path.basename(glbPath, '.glb');
    onProgress({ type: 'file-start', file: `${baseName}.glb`, message: `Processing: ${baseName}.glb` });

    // Fix misaligned GLBs before reading (some exporters violate the 4-byte alignment spec)
    const rawBuf = await fs.readFile(glbPath);
    const alignedBuf = fixGlbAlignment(rawBuf);
    let readPath = glbPath;
    let tmpPath = null;
    if (alignedBuf !== rawBuf) {
      tmpPath = glbPath + '.aligned.tmp';
      await fs.writeFile(tmpPath, alignedBuf);
      readPath = tmpPath;
    }
    let document;
    try {
      document = await io.read(readPath);
    } catch (readErr) {
      // GLB may already have external texture URIs that can't be resolved — copy as-is
      onProgress({ type: 'file-skip', file: `${baseName}.glb`, message: `  Skipped: already has external textures or unreadable (${readErr.message})\n` });
      await fs.writeFile(path.join(modelsDir, `${baseName}.glb`), rawBuf);
      continue;
    } finally {
      if (tmpPath) await fs.unlink(tmpPath).catch(() => {});
    }
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
    const dedupedNames = new Map();

    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData) continue;

      const { filename, category } = nameMap.get(texture);

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

      const rawPixels = await sharp(Buffer.from(imageData)).raw().toBuffer();
      const pixelHash = crypto.createHash('sha256').update(rawPixels).digest('hex');

      const existingByName = dedupKey ? dedupIndex.get(`name:${dedupKey}`) : null;
      const existingByHash = dedupIndex.get(`hash:${pixelHash}`);
      const existing = existingByName || existingByHash;

      if (existing) {
        dedupedNames.set(texture, existing);

        const existingCategory = manifest[existing];
        if ((categoryPriority[category] || 0) > (categoryPriority[existingCategory] || 0)) {
          manifest[existing] = category;
        }

        onProgress({
          type: 'texture-reused',
          file: `${baseName}.glb`,
          filename: existing,
          originalName: filename,
          category,
          message: `  Reused: ${filename} → ${existing} (deduplicated)`,
        });
      } else {
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

    const imageURIs = new Map();
    const uriPrefix = separateFolders ? '../textures/' : '';
    for (let i = 0; i < textures.length; i++) {
      const resolvedName = dedupedNames.get(textures[i]);
      if (!resolvedName) continue;
      imageURIs.set(i, uriPrefix + resolvedName);
      textures[i].setImage(null);
    }

    const outputGlbPath = path.join(modelsDir, `${baseName}.glb`);
    await io.write(outputGlbPath, document);
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
