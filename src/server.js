import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { statSync } from 'node:fs';
import os from 'node:os';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import chokidar from 'chokidar';
import open from 'open';
import { extractCommand } from './extract.js';
import { compressCommand } from './compress.js';
import { dedupScan, dedupApply } from './dedup.js';

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

// ===================================================================
// Folder fingerprinting — given a folder name + sample file sizes,
// find the folder's absolute path on disk. Used by showDirectoryPicker()
// and drag-and-drop, since browsers hide the real path for security.
// ===================================================================

function findFilesMacOS(anchorFile) {
  const safeName = anchorFile.name.replace(/'/g, "\\'");
  const cmd = `mdfind "kMDItemFSName == '${safeName}' && kMDItemFSSize == ${anchorFile.size}" 2>/dev/null | head -50`;
  try {
    const result = execSync(cmd, { encoding: 'utf8', timeout: 5000 }).trim();
    return result ? result.split('\n').filter(Boolean) : [];
  } catch {
    return [];
  }
}

function findFilesWindows(anchorFile) {
  const home = os.homedir();
  const searchRoots = [
    path.join(home, 'Documents'),
    path.join(home, 'Desktop'),
    path.join(home, 'Downloads'),
    path.join(home, 'Projects'),
    home,
  ].filter(p => {
    try { return statSync(p).isDirectory(); } catch { return false; }
  });

  if (searchRoots.length === 0) return [];

  // Escape single quotes for PowerShell (double them)
  const escName = anchorFile.name.replace(/'/g, "''");
  const rootList = searchRoots.map(r => `'${r.replace(/'/g, "''")}'`).join(',');
  const psCmd = `powershell.exe -NoProfile -Command "Get-ChildItem -Path ${rootList} -Recurse -File -Filter '${escName}' -ErrorAction SilentlyContinue | Where-Object { $_.Length -eq ${anchorFile.size} } | Select-Object -First 50 -ExpandProperty FullName"`;

  try {
    const result = execSync(psCmd, { encoding: 'utf8', timeout: 15000 }).trim();
    return result ? result.split(/\r?\n/).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function findFilesByFingerprint(anchorFile) {
  return process.platform === 'win32'
    ? findFilesWindows(anchorFile)
    : findFilesMacOS(anchorFile);
}

app.post('/api/resolve-by-fingerprint', async (req, res) => {
  const { folderName, files = [] } = req.body;
  if (!folderName || files.length === 0) {
    return res.json({ path: null, candidates: [] });
  }

  // Strategy: find the most unique file (largest size), search for it by exact size,
  // then verify the parent folder has the expected name.
  const sortedFiles = [...files].sort((a, b) => b.size - a.size);
  const anchorFile = sortedFiles[0];

  let candidateDirs = [];
  try {
    const matches = findFilesByFingerprint(anchorFile);
    candidateDirs = matches
      .map(filePath => path.dirname(filePath))
      .filter(dirPath => path.basename(dirPath) === folderName);
  } catch {}

  // Deduplicate
  candidateDirs = [...new Set(candidateDirs)];

  // Verify each candidate by checking that all fingerprint files exist with matching sizes
  const verifiedCandidates = [];
  for (const dir of candidateDirs) {
    let matches = 0;
    for (const f of files) {
      try {
        const stat = await fs.stat(path.join(dir, f.name));
        if (stat.size === f.size) matches++;
      } catch {}
    }
    if (matches === files.length) verifiedCandidates.push(dir);
  }

  if (verifiedCandidates.length === 0) return res.json({ path: null, candidates: [] });
  if (verifiedCandidates.length === 1) return res.json({ path: verifiedCandidates[0], candidates: verifiedCandidates });

  return res.json({ path: null, candidates: verifiedCandidates });
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
