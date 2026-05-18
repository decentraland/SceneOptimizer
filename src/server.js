import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import open from 'open';
import { extractCommand } from './extract.js';
import { compressCommand } from './compress.js';
import { dedupScan, dedupApply } from './dedup.js';
import { atlasCommand } from './atlas.js';
import { alphaExtractCommand } from './alphaExtract.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

const watchedFiles = new Map();
const sseClients = [];
let isProcessing = false;
let watcher = null;

let settings = {
  watchFolder: '',
  outputDir: '',
  separateFolders: false,
};

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const client of sseClients) {
    client.write(payload);
  }
}

function getSnapshot() {
  return Array.from(watchedFiles.values());
}

async function startWatcher() {
  if (watcher) await watcher.close();
  watchedFiles.clear();

  if (!settings.watchFolder) return;

  await fs.mkdir(settings.watchFolder, { recursive: true });

  watcher = chokidar.watch(settings.watchFolder, {
    ignoreInitial: false,
    depth: 0,
    awaitWriteFinish: { stabilityThreshold: 1000, pollInterval: 200 },
  });

  watcher.on('add', async (filePath) => {
    if (!filePath.endsWith('.glb')) return;
    const name = path.basename(filePath);
    let size = 0;
    try {
      const stat = await fs.stat(filePath);
      size = stat.size;
    } catch {}
    const entry = { name, path: filePath, size, status: 'pending', detectedAt: Date.now() };
    watchedFiles.set(name, entry);
    broadcast('file-added', entry);
  });

  watcher.on('unlink', (filePath) => {
    if (!filePath.endsWith('.glb')) return;
    const name = path.basename(filePath);
    watchedFiles.delete(name);
    broadcast('file-removed', { name });
  });
}

app.get('/api/files', (req, res) => {
  res.json(getSnapshot());
});

app.get('/api/settings', (req, res) => {
  res.json({ ...settings, isProcessing });
});

app.post('/api/settings', async (req, res) => {
  const { watchFolder, outputDir, separateFolders } = req.body;
  let restart = false;

  if (watchFolder !== undefined && watchFolder !== settings.watchFolder) {
    settings.watchFolder = watchFolder ? path.resolve(watchFolder) : '';
    restart = true;
  }
  if (outputDir !== undefined) {
    settings.outputDir = outputDir ? path.resolve(outputDir) : '';
  }
  if (separateFolders !== undefined) {
    settings.separateFolders = !!separateFolders;
  }
  if (restart) await startWatcher();
  res.json(settings);
});

app.post('/api/extract', async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'Processing in progress' });

  isProcessing = true;
  broadcast('status', { isProcessing: true });

  try {
    const { files } = req.body;
    let targets;
    if (!files || files === 'all') {
      targets = Array.from(watchedFiles.values()).filter((f) => f.status !== 'extracting');
    } else {
      targets = files.map((name) => watchedFiles.get(name)).filter(Boolean);
    }

    if (targets.length === 0) {
      return res.status(400).json({ error: 'No files to process' });
    }

    for (const entry of targets) {
      entry.status = 'extracting';
      watchedFiles.set(entry.name, entry);
      broadcast('file-updated', entry);
    }

    const allPaths = targets.map((t) => t.path);
    try {
      const manifest = await extractCommand(allPaths, { outdir: settings.outputDir, separateFolders: settings.separateFolders }, (e) => {
        broadcast('extract-progress', e);
        if (e.type === 'file-done' || e.type === 'file-skip') {
          const entry = targets.find((t) => t.name === e.file);
          if (entry) {
            entry.status = 'extracted';
            watchedFiles.set(entry.name, entry);
            broadcast('file-updated', entry);
          }
        }
      });

      for (const entry of targets) {
        if (entry.status === 'extracting') {
          entry.status = 'extracted';
          watchedFiles.set(entry.name, entry);
          broadcast('file-updated', entry);
        }
      }

      res.json({ success: true, results: targets.map((t) => ({ file: t.name, status: 'extracted' })), manifest });
    } catch (err) {
      for (const entry of targets) {
        if (entry.status === 'extracting') {
          entry.status = 'error';
          entry.error = err.message;
          watchedFiles.set(entry.name, entry);
          broadcast('file-updated', entry);
        }
      }
      res.status(500).json({ error: err.message });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isProcessing = false;
    broadcast('status', { isProcessing: false });
  }
});

