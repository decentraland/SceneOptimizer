import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { glob } from 'glob';
import { formatBytes } from './utils.js';

/**
 * Regex to detect Blender-style numbered duplicates.
 * Matches: name_9.png, name_10.png, name.002.png, name.004.png
 * Group 1: base name (e.g. "Leaf_Mask4_basecolor")
 * Group 4: extension (e.g. ".png")
 */
const DUPE_REGEX = /^(.+?)(?:[-_](\d+)|\.(\d{3,}))(\.\w+)$/;

function getCanonicalName(filename) {
  const m = filename.match(DUPE_REGEX);
  if (!m) return null;
  return m[1] + m[4]; // base + extension
}

function readGlbJson(buf) {
  if (buf.length < 20) return null;
  const magic = buf.readUInt32LE(0);
  if (magic !== 0x46546C67) return null;
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonStr = buf.subarray(20, 20 + jsonChunkLength).toString('utf8').trimEnd();
  try {
    return JSON.parse(jsonStr);
  } catch {
    return null;
  }
}

function rewriteGlb(buf, replacements) {
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonStr = buf.subarray(20, 20 + jsonChunkLength).toString('utf8').trimEnd();

  let json;
  try {
    json = JSON.parse(jsonStr);
  } catch {
    return null;
  }

  let modified = false;
  if (json.images) {
    for (const img of json.images) {
      const uri = img.uri;
      if (uri && replacements.has(uri)) {
        img.uri = replacements.get(uri);
        modified = true;
      }
    }
  }

  if (!modified) return null;

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

  return out;
}

async function getPixelHash(filePath) {
  try {
    const rawPixels = await sharp(filePath).raw().toBuffer();
    return crypto.createHash('sha256').update(rawPixels).digest('hex');
  } catch {
    return null;
  }
}

async function getImageInfo(filePath) {
  try {
    const stat = await fs.stat(filePath);
    const meta = await sharp(filePath).metadata();
    return { size: stat.size, width: meta.width, height: meta.height };
  } catch {
    return { size: 0, width: 0, height: 0 };
  }
}

