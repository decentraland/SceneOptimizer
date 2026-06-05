import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { glob } from 'glob';

const TEXTURE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.webp']);

const defaultProgress = (e) => console.log(e.message);

// ----- GLB header / JSON chunk helpers -----

const GLB_MAGIC = 0x46546c67;
const GLB_JSON_CHUNK_TYPE = 0x4e4f534a;

function readGlbJson(buf) {
  if (buf.length < 20 || buf.readUInt32LE(0) !== GLB_MAGIC) return null;
  const jsonChunkLength = buf.readUInt32LE(12);
  const jsonStr = buf.subarray(20, 20 + jsonChunkLength).toString('utf8').replace(/\0+$/, '').trimEnd();
  try {
    return { json: JSON.parse(jsonStr), jsonChunkLength };
  } catch {
    return null;
  }
}

function writeGlbWithJson(buf, json) {
  const jsonChunkLength = buf.readUInt32LE(12);
  const binaryChunkStart = 20 + jsonChunkLength;
  const hasBinaryChunk = binaryChunkStart + 8 <= buf.length;
  const binaryChunk = hasBinaryChunk ? buf.subarray(binaryChunkStart) : Buffer.alloc(0);

  let newJsonStr = JSON.stringify(json);
  while (Buffer.byteLength(newJsonStr, 'utf8') % 4 !== 0) newJsonStr += ' ';
  const newJsonBuf = Buffer.from(newJsonStr, 'utf8');

  const jsonSectionLength = 8 + newJsonBuf.length;
  let padding = Buffer.alloc(0);
  if (hasBinaryChunk && (12 + jsonSectionLength) % 4 !== 0) {
    const padLen = 4 - ((12 + jsonSectionLength) % 4);
    padding = Buffer.alloc(padLen, 0x20);
  }

  const totalLength = 12 + jsonSectionLength + padding.length + binaryChunk.length;
  const out = Buffer.alloc(totalLength);

  out.writeUInt32LE(GLB_MAGIC, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(totalLength, 8);
  out.writeUInt32LE(newJsonBuf.length + padding.length, 12);
  out.writeUInt32LE(GLB_JSON_CHUNK_TYPE, 16);
  newJsonBuf.copy(out, 20);
  if (padding.length > 0) padding.copy(out, 20 + newJsonBuf.length);
  if (binaryChunk.length > 0) binaryChunk.copy(out, 20 + newJsonBuf.length + padding.length);

  return out;
}

// ----- Material signature & hashing -----

function arr(v, def) {
  return Array.isArray(v) && v.length === def.length ? v : def;
}

function num(v, def) {
  return typeof v === 'number' && Number.isFinite(v) ? v : def;
}

function getTextureSig(json, texIdx) {
  if (texIdx == null) return null;
  const tex = json.textures?.[texIdx];
  if (!tex) return null;
  const imageUri = tex.source != null ? json.images?.[tex.source]?.uri ?? null : null;
  const sampler = tex.sampler != null ? json.samplers?.[tex.sampler] : null;
  return {
    uri: imageUri,
    magFilter: sampler?.magFilter ?? null,
    minFilter: sampler?.minFilter ?? null,
    wrapS: sampler?.wrapS ?? 10497,
    wrapT: sampler?.wrapT ?? 10497,
  };
}

function texInfoSig(json, info) {
  if (!info) return null;
  return {
    ...getTextureSig(json, info.index),
    texCoord: info.texCoord ?? 0,
    extensions: info.extensions ?? null,
  };
}

function getMaterialSig(json, mat) {
  const pbr = mat.pbrMetallicRoughness || {};
  return {
    baseColorFactor: arr(pbr.baseColorFactor, [1, 1, 1, 1]),
    baseColorTexture: texInfoSig(json, pbr.baseColorTexture),
    metallicFactor: num(pbr.metallicFactor, 1),
    roughnessFactor: num(pbr.roughnessFactor, 1),
    metallicRoughnessTexture: texInfoSig(json, pbr.metallicRoughnessTexture),
    normalTexture: mat.normalTexture
      ? { ...texInfoSig(json, mat.normalTexture), scale: num(mat.normalTexture.scale, 1) }
      : null,
    occlusionTexture: mat.occlusionTexture
      ? { ...texInfoSig(json, mat.occlusionTexture), strength: num(mat.occlusionTexture.strength, 1) }
      : null,
    emissiveTexture: texInfoSig(json, mat.emissiveTexture),
    emissiveFactor: arr(mat.emissiveFactor, [0, 0, 0]),
    alphaMode: mat.alphaMode || 'OPAQUE',
    alphaCutoff: num(mat.alphaCutoff, 0.5),
    doubleSided: mat.doubleSided === true,
    extensions: mat.extensions ?? null,
  };
}

function stableStringify(obj) {
  if (obj === null || obj === undefined) return 'null';
  if (typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

function hashMaterial(json, mat) {
  const sig = getMaterialSig(json, mat);
  return crypto.createHash('sha256').update(stableStringify(sig)).digest('hex').slice(0, 16);
}

// ----- Material normalization -----
//
// Returns a new material object with:
//   - The canonical name applied
//   - Original texture/sampler indices preserved (they're valid in this GLB)
//   - Default values stripped per the glTF spec to reduce JSON noise
//   - Keys in a deterministic order
//
// Two materials with the same hash that go through this normalizer end up with
// byte-identical JSON output (modulo the texture indices, which point at the
// same URIs through this GLB's textures array).

function pickTexInfo(info) {
  if (!info) return undefined;
  const out = { index: info.index };
  if (info.texCoord && info.texCoord !== 0) out.texCoord = info.texCoord;
  if (info.extensions) out.extensions = info.extensions;
  return out;
}

function normalizeMaterial(mat, canonicalName) {
  const pbr = mat.pbrMetallicRoughness || {};
  const out = { name: canonicalName };

  const newPbr = {};
  const baseColorFactor = arr(pbr.baseColorFactor, [1, 1, 1, 1]);
  if (baseColorFactor.some((v, i) => v !== [1, 1, 1, 1][i])) newPbr.baseColorFactor = baseColorFactor;

  if (pbr.baseColorTexture) newPbr.baseColorTexture = pickTexInfo(pbr.baseColorTexture);

  const metallicFactor = num(pbr.metallicFactor, 1);
  if (metallicFactor !== 1) newPbr.metallicFactor = metallicFactor;

  const roughnessFactor = num(pbr.roughnessFactor, 1);
  if (roughnessFactor !== 1) newPbr.roughnessFactor = roughnessFactor;

  if (pbr.metallicRoughnessTexture) newPbr.metallicRoughnessTexture = pickTexInfo(pbr.metallicRoughnessTexture);

  if (Object.keys(newPbr).length > 0) out.pbrMetallicRoughness = newPbr;

  if (mat.normalTexture) {
    const n = pickTexInfo(mat.normalTexture);
    const scale = num(mat.normalTexture.scale, 1);
    if (scale !== 1) n.scale = scale;
    out.normalTexture = n;
  }

  if (mat.occlusionTexture) {
    const o = pickTexInfo(mat.occlusionTexture);
    const strength = num(mat.occlusionTexture.strength, 1);
    if (strength !== 1) o.strength = strength;
    out.occlusionTexture = o;
  }

  if (mat.emissiveTexture) out.emissiveTexture = pickTexInfo(mat.emissiveTexture);

  const emissiveFactor = arr(mat.emissiveFactor, [0, 0, 0]);
  if (emissiveFactor.some((v) => v !== 0)) out.emissiveFactor = emissiveFactor;

  if (mat.alphaMode && mat.alphaMode !== 'OPAQUE') out.alphaMode = mat.alphaMode;
  if (mat.alphaMode === 'MASK') out.alphaCutoff = num(mat.alphaCutoff, 0.5);
  if (mat.doubleSided === true) out.doubleSided = true;
  if (mat.extensions) out.extensions = mat.extensions;
  if (mat.extras) out.extras = mat.extras;

  return out;
}

// ----- Aux file mirroring (textures + manifest) -----

async function copyAuxFiles(srcDir, dstDir, predicate) {
  const entries = await fs.readdir(srcDir, { withFileTypes: true });
  let count = 0;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!predicate(entry.name)) continue;
    await fs.copyFile(path.join(srcDir, entry.name), path.join(dstDir, entry.name));
    count++;
  }
  return count;
}

const isTextureFile = (n) => TEXTURE_EXTS.has(path.extname(n).toLowerCase());
const isManifestFile = (n) => n === 'manifest.json';

// ----- Main command -----

export async function canonicalizeCommand(inputFolder, options = {}, onProgress = defaultProgress) {
  const inputDir = path.resolve(inputFolder);
  const separateFolders = options.separateFolders === true;
  const inputModelsDir = separateFolders ? path.join(inputDir, 'models') : inputDir;
  const inputTexturesDir = separateFolders ? path.join(inputDir, 'textures') : inputDir;

  const outputDir = options.outdir ? path.resolve(options.outdir) : path.join(inputDir, 'canonicalized');
  const outputModelsDir = separateFolders ? path.join(outputDir, 'models') : outputDir;
  const outputTexturesDir = separateFolders ? path.join(outputDir, 'textures') : outputDir;

  const stat = await fs.stat(inputModelsDir).catch(() => null);
  if (!stat || !stat.isDirectory()) {
    throw new Error(`Input models folder not found: ${inputModelsDir}`);
  }

  const ignorePatterns = [
    '**/node_modules/**',
    '**/.git/**',
    '**/meshopt/**',
    '**/atlas/**',
    '**/canonicalized/**',
    '**/*.aligned.tmp',
    '**/*.backup.glb',
  ];
  // If the output dir lives inside the input dir, exclude that subtree from
  // the scan so re-runs don't double-process the previous output.
  const relOutput = path.relative(inputModelsDir, outputModelsDir);
  if (relOutput && !relOutput.startsWith('..') && !path.isAbsolute(relOutput)) {
    const head = relOutput.split(path.sep)[0];
    if (head) ignorePatterns.push(`${head}/**`);
  }

  const glbFiles = await glob('**/*.glb', {
    cwd: inputModelsDir,
    nodir: true,
    posix: true,
    ignore: ignorePatterns,
  });

  if (glbFiles.length === 0) throw new Error(`No .glb files found in: ${inputModelsDir}`);

  await fs.mkdir(outputModelsDir, { recursive: true });
  if (separateFolders) await fs.mkdir(outputTexturesDir, { recursive: true });

  // ---------- PASS 1: scan all GLBs, build hash → groups ----------
  onProgress({
    type: 'start',
    fileCount: glbFiles.length,
    inputDir,
    outputDir,
    message: `Scanning ${glbFiles.length} GLB(s) for materials...`,
  });

  // hash → { canonicalName, members: [{glb, matIdx, originalName}] }
  const groups = new Map();
  // Per-GLB cache so we don't reparse in pass 2
  const glbCache = new Map(); // rel → { buf, json, hashes: hash[] }

  let totalMaterialsBefore = 0;

  for (const rel of glbFiles) {
    const absPath = path.join(inputModelsDir, rel);
    const buf = await fs.readFile(absPath);
    const parsed = readGlbJson(buf);
    if (!parsed) {
      onProgress({ type: 'file-skip', file: rel, message: `  Skipping (not a valid GLB): ${rel}` });
      continue;
    }
    const json = parsed.json;
    const materials = json.materials || [];
    const hashes = [];
    for (let i = 0; i < materials.length; i++) {
      const mat = materials[i];
      const h = hashMaterial(json, mat);
      hashes.push(h);
      let group = groups.get(h);
      if (!group) {
        group = { hash: h, members: [], nameCounts: new Map() };
        groups.set(h, group);
      }
      group.members.push({ glb: rel, matIdx: i, originalName: mat.name || `material_${i}` });
      const nm = mat.name || `material_${i}`;
      group.nameCounts.set(nm, (group.nameCounts.get(nm) || 0) + 1);
    }
    totalMaterialsBefore += materials.length;
    glbCache.set(rel, { buf, json, hashes });
  }

  // Pick canonical name for each hash: most-common, alphabetical tiebreaker.
  for (const group of groups.values()) {
    let bestName = null;
    let bestCount = -1;
    for (const [name, count] of [...group.nameCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (count > bestCount) {
        bestCount = count;
        bestName = name;
      }
    }
    group.canonicalName = bestName;
  }

  // Find groups that span more than one GLB (where canonicalization actually shares).
  const crossGlbGroups = [...groups.values()]
    .filter((g) => new Set(g.members.map((m) => m.glb)).size > 1)
    .sort((a, b) => b.members.length - a.members.length);

  onProgress({
    type: 'scan-done',
    totalMaterials: totalMaterialsBefore,
    uniqueHashes: groups.size,
    crossGlbGroups: crossGlbGroups.length,
    message: `Found ${totalMaterialsBefore} material(s) across ${glbFiles.length} GLB(s) → ${groups.size} unique hash(es) | ${crossGlbGroups.length} groups span multiple GLBs`,
  });

  // ---------- PASS 2: rewrite each GLB ----------

  let totalMaterialsAfter = 0;
  let totalCollapsedWithin = 0;
  let writtenGlbs = 0;

  for (const rel of glbFiles) {
    const cached = glbCache.get(rel);
    if (!cached) continue;
    const { buf, json, hashes } = cached;
    const materials = json.materials || [];

    const indexMap = new Array(materials.length);
    const hashToSurvivor = new Map();
    const newMaterials = [];

    for (let i = 0; i < materials.length; i++) {
      const h = hashes[i];
      const survivor = hashToSurvivor.get(h);
      if (survivor !== undefined) {
        indexMap[i] = survivor;
        continue;
      }
      const newIdx = newMaterials.length;
      hashToSurvivor.set(h, newIdx);
      indexMap[i] = newIdx;
      newMaterials.push(normalizeMaterial(materials[i], groups.get(h).canonicalName));
    }

    const collapsedWithin = materials.length - newMaterials.length;
    totalCollapsedWithin += collapsedWithin;
    totalMaterialsAfter += newMaterials.length;

    // Remap primitive material references
    if (collapsedWithin > 0 && Array.isArray(json.meshes)) {
      for (const mesh of json.meshes) {
        if (!Array.isArray(mesh.primitives)) continue;
        for (const prim of mesh.primitives) {
          if (typeof prim.material === 'number') prim.material = indexMap[prim.material];
        }
      }
    }

    json.materials = newMaterials;

    const newBuf = writeGlbWithJson(buf, json);
    const outFile = path.join(outputModelsDir, rel);
    await fs.mkdir(path.dirname(outFile), { recursive: true });
    await fs.writeFile(outFile, newBuf);
    writtenGlbs++;

    onProgress({
      type: 'file-done',
      file: rel,
      beforeMaterials: materials.length,
      afterMaterials: newMaterials.length,
      collapsedWithin,
      message: `  ${rel}: ${materials.length} → ${newMaterials.length} material(s)${collapsedWithin > 0 ? ` (collapsed ${collapsedWithin} within)` : ''}`,
    });
  }

  // Mirror sibling textures + manifest so the output folder is self-contained.
  let copiedTextures = 0;
  if (separateFolders) {
    if (await fs.stat(inputTexturesDir).catch(() => null)) {
      copiedTextures += await copyAuxFiles(inputTexturesDir, outputTexturesDir, isTextureFile);
      copiedTextures += await copyAuxFiles(inputTexturesDir, outputTexturesDir, isManifestFile);
    }
  } else {
    copiedTextures += await copyAuxFiles(inputDir, outputDir, isTextureFile);
    copiedTextures += await copyAuxFiles(inputDir, outputDir, isManifestFile);
  }

  // Write a JSON report describing groups for inspection.
  const reportPath = path.join(outputDir, 'canonicalize-report.json');
  const report = {
    inputDir,
    outputDir,
    totalGlbs: writtenGlbs,
    totalMaterialsBefore,
    totalMaterialsAfter,
    totalCollapsedWithin,
    uniqueHashes: groups.size,
    crossGlbGroups: crossGlbGroups.length,
    topGroups: crossGlbGroups.slice(0, 30).map((g) => ({
      canonicalName: g.canonicalName,
      hash: g.hash,
      memberCount: g.members.length,
      glbCount: new Set(g.members.map((m) => m.glb)).size,
      glbs: [...new Set(g.members.map((m) => m.glb))].slice(0, 20),
      originalNames: [...g.nameCounts.entries()].sort((a, b) => b[1] - a[1]).map(([n, c]) => `${n} (×${c})`),
    })),
  };
  await fs.writeFile(reportPath, JSON.stringify(report, null, 2));

  onProgress({
    type: 'top-groups-header',
    message: `\nTop cross-GLB groups (canonical name → GLB count):`,
  });
  for (const g of crossGlbGroups.slice(0, 10)) {
    const glbCount = new Set(g.members.map((m) => m.glb)).size;
    onProgress({
      type: 'top-group',
      canonicalName: g.canonicalName,
      glbCount,
      message: `  ${g.canonicalName}: ${glbCount} GLB(s), ${g.members.length} material instance(s)`,
    });
  }

  onProgress({
    type: 'summary',
    totalMaterialsBefore,
    totalMaterialsAfter,
    totalCollapsedWithin,
    crossGlbGroups: crossGlbGroups.length,
    copiedTextures,
    reportPath,
    outputDir,
    message: `\nCanonicalize: ${totalMaterialsBefore} → ${totalMaterialsAfter} material(s) (collapsed ${totalCollapsedWithin} within-GLB) | ${crossGlbGroups.length} cross-GLB groups | mirrored ${copiedTextures} aux files\nOutput: ${outputDir}\nReport: ${reportPath}\nDone!`,
  });

  return {
    totalMaterialsBefore,
    totalMaterialsAfter,
    totalCollapsedWithin,
    uniqueHashes: groups.size,
    crossGlbGroups: crossGlbGroups.length,
    copiedTextures,
    outputDir,
    reportPath,
  };
}