app.post('/api/compress', async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'Processing in progress' });

  isProcessing = true;
  broadcast('status', { isProcessing: true });

  try {
    const opts = {
      basecolorSize: String(req.body.basecolorSize || 1024),
      normalSize: String(req.body.normalSize || 1024),
      ormSize: String(req.body.ormSize || 512),
      emissiveSize: String(req.body.emissiveSize || 512),
      otherSize: String(req.body.otherSize || 512),
      quality: String(req.body.quality || 85),
      depth: String(req.body.depth || 8),
      format: req.body.format || 'png',
      denoise: req.body.denoise || 'off',
    };

    const texturesDir = settings.separateFolders ? path.join(settings.outputDir, 'textures') : settings.outputDir;
    const result = await compressCommand(texturesDir, opts, (e) => {
      broadcast('compress-progress', e);
    });

    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isProcessing = false;
    broadcast('status', { isProcessing: false });
  }
});

// === Dedup endpoints ===

let dedupScanResult = null;

app.post('/api/dedup/scan', async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'Processing in progress' });

  const folder = settings.outputDir;
  if (!folder) return res.status(400).json({ error: 'No output folder configured' });

  isProcessing = true;
  broadcast('status', { isProcessing: true });

  try {
    const result = await dedupScan(folder, { separateFolders: settings.separateFolders }, (e) => {
      broadcast('dedup-progress', e);
    });

    dedupScanResult = result;
    res.json({ success: true, ...result });
  } catch (err) {
    console.error('Dedup scan error:', err);
    res.status(500).json({ error: err.message });
  } finally {
    isProcessing = false;
    broadcast('status', { isProcessing: false });
  }
});

app.post('/api/dedup/apply', async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'Processing in progress' });

  const { groupIds } = req.body;
  if (!groupIds || !dedupScanResult) return res.status(400).json({ error: 'No scan result or groups' });

  isProcessing = true;
  broadcast('status', { isProcessing: true });

  try {

    const folder = settings.outputDir;
    const result = await dedupApply(folder, groupIds, dedupScanResult, { separateFolders: settings.separateFolders }, (e) => {
      broadcast('dedup-progress', e);
    });

    dedupScanResult = null;
    res.json({ success: true, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message });
  } finally {
    isProcessing = false;
    broadcast('status', { isProcessing: false });
  }
});

// === Atlas endpoints ===

app.post('/api/atlas/generate', async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'Processing in progress' });

  const { inputDir, outputDir, size, margin } = req.body || {};
  if (!inputDir || !outputDir) {
    return res.status(400).json({ error: 'inputDir and outputDir are required' });
  }

  isProcessing = true;
  broadcast('status', { isProcessing: true });

  try {
    const opts = {
      size: parseInt(size, 10) || 1024,
      margin: Math.max(0, parseInt(margin, 10) || 0),
    };
    const result = await atlasCommand(inputDir, outputDir, opts, (e) => {
      broadcast('atlas-progress', e);
    });
    res.json({ success: true, ...result });
  } catch (err) {
    broadcast('atlas-progress', { type: 'error', message: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    isProcessing = false;
    broadcast('status', { isProcessing: false });
  }
});

app.post('/api/alpha/extract', async (req, res) => {
  if (isProcessing) return res.status(409).json({ error: 'Processing in progress' });

  const { inputDir, outputDir } = req.body || {};
  if (!inputDir || !outputDir) {
    return res.status(400).json({ error: 'inputDir and outputDir are required' });
  }

  isProcessing = true;
  broadcast('status', { isProcessing: true });

  try {
    const result = await alphaExtractCommand(inputDir, outputDir, {}, (e) => {
      broadcast('alpha-progress', e);
    });
    res.json({ success: true, ...result });
  } catch (err) {
    broadcast('alpha-progress', { type: 'error', message: err.message });
    res.status(500).json({ error: err.message });
  } finally {
    isProcessing = false;
    broadcast('status', { isProcessing: false });
  }
});