export async function dedupScan(folder, options = {}, onProgress = () => {}) {
  const modelsDir = options.separateFolders ? path.join(folder, 'models') : folder;
  const texturesDir = options.separateFolders ? path.join(folder, 'textures') : folder;

  // Find all GLBs
  const glbFiles = await glob('*.glb', { cwd: modelsDir, absolute: true });

  if (glbFiles.length === 0) {
    onProgress({ type: 'dedup-scan-done', totalGroups: 0, totalDuplicates: 0, totalSavings: 0, message: 'No GLB files found.' });
    return { groups: [], totalGroups: 0, totalDuplicates: 0, totalSavings: 0 };
  }

  // Collect all texture URI references from GLBs
  const textureToGlbs = new Map(); // textureName -> [glbName, ...]

  for (const glbPath of glbFiles) {
    const glbName = path.basename(glbPath);
    const buf = await fs.readFile(glbPath);
    const json = readGlbJson(buf);
    if (!json || !json.images) continue;

    for (const img of json.images) {
      if (!img.uri) continue;
      const uri = img.uri;
      if (!textureToGlbs.has(uri)) textureToGlbs.set(uri, []);
      const list = textureToGlbs.get(uri);
      if (!list.includes(glbName)) list.push(glbName);
    }
  }

  onProgress({ type: 'dedup-scan-start', glbCount: glbFiles.length, textureCount: textureToGlbs.size, message: `Scanning ${glbFiles.length} GLBs with ${textureToGlbs.size} texture references...` });

  // Group textures by canonical name
  const canonicalGroups = new Map(); // canonicalName -> [textureName, ...]
  for (const textureName of textureToGlbs.keys()) {
    const canonical = getCanonicalName(textureName);
    if (canonical) {
      if (!canonicalGroups.has(canonical)) canonicalGroups.set(canonical, []);
      canonicalGroups.get(canonical).push(textureName);
    }
  }

  // Also check for textures on disk that aren't referenced by GLBs
  const allPngs = await glob('*.png', { cwd: texturesDir });
  for (const png of allPngs) {
    const canonical = getCanonicalName(png);
    if (canonical) {
      if (!canonicalGroups.has(canonical)) canonicalGroups.set(canonical, []);
      const list = canonicalGroups.get(canonical);
      if (!list.includes(png)) list.push(png);
    }
  }

  // =============================================
  // PHASE 1: Suffix-based duplicates (_9, .002)
  // =============================================
  const groups = [];
  let groupIdx = 0;
  const alreadyGrouped = new Set(); // track textures already in a group

  for (const [canonical, members] of canonicalGroups) {
    const canonicalPath = path.join(texturesDir, canonical);
    let canonicalExists = false;
    try {
      await fs.access(canonicalPath);
      canonicalExists = true;
    } catch {}

    if (!canonicalExists) continue;
    if (members.length === 0) continue;

    const duplicates = members.filter(m => m !== canonical);
    if (duplicates.length === 0) continue;

    const canonicalInfo = await getImageInfo(canonicalPath);
    const canonicalHash = await getPixelHash(canonicalPath);

    const dupeInfos = [];
    let totalSavings = 0;

    for (const dupe of duplicates) {
      const dupePath = path.join(texturesDir, dupe);
      try { await fs.access(dupePath); } catch { continue; }

      const info = await getImageInfo(dupePath);
      const hash = await getPixelHash(dupePath);
      const pixelMatch = canonicalHash && hash ? canonicalHash === hash : false;

      dupeInfos.push({
        filename: dupe, path: dupePath, size: info.size,
        width: info.width, height: info.height, pixelHash: hash,
        pixelMatch, referencedBy: textureToGlbs.get(dupe) || [],
      });
      totalSavings += info.size;
    }

    if (dupeInfos.length === 0) continue;

    const allPixelMatch = dupeInfos.every(d => d.pixelMatch);
    const group = {
      id: `group-${groupIdx++}`,
      canonical: { filename: canonical, path: canonicalPath, size: canonicalInfo.size, width: canonicalInfo.width, height: canonicalInfo.height, pixelHash: canonicalHash },
      canonicalReferencedBy: textureToGlbs.get(canonical) || [],
      duplicates: dupeInfos,
      pixelMatch: allPixelMatch,
      savingsBytes: totalSavings,
    };

    groups.push(group);
    alreadyGrouped.add(canonical);
    for (const d of dupeInfos) alreadyGrouped.add(d.filename);
    onProgress({ type: 'dedup-scan-group', group, message: `Found (suffix): ${canonical} has ${dupeInfos.length} duplicate(s)` });
  }

  // =============================================
  // PHASE 2: Content-hash duplicates (different names, same pixels)
  // =============================================
  onProgress({ type: 'dedup-scan-hashing', message: 'Hashing all textures for content-based dedup...' });

  const allPngFiles = await glob('*.{png,jpg,jpeg}', { cwd: texturesDir });
  const hashToFiles = new Map(); // pixelHash -> [{ filename, path, info }]

  for (const png of allPngFiles) {
    if (alreadyGrouped.has(png)) continue; // skip already grouped

    const pngPath = path.join(texturesDir, png);
    const info = await getImageInfo(pngPath);
    const hash = await getPixelHash(pngPath);
    if (!hash) continue;

    if (!hashToFiles.has(hash)) hashToFiles.set(hash, []);
    hashToFiles.get(hash).push({ filename: png, path: pngPath, ...info, pixelHash: hash });
  }

  for (const [hash, files] of hashToFiles) {
    if (files.length < 2) continue;

    // Pick the canonical: prefer the one referenced by most GLBs, then shortest name
    files.sort((a, b) => {
      const aRefs = (textureToGlbs.get(a.filename) || []).length;
      const bRefs = (textureToGlbs.get(b.filename) || []).length;
      if (bRefs !== aRefs) return bRefs - aRefs;
      return a.filename.length - b.filename.length;
    });

    const canon = files[0];
    const dupes = files.slice(1);

    let totalSavings = 0;
    const dupeInfos = dupes.map(d => {
      totalSavings += d.size;
      return {
        filename: d.filename, path: d.path, size: d.size,
        width: d.width, height: d.height, pixelHash: d.pixelHash,
        pixelMatch: true,
        referencedBy: textureToGlbs.get(d.filename) || [],
      };
    });

    const group = {
      id: `group-${groupIdx++}`,
      canonical: { filename: canon.filename, path: canon.path, size: canon.size, width: canon.width, height: canon.height, pixelHash: canon.pixelHash },
      canonicalReferencedBy: textureToGlbs.get(canon.filename) || [],
      duplicates: dupeInfos,
      pixelMatch: true,
      savingsBytes: totalSavings,
    };

    groups.push(group);
    onProgress({ type: 'dedup-scan-group', group, message: `Found (content): ${canon.filename} has ${dupeInfos.length} duplicate(s) with identical pixels` });
  }

  const totalDuplicates = groups.reduce((sum, g) => sum + g.duplicates.length, 0);
  const totalSavings = groups.reduce((sum, g) => sum + g.savingsBytes, 0);

  onProgress({ type: 'dedup-scan-done', totalGroups: groups.length, totalDuplicates, totalSavings, message: `Scan complete: ${groups.length} group(s), ${totalDuplicates} duplicate(s), ${formatBytes(totalSavings)} savings` });

  return { groups, totalGroups: groups.length, totalDuplicates, totalSavings };
}

