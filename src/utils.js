import { glob } from 'glob';
import path from 'node:path';

const SLOT_MAP = {
  baseColorTexture: 'baseColor',
  metallicRoughnessTexture: 'orm',
  normalTexture: 'normal',
  occlusionTexture: 'orm',
  emissiveTexture: 'emissive',
};

const FILENAME_SUFFIXES = ['baseColor', 'normal', 'orm', 'metallicRoughness', 'occlusion', 'emissive'];
const SUFFIX_REGEX = new RegExp(`_(${FILENAME_SUFFIXES.join('|')})\\.`, 'i');

const MIME_TO_EXT = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

const EXT_TO_MIME = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

export function classifyTextureSlot(slotName) {
  return SLOT_MAP[slotName] || 'other';
}

export function classifyByFilename(filename) {
  const match = filename.match(SUFFIX_REGEX);
  if (!match) return 'other';
  const suffix = match[1].toLowerCase();
  if (suffix === 'metallicroughness' || suffix === 'occlusion') return 'orm';
  if (suffix === 'basecolor') return 'baseColor';
  return suffix;
}

export function mimeToExtension(mimeType) {
  return MIME_TO_EXT[mimeType] || '.png';
}

export function extensionToMime(ext) {
  return EXT_TO_MIME[ext.toLowerCase()] || 'image/png';
}

export async function resolveGlobs(input) {
  const stat = await import('node:fs/promises').then((fs) => fs.stat(input).catch(() => null));
  let pattern = input;
  if (stat && stat.isDirectory()) {
    pattern = path.join(input, '**/*.glb');
  }
  const files = await glob(pattern, { absolute: true });
  return files.filter((f) => f.endsWith('.glb'));
}

export function sanitizeFilename(name) {
  return name.replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/\s+/g, '_');
}

export function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(1024));
  return `${(bytes / Math.pow(1024, i)).toFixed(1)} ${units[i]}`;
}