app.get('/api/atlas/preview', async (req, res) => {
  try {
    const filePath = req.query.path ? path.resolve(req.query.path) : null;
    if (!filePath) return res.status(400).json({ error: 'path required' });
    const name = path.basename(filePath);
    if (!/^atlas(_alpha|_auto_alpha)?_\d+\.png$/i.test(name)) {
      return res.status(400).json({ error: 'Only atlas PNG previews are allowed' });
    }
    res.sendFile(filePath);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/dedup/texture/:filename', async (req, res) => {
  try {
    const dir = settings.separateFolders ? path.join(settings.outputDir, 'textures') : settings.outputDir;
    const filePath = path.join(dir, req.params.filename);
    // Prevent path traversal
    if (!filePath.startsWith(dir)) return res.status(403).json({ error: 'Forbidden' });
    res.sendFile(filePath);
  } catch (err) {
    res.status(404).json({ error: 'Not found' });
  }
});

app.get('/api/browse', async (req, res) => {
  try {
    const dir = req.query.dir ? path.resolve(req.query.dir) : os.homedir();
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const folders = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

    res.json({
      current: dir,
      parent: path.dirname(dir) !== dir ? path.dirname(dir) : null,
      folders,
    });
  } catch (err) {
    res.status(400).json({ error: err.message, current: os.homedir(), parent: null, folders: [] });
  }
});

app.post('/api/resolve-drop', async (req, res) => {
  const { name, entries: droppedEntries = [], nearPath = '' } = req.body;
  if (!name) return res.json({ path: null });

  // Collect candidate paths via Spotlight
  const candidates = [];
  try {
    const { execSync } = await import('node:child_process');
    const safeName = name.replace(/'/g, "\\'");
    const cmd = `mdfind "kMDItemFSName == '${safeName}' && kMDItemContentType == 'public.folder'" 2>/dev/null | head -50`;
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    if (result) candidates.push(...result.split('\n').filter(Boolean));
  } catch {}

  // Also check common locations
  const home = os.homedir();
  for (const base of [
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Documents'),
    home,
    path.dirname(settings.watchFolder),
    path.dirname(settings.outputDir),
  ]) {
    const c = path.join(base, name);
    if (!candidates.includes(c)) candidates.push(c);
  }

  // Filter to only valid directories
  const validCandidates = [];
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate);
      if (stat.isDirectory()) validCandidates.push(candidate);
    } catch {}
  }

  if (validCandidates.length === 0) return res.json({ path: null });
  if (validCandidates.length === 1) return res.json({ path: validCandidates[0] });

  // Score each candidate by file fingerprint matching
  if (droppedEntries.length > 0) {
    let bestScore = 0;
    let bestPath = null;

    for (const candidate of validCandidates) {
      let score = 0;
      for (const entry of droppedEntries) {
        try {
          const fullPath = path.join(candidate, entry.path || entry.name);
          const s = await fs.stat(fullPath);
          if (entry.isDir ? s.isDirectory() : s.isFile()) score++;
        } catch {}
      }
      if (score > bestScore) {
        bestScore = score;
        bestPath = candidate;
      }
    }

    if (bestPath && bestScore >= Math.min(droppedEntries.length, 2)) {
      return res.json({ path: bestPath });
    }
  }

  // If fingerprinting didn't work (empty folder), use proximity to nearPath
  if (nearPath) {
    let bestLen = 0;
    let bestPath = null;
    for (const candidate of validCandidates) {
      let common = 0;
      const parts1 = candidate.split('/');
      const parts2 = nearPath.split('/');
      for (let i = 0; i < Math.min(parts1.length, parts2.length); i++) {
        if (parts1[i] === parts2[i]) common++;
        else break;
      }
      if (common > bestLen) {
        bestLen = common;
        bestPath = candidate;
      }
    }
    if (bestPath) return res.json({ path: bestPath });
  }

  // Prefer paths under home directory
  const homePath = validCandidates.find((c) => c.startsWith(home));
  return res.json({ path: homePath || validCandidates[0] });
});

app.get('/api/events', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  res.write(`event: snapshot\ndata: ${JSON.stringify(getSnapshot())}\n\n`);
  res.write(`event: status\ndata: ${JSON.stringify({ isProcessing })}\n\n`);

  sseClients.push(res);
  req.on('close', () => {
    const idx = sseClients.indexOf(res);
    if (idx >= 0) sseClients.splice(idx, 1);
  });
});

// Global JSON error handler (prevents Express from returning HTML error pages)
app.use((err, req, res, _next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: err.message || 'Internal server error' });
});

const PORT = process.env.PORT || 3000;

await startWatcher();

app.listen(PORT, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`SceneOptimizer running at ${url}`);
  console.log(`Watching folder: ${settings.watchFolder}`);
  console.log(`Output folder: ${settings.outputDir}`);
  open(url);
});
