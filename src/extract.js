import fs from 'node:fs/promises';
import path from 'node:path';
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

  for (const material of root.listMaterials()) {
    const matName = sanitizeFilename(material.getName() || 'material');
    const slots = [
      ['baseColorTexture', material.getBaseColorTexture()],
      ['normalTexture', material.getNormalTexture()],
      ['metallicRoughnessTexture', material.getMetallicRoughnessTexture()],
      ['occlusionTexture', material.getOcclusionTexture()],
      ['emissiveTexture', material.getEmissiveTexture()],
    ];

    for (const [slotName, texture] of slots) {
      if (!texture || nameMap.has(texture)) continue;
      const category = classifyTextureSlot(slotName);
      const ext = mimeToExtension(texture.getMimeType());
      let baseName = `${matName}_${category}`;
      let finalName = baseName + ext;

      let counter = 2;
      while (usedNames.has(finalName)) {
        finalName = `${baseName}_${counter}${ext}`;
        counter++;
      }

      usedNames.add(finalName);
      nameMap.set(texture, { filename: finalName, category });
    }
  }

  for (const texture of textures) {
    if (nameMap.has(texture)) continue;

    const slots = listTextureSlots(texture);
    const category = slots.length > 0 ? classifyTextureSlot(slots[0]) : 'other';
    const texName = sanitizeFilename(texture.getName() || 'texture');
    const ext = mimeToExtension(texture.getMimeType());
    let baseName = `${texName}_${category}`;
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

    for (const texture of textures) {
      const imageData = texture.getImage();
      if (!imageData) continue;

      const { filename, category } = nameMap.get(texture);
      const texturePath = path.join(texturesDir, filename);
      await fs.writeFile(texturePath, imageData);

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

    // Build a map of image index → URI for patching the GLB after write
    const imageURIs = new Map();
    const imageList = root.listTextures();
    for (let i = 0; i < imageList.length; i++) {
      const info = nameMap.get(imageList[i]);
      if (!info) continue;
      imageURIs.set(i, '../textures/' + info.filename);
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