export async function dedupApply(folder, groupIds, scanResult, options = {}, onProgress = () => {}) {
  const modelsDir = options.separateFolders ? path.join(folder, 'models') : folder;
  const texturesDir = options.separateFolders ? path.join(folder, 'textures') : folder;

  const selectedGroups = scanResult.groups.filter(g => groupIds.includes(g.id));

  if (selectedGroups.length === 0) {
    onProgress({ type: 'dedup-apply-done', rewrittenGlbs: 0, deletedFiles: 0, savedBytes: 0, message: 'No groups selected.' });
    return { rewrittenGlbs: 0, deletedFiles: 0, savedBytes: 0 };
  }

  onProgress({ type: 'dedup-apply-start', groupCount: selectedGroups.length, message: `Applying ${selectedGroups.length} dedup group(s)...` });

  // Build a global replacement map: oldUri -> newUri
  const replacements = new Map();
  const filesToDelete = [];

  for (const group of selectedGroups) {
    for (const dupe of group.duplicates) {
      replacements.set(dupe.filename, group.canonical.filename);
      filesToDelete.push(path.join(texturesDir, dupe.filename));
    }
  }

  // Find all GLBs that need rewriting
  const glbFiles = await glob('*.glb', { cwd: modelsDir, absolute: true });
  let rewrittenGlbs = 0;

  for (const glbPath of glbFiles) {
    const glbName = path.basename(glbPath);
    const buf = await fs.readFile(glbPath);
    const result = rewriteGlb(buf, replacements);

    if (result) {
      await fs.writeFile(glbPath, result);
      rewrittenGlbs++;
      onProgress({ type: 'dedup-apply-rewrite', glb: glbName, message: `Rewrote: ${glbName}` });
    }
  }

  // Delete duplicate files
  let deletedFiles = 0;
  let savedBytes = 0;

  for (const filePath of filesToDelete) {
    try {
      const stat = await fs.stat(filePath);
      savedBytes += stat.size;
      await fs.unlink(filePath);
      deletedFiles++;
      onProgress({ type: 'dedup-apply-delete', filename: path.basename(filePath), message: `Deleted: ${path.basename(filePath)}` });
    } catch {}
  }

  onProgress({ type: 'dedup-apply-done', rewrittenGlbs, deletedFiles, savedBytes, message: `Done! Rewrote ${rewrittenGlbs} GLB(s), deleted ${deletedFiles} file(s), saved ${formatBytes(savedBytes)}` });

  return { rewrittenGlbs, deletedFiles, savedBytes };
}

